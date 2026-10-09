import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { AnimatePresence } from 'motion/react';

import { auth, db, googleProvider } from './lib/firebase';
import { signInWithPopup, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, collection, addDoc, onSnapshot, serverTimestamp, deleteDoc, query, where, writeBatch, DocumentReference } from 'firebase/firestore';

import { CameraConfig, LogEntry, LogSentiment, RoutePoint, KnownFace, NotificationPrefs, UserPreferences, WatchlistEntry, RegistryAuditEntry, TabId, CameraMediaRefs, ViewMode, GuardScope } from './types';
import { detectStreamType, buildSnapshotUrl } from './lib/streamAdapters';
import { parseCsv, toCsv, downloadCsv } from './lib/csv';
import { computeGapAnalysis } from './lib/registryReport';
import { buildSightings, PlateSighting } from './lib/plateTracking';
import { recordSightings } from './lib/plateStore';
import { DEMO_GRID_CAMERAS } from './data/demoGridCameras';
import { fetchSentinelCatalogue } from './lib/sentinelCatalogue';
import { canAnalyzeOnServer, planGuardSync, toggleGuardSelection } from './lib/guardSync';
import { chunk, describeSummary, ImportSummary, parseLatLng, planBulkImport, summarizePlan } from './lib/bulkImport';

import OnboardingScreen from './components/OnboardingScreen';
import AuthScreen from './components/AuthScreen';
import Sidebar from './components/Sidebar';
import MobileNav from './components/MobileNav';
import Header from './components/Header';
import MonitorTab from './components/MonitorTab';
import type { FeedStatus } from './components/CameraFeed';
import AnalyticsTab from './components/AnalyticsTab';
import SettingsTab from './components/SettingsTab';
import RegistryTab from './components/RegistryTab';
import GuideTab from './components/GuideTab';
import ChatWidget from './components/ChatWidget';
import DvrGuideModal from './components/DvrGuideModal';
import FirstUseTour from './components/FirstUseTour';
import CommandPalette from './components/CommandPalette';
import IncidentAlertDrawer from './components/IncidentAlertDrawer';
import TrackingAlertBanner from './components/TrackingAlertBanner';
import { useTracking, type TrackAlert } from './lib/tracking';

enum OperationType { CREATE = 'create', UPDATE = 'update', DELETE = 'delete', LIST = 'list', GET = 'get', WRITE = 'write' }

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null; email?: string | null; emailVerified?: boolean | null;
    isAnonymous?: boolean | null; tenantId?: string | null;
    providerInfo?: { providerId?: string | null; email?: string | null }[];
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid, email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified, isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(p => ({ providerId: p.providerId, email: p.email })) || []
    },
    operationType, path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

/** Registry defaults for a brand-new camera — fields only, no id, since
 *  real users get their id from Firestore's addDoc, not assigned locally. */
function defaultCameraFields(name: string): Omit<CameraConfig, 'id'> {
  return {
    name, peopleThreshold: 5, vehicleThreshold: 2, sensitivity: 5, interval: 60,
    webhookUrl: '', useRemoteFeed: false, remoteStreamUrl: '', facingMode: 'user',
    // Simulated, not local-device: a placeholder/newly-seeded camera has no
    // stream configured yet, and defaulting to getUserMedia() would silently
    // open the viewer's own webcam/front camera on every first load instead
    // of showing a harmless demo tile. Matches the CSV bulk-import fallback.
    suspiciousRules: 'Any unknown person approaching the door', useSimulatedFeed: true,
    connectivityStatus: 'unknown', maintenanceStatus: 'operational', onboardedVia: 'manual'
  };
}
function createDefaultCamera(id: string, name: string): CameraConfig {
  return { id, ...defaultCameraFields(name) };
}

/**
 * Collapses cameras that point at the same remote stream URL down to one.
 * bulkImportCameras already guards new imports against creating these, but
 * that check only ever ran against whatever was in local state at click
 * time — an "Onboard grid cameras" click fired again before the first batch's
 * Firestore writes had round-tripped back through onSnapshot (or a second
 * CSV import of the same grid in an earlier session, before that guard
 * existed) leaves genuine duplicate documents on record. Loading N
 * duplicate records for one physical camera doesn't just look wrong in the
 * registry — each one independently opens its own WHEP connection, so a
 * doubled registry silently doubles every camera's real network and decode
 * load. Applied wherever a camera list is loaded wholesale from an
 * external source (Firestore, localStorage), not on every render — set
 * membership is by remoteStreamUrl only for actual remote feeds, so
 * multiple simulated/local placeholder cameras (no URL to compare) are
 * left alone.
 */
