import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { AnimatePresence } from 'motion/react';

import { auth, db, googleProvider } from './lib/firebase';
import { signInWithPopup, onAuthStateChanged, signOut, User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, collection, addDoc, onSnapshot, serverTimestamp, deleteDoc, query, where, writeBatch } from 'firebase/firestore';

import { CameraConfig, LogEntry, KnownFace, NotificationPrefs, UserPreferences, WatchlistEntry, RegistryAuditEntry, TabId, CameraMediaRefs } from './types';
import { detectStreamType, buildSnapshotUrl } from './lib/streamAdapters';
import { parseCsv, toCsv, downloadCsv } from './lib/csv';
import { computeGapAnalysis } from './lib/registryReport';

import OnboardingScreen from './components/OnboardingScreen';
import AuthScreen from './components/AuthScreen';
import Sidebar from './components/Sidebar';
import MobileNav from './components/MobileNav';
import Header from './components/Header';
import MonitorTab from './components/MonitorTab';
import AnalyticsTab from './components/AnalyticsTab';
import SettingsTab from './components/SettingsTab';
import RegistryTab from './components/RegistryTab';
import GuideTab from './components/GuideTab';
import ChatWidget from './components/ChatWidget';
import DvrGuideModal from './components/DvrGuideModal';

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
    suspiciousRules: 'Any unknown person approaching the door', useSimulatedFeed: false,
    connectivityStatus: 'unknown', maintenanceStatus: 'operational', onboardedVia: 'manual'
  };
}
function createDefaultCamera(id: string, name: string): CameraConfig {
  return { id, ...defaultCameraFields(name) };
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
  const [viewMode, setViewMode] = useState<'focus' | 'grid'>('focus');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [webhookStatus, setWebhookStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [showDVRGuide, setShowDVRGuide] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [googleSheetsId, setGoogleSheetsId] = useState<string>('');
  const [isSaveLoading, setIsSaveLoading] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean | null>(null);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [userDepartment, setUserDepartment] = useState('');
  const [userRole, setUserRole] = useState<'operator' | 'admin'>('admin');
  const [routePlate, setRoutePlate] = useState<string | null>(null);

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isChatSending, setIsChatSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'model'; text: string }>>([
    { role: 'model', text: 'Hello! I am your OmniSee security co-pilot. I have analyzed your vision event log and can answer queries about people, vehicles, and custom alerts. What would you like to review?' }
  ]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const captureTimerRef = useRef<NodeJS.Timeout | null>(null);
  const mediaRefs = useRef<CameraMediaRefs>({ video: null, img: null, canvas: null });

  const activeCamera = cameras.find(c => c.id === activeCameraId) || cameras[0];
  const isAdmin = userRole === 'admin';

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

  // ---------- Auth + user preferences ----------
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setAuthLoading(false);
      if (firebaseUser) {
        setUser(firebaseUser);
        setIsAuthenticated(true);
        try {
          const userDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (userDoc.exists()) {
            const data = userDoc.data() as UserPreferences;
            setTheme(data.theme || 'light');
            if (data.notificationPrefs) setNotificationPrefs(data.notificationPrefs);
            setGoogleSheetsId(data.googleSheetsId || '');
            setUserDepartment(data.department || '');
            setUserRole(data.role || 'admin');
            localStorage.setItem(`user-${firebaseUser.uid}-googleSheetsId`, data.googleSheetsId || '');
            if (data.notificationPrefs) localStorage.setItem(`user-${firebaseUser.uid}-notificationPrefs`, JSON.stringify(data.notificationPrefs));
            setIsOfflineMode(false);
            setDbError(null);
          } else {
            try {
              await setDoc(doc(db, 'users', firebaseUser.uid), {
                theme: 'light', notificationPrefs: DEFAULT_NOTIFICATION_PREFS, googleSheetsId: '',
                department: '', role: 'admin', updatedAt: serverTimestamp()
              });
              const seedRef = await addDoc(collection(db, 'cameras'), {
                ...defaultCameraFields('Main Entrance'), userId: firebaseUser.uid,
                createdAt: serverTimestamp(), updatedAt: serverTimestamp()
              });
              await addDoc(collection(db, 'registryAudit'), {
                cameraId: seedRef.id, cameraName: 'Main Entrance', action: 'create', source: 'manual',
                userId: firebaseUser.uid, performedBy: firebaseUser.email || firebaseUser.uid, timestamp: serverTimestamp()
              });
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
              const parsed = JSON.parse(localCams);
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
        setTheme('light');
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
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'faces'));
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
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'watchlist'));
    return () => unsub();
  }, [user]);

  // ---------- Camera registry (Model 1 — central registry, mandatory foundation) ----------
  useEffect(() => {
    if (!user || user.uid === 'demo-guest') return;
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
          lastAnalysisTime: data.lastAnalysisTime?.toDate ? data.lastAnalysisTime.toDate() : data.lastAnalysisTime,
          location: data.location, department: data.department, ownership: data.ownership,
          cameraType: data.cameraType, connectivityStatus: data.connectivityStatus || 'unknown',
          maintenanceStatus: data.maintenanceStatus || 'operational', installDate: data.installDate,
          storageDetails: data.storageDetails, onboardedVia: data.onboardedVia || 'manual',
        });
      });
      if (cams.length > 0) {
        setCameras(cams);
        if (!cams.find(c => c.id === activeCameraId)) setActiveCameraId(cams[0].id);
      }
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'cameras'));
    return () => unsub();
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
    const guestCams = localStorage.getItem('demo-guest-cameras');
    if (guestCams) {
      try {
        const parsed = JSON.parse(guestCams);
        if (Array.isArray(parsed) && parsed.length > 0) { setCameras(parsed); setActiveCameraId(parsed[0].id); }
      } catch (e) { console.error(e); }
    }
    const guestPrefs = localStorage.getItem('demo-guest-notificationPrefs');
    if (guestPrefs) { try { setNotificationPrefs(JSON.parse(guestPrefs)); } catch (e) { console.error(e); } }
    setIsAuthenticated(true);
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
      setTimeout(() => { setIsSaveLoading(false); setSaveSuccess(true); setIsOfflineMode(true); setTimeout(() => setSaveSuccess(null), 3000); }, 600);
      return;
    }

    try {
      await setDoc(doc(db, 'users', user.uid), {
        theme, notificationPrefs, googleSheetsId, department: userDepartment, role: userRole, updatedAt: serverTimestamp()
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
      const response = await fetch('/api/gemini/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userMsg, history: chatMessages.slice(-15),
          cameraLogs: logs.slice(0, 20).map(l => ({ cameraName: l.cameraName, summary: l.summary, timestamp: l.timestamp, counts: l.counts }))
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
  const handleFallbackToSimulated = useCallback(() => updateActiveCamera({ useSimulatedFeed: true, useRemoteFeed: false }), [updateActiveCamera]);

  // ---------- Frame capture + analysis ----------
  const captureAndAnalyze = useCallback(async () => {
    const isSimulated = !!activeCamera.useSimulatedFeed;
    const isRemote = !!activeCamera.useRemoteFeed && !!activeCamera.remoteStreamUrl;
    const streamType = isRemote ? detectStreamType(activeCamera.remoteStreamUrl) : null;

    if (!canvasRef.current || isAnalyzing) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    const canvas = canvasRef.current;

    const MAX_DIMENSION = 1024;
    let width = 640, height = 360;
    const refs = mediaRefs.current;

    if (isSimulated) { width = refs.canvas?.width || 640; height = refs.canvas?.height || 360; }
    else if (isRemote && streamType === 'video') { width = refs.video?.videoWidth || 640; height = refs.video?.videoHeight || 360; }
    else if (isRemote && streamType === 'image') { width = refs.img?.naturalWidth || 640; height = refs.img?.naturalHeight || 360; }
    else if (!isRemote) { width = refs.video?.videoWidth || 640; height = refs.video?.videoHeight || 360; }

    if (width === 0 || height === 0) { width = 640; height = 360; }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      width *= ratio; height *= ratio;
    }
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setIsAnalyzing(false); return; }

    try {
      if (isSimulated) {
        if (!refs.canvas) throw new Error('Simulated feed is not ready yet.');
        ctx.drawImage(refs.canvas, 0, 0, width, height);
      } else if (isRemote) {
        if (streamType === 'video' && refs.video) ctx.drawImage(refs.video, 0, 0, width, height);
        else if (streamType === 'image' && refs.img) ctx.drawImage(refs.img, 0, 0, width, height);
        else if (streamType === 'iframe') {
          const snapshotImgUrl = buildSnapshotUrl(activeCamera.remoteStreamUrl);
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
      if (!base64Image) { setIsAnalyzing(false); return; }

      const analyzeResponse = await fetch('/api/gemini/analyze-frame', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64Image,
          knownFaces: knownFaces.slice(0, 6).map(f => ({ name: f.name, imageData: f.imageData })),
          watchlist: watchlist.map(w => w.plate),
          camera: {
            name: activeCamera.name, sensitivity: activeCamera.sensitivity,
            peopleThreshold: activeCamera.peopleThreshold, vehicleThreshold: activeCamera.vehicleThreshold,
            suspiciousRules: activeCamera.suspiciousRules
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

      const summaryWithExtra = `${data.summary}${data.brands?.length ? ` Detected brands: ${data.brands.join(', ')}.` : ''} People: ${data.people_identified?.join(', ') || 'N/A'}`;
      const alerts: string[] = [...(data.alerts || [])];
      if (isWatchlistMatch) alerts.unshift(`Watchlist match: ${watchlistMatches.join(', ')}`);

      const newEntry: LogEntry = {
        id: Math.random().toString(36).substr(2, 9), cameraId: activeCamera.id, cameraName: activeCamera.name, timestamp: new Date(),
        summary: summaryWithExtra, counts: data.counts || { people: 0, vehicles: 0, other: 0 },
        isUnusual: isWatchlistMatch || data.isUnusual || (data.people_identified?.includes('Unknown Person') && activeCamera.sensitivity > 3),
        unusualReason: data.isUnusualReason || (data.people_identified?.includes('Unknown Person') ? 'Unknown identity detected near camera' : undefined),
        alerts, detectedPlates, isWatchlistMatch
      };

      if (!user || user.uid === 'demo-guest') {
        setLogs(prev => [newEntry, ...prev].slice(0, 100));
      } else {
        addDoc(collection(db, 'logs'), {
          cameraId: activeCamera.id, cameraName: activeCamera.name, summary: summaryWithExtra,
          detectedItems: data.people_identified || [], timestamp: new Date(), userId: user.uid,
          counts: data.counts || { people: 0, vehicles: 0, other: 0 }, isUnusual: newEntry.isUnusual,
          unusualReason: newEntry.unusualReason || '', alerts, detectedPlates, isWatchlistMatch
        }).catch(err => { console.error('Firestore log write failed, falling back to local state:', err); setLogs(prev => [newEntry, ...prev].slice(0, 100)); });
      }

      setCameras(prev => prev.map(c => c.id === activeCamera.id ? { ...c, lastAnalysisTime: new Date() } : c));

      const payload = { camera_id: activeCamera.id, camera_name: activeCamera.name, alert: newEntry.summary, timestamp: newEntry.timestamp, data: { ...newEntry, raw_ai_data: data } };
      fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(err => console.error('Internal sync failed:', err));

      if (activeCamera.webhookUrl) {
        fetch('/api/proxy-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: activeCamera.webhookUrl, payload }) })
          .then(res => res.json())
          .then(d => { if (!d.success) console.error(`[WEBHOOK] Proxy sync reported failure for ${activeCamera.name}:`, d.error); })
          .catch(err => console.error('External webhook proxy sync failed:', err));
      }

      fetch('/api/sheets/append', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraId: activeCamera.id, cameraName: activeCamera.name, summary: newEntry.summary, timestamp: newEntry.timestamp.toISOString(), counts: newEntry.counts })
      }).catch(err => console.error('Sheets sync failed:', err));
    } catch (err: unknown) {
      console.error('Frame analysis failed:', err);
      setAnalysisError(err instanceof Error ? err.message : String(err));
    } finally { setIsAnalyzing(false); }
  }, [activeCamera, isAnalyzing, knownFaces, watchlist, user]);

  useEffect(() => {
    if (isCapturing) {
      captureAndAnalyze();
      captureTimerRef.current = setInterval(captureAndAnalyze, activeCamera.interval * 1000);
    } else if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    return () => { if (captureTimerRef.current) clearInterval(captureTimerRef.current); };
  }, [isCapturing, captureAndAnalyze, activeCamera.interval]);

  const exportData = () => {
    const csvHeader = 'Timestamp,Node,Summary,People,Vehicles,Other,IsUnusual,Plates,Alerts\n';
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

  const bulkImportCameras = async (rows: Record<string, string>[]) => {
    if (!user) return;
    const valid = rows.filter(r => r.name?.trim());
    const localCreated: CameraConfig[] = [];
    for (const row of valid) {
      const fields: Omit<CameraConfig, 'id'> = {
        ...defaultCameraFields(row.name.trim()),
        department: row.department || undefined,
        ownership: row.ownership || undefined,
        cameraType: (row.cameraType as CameraConfig['cameraType']) || undefined,
        connectivityStatus: (row.connectivityStatus as CameraConfig['connectivityStatus']) || 'unknown',
        maintenanceStatus: (row.maintenanceStatus as CameraConfig['maintenanceStatus']) || 'operational',
        installDate: row.installDate || undefined,
        storageDetails: row.storageDetails || undefined,
        location: row.lat && row.lng ? { lat: parseFloat(row.lat), lng: parseFloat(row.lng) } : undefined,
        useSimulatedFeed: true,
        onboardedVia: 'bulk_import',
      };
      if (user.uid === 'demo-guest') {
        const id = `guest-cam-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        localCreated.push({ id, ...fields });
      } else {
        try {
          const ref = await addDoc(collection(db, 'cameras'), { ...fields, userId: user.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
          await logRegistryAudit(ref.id, fields.name, 'create', 'bulk_import');
        } catch (error) { console.error(`Bulk import failed for row "${row.name}":`, error); }
      }
    }
    if (user.uid === 'demo-guest' && localCreated.length > 0) {
      setCameras(prev => [...prev, ...localCreated]);
      setAuditTrail(prev => [
        ...localCreated.map(c => ({ id: `local-${c.id}`, cameraId: c.id, cameraName: c.name, action: 'create' as const, source: 'bulk_import' as const, performedBy: 'guest', timestamp: new Date() })),
        ...prev
      ]);
    }
  };

  const handleRegistryCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !user) return;
    const text = await file.text();
    await bulkImportCameras(parseCsv(text));
  };

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

  const handleShowRoute = (plate: string) => { setRoutePlate(plate); setActiveTab('map'); };

  const routePoints = useMemo(() => {
    if (!routePlate) return [];
    return logs
      .filter(l => l.detectedPlates?.some(p => p.toUpperCase() === routePlate))
      .map(l => {
        const cam = cameras.find(c => c.id === l.cameraId);
        return cam?.location ? { lat: cam.location.lat, lng: cam.location.lng, label: l.cameraName, timestamp: l.timestamp } : null;
      })
      .filter((p): p is { lat: number; lng: number; label: string; timestamp: Date } => p !== null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }, [routePlate, logs, cameras]);

  const gapReport = useMemo(() => computeGapAnalysis(cameras), [cameras]);

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
          <div className="flex flex-col lg:flex-row h-screen">
            <canvas ref={canvasRef} className="hidden" />
            <Sidebar activeTab={activeTab} onChangeTab={setActiveTab} onLogout={handleLogout} />

            <div className="lg:pl-20 min-h-screen flex flex-col w-full">
              <Header isCapturing={isCapturing} onToggleCapturing={() => setIsCapturing(!isCapturing)} user={user} onLogout={handleLogout} />

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

                <AnimatePresence mode="wait">
                  {activeTab === 'monitor' && (
                    <MonitorTab
                      cameras={cameras} activeCameraId={activeCameraId} onSelectCamera={setActiveCameraId}
                      onAddCamera={addCamera} isCapturing={isCapturing} isAnalyzing={isAnalyzing}
                      cameraError={cameraError} analysisError={analysisError} logs={logs}
                      viewMode={viewMode} onChangeViewMode={setViewMode} containerRef={containerRef}
                      isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen}
                      onToggleCameraFacing={toggleCameraFacing} mediaRefs={mediaRefs}
                      onCameraError={setCameraError} onFallbackToSimulated={handleFallbackToSimulated}
                      onChangeTab={setActiveTab}
                    />
                  )}
                  {activeTab === 'analytics' && (
                    <AnalyticsTab logs={logs} onChangeTab={setActiveTab} onExport={exportData} onShowRoute={handleShowRoute} activeRoutePlate={routePlate} />
                  )}
                  {activeTab === 'map' && (
                    <RegistryTab
                      cameras={cameras} activeCameraId={activeCameraId} onSelectCamera={handleSelectCameraFromRegistry}
                      routePlate={routePlate} routePoints={routePoints} onClearRoute={() => setRoutePlate(null)}
                      isAdmin={isAdmin} onAddCamera={() => { addCamera(); handleJumpToSetup(); }}
                      onRemoveCamera={removeCamera} onCsvUpload={handleRegistryCsvUpload} onExportCsv={exportRegistryCsv}
                      gapReport={gapReport} auditTrail={auditTrail}
                    />
                  )}
                  {activeTab === 'settings' && (
                    <SettingsTab
                      theme={theme} onToggleTheme={handleToggleTheme} notificationPrefs={notificationPrefs} onUpdateNotifyPrefs={updateNotifyPrefs}
                      user={user} onSaveSettings={handleSaveSettings} isSaveLoading={isSaveLoading} saveSuccess={saveSuccess}
                      googleSheetsId={googleSheetsId} onChangeGoogleSheetsId={setGoogleSheetsId}
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

              <footer className="mt-auto border-t border-border p-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-ink-muted">
                <p className="text-[10px] uppercase tracking-[0.14em] font-semibold">Frame analysis runs server-side</p>
                <p className="text-[10px] font-mono">NODE_UID: {user?.uid?.slice(0, 8) || '—'}</p>
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

            <MobileNav activeTab={activeTab} onChangeTab={setActiveTab} />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