function dedupeCamerasByStreamUrl(cams: CameraConfig[]): CameraConfig[] {
  const seenUrls = new Set<string>();
  return cams.filter(c => {
    const url = c.useRemoteFeed ? c.remoteStreamUrl.trim().toLowerCase() : '';
    if (!url) return true;
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  criticalAlerts: true, systemStatus: true, quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00'
};

const REGISTRY_CSV_COLUMNS = ['id', 'name', 'department', 'ownership', 'cameraType', 'connectivityStatus', 'maintenanceStatus', 'installDate', 'storageDetails', 'lat', 'lng', 'onboardedVia'];

export default function App() {
  const [cameras, setCameras] = useState<CameraConfig[]>([createDefaultCamera('cam-1', 'Main Entrance')]);
  const [activeCameraId, setActiveCameraId] = useState<string>('cam-1');
  const [isCapturing, setIsCapturing] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [knownFaces, setKnownFaces] = useState<KnownFace[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [auditTrail, setAuditTrail] = useState<RegistryAuditEntry[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>('monitor');
  const [viewMode, setViewMode] = useState<ViewMode>('focus');
  const [guardScope, setGuardScope] = useState<GuardScope>('active');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [showDVRGuide, setShowDVRGuide] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  // Dark by default — a security/NOC monitoring tool reads as more purpose-
  // built in dark mode, and it's more legible on a projector during a demo.
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [showFirstUseTour, setShowFirstUseTour] = useState(false);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [googleSheetsId, setGoogleSheetsId] = useState<string>('');
  // No credentials are shipped with the app: each user enters their own under Settings → stream access.
  const [streamAccessPassword, setStreamAccessPassword] = useState<string>(
    () => localStorage.getItem('demo-guest-streamAccessPassword') || localStorage.getItem('omni_stream_password') || ''
  );
  // RTSP/WHEP on the grid's raw origin authenticate with email:password
  // (Basic auth, email as username) — a separate credential from the HLS
  // path's password-only login, per the grid's integrator guide.
  const [streamAccessEmail, setStreamAccessEmail] = useState<string>(
    () => localStorage.getItem('demo-guest-streamAccessEmail') || localStorage.getItem('omni_stream_email') || ''
  );
  const [isSaveLoading, setIsSaveLoading] = useState(false);
  // Background tracking (Feed > Full Panel). Lives here so a red alert reaches the screen whichever tab is open.
  const [panelOpenCameraId, setPanelOpenCameraId] = useState<string | null>(null);
  const [panelAlert, setPanelAlert] = useState<TrackAlert | null>(null);
  const [bannerAlert, setBannerAlert] = useState<TrackAlert | null>(null);
  const focusAlert = (a: TrackAlert) => {
    setActiveTab('monitor'); setViewMode('panel'); setActiveCameraId(a.cameraId);
    setPanelAlert(a); setPanelOpenCameraId(a.cameraId);
  };
  const tracking = useTracking({ email: streamAccessEmail, password: streamAccessPassword }, (a) => { setBannerAlert(a); focusAlert(a); });
  const [saveSuccess, setSaveSuccess] = useState<boolean | null>(null);
  const [isLoadingDemoGrid, setIsLoadingDemoGrid] = useState(false);
  const [demoGridStatus, setDemoGridStatus] = useState<{ type: 'live' | 'fallback'; message: string } | null>(null);
  // Whether the server's analysis worker is running (enables the bulk "Analyze on server" control).
  const [serverAnalysisAvailable, setServerAnalysisAvailable] = useState(false);
  useEffect(() => {
    fetch('/api/analysis/config').then(r => r.json()).then(d => setServerAnalysisAvailable(!!d.enabled)).catch(() => setServerAnalysisAvailable(false));
  }, []);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [userDepartment, setUserDepartment] = useState('');
  const [userRole, setUserRole] = useState<'operator' | 'admin'>('admin');
  const [routePlate, setRoutePlate] = useState<string | null>(null);
  const [routePoints, setRoutePoints] = useState<RoutePoint[]>([]);
  const [highlightLogId, setHighlightLogId] = useState<string | null>(null);
  const handleJumpToLog = useCallback((logId: string) => {
    setHighlightLogId(logId);
    setActiveTab('analytics');
  }, []);

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

  // Global Keyboard Navigation:
  // - ⌘K / Ctrl+K: Open Search Palette
  // - G: Cycle layout (Focus -> 1+5 Matrix -> Wall Grid)
  // - 1-9: Quick Spotlight Cameras 1 through 9
  useEffect(() => {
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen(v => !v);
        return;
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setViewMode(prev => (prev === 'focus' ? 'matrix' : prev === 'matrix' ? 'grid' : 'focus'));
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const index = parseInt(e.key, 10) - 1;
        if (cameras[index]) {
          e.preventDefault();
          setActiveCameraId(cameras[index].id);
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeydown);
    return () => window.removeEventListener('keydown', handleGlobalKeydown);
  }, [cameras]);

  const [chatInput, setChatInput] = useState('');
  const [isChatSending, setIsChatSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'model'; text: string }>>([
    { role: 'model', text: 'Hello! I am your OmniSee security co-pilot. I have analyzed your vision event log and can answer queries about people, vehicles, and custom alerts. What would you like to review?' }
  ]);

  const containerRef = useRef<HTMLDivElement>(null);
  const mediaRefs = useRef<Map<string, CameraMediaRefs>>(new Map());
  const inFlightAnalysisRef = useRef<Set<string>>(new Set());
  const lastAnalysisAttemptRef = useRef<Map<string, number>>(new Map());
  // Server hand-over bookkeeping for the guard (see the effect further down).
  const serverGuardIdsRef = useRef<Set<string>>(new Set());
  const serverGuardFailedRef = useRef<Set<string>>(new Set());
  const guardWasOnRef = useRef(false);
  const camerasRef = useRef<CameraConfig[]>(cameras);
  useEffect(() => { camerasRef.current = cameras; }, [cameras]);

  const activeCamera = cameras.find(c => c.id === activeCameraId) || cameras[0];
  const isAdmin = userRole === 'admin';

  // ---------- Multi-camera analysis selection ----------
  const [extraAnalysisCameraIds, setExtraAnalysisCameraIds] = useState<Set<string>>(new Set());
  const toggleAnalysisCamera = useCallback((id: string) => {
    const next = toggleGuardSelection(guardScope, extraAnalysisCameraIds, id);
    if (next.scope !== guardScope) setGuardScope(next.scope);
    setExtraAnalysisCameraIds(next.selected);
  }, [guardScope, extraAnalysisCameraIds]);
  const analysisCameraIds = useMemo(() => {
    if (guardScope === 'all') {
      return new Set(cameras.map(c => c.id));
    }
    if (guardScope === 'selected') {
      const s = new Set(extraAnalysisCameraIds);
      s.add(activeCameraId);
      return s;
    }
    return new Set([activeCameraId]);
  }, [guardScope, cameras, extraAnalysisCameraIds, activeCameraId]);
  const [analyzingCameraIds, setAnalyzingCameraIds] = useState<Set<string>>(new Set());
  const [analysisErrors, setAnalysisErrors] = useState<Map<string, string>>(new Map());
  const analysisError = analysisErrors.get(activeCameraId) || null;

  // Real per-camera connection status (reported by whichever CameraFeed
  // instance is actually mounted for that camera) — not the registry's
  // static connectivityStatus field, which is manually-set metadata that
  // says "online" regardless of whether the feed is actually playing.
  const [cameraStatuses, setCameraStatuses] = useState<Map<string, FeedStatus>>(new Map());
  const handleCameraStatusChange = useCallback((cameraId: string, status: FeedStatus) => {
    setCameraStatuses(prev => {
      if (prev.get(cameraId) === status) return prev;
      const next = new Map(prev);
      next.set(cameraId, status);
      return next;
    });
  }, []);
  const camerasLive = useMemo(() => cameras.filter(c => cameraStatuses.get(c.id) === 'live').length, [cameras, cameraStatuses]);

  const updateActiveCamera = useCallback((updates: Partial<CameraConfig>) => {
    setCameras(prev => prev.map(c => c.id === activeCameraId ? { ...c, ...updates } : c));
  }, [activeCameraId]);

  const logRegistryAudit = useCallback(async (cameraId: string, cameraName: string, action: 'create' | 'update' | 'delete', source: 'manual' | 'bulk_import') => {
    if (!user || user.uid === 'demo-guest') return;
    try {
      await addDoc(collection(db, 'registryAudit'), {
        cameraId, cameraName, action, source, userId: user.uid, performedBy: user.email || user.uid, timestamp: serverTimestamp()
      });
    } catch (err) { console.error('Audit log write failed (non-fatal):', err); }
  }, [user]);

  // Long-lived onSnapshot listeners must never throw from their error
  // callback — an uncaught throw there (which handleFirestoreError does,
  // by design, for one-shot mutations) just produces a console crash with
  // no recovery. A rules mismatch or transient outage should degrade to
  // offline mode, not take the listener down silently.
  const handleListenerError = useCallback((collectionName: string, error: unknown) => {
    console.error(`Firestore listener failed for "${collectionName}" (falling back to offline/local state):`, error);
    setIsOfflineMode(true);
    setDbError(error instanceof Error ? error.message : String(error));
  }, []);

  // ---------- Auth + user preferences ----------
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setAuthLoading(false);
      if (firebaseUser) {
        setUser(firebaseUser);
        setIsAuthenticated(true);
        if (localStorage.getItem('omni-first-tour') !== 'true') setShowFirstUseTour(true);
        try {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (userDoc.exists()) {
            const data = userDoc.data() as UserPreferences;
            setTheme(data.theme || 'dark');
            if (data.notificationPrefs) setNotificationPrefs(data.notificationPrefs);
            setGoogleSheetsId(data.googleSheetsId || '');
            setStreamAccessPassword(data.streamAccessPassword || localStorage.getItem('omni_stream_password') || '');
            // Pre-fills with the signed-in Google email on a first read (a
            // reasonable default — the two are often the same person's
            // email) if nothing's been explicitly set yet; still editable
            // in Settings since the grid-registered email isn't guaranteed
            // to match the login email.
            setStreamAccessEmail(data.streamAccessEmail || localStorage.getItem('omni_stream_email') || '');
            setUserDepartment(data.department || '');
            setUserRole(data.role || 'admin');
            localStorage.setItem(`user-${firebaseUser.uid}-googleSheetsId`, data.googleSheetsId || '');
            if (data.notificationPrefs) localStorage.setItem(`user-${firebaseUser.uid}-notificationPrefs`, JSON.stringify(data.notificationPrefs));
            setIsOfflineMode(false);
            setDbError(null);
          } else {
            try {
              await setDoc(doc(db, 'users', firebaseUser.uid), {
                theme: 'dark', notificationPrefs: DEFAULT_NOTIFICATION_PREFS, googleSheetsId: '', streamAccessPassword: '',
                streamAccessEmail: firebaseUser.email || '',
                department: '', role: 'admin', updatedAt: serverTimestamp()
              });
              setStreamAccessEmail(firebaseUser.email || '');
              // Camera seeding happens once in the cameras registry listener
              // below (it fires for both brand-new users and any existing
              // account that has zero camera docs) — not duplicated here.
              setIsOfflineMode(false);
              setDbError(null);
            } catch (err) {
              console.warn('Firestore initialize user settings failed (falling back to offline local model):', err);
              setIsOfflineMode(true);
            }
          }
        } catch (error: unknown) {
          console.warn('Firestore user config load failed - falling back to offline cache backup:', error);
          setIsOfflineMode(true);
          setDbError(error instanceof Error ? error.message : String(error));

          const localSheetsId = localStorage.getItem(`user-${firebaseUser.uid}-googleSheetsId`);
          if (localSheetsId) setGoogleSheetsId(localSheetsId);
          const localCams = localStorage.getItem(`user-${firebaseUser.uid}-cameras`);
          if (localCams) {
            try {
              const parsed = dedupeCamerasByStreamUrl(JSON.parse(localCams));
              if (Array.isArray(parsed) && parsed.length > 0) {
                setCameras(parsed);
                if (!parsed.find((c: CameraConfig) => c.id === activeCameraId)) setActiveCameraId(parsed[0].id);
              }
            } catch (e) { console.error('Local storage camera fallback parse failed', e); }
          }
          const localPrefs = localStorage.getItem(`user-${firebaseUser.uid}-notificationPrefs`);
          if (localPrefs) {
            try { setNotificationPrefs(JSON.parse(localPrefs)); } catch (e) { console.error('Local storage notificationPrefs fallback parse failed', e); }
          }
        }
      } else {
        setUser(null);
        setIsAuthenticated(false);
        setTheme('dark');
        setGoogleSheetsId('');
        setUserDepartment('');
        setUserRole('admin');
        setNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
        setCameras([createDefaultCamera('cam-1', 'Main Entrance')]);
        setActiveCameraId('cam-1');
        setAuditTrail([]);
      }
    });

    setShowOnboarding(localStorage.getItem('omni-onboarding') !== 'true');
    return () => unsub();
  }, []);

  // ---------- Known faces ----------
  useEffect(() => {
    if (!user || user.uid === 'demo-guest') return;
    const q = query(collection(db, 'faces'), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const faces: KnownFace[] = [];
      snapshot.forEach(d => { const data = d.data(); faces.push({ id: d.id, name: data.name, imageData: data.imageData }); });
      setKnownFaces(faces);
    }, (error) => handleListenerError('faces', error));
    return () => unsub();
  }, [user]);

  // ---------- Watchlist ----------
  useEffect(() => {
    if (!user || user.uid === 'demo-guest') return;
    const q = query(collection(db, 'watchlist'), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const entries: WatchlistEntry[] = [];
      snapshot.forEach(d => {
        const data = d.data();
        entries.push({ id: d.id, plate: data.plate, reason: data.reason || '', addedBy: data.userId, createdAt: data.createdAt?.toDate?.() || new Date() });
      });
      setWatchlist(entries);
    }, (error) => handleListenerError('watchlist', error));
    return () => unsub();
  }, [user]);

  // ---------- Logs ----------
  useEffect(() => {
    if (!user || user.uid === 'demo-guest') return;
    const q = query(collection(db, 'logs'), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const dbLogs: LogEntry[] = [];
      snapshot.forEach(d => {
        const data = d.data({ serverTimestamps: 'estimate' });
        let ts: Date;
        if (data.timestamp && typeof data.timestamp.toDate === 'function') ts = data.timestamp.toDate();
        else if (data.timestamp) { const p = new Date(data.timestamp); ts = isNaN(p.getTime()) ? new Date() : p; }
        else ts = new Date();
        dbLogs.push({
          id: d.id, cameraId: data.cameraId || '', cameraName: data.cameraName || 'Unknown Camera', timestamp: ts,
          summary: data.summary || '', counts: data.counts || { people: 0, vehicles: 0, other: 0 },
          sentiment: (['calm', 'neutral', 'tense', 'critical'] as const).includes(data.sentiment) ? data.sentiment as LogSentiment : 'neutral',
          isUnusual: data.isUnusual || false, unusualReason: data.unusualReason || undefined, alerts: data.alerts || [],
          detectedPlates: data.detectedPlates || [], isWatchlistMatch: data.isWatchlistMatch || false,
        });
      });
      dbLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setLogs(dbLogs.slice(0, 100));
    }, (error) => handleListenerError('logs', error));
    return () => unsub();
  }, [user]);

  // ---------- Camera registry (Model 1 — central registry, mandatory foundation) ----------
  const hasSeededCameraRef = useRef(false);
  useEffect(() => {
    if (!user || user.uid === 'demo-guest') return;
    hasSeededCameraRef.current = false;
    const q = query(collection(db, 'cameras'), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const cams: CameraConfig[] = [];
      snapshot.forEach(d => {
        const data = d.data();
        cams.push({
          id: d.id, name: data.name || 'Unnamed Camera',
          peopleThreshold: data.peopleThreshold ?? 5, vehicleThreshold: data.vehicleThreshold ?? 2,
          sensitivity: data.sensitivity ?? 5, interval: data.interval ?? 60,
          webhookUrl: data.webhookUrl || '', useRemoteFeed: !!data.useRemoteFeed, remoteStreamUrl: data.remoteStreamUrl || '',
          facingMode: data.facingMode || 'user', suspiciousRules: data.suspiciousRules || '',
          useSimulatedFeed: !!data.useSimulatedFeed,
          serverAnalysis: !!data.serverAnalysis, lastAnalysisError: data.lastAnalysisError || undefined,
          lastAnalysisTime: data.lastAnalysisTime?.toDate ? data.lastAnalysisTime.toDate() : data.lastAnalysisTime,
          location: data.location, department: data.department, ownership: data.ownership,
          cameraType: data.cameraType, connectivityStatus: data.connectivityStatus || 'unknown',
          maintenanceStatus: data.maintenanceStatus || 'operational', installDate: data.installDate,
          storageDetails: data.storageDetails, onboardedVia: data.onboardedVia || 'manual',
        });
      });
      if (cams.length > 0) {
        const deduped = dedupeCamerasByStreamUrl(cams);
        setCameras(deduped);
        if (!deduped.find(c => c.id === activeCameraId)) setActiveCameraId(deduped[0].id);
      } else if (!hasSeededCameraRef.current) {
        // Covers both brand-new accounts and any existing account whose
        // users/{uid} doc predates the registry migration and therefore
        // never got a camera document created for it.
        hasSeededCameraRef.current = true;
        addDoc(collection(db, 'cameras'), {
          ...defaultCameraFields('Main Entrance'), userId: user.uid,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        }).then(ref => logRegistryAudit(ref.id, 'Main Entrance', 'create', 'manual'))
          .catch(err => console.error('Failed to seed a default camera:', err));
      }
    }, (error) => handleListenerError('cameras', error));
    return () => unsub();
    // activeCameraId and logRegistryAudit intentionally omitted: re-subscribing
    // this listener on every camera switch would be wasteful, and reading a
    // slightly-stale activeCameraId here self-corrects on the next snapshot.
  }, [user]);

  // ---------- Registry audit trail (admin-only) ----------
  useEffect(() => {
    if (!user || user.uid === 'demo-guest' || !isAdmin) return;
    const q = query(collection(db, 'registryAudit'), where('userId', '==', user.uid));
    const unsub = onSnapshot(q, (snapshot) => {
      const entries: RegistryAuditEntry[] = [];
      snapshot.forEach(d => {
        const data = d.data();
        entries.push({
          id: d.id, cameraId: data.cameraId, cameraName: data.cameraName, action: data.action,
          source: data.source, performedBy: data.performedBy,
          timestamp: data.timestamp?.toDate ? data.timestamp.toDate() : new Date(),
        });
      });
      entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setAuditTrail(entries.slice(0, 200));
    }, (error) => console.error('Audit trail load failed (non-fatal):', error));
    return () => unsub();
  }, [user, isAdmin]);

  // ---------- Auth actions ----------
  const handleGoogleLogin = async () => {
    setLoginError(null);
    setIsSigningIn(true);
    try { await signInWithPopup(auth, googleProvider); }
    catch (error: unknown) { setLoginError(error instanceof Error ? error.message : String(error)); }
    finally { setIsSigningIn(false); }
  };

  const handleGuestBypass = () => {
    setLoginError(null);
    setUser({ uid: 'demo-guest', displayName: 'Offline Demo User', email: 'guest@omni-camera.io', photoURL: null, emailVerified: true } as unknown as FirebaseUser);
    const guestSheetsId = localStorage.getItem('demo-guest-googleSheetsId');
    if (guestSheetsId) setGoogleSheetsId(guestSheetsId);
    const guestStreamPw = localStorage.getItem('demo-guest-streamAccessPassword');
    if (guestStreamPw) setStreamAccessPassword(guestStreamPw);
    const guestStreamEmail = localStorage.getItem('demo-guest-streamAccessEmail');
    if (guestStreamEmail) setStreamAccessEmail(guestStreamEmail);
    const guestCams = localStorage.getItem('demo-guest-cameras');
    if (guestCams) {
      try {
        const parsed = dedupeCamerasByStreamUrl(JSON.parse(guestCams));
        if (Array.isArray(parsed) && parsed.length > 0) { setCameras(parsed); setActiveCameraId(parsed[0].id); }
      } catch (e) { console.error(e); }
    }
    const guestPrefs = localStorage.getItem('demo-guest-notificationPrefs');
    if (guestPrefs) { try { setNotificationPrefs(JSON.parse(guestPrefs)); } catch (e) { console.error(e); } }
    setIsAuthenticated(true);
    if (localStorage.getItem('omni-first-tour') !== 'true') setShowFirstUseTour(true);
  };

  const handleToggleTheme = async () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    if (user && user.uid !== 'demo-guest') {
      try { await updateDoc(doc(db, 'users', user.uid), { theme: newTheme, updatedAt: serverTimestamp() }); }
      catch (error) { handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`); }
    }
  };

  const updateNotifyPrefs = async (prefs: Partial<NotificationPrefs>) => {
    const newPrefs = { ...notificationPrefs, ...prefs };
    setNotificationPrefs(newPrefs);
    if (user && user.uid !== 'demo-guest') {
      try { await updateDoc(doc(db, 'users', user.uid), { notificationPrefs: newPrefs, updatedAt: serverTimestamp() }); }
      catch (error) { handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`); }
    }
  };

  const handleCompleteOnboarding = () => { localStorage.setItem('omni-onboarding', 'true'); setShowOnboarding(false); };
  const handleDismissFirstUseTour = () => { localStorage.setItem('omni-first-tour', 'true'); setShowFirstUseTour(false); };
  const handleLogout = async () => { await signOut(auth); setActiveTab('monitor'); };

  const handleSaveSettings = async () => {
    if (!user) return;
    setIsSaveLoading(true);
    setSaveSuccess(null);

    const keySheets = user.uid === 'demo-guest' ? 'demo-guest-googleSheetsId' : `user-${user.uid}-googleSheetsId`;
    const keyCams = user.uid === 'demo-guest' ? 'demo-guest-cameras' : `user-${user.uid}-cameras`;
    const keyPrefs = user.uid === 'demo-guest' ? 'demo-guest-notificationPrefs' : `user-${user.uid}-notificationPrefs`;
    localStorage.setItem(keySheets, googleSheetsId);
    localStorage.setItem(keyCams, JSON.stringify(cameras));
    localStorage.setItem(keyPrefs, JSON.stringify(notificationPrefs));

    if (user.uid === 'demo-guest') {
      // Guest mode is entirely local by design, so this is the only place
      // the stream credentials are persisted at all for that path.
      localStorage.setItem('demo-guest-streamAccessPassword', streamAccessPassword);
      localStorage.setItem('demo-guest-streamAccessEmail', streamAccessEmail);
      setTimeout(() => { setIsSaveLoading(false); setSaveSuccess(true); setIsOfflineMode(true); setTimeout(() => setSaveSuccess(null), 3000); }, 600);
      return;
    }

    try {
      await setDoc(doc(db, 'users', user.uid), {
        theme, notificationPrefs, googleSheetsId, streamAccessPassword, streamAccessEmail, department: userDepartment, role: userRole, updatedAt: serverTimestamp()
      });

      const batch = writeBatch(db);
      cameras.forEach(cam => {
        const { id, ...fields } = cam;
        batch.update(doc(db, 'cameras', id), { ...fields, updatedAt: serverTimestamp() });
      });
      await batch.commit();
      cameras.forEach(cam => logRegistryAudit(cam.id, cam.name, 'update', 'manual'));

      setIsSaveLoading(false); setSaveSuccess(true); setIsOfflineMode(false); setDbError(null);
      setTimeout(() => setSaveSuccess(null), 3000);
    } catch (error: unknown) {
      console.warn('Firestore save failed - using local cache fallback:', error);
      setIsSaveLoading(false); setSaveSuccess(true); setIsOfflineMode(true);
      setDbError(error instanceof Error ? error.message : String(error));
      setTimeout(() => setSaveSuccess(null), 3500);
    }
  };

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || isChatSending) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setIsChatSending(true);
    try {
      // Grab a fresh frame from every camera currently under AI analysis
      // (always includes the focused camera — see analysisCameraIds) so the
      // chatbot can answer questions about what's literally visible right
      // now — object counts, scenery, anything not covered by the fixed
      // people/vehicle/brand schema the periodic summaries are built from —
      // instead of being limited to those stored summaries. Capped at 4 and
      // run with allSettled so a camera that isn't currently decodable just
      // gets skipped rather than blocking the question.
      const candidateCameras = Array.from(analysisCameraIds)
        .map(id => cameras.find(c => c.id === id))
        .filter((c): c is CameraConfig => !!c)
        .slice(0, 4);
      const frameResults = await Promise.allSettled(
        candidateCameras.map(async (camera) => ({
          cameraName: camera.name,
          imageBase64: await captureFrameBase64(camera),
        }))
      );
      const frames = frameResults
        .filter((r): r is PromiseFulfilledResult<{ cameraName: string; imageBase64: string }> => r.status === 'fulfilled')
        .map(r => r.value);

      const response = await fetch('/api/gemini/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMsg, history: chatMessages.slice(-15),
          cameraLogs: logs.slice(0, 20).map(l => ({ cameraName: l.cameraName, summary: l.summary, timestamp: l.timestamp, counts: l.counts })),
          frames
        })
      });
      if (!response.ok) throw new Error('Failed to receive response from OmniSee AI.');
      const data = await response.json();
      setChatMessages(prev => [...prev, { role: 'model', text: data.text || 'No response text received.' }]);
    } catch (error: unknown) {
      setChatMessages(prev => [...prev, { role: 'model', text: `Error: ${error instanceof Error ? error.message : 'The AI pilot is offline. Try again shortly.'}` }]);
    } finally { setIsChatSending(false); }
  };

  const handleFaceUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      const name = prompt('Enter name for this person:');
      if (!name) return;
      if (user.uid === 'demo-guest') {
        setKnownFaces(prev => [...prev, { id: `guest-face-${Date.now()}`, name, imageData: base64 }]);
        return;
      }
      try { await addDoc(collection(db, 'faces'), { name, imageData: base64, userId: user.uid, createdAt: serverTimestamp() }); }
      catch (error) { handleFirestoreError(error, OperationType.CREATE, 'faces'); }
    };
    reader.readAsDataURL(file);
  };

  const removeKnownFace = async (id: string) => {
    if (user && user.uid === 'demo-guest') { setKnownFaces(prev => prev.filter(f => f.id !== id)); return; }
    try { await deleteDoc(doc(db, 'faces', id)); }
    catch (error) { handleFirestoreError(error, OperationType.DELETE, `faces/${id}`); }
  };

  const addWatchlistEntry = async (plate: string, reason: string) => {
    if (!user) return;
    if (user.uid === 'demo-guest') {
      setWatchlist(prev => [...prev, { id: `guest-watch-${Date.now()}`, plate, reason, addedBy: user.uid, createdAt: new Date() }]);
      return;
    }
    try { await addDoc(collection(db, 'watchlist'), { plate, reason, userId: user.uid, createdAt: serverTimestamp() }); }
    catch (error) { handleFirestoreError(error, OperationType.CREATE, 'watchlist'); }
  };

  const removeWatchlistEntry = async (id: string) => {
    if (user && user.uid === 'demo-guest') { setWatchlist(prev => prev.filter(w => w.id !== id)); return; }
    try { await deleteDoc(doc(db, 'watchlist', id)); }
    catch (error) { handleFirestoreError(error, OperationType.DELETE, `watchlist/${id}`); }
  };

  const updateUserProfile = (updates: { department?: string; role?: 'operator' | 'admin' }) => {
    if (updates.department !== undefined) setUserDepartment(updates.department);
    if (updates.role !== undefined) setUserRole(updates.role);
  };

  // ---------- Fullscreen ----------
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(err => console.error(`Error attempting to enable full-screen mode: ${err.message}`));
      setIsFullscreen(true);
    } else { document.exitFullscreen(); setIsFullscreen(false); }
  };
  useEffect(() => {
    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  const toggleCameraFacing = () => updateActiveCamera({ facingMode: activeCamera.facingMode === 'user' ? 'environment' : 'user' });
  const handleFallbackToSimulated = useCallback((targetCamId?: string) => {
    const idToUpdate = targetCamId || activeCameraId;
    setCameras(prev => prev.map(c => c.id === idToUpdate ? { ...c, useSimulatedFeed: true, useRemoteFeed: false } : c));
  }, [activeCameraId]);

  // ---------- Frame capture + analysis ----------
  // Grabs one still frame from whatever this camera is currently rendering
  // (simulated canvas, WHEP/HLS video element, plain image, or an iframe via
  // the snapshot proxy) as a base64 JPEG. Shared by the periodic analysis
  // loop below and the chatbot (see handleSendChat) — anywhere that needs
  // "what does this camera see right now" rather than a stored summary.
  const captureFrameBase64 = useCallback(async (camera: CameraConfig): Promise<string> => {
    const refs = mediaRefs.current.get(camera.id);
    if (!refs) throw new Error(`"${camera.name}" isn't live right now.`);

    const isSimulated = !!camera.useSimulatedFeed;
    const isRemote = !!camera.useRemoteFeed && !!camera.remoteStreamUrl;
    const streamType = isRemote ? detectStreamType(camera.remoteStreamUrl) : null;

    const canvas = document.createElement('canvas');
    const MAX_DIMENSION = 1024;
    let width = 640, height = 360;

    if (isSimulated) { width = refs.canvas?.width || 640; height = refs.canvas?.height || 360; }
    else if (isRemote && (streamType === 'video' || streamType === 'hls')) { width = refs.video?.videoWidth || 640; height = refs.video?.videoHeight || 360; }
    else if (isRemote && streamType === 'image') { width = refs.img?.naturalWidth || 640; height = refs.img?.naturalHeight || 360; }
    else if (!isRemote) { width = refs.video?.videoWidth || 640; height = refs.video?.videoHeight || 360; }

    if (width === 0 || height === 0) { width = 640; height = 360; }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      width *= ratio; height *= ratio;
    }
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable.');

    if (isSimulated) {
      if (!refs.canvas) throw new Error('Simulated feed is not ready yet.');
      ctx.drawImage(refs.canvas, 0, 0, width, height);
    } else if (isRemote) {
      if ((streamType === 'video' || streamType === 'hls') && refs.video && refs.video.videoWidth > 0 && refs.video.readyState >= 2) {
        ctx.drawImage(refs.video, 0, 0, width, height);
      } else if (streamType === 'video' || streamType === 'hls') {
        // If video is attached but still buffering, give it a quick moment to render the first frame
        if (refs.video && refs.video.videoWidth > 0) {
          ctx.drawImage(refs.video, 0, 0, width, height);
        } else {
          // Robust server-side snapshot fallback — ensures frame capture succeeds even before video mounts
          const snapshotUrl = `/api/camera-snapshot?url=${encodeURIComponent(camera.remoteStreamUrl)}&password=${encodeURIComponent(streamAccessPassword)}&email=${encodeURIComponent(streamAccessEmail)}`;
          const res = await fetch(snapshotUrl);
          if (res.ok) {
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            try {
              const tempImg = new Image();
              await new Promise((resolve, reject) => {
                tempImg.onload = resolve;
                tempImg.onerror = () => reject(new Error('Unable to parse snapshot image data.'));
                setTimeout(() => reject(new Error('Image render timeout')), 6000);
                tempImg.src = objectUrl;
              });
              ctx.drawImage(tempImg, 0, 0, width, height);
            } finally {
              URL.revokeObjectURL(objectUrl);
            }
          } else if (refs.video) {
            ctx.drawImage(refs.video, 0, 0, width, height);
          } else {
            throw new Error('Camera feed is still buffering and snapshot fallback unavailable.');
          }
        }
      } else if (streamType === 'image' && refs.img) {
        ctx.drawImage(refs.img, 0, 0, width, height);
      } else if (streamType === 'unsupported') {
        throw new Error('RTSP/WHEP URLs cannot be analyzed directly in the browser. Use this camera\'s HLS URL instead.');
      }
      else if (streamType === 'iframe') {
        const snapshotImgUrl = buildSnapshotUrl(camera.remoteStreamUrl);
        if (!snapshotImgUrl) throw new Error('Failed to parse iframe URL for snapshot extraction.');
        const proxiedUrl = `/api/proxy-frame?url=${encodeURIComponent(snapshotImgUrl)}`;
        const res = await fetch(proxiedUrl);
        if (!res.ok) throw new Error((await res.text()) || `Proxy response status: ${res.status}`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        try {
          const tempImg = new Image();
          await new Promise((resolve, reject) => {
            tempImg.onload = resolve;
            tempImg.onerror = () => reject(new Error('Unable to parse the retrieved frame data as an image.'));
            setTimeout(() => reject(new Error('Image render timeout')), 5000);
            tempImg.src = objectUrl;
          });
          ctx.drawImage(tempImg, 0, 0, width, height);
        } finally { URL.revokeObjectURL(objectUrl); }
      } else {
        throw new Error('Embedded stream player URLs require active snapshot endpoints to analyze frame content.');
      }
    } else {
      if (!refs.video) throw new Error('Camera feed is not ready yet.');
      ctx.drawImage(refs.video, 0, 0, width, height);
    }

    const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    if (!base64Image) throw new Error('Failed to capture frame.');
    return base64Image;
  }, []);

  // Parameterized by camera (rather than closing over a single activeCamera)
  // so multiple cameras — the focused one plus any grid-view checkboxes —
  // can run their own capture/analysis cycles concurrently.
  const captureAndAnalyzeCamera = useCallback(async (camera: CameraConfig) => {
    if (inFlightAnalysisRef.current.has(camera.id)) return;
    if (!mediaRefs.current.get(camera.id)) return; // this camera's feed hasn't reported its DOM refs yet

    inFlightAnalysisRef.current.add(camera.id);
    setAnalyzingCameraIds(prev => new Set(prev).add(camera.id));
    setAnalysisErrors(prev => { if (!prev.has(camera.id)) return prev; const next = new Map(prev); next.delete(camera.id); return next; });

    const finish = () => {
      inFlightAnalysisRef.current.delete(camera.id);
      setAnalyzingCameraIds(prev => { if (!prev.has(camera.id)) return prev; const next = new Set(prev); next.delete(camera.id); return next; });
    };

    try {
      const base64Image = await captureFrameBase64(camera);

      const analyzeResponse = await fetch('/api/gemini/analyze-frame', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64Image,
          knownFaces: knownFaces.slice(0, 6).map(f => ({ name: f.name, imageData: f.imageData })),
          watchlist: watchlist.map(w => w.plate),
          camera: {
            name: camera.name, sensitivity: camera.sensitivity,
            peopleThreshold: camera.peopleThreshold, vehicleThreshold: camera.vehicleThreshold,
            suspiciousRules: camera.suspiciousRules
          }
        })
      });
      if (!analyzeResponse.ok) {
        const errBody = await analyzeResponse.json().catch(() => ({}));
        throw new Error(errBody.error || `Frame analysis request failed (${analyzeResponse.status})`);
      }
      const data = await analyzeResponse.json();

      const detectedPlates: string[] = data.detected_plates || [];
      const watchlistMatches: string[] = data.watchlistMatches || [];
      const isWatchlistMatch = watchlistMatches.length > 0;
      const sentiment: LogSentiment = (['calm', 'neutral', 'tense', 'critical'] as const).includes(data.sentiment) ? data.sentiment : 'neutral';

      const summaryWithExtra = `${data.summary}${data.brands?.length ? ` Detected brands: ${data.brands.join(', ')}.` : ''} People: ${data.people_identified?.join(', ') || 'N/A'}`;
      const alerts: string[] = [...(data.alerts || [])];
      if (isWatchlistMatch) alerts.unshift(`Watchlist match: ${watchlistMatches.join(', ')}`);

      // "Unknown Person" only means something against a set of known faces. Without any registered, every
      // passer-by on a street camera is unknown, which flagged every busy scene as an anomaly.
      const unknownPersonFlag = knownFaces.length > 0 && !!data.people_identified?.includes('Unknown Person') && camera.sensitivity > 3;
      const newEntry: LogEntry = {
        id: Math.random().toString(36).substr(2, 9), cameraId: camera.id, cameraName: camera.name, timestamp: new Date(),
        summary: summaryWithExtra, counts: data.counts || { people: 0, vehicles: 0, other: 0 }, sentiment,
        isUnusual: isWatchlistMatch || !!data.isUnusual || unknownPersonFlag,
        unusualReason: data.isUnusualReason || (unknownPersonFlag ? 'Unknown identity detected near camera' : undefined),
        alerts, detectedPlates, isWatchlistMatch
      };

      if (!user || user.uid === 'demo-guest') {
        setLogs(prev => [newEntry, ...prev].slice(0, 100));
      } else {
        addDoc(collection(db, 'logs'), {
          cameraId: camera.id, cameraName: camera.name, summary: summaryWithExtra,
          detectedItems: data.people_identified || [], timestamp: new Date(), userId: user.uid,
          counts: data.counts || { people: 0, vehicles: 0, other: 0 }, sentiment, isUnusual: newEntry.isUnusual,
          unusualReason: newEntry.unusualReason || '', alerts, detectedPlates, isWatchlistMatch,
          plateReads: data.plate_reads || [], plateSource: data.plate_source || 'gemini'
        }).catch(err => { console.warn('Firestore log write failed, falling back to local state:', err); setLogs(prev => [newEntry, ...prev].slice(0, 100)); });
      }

      // Permanent plate sightings (the source for vehicle search / route reconstruction).
      if (user && user.uid !== 'demo-guest' && detectedPlates.length > 0) {
        recordSightings(user.uid, buildSightings(
          { id: camera.id, name: camera.name, department: camera.department, location: camera.location },
          newEntry.timestamp, detectedPlates, data.plate_reads || [], data.plate_source || 'gemini',
        )).catch(err => console.warn('Could not record plate sightings:', err));
      }

      setCameras(prev => prev.map(c => c.id === camera.id ? { ...c, lastAnalysisTime: new Date() } : c));

      const payload = { camera_id: camera.id, camera_name: camera.name, alert: newEntry.summary, timestamp: newEntry.timestamp, data: { ...newEntry, raw_ai_data: data } };
      fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(err => console.warn('Internal sync failed:', err));

      if (camera.webhookUrl) {
        fetch('/api/proxy-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: camera.webhookUrl, payload }) })
          .then(res => res.json())
          .then(d => { if (!d.success) console.warn(`[WEBHOOK] Proxy sync reported failure for ${camera.name}:`, d.error); })
          .catch(err => console.warn('External webhook proxy sync failed:', err));
      }

      fetch('/api/sheets/append', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraId: camera.id, cameraName: camera.name, summary: newEntry.summary, timestamp: newEntry.timestamp.toISOString(), counts: newEntry.counts })
      }).catch(err => console.warn('Sheets sync failed:', err));
    } catch (err: unknown) {
      console.warn(`Frame analysis failed for "${camera.name}":`, err);
      setAnalysisErrors(prev => new Map(prev).set(camera.id, err instanceof Error ? err.message : String(err)));
    } finally { finish(); }
  }, [knownFaces, watchlist, user, captureFrameBase64]);

  // One shared 1s tick checks every selected camera's own interval setting
  // rather than juggling a separate setInterval per camera — simpler, and
  // avoids re-deriving N timers whenever the camera list changes.
  useEffect(() => {
    if (!isCapturing) return;
    const tick = () => {
      const now = Date.now();
      for (const id of analysisCameraIds) {
        const camera = camerasRef.current.find(c => c.id === id);
        if (!camera) continue;
        if (camera.serverAnalysis) continue; // the server worker owns this camera's schedule
        // Cameras the guard is handing to the server are skipped from the first tick: the flag only lands a moment
        // later, and analysing here in the meantime produced one duplicate log per camera at activation.
        if (serverAnalysisAvailable && user && user.uid !== 'demo-guest' && canAnalyzeOnServer(camera) && !serverGuardFailedRef.current.has(id)) continue;
        const last = lastAnalysisAttemptRef.current.get(id) || 0;
        const intervalMs = Math.max(5, camera.interval) * 1000;
        if (now - last >= intervalMs) {
          lastAnalysisAttemptRef.current.set(id, now);
          captureAndAnalyzeCamera(camera);
        }
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isCapturing, analysisCameraIds, captureAndAnalyzeCamera, serverAnalysisAvailable, user]);

  const exportData = () => {
    const csvHeader = 'Timestamp,Camera,Summary,People,Vehicles,Other,IsUnusual,Plates,Alerts\n';
    const csvContent = logs.map(log => {
      const summary = `"${log.summary.replace(/"/g, '""')}"`;
      const alerts = `"${log.alerts.join('; ').replace(/"/g, '""')}"`;
      const camName = `"${log.cameraName.replace(/"/g, '""')}"`;
      const plates = `"${(log.detectedPlates || []).join('; ')}"`;
      return `${log.timestamp.toISOString()},${camName},${summary},${log.counts.people},${log.counts.vehicles},${log.counts.other},${log.isUnusual},${plates},${alerts}`;
    }).join('\n');
    const blob = new Blob([csvHeader + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.setAttribute('download', `surveillance_report_${new Date().toISOString()}.csv`);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  // ---------- Registry: add / remove / bulk import / export ----------
  const addCamera = async () => {
    if (!user) return;
    const name = `New Camera ${cameras.length + 1}`;
    if (user.uid === 'demo-guest') {
      const newId = `cam-${Math.random().toString(36).substr(2, 9)}`;
      setCameras(prev => [...prev, { id: newId, ...defaultCameraFields(name), facingMode: 'environment', suspiciousRules: '' }]);
      setActiveCameraId(newId);
      setAuditTrail(prev => [{ id: `local-${newId}`, cameraId: newId, cameraName: name, action: 'create', source: 'manual', performedBy: 'guest', timestamp: new Date() }, ...prev]);
      return;
    }
    try {
      const ref = await addDoc(collection(db, 'cameras'), {
        ...defaultCameraFields(name), facingMode: 'environment', suspiciousRules: '',
        userId: user.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      setActiveCameraId(ref.id);
      logRegistryAudit(ref.id, name, 'create', 'manual');
    } catch (error) { handleFirestoreError(error, OperationType.CREATE, 'cameras'); }
  };

  const removeCamera = async (id: string) => {
    if (cameras.length <= 1 || !user) return;
    const cam = cameras.find(c => c.id === id);
    if (user.uid === 'demo-guest') {
      setCameras(prev => prev.filter(c => c.id !== id));
      if (activeCameraId === id) setActiveCameraId(cameras.find(c => c.id !== id)?.id || cameras[0].id);
      if (cam) setAuditTrail(prev => [{ id: `local-${Date.now()}`, cameraId: id, cameraName: cam.name, action: 'delete', source: 'manual', performedBy: 'guest', timestamp: new Date() }, ...prev]);
      return;
    }
    try {
      await deleteDoc(doc(db, 'cameras', id));
      if (activeCameraId === id) setActiveCameraId(cameras.find(c => c.id !== id)?.id || cameras[0].id);
      if (cam) logRegistryAudit(id, cam.name, 'delete', 'manual');
    } catch (error) { handleFirestoreError(error, OperationType.DELETE, `cameras/${id}`); }
  };

  // Firestore allows 500 operations per batch; each camera costs two (the camera and its audit entry).
  const IMPORT_CHUNK = 200;

  const bulkImportCameras = async (rows: Record<string, string>[]): Promise<ImportSummary | null> => {
    if (!user) return null;
    // Matched by stream URL, so re-importing the same list (or clicking "Onboard grid cameras" twice)
    // never duplicates a camera — and fills in details an earlier import didn't have.
    const plan = planBulkImport(rows, camerasRef.current);
    const summary = summarizePlan(plan);

    const newFields = (row: Record<string, string>): Omit<CameraConfig, 'id'> => {
      const hasRemoteFeed = !!row.remoteStreamUrl?.trim();
      return {
        ...defaultCameraFields(row.name.trim()),
        department: row.department || undefined,
        ownership: row.ownership || undefined,
        cameraType: (row.cameraType as CameraConfig['cameraType']) || undefined,
        connectivityStatus: (row.connectivityStatus as CameraConfig['connectivityStatus']) || 'unknown',
        maintenanceStatus: (row.maintenanceStatus as CameraConfig['maintenanceStatus']) || 'operational',
        installDate: row.installDate || undefined,
        storageDetails: row.storageDetails || undefined,
        // Validated: a blank/NaN/out-of-range coordinate must not be stored as a location.
        location: parseLatLng(row.lat, row.lng),
        // A remoteStreamUrl column onboards a real feed directly; otherwise
        // fall back to the simulated demo feed so the card isn't broken.
        useRemoteFeed: hasRemoteFeed,
        remoteStreamUrl: row.remoteStreamUrl?.trim() || '',
        useSimulatedFeed: !hasRemoteFeed,
        onboardedVia: 'bulk_import',
      };
    };

    if (user.uid === 'demo-guest') {
      const created = plan.create.map(row => ({
        id: `guest-cam-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...newFields(row),
      }));
      const fillById = new Map(plan.update.map(u => [u.id, u.fields]));
      if (created.length > 0 || fillById.size > 0) {
        setCameras(prev => [...prev.map(c => (fillById.has(c.id) ? { ...c, ...fillById.get(c.id) } : c)), ...created]);
        setAuditTrail(prev => [
          ...created.map(c => ({ id: `local-${c.id}`, cameraId: c.id, cameraName: c.name, action: 'create' as const, source: 'bulk_import' as const, performedBy: 'guest', timestamp: new Date() })),
          ...plan.update.map(u => ({ id: `local-${u.id}-${Date.now()}`, cameraId: u.id, cameraName: u.name, action: 'update' as const, source: 'bulk_import' as const, performedBy: 'guest', timestamp: new Date() })),
          ...prev
        ]);
      }
      return summary;
    }

    type Op = { kind: 'create'; ref: DocumentReference; fields: Omit<CameraConfig, 'id'> } | { kind: 'update'; id: string; name: string; fields: Record<string, unknown> };
    const ops: Op[] = [
      ...plan.create.map(row => ({ kind: 'create' as const, ref: doc(collection(db, 'cameras')), fields: newFields(row) })),
      ...plan.update.map(u => ({ kind: 'update' as const, id: u.id, name: u.name, fields: u.fields })),
    ];
    let committed = 0;
    try {
      for (const group of chunk(ops, IMPORT_CHUNK)) {
        const batch = writeBatch(db);
        for (const op of group) {
          const cameraId = op.kind === 'create' ? op.ref.id : op.id;
          const cameraName = op.kind === 'create' ? op.fields.name : op.name;
          if (op.kind === 'create') batch.set(op.ref, { ...op.fields, userId: user.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          else batch.update(doc(db, 'cameras', op.id), { ...op.fields, updatedAt: serverTimestamp() });
          // The audit entry commits atomically with the change it describes.
          batch.set(doc(collection(db, 'registryAudit')), {
            cameraId, cameraName, action: op.kind, source: 'bulk_import', userId: user.uid, performedBy: user.email || user.uid, timestamp: serverTimestamp(),
          });
        }
        await batch.commit();
        committed += group.length;
      }
    } catch (error) {
      console.error('Bulk import batch failed:', error);
      // Report what actually landed rather than the plan.
      const created = Math.min(committed, plan.create.length);
      return { ...summary, created, updated: Math.max(0, committed - plan.create.length) };
    }
    return summary;
  };

  const handleRegistryCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !user) return;
    const text = await file.text();
    const result = await bulkImportCameras(parseCsv(text));
    if (result) {
      setDemoGridStatus({ type: 'live', message: `CSV import: ${describeSummary(result)}` });
      setTimeout(() => setDemoGridStatus(null), 12000);
    }
  };

  // Tries the grid's own live catalogue first (see fetchSentinelCatalogue) —
  // per its integrator guide, hardcoded camera ids/URLs go stale, and
  // demoGridCameras.ts is exactly that. Falls back to the static list only
  // if the live fetch itself fails (network error, unparseable response),
  // so the button still does something useful when the grid — or this
  // sandbox's ability to reach it — is unavailable, rather than going dead.
  const loadDemoGrid = async () => {
    setIsLoadingDemoGrid(true);
    setDemoGridStatus(null);
    let keepStatus = false;
    try {
      const { entries, source } = await fetchSentinelCatalogue(streamAccessPassword, streamAccessEmail);
      const result = await bulkImportCameras(entries.map(c => ({
        name: c.name, remoteStreamUrl: c.remoteStreamUrl,
        connectivityStatus: c.isLive === true ? 'online' : c.isLive === false ? 'offline' : 'unknown',
        lat: c.lat !== undefined ? String(c.lat) : '', lng: c.lng !== undefined ? String(c.lng) : '',
        department: c.department || '',
      })));
      if (source === 'bundled-fallback') {
        // The server couldn't reach the real catalogue and substituted its built-in list — say so,
        // because the live grid may have more cameras than this.
        keepStatus = true;
        setDemoGridStatus({ type: 'fallback', message: `The live grid catalogue couldn't be reached, so the built-in list of ${entries.length} cameras was used instead — the real grid may have more. Check Settings → stream access credentials, then load again. ${result ? describeSummary(result) : ''}` });
      } else {
        setDemoGridStatus({ type: 'live', message: `Catalogue lists ${entries.length} cameras. ${result ? describeSummary(result) : ''}` });
      }
    } catch (err) {
      console.warn('Live Sentinel catalogue fetch failed, falling back to the bundled demo list:', err);
      keepStatus = true;
      const result = await bulkImportCameras(DEMO_GRID_CAMERAS);
      setDemoGridStatus({ type: 'fallback', message: `Couldn't read the grid catalogue, so the built-in list of ${DEMO_GRID_CAMERAS.length} cameras was used instead — the real grid may have more. (Stream access credentials are set in Settings.) ${result ? describeSummary(result) : ''}` });
    } finally {
      setIsLoadingDemoGrid(false);
      // Warnings stay until the next action; only the all-good message fades.
      if (!keepStatus) setTimeout(() => setDemoGridStatus(null), 12000);
    }
  };

  // Turns server-side analysis on/off for every camera that has a remote feed (the only kind a server can capture).
  const setServerAnalysisForAll = async (enabled: boolean) => {
    if (!user) return;
    const targets = camerasRef.current.filter(c => c.useRemoteFeed && c.remoteStreamUrl.trim() && !!c.serverAnalysis !== enabled);
    if (targets.length === 0) return;
    setCameras(prev => prev.map(c => (targets.some(t => t.id === c.id) ? { ...c, serverAnalysis: enabled } : c)));
    if (user.uid === 'demo-guest') return;
    try {
      for (const group of chunk(targets, 400)) {
        const batch = writeBatch(db);
        group.forEach(c => batch.update(doc(db, 'cameras', c.id), { serverAnalysis: enabled, updatedAt: serverTimestamp() }));
        await batch.commit();
      }
    } catch (error) {
      console.error('Could not update server analysis for all cameras:', error);
      setDbError(error instanceof Error ? error.message : String(error));
    }
  };

  // "Activate Guard" also hands the targeted cameras to the server worker (when it is running), so the
  // analysis keeps going without this tab and results land in Firestore. The browser loop skips any camera
  // flagged serverAnalysis, so nothing is analysed twice; if the write fails the flag is reverted and the
  // browser keeps analysing as before. "Pause Guard" (or deselecting a camera) clears the flag again.
  useEffect(() => {
    if (!serverAnalysisAvailable || !user || user.uid === 'demo-guest') return;
    const { enable: toEnable, disable: toDisable } = planGuardSync({
      isCapturing, targetIds: analysisCameraIds, cameras, guardFlaggedIds: serverGuardIdsRef.current,
      failedIds: serverGuardFailedRef.current, wasCapturing: guardWasOnRef.current,
    });
    if (!isCapturing) serverGuardFailedRef.current.clear();
    guardWasOnRef.current = isCapturing;
    if (toEnable.length === 0 && toDisable.length === 0) return;

    const setLocal = (ids: string[], value: boolean) => setCameras(prev => prev.map(c => (ids.includes(c.id) ? { ...c, serverAnalysis: value } : c)));
    const write = async (ids: string[], value: boolean) => {
      if (ids.length === 0) return;
      setLocal(ids, value);
      try {
        for (const group of chunk(ids, 400)) {
          const batch = writeBatch(db);
          group.forEach(id => batch.update(doc(db, 'cameras', id), { serverAnalysis: value, updatedAt: serverTimestamp() }));
          await batch.commit();
        }
        ids.forEach(id => { if (value) serverGuardIdsRef.current.add(id); else serverGuardIdsRef.current.delete(id); });
      } catch (error) {
        console.error('Could not update server analysis for the guard:', error);
        setLocal(ids, !value); // fall back to the previous behaviour for these cameras
        // Do not retry in a loop: a failed enable waits for the next Activate, a failed release is reported once.
        ids.forEach(id => { if (value) serverGuardFailedRef.current.add(id); else serverGuardIdsRef.current.delete(id); });
        setDbError(error instanceof Error ? error.message : String(error));
      }
    };
    void write(toEnable, true);
    void write(toDisable, false);
  }, [isCapturing, analysisCameraIds, cameras, serverAnalysisAvailable, user]);

  const exportRegistryCsv = () => {
    const rows = cameras.map(c => ({
      id: c.id, name: c.name, department: c.department || '', ownership: c.ownership || '',
      cameraType: c.cameraType || '', connectivityStatus: c.connectivityStatus || 'unknown',
      maintenanceStatus: c.maintenanceStatus || '', installDate: c.installDate || '',
      storageDetails: c.storageDetails || '', lat: c.location?.lat ?? '', lng: c.location?.lng ?? '',
      onboardedVia: c.onboardedVia || 'manual'
    }));
    downloadCsv(`camera_registry_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, REGISTRY_CSV_COLUMNS));
  };

  const testWebhook = async () => {
    if (!activeCamera.webhookUrl) return;
    setWebhookStatus('testing');
    try {
      const response = await fetch('/api/proxy-webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: activeCamera.webhookUrl, payload: { type: 'test', camera_id: activeCamera.id, camera_name: activeCamera.name, message: 'OmniSee Pro Webhook Test', timestamp: new Date().toISOString() } })
      });
      const data = await response.json();
      setWebhookStatus(response.ok && data.success ? 'success' : 'error');
    } catch { setWebhookStatus('error'); }
    setTimeout(() => setWebhookStatus('idle'), 3000);
  };

  const handleShowRoute = (plate: string, points: RoutePoint[]) => { setRoutePlate(plate); setRoutePoints(points); setActiveTab('map'); };
  const clearRoute = () => { setRoutePlate(null); setRoutePoints([]); };

  // Guest mode has no database, so its sightings are derived from the in-memory event log.
  const guestSightings = useMemo<PlateSighting[]>(() => {
    if (user && user.uid !== 'demo-guest') return [];
    return logs.flatMap(l => (l.detectedPlates || []).map(plate => {
      const cam = cameras.find(c => c.id === l.cameraId);
      return {
        id: `${l.id}_${plate}`, plate: plate.toUpperCase().replace(/[^A-Z0-9]/g, ''), cameraId: l.cameraId, cameraName: l.cameraName,
        department: cam?.department, location: cam?.location, timestamp: l.timestamp, confidence: null, source: 'gemini' as const,
      };
    }));
  }, [user, logs, cameras]);

  const gapReport = useMemo(() => computeGapAnalysis(cameras), [cameras]);

  // Tailwind's @theme aliases (e.g. --color-surface: var(--surface)) are
  // resolved once at :root — overriding --surface on a descendant element
  // never propagates back through that alias, so data-theme has to live on
  // <html> itself (as index.css's own comment says) for dark mode to
  // actually repaint anything, not just on this component's root div.
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  const handleSelectCameraFromRegistry = (id: string) => { setActiveCameraId(id); setActiveTab('monitor'); };
  const handleJumpToSetup = () => setActiveTab('settings');

  return (
    <div data-theme={theme} className="min-h-screen font-sans transition-colors duration-200 overflow-x-hidden bg-surface text-ink">
      <AnimatePresence mode="wait">
        {authLoading ? (
          <div className="fixed inset-0 bg-surface flex items-center justify-center">
            <RefreshCw className="w-7 h-7 text-accent animate-spin" strokeWidth={1.75} />
          </div>
        ) : showOnboarding ? (
          <OnboardingScreen onComplete={handleCompleteOnboarding} />
        ) : !isAuthenticated ? (
          <AuthScreen loginError={loginError} isSigningIn={isSigningIn} onGoogleLogin={handleGoogleLogin} onGuestBypass={handleGuestBypass} />
        ) : (
          <div className="flex flex-col lg:flex-row min-h-screen">
            <Sidebar activeTab={activeTab} onChangeTab={setActiveTab} onLogout={handleLogout} />

            {/* pb-16 reserves space for the fixed MobileNav bar (h-16) below
                lg — without it, the footer's last ~64px scrolls in underneath
                the nav instead of stopping above it. */}
            <div className="lg:pl-24 min-h-screen flex flex-col w-full pb-16 lg:pb-0">
              <Header
                isCapturing={isCapturing} onToggleCapturing={() => setIsCapturing(!isCapturing)} user={user} onLogout={handleLogout}
                camerasLive={camerasLive}
                camerasTotal={cameras.length}
                alertsToday={logs.filter(l => l.alerts.length > 0 && l.timestamp.toDateString() === new Date().toDateString()).length}
                geminiHealthy={analysisErrors.size === 0}
                onOpenSearch={() => setIsCommandPaletteOpen(true)}
                theme={theme}
                onToggleTheme={handleToggleTheme}
                guardScope={guardScope}
                onChangeGuardScope={setGuardScope}
              />

              <main className="flex-1 p-6 lg:p-10">
                {isOfflineMode && (
                  <div className="mb-6 card border-warning/30 p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-warning-soft flex items-center justify-center text-warning shrink-0">
                        <RefreshCw className="w-4 h-4" strokeWidth={1.75} />
                      </div>
                      <div>
                        <h3 className="text-xs font-bold text-warning">Local backup active (offline mode)</h3>
                        <p className="text-[11px] text-ink-muted mt-0.5">Your settings are cached locally and will sync once the connection returns.</p>
                        {dbError && <div className="mt-2 text-[10px] font-mono text-warning bg-surface-muted px-3 py-1.5 rounded-lg break-all">{dbError}</div>}
                      </div>
                    </div>
                    <button onClick={handleSaveSettings} className="btn-secondary !py-2 text-[10px] shrink-0"><RefreshCw className="w-3 h-3" strokeWidth={1.75} /> Force sync</button>
                  </div>
                )}

                {/* Kept mounted (CSS-hidden, not unmounted) even off-tab: MonitorTab owns
                    the live HLS connection via CameraFeed, and the background capture/
                    analysis loop reads frames from its video ref. Unmounting on every tab
                    switch used to kill the stream, forcing a full reconnect (and a blank
                    frame being sent to Gemini) whenever the user came back. */}
                <div className={activeTab === 'monitor' ? '' : 'hidden'}>
                  <MonitorTab
                    cameras={cameras} activeCameraId={activeCameraId} onSelectCamera={setActiveCameraId}
                    onAddCamera={addCamera} isCapturing={isCapturing}
                    cameraError={cameraError} analysisError={analysisError} logs={logs}
                    viewMode={viewMode} onChangeViewMode={setViewMode} containerRef={containerRef}
                    isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen}
                    onToggleCameraFacing={toggleCameraFacing} mediaRefs={mediaRefs}
                    onCameraError={setCameraError} onFallbackToSimulated={handleFallbackToSimulated}
                    onChangeTab={setActiveTab} streamAccessPassword={streamAccessPassword} streamAccessEmail={streamAccessEmail}
                    analysisCameraIds={analysisCameraIds} analyzingCameraIds={analyzingCameraIds}
                    onToggleAnalysisCamera={toggleAnalysisCamera} onJumpToLog={handleJumpToLog}
                    onCameraStatusChange={handleCameraStatusChange}
                    tracking={tracking} panelOpenCameraId={panelOpenCameraId} panelAlert={panelAlert}
                    onPanelOpenCamera={(id) => { setPanelOpenCameraId(id); setPanelAlert((p) => (p && p.cameraId === id ? p : null)); }}
                    onPanelCloseCamera={() => { setPanelOpenCameraId(null); setPanelAlert(null); }}
                  />
                </div>
                <AnimatePresence mode="wait">
                  {activeTab === 'analytics' && (
                    <AnalyticsTab logs={logs} onChangeTab={setActiveTab} onExport={exportData} onShowRoute={handleShowRoute} activeRoutePlate={routePlate} userId={user && user.uid !== 'demo-guest' ? user.uid : null} decidedBy={user?.email || user?.uid || 'unknown'} localSightings={guestSightings} highlightLogId={highlightLogId} onHighlightHandled={() => setHighlightLogId(null)} />
                  )}
                  {activeTab === 'map' && (
                    <RegistryTab
                      cameras={cameras} activeCameraId={activeCameraId} onSelectCamera={handleSelectCameraFromRegistry}
                      routePlate={routePlate} routePoints={routePoints} onClearRoute={clearRoute}
                      isAdmin={isAdmin} onAddCamera={() => { addCamera(); handleJumpToSetup(); }}
                      onRemoveCamera={removeCamera} onCsvUpload={handleRegistryCsvUpload} onExportCsv={exportRegistryCsv}
                      onLoadDemoGrid={loadDemoGrid} isLoadingDemoGrid={isLoadingDemoGrid} demoGridStatus={demoGridStatus} onDismissDemoGridStatus={() => setDemoGridStatus(null)}
                      serverAnalysisAvailable={serverAnalysisAvailable} onSetServerAnalysisAll={setServerAnalysisForAll}
                      gapReport={gapReport} auditTrail={auditTrail}
                    />
                  )}
                  {activeTab === 'settings' && (
                    <SettingsTab
                      theme={theme} onToggleTheme={handleToggleTheme} notificationPrefs={notificationPrefs} onUpdateNotifyPrefs={updateNotifyPrefs}
                      user={user} onSaveSettings={handleSaveSettings} isSaveLoading={isSaveLoading} saveSuccess={saveSuccess}
                      googleSheetsId={googleSheetsId} onChangeGoogleSheetsId={setGoogleSheetsId}
                      streamAccessPassword={streamAccessPassword} onChangeStreamAccessPassword={setStreamAccessPassword}
                      streamAccessEmail={streamAccessEmail} onChangeStreamAccessEmail={setStreamAccessEmail}
                      cameras={cameras} activeCameraId={activeCameraId} onSelectCamera={setActiveCameraId}
                      onAddCamera={addCamera} onRemoveCamera={removeCamera} onUpdateActiveCamera={updateActiveCamera}
                      onOpenSetupGuides={() => setShowDVRGuide(true)} webhookStatus={webhookStatus} onTestWebhook={testWebhook}
                      knownFaces={knownFaces} onFaceUpload={handleFaceUpload} onRemoveFace={removeKnownFace}
                      watchlist={watchlist} onAddWatchlistEntry={addWatchlistEntry} onRemoveWatchlistEntry={removeWatchlistEntry}
                      userDepartment={userDepartment} userRole={userRole} onUpdateUserProfile={updateUserProfile} isAdmin={isAdmin}
                    />
                  )}
                  {activeTab === 'guide' && <GuideTab />}
                </AnimatePresence>
              </main>

              <footer className="mt-auto border-t border-border px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-ink-muted">
                <p className="text-[10px] uppercase tracking-[0.14em] font-semibold">Frame analysis runs server-side — never in your browser</p>
                <p className="text-[10px] font-semibold">OmniSee Pro</p>
              </footer>
            </div>

            <DvrGuideModal
              isOpen={showDVRGuide} selectedGuideId={selectedGuideId}
              onSelectGuide={(id) => { setSelectedGuideId(id); setShowDVRGuide(false); }}
              onShowGeneral={() => { setShowDVRGuide(true); setSelectedGuideId(null); }}
              onClose={() => { setShowDVRGuide(false); setSelectedGuideId(null); }}
            />

            <ChatWidget
              isOpen={isChatOpen} onToggle={() => setIsChatOpen(!isChatOpen)} messages={chatMessages}
              input={chatInput} onInputChange={setChatInput} isSending={isChatSending} onSend={handleSendChat}
            />

            <CommandPalette
              isOpen={isCommandPaletteOpen} onClose={() => setIsCommandPaletteOpen(false)}
              cameras={cameras} logs={logs}
              onSelectCamera={handleSelectCameraFromRegistry} onJumpToLog={handleJumpToLog} onChangeTab={setActiveTab}
            />

            <IncidentAlertDrawer
              logs={logs}
              activeTab={activeTab}
              notificationPrefs={notificationPrefs}
              onSelectCamera={(id) => { setActiveCameraId(id); setActiveTab('monitor'); }}
              onJumpToLog={handleJumpToLog}
              onChangeTab={setActiveTab}
            />

            <TrackingAlertBanner
              alert={bannerAlert}
              onOpen={(a) => focusAlert(a)} onDismiss={() => setBannerAlert(null)}
            />

            <MobileNav activeTab={activeTab} onChangeTab={setActiveTab} />
            {showFirstUseTour && <FirstUseTour onDismiss={handleDismissFirstUseTour} />}
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
