import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Settings2, Eye, AlertTriangle, Activity, Clock, FolderHeart, ExternalLink, BarChart2,
  Camera, HelpCircle, Plus, Trash2, Settings, ShieldCheck, Users, Truck, RefreshCw, Check,
  Save, MapPin, Building2, ScanLine, ShieldAlert, KeyRound, EyeOff, ChevronDown, ChevronRight, Search
} from 'lucide-react';
import { cn } from '../lib/utils';
import AdminUsersPanel from './AdminUsersPanel';
import FederationPanel from './FederationPanel';
import AllDepartmentsPanel from './AllDepartmentsPanel';
import ZoneLineEditor from './ZoneLineEditor';
import AddCameraDialog from './AddCameraDialog';
import { localWatchProblems } from '../lib/localWatch';
import { CameraConfig, KnownFace, NotificationPrefs, WatchlistEntry } from '../types';
import { User as FirebaseUser } from 'firebase/auth';

interface SettingsTabProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  notificationPrefs: NotificationPrefs;
  onUpdateNotifyPrefs: (prefs: Partial<NotificationPrefs>) => void;
  user: FirebaseUser | null;
  onSaveSettings: () => void;
  isSaveLoading: boolean;
  saveSuccess: boolean | null;
  googleSheetsId: string;
  onChangeGoogleSheetsId: (v: string) => void;
  streamAccessPassword: string;
  onChangeStreamAccessPassword: (v: string) => void;
  streamAccessEmail: string;
  onChangeStreamAccessEmail: (v: string) => void;
  cameras: CameraConfig[];
  activeCameraId: string;
  onSelectCamera: (id: string) => void;
  onAddCamera: () => void;
  /** Creates a camera with the fields the Add camera form collected. */
  onCreateCamera: (fields: Partial<CameraConfig>) => void;
  onRemoveCamera: (id: string) => void;
  onUpdateActiveCamera: (updates: Partial<CameraConfig>) => void;
  onOpenSetupGuides: () => void;
  webhookStatus: 'idle' | 'testing' | 'success' | 'error';
  onTestWebhook: () => void;
  knownFaces: KnownFace[];
  onFaceUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveFace: (id: string) => void;
  watchlist: WatchlistEntry[];
  onAddWatchlistEntry: (plate: string, reason: string) => void;
  onRemoveWatchlistEntry: (id: string) => void;
  /** The department new faces / plates are saved for (everyone in it sees them), when there is one. */
  faceDepartment?: string;
  watchDepartment?: string;
  userDepartment: string;
  userRole: 'viewer' | 'operator' | 'admin';
  onUpdateUserProfile: (updates: { department?: string; role?: 'operator' | 'admin' }) => void;
  isAdmin: boolean;
}

export default function SettingsTab(props: SettingsTabProps) {
  const {
    theme, onToggleTheme, notificationPrefs, onUpdateNotifyPrefs, user, onSaveSettings,
    isSaveLoading, saveSuccess, googleSheetsId, onChangeGoogleSheetsId,
    streamAccessPassword, onChangeStreamAccessPassword, streamAccessEmail, onChangeStreamAccessEmail, cameras, activeCameraId,
    onSelectCamera, onCreateCamera, onRemoveCamera, onUpdateActiveCamera, onOpenSetupGuides,
    webhookStatus, onTestWebhook, knownFaces, onFaceUpload, onRemoveFace,
    watchlist, onAddWatchlistEntry, onRemoveWatchlistEntry, faceDepartment, watchDepartment,
    userDepartment, userRole, onUpdateUserProfile, isAdmin
  } = props;

  const activeCamera = cameras.find(c => c.id === activeCameraId) || cameras[0];
  const [showStreamPassword, setShowStreamPassword] = useState(false);
  // The camera list: a search, 15 to a page (as in the Registry), and each camera is a row that opens to its configuration.
  const [camSearch, setCamSearch] = useState('');
  const [camPage, setCamPage] = useState(0);
  const [openCameraId, setOpenCameraId] = useState<string | null>(null);
  const CAMERA_PAGE_SIZE = 15;
  const filteredCams = (() => {
    const q = camSearch.trim().toLowerCase();
    return q ? cameras.filter((c) => `${c.name} ${c.department || ''} ${c.id}`.toLowerCase().includes(q)) : cameras;
  })();
  const camPages = Math.max(1, Math.ceil(filteredCams.length / CAMERA_PAGE_SIZE));
  const camPageClamped = Math.min(camPage, camPages - 1);
  const pageCams = filteredCams.slice(camPageClamped * CAMERA_PAGE_SIZE, (camPageClamped + 1) * CAMERA_PAGE_SIZE);
  const toggleCamera = (id: string) => {
    if (openCameraId === id && activeCameraId === id) { setOpenCameraId(null); return; }
    onSelectCamera(id); setOpenCameraId(id);
  };
  // "Add camera" creates the camera at the end of the fleet, usually on another page and collapsed, so nothing seemed to happen: once it appears, clear the search, go to its page and open it.
  const idsBeforeAdd = useRef<Set<string> | null>(null);
  const [showAddCamera, setShowAddCamera] = useState(false);
  const rememberCameras = () => { idsBeforeAdd.current = new Set(cameras.map((c) => c.id)); };
  useEffect(() => {
    const before = idsBeforeAdd.current;
    if (!before) return;
    const added = cameras.find((c) => !before.has(c.id));
    if (!added) return;
    idsBeforeAdd.current = null;
    setCamSearch('');
    setCamPage(Math.floor(cameras.findIndex((c) => c.id === added.id) / CAMERA_PAGE_SIZE));
    onSelectCamera(added.id);
    setOpenCameraId(added.id);
    setTimeout(() => document.getElementById(`camera-config-${added.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
  }, [cameras]);
  // The toggle only means something if the server's analysis worker is running.
  const [serverAnalysisAvailable, setServerAnalysisAvailable] = useState(false);
  const [analysisKnown, setAnalysisKnown] = useState(false); // so the zone editor does not say "not running" before the server has answered
  useEffect(() => {
    fetch('/api/analysis/config').then(r => r.json()).then(d => setServerAnalysisAvailable(!!d.enabled)).catch(() => setServerAnalysisAvailable(false)).finally(() => setAnalysisKnown(true));
  }, []);

  const handleAddWatchlist = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const plateInput = form.elements.namedItem('plate') as HTMLInputElement;
    const reasonInput = form.elements.namedItem('reason') as HTMLInputElement;
    const plate = plateInput.value.trim().toUpperCase();
    if (!plate) return;
    onAddWatchlistEntry(plate, reasonInput.value.trim());
    form.reset();
  };

  return (
    <>
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      key="settings" className="max-w-4xl mx-auto space-y-6 pb-24"
    >
      <div className="space-y-1">
        <h2 className="text-xl font-bold font-display text-ink">Settings</h2>
        <p className="text-sm text-ink-muted">System preferences, cameras, and security configuration.</p>
      </div>

      {/* System Preferences */}
      <div className="card p-8">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
            <Settings2 className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-lg font-bold font-display text-ink">System preferences</h2>
            <p className="text-xs text-ink-muted">Global appearance and notification behavior</p>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          <div className="space-y-4">
            <h3 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Display</h3>
            <div className="flex items-center justify-between p-4 panel">
              <div className="flex items-center gap-3">
                <Eye className="w-4.5 h-4.5 text-accent" strokeWidth={1.75} />
                <span className="text-sm font-semibold text-ink">Interface theme</span>
              </div>
              <button onClick={onToggleTheme} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95">
                {theme === 'dark' ? 'Dark mode' : 'Light mode'}
              </button>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Notifications</h3>
            <div className="space-y-2">
              {[
                { key: 'criticalAlerts', label: 'Critical alerts', icon: AlertTriangle },
                { key: 'systemStatus', label: 'System status', icon: Activity },
                { key: 'quietHoursEnabled', label: 'Quiet hours', icon: Clock },
              ].map((pref) => {
                const isEnabled = Boolean(notificationPrefs[pref.key as keyof NotificationPrefs]);
                return (
                  <button
                    key={pref.key}
                    role="switch"
                    aria-checked={isEnabled}
                    onClick={() => onUpdateNotifyPrefs({ [pref.key]: !isEnabled })}
                    className="w-full flex items-center justify-between p-3.5 panel hover:border-accent/40 active:scale-[0.99] transition-all text-left group"
                  >
                    <div className="flex items-center gap-3">
                      <pref.icon className={cn('w-4.5 h-4.5 transition-colors', isEnabled ? 'text-accent' : 'text-ink-muted group-hover:text-ink')} strokeWidth={1.75} />
                      <span className="text-sm font-semibold text-ink">{pref.label}</span>
                    </div>
                    <div className={cn('switch-track', isEnabled ? 'bg-accent' : 'bg-border')}>
                      <span className={cn('switch-thumb', isEnabled ? 'translate-x-5' : 'translate-x-0.5')} />
                    </div>
                  </button>
                );
              })}
            </div>

            {notificationPrefs.quietHoursEnabled && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="grid grid-cols-2 gap-3 p-4 panel">
                <div className="space-y-1.5">
                  <label className="text-[9px] font-bold text-ink-muted uppercase">Start time</label>
                  <input type="time" value={notificationPrefs.quietHoursStart} onChange={(e) => onUpdateNotifyPrefs({ quietHoursStart: e.target.value })} className="input !py-2 !px-4" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[9px] font-bold text-ink-muted uppercase">End time</label>
                  <input type="time" value={notificationPrefs.quietHoursEnd} onChange={(e) => onUpdateNotifyPrefs({ quietHoursEnd: e.target.value })} className="input !py-2 !px-4" />
                </div>
              </motion.div>
            )}
          </div>
        </div>
      </div>

      {/* Department / role */}
      <div className="card p-8">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
            <Building2 className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-lg font-bold font-display text-ink">Department &amp; access</h2>
            <p className="text-xs text-ink-muted">Used to group cameras on the Map and gate watchlist management</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Department</label>
            <input
              value={userDepartment}
              onChange={(e) => onUpdateUserProfile({ department: e.target.value })}
              placeholder="e.g. Municipal Corporation"
              className="input"
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Role</label>
            <input value={userRole.charAt(0).toUpperCase() + userRole.slice(1)} readOnly className="input" aria-describedby="role-help" />
          </div>
        </div>
        <p id="role-help" className="text-[10px] text-ink-muted italic mt-4">Your role is set by an administrator and cannot be changed here. Only Admin accounts can manage the vehicle watchlist below.</p>
      </div>

      {/* Administrators: users, departments and which cameras each department sees. Not for the offline guest (no account, no server session). */}
      {isAdmin && user && user.uid !== 'demo-guest' && <AdminUsersPanel />}
      {isAdmin && user && user.uid !== 'demo-guest' && <AllDepartmentsPanel />}
      {isAdmin && user && user.uid !== 'demo-guest' && <FederationPanel />}

      {/* Cloud sync status */}
      <div className="card p-8 relative overflow-hidden">
        <div className="flex items-center gap-4 text-left">
          <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
            <FolderHeart className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-base font-bold font-display text-ink">Cloud settings sync</h2>
            <p className="text-xs text-ink-muted">
              {user?.uid === 'demo-guest' ? 'Running in offline guest bypass mode' : `Signed in as: ${user?.email}`}
            </p>
          </div>
        </div>
      </div>

      {/* Sheets link */}
      <div className="card p-8">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-success-soft flex items-center justify-center text-success">
            <BarChart2 className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-lg font-bold font-display text-ink">Google Sheets export</h2>
            <p className="text-xs text-ink-muted">Export surveillance logs to a spreadsheet</p>
          </div>
        </div>
        <div className="p-5 panel space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <p className="text-xs font-semibold text-ink">Spreadsheet link</p>
            {googleSheetsId && (
              <button onClick={() => window.open(`https://docs.google.com/spreadsheets/d/${googleSheetsId}`, '_blank')} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95">
                <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.75} /> Open sheet
              </button>
            )}
          </div>
          <input
            type="text"
            placeholder="e.g. 1aBC-dEFghIjKLmNoPQRsTuvWxYz1234567890AA_BB"
            value={googleSheetsId}
            onChange={(e) => {
              const val = e.target.value;
              const match = val.match(/\/d\/([a-zA-Z0-9-_]+)/);
              onChangeGoogleSheetsId(match?.[1] || val);
            }}
            className="input font-mono text-xs"
          />
        </div>
      </div>

      {/* Remote stream access credentials */}
      <div className="card p-8">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
            <KeyRound className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-lg font-bold font-display text-ink">Stream access credentials</h2>
            <p className="text-xs text-ink-muted">Sent to password-protected remote feed hosts (applies to every Remote Link Feed camera)</p>
          </div>
        </div>
        <div className="p-5 panel space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Access email</label>
            <input
              type="email"
              placeholder="Registered email for your camera grid access"
              value={streamAccessEmail}
              onChange={(e) => onChangeStreamAccessEmail(e.target.value)}
              className="input font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-[10px] text-ink-muted leading-relaxed">
              Some remote grids pair this with the password below — as email:password Basic auth for their direct RTSP/WebRTC endpoints, and as the login field for their HLS CDN.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Access password</label>
            <div className="relative">
              <input
                type={showStreamPassword ? 'text' : 'password'}
                placeholder="Access password for your camera CDN"
                value={streamAccessPassword}
                onChange={(e) => onChangeStreamAccessPassword(e.target.value)}
                className="input font-mono text-xs !pr-11"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowStreamPassword(v => !v)}
                className="btn-ghost !absolute !right-1.5 !top-1/2 !-translate-y-1/2 !p-1.5 min-w-[32px] min-h-[32px] flex items-center justify-center active:scale-95"
                title={showStreamPassword ? 'Hide' : 'Show'}
              >
                {showStreamPassword ? <EyeOff className="w-3.5 h-3.5" strokeWidth={1.75} /> : <Eye className="w-3.5 h-3.5" strokeWidth={1.75} />}
              </button>
            </div>
          </div>
          <p className="text-[10px] text-ink-muted leading-relaxed italic">
            Remote feeds are relayed through this server (needed for CDNs that don't send CORS headers), so these credentials are sent to your camera host server-side and never appear in your browser's network requests. Change or clear them here anytime.
          </p>
        </div>
      </div>

      {showAddCamera && <AddCameraDialog isAdmin={isAdmin} onClose={() => setShowAddCamera(false)} onCreate={(f) => { rememberCameras(); onCreateCamera(f); }} onOnboarded={rememberCameras} />}

      {/* Cameras */}
      <div className="card p-8">
        <div className="flex items-center justify-between mb-7 flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
              <Camera className="w-5.5 h-5.5" strokeWidth={1.75} />
            </div>
            <div>
              <h2 className="text-lg font-bold font-display text-ink">Camera management</h2>
              <p className="text-xs text-ink-muted">Configure every camera in your fleet</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onOpenSetupGuides} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95"><HelpCircle className="w-3.5 h-3.5" strokeWidth={1.75} /> Setup guides</button>
            <button onClick={() => setShowAddCamera(true)} data-testid="settings-add-camera" className="btn-primary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95"><Plus className="w-3.5 h-3.5" strokeWidth={1.75} /> Add camera</button>
          </div>
        </div>

        <div className="relative mb-4 max-w-md">
          <Search className="w-4 h-4 text-ink-muted absolute left-3.5 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
          <input value={camSearch} onChange={(e) => { setCamSearch(e.target.value); setCamPage(0); }} placeholder="Search cameras by name, department or id..." aria-label="Search cameras" data-testid="settings-camera-search" className="input !pl-10 !pr-4 !py-2 text-sm" />
        </div>

        <ul className="space-y-2" data-testid="settings-camera-list">
          {pageCams.map((cam) => {
            const open = openCameraId === cam.id && activeCameraId === cam.id;
            return (
              <li key={cam.id} className={cn('rounded-xl border transition-colors', open ? 'border-accent bg-surface' : 'border-border bg-surface-muted')}>
                <div className="flex items-center gap-2 pr-2">
                  <button
                    onClick={() => toggleCamera(cam.id)}
                    aria-expanded={open} aria-controls={`camera-config-${cam.id}`}
                    data-testid={`settings-camera-${cam.id}`}
                    className="flex-1 min-w-0 flex items-center gap-3 p-4 text-left"
                  >
                    {open ? <ChevronDown className="w-4 h-4 text-accent shrink-0" strokeWidth={1.75} /> : <ChevronRight className="w-4 h-4 text-ink-muted shrink-0" strokeWidth={1.75} />}
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-ink truncate">{cam.name}</span>
                      <span className="block text-[10px] font-medium text-ink-muted truncate">{cam.useRemoteFeed ? 'Remote feed' : 'Local feed'}{cam.department ? ` · ${cam.department}` : ''}</span>
                    </span>
                  </button>
                  {isAdmin && cameras.length > 1 && (
                    <button onClick={() => onRemoveCamera(cam.id)} className="p-1.5 rounded-lg hover:bg-critical hover:text-white transition-all active:scale-95 min-w-[32px] min-h-[32px] flex items-center justify-center text-ink-muted" title="Delete camera" aria-label={`Delete ${cam.name}`}>
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
                {open && (
                  <div id={`camera-config-${cam.id}`} className="px-5 pb-6 pt-5 space-y-8 border-t border-border" data-testid="camera-config">
        <div className="space-y-4">
          <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Camera name</label>
          <input type="text" value={activeCamera.name} onChange={(e) => onUpdateActiveCamera({ name: e.target.value })} className="input text-lg font-bold" placeholder="e.g. Garden View" />
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" strokeWidth={1.75} /> Department</label>
            <input type="text" value={activeCamera.department || ''} onChange={(e) => onUpdateActiveCamera({ department: e.target.value })} className="input" placeholder="e.g. Transport" />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" strokeWidth={1.75} /> Coordinates (for Map)</label>
            <div className="flex gap-2">
              <input
                type="number" step="any" placeholder="Latitude"
                value={activeCamera.location?.lat ?? ''}
                onChange={(e) => onUpdateActiveCamera({ location: { lat: parseFloat(e.target.value) || 0, lng: activeCamera.location?.lng ?? 0 } })}
                className="input"
              />
              <input
                type="number" step="any" placeholder="Longitude"
                value={activeCamera.location?.lng ?? ''}
                onChange={(e) => onUpdateActiveCamera({ location: { lat: activeCamera.location?.lat ?? 0, lng: parseFloat(e.target.value) || 0 } })}
                className="input"
              />
            </div>
          </div>
        </div>

        {/* Registry metadata — Sentinel Mesh Model 1 mandatory foundation */}
        <div className="grid sm:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Ownership</label>
            <input type="text" value={activeCamera.ownership || ''} onChange={(e) => onUpdateActiveCamera({ ownership: e.target.value })} className="input" placeholder="e.g. Municipal Corporation" />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Camera type</label>
            <select value={activeCamera.cameraType || ''} onChange={(e) => onUpdateActiveCamera({ cameraType: (e.target.value || undefined) as CameraConfig['cameraType'] })} className="input">
              <option value="">Unspecified</option>
              <option value="fixed">Fixed</option>
              <option value="ptz">PTZ</option>
              <option value="dome">Dome</option>
              <option value="bullet">Bullet</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Connectivity status</label>
            <select value={activeCamera.connectivityStatus || 'unknown'} onChange={(e) => onUpdateActiveCamera({ connectivityStatus: e.target.value as CameraConfig['connectivityStatus'] })} className="input">
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="degraded">Degraded</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Maintenance status</label>
            <select value={activeCamera.maintenanceStatus || 'operational'} onChange={(e) => onUpdateActiveCamera({ maintenanceStatus: e.target.value as CameraConfig['maintenanceStatus'] })} className="input">
              <option value="operational">Operational</option>
              <option value="needs_maintenance">Needs maintenance</option>
              <option value="decommissioned">Decommissioned</option>
            </select>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Install date</label>
            <input type="date" value={activeCamera.installDate || ''} onChange={(e) => onUpdateActiveCamera({ installDate: e.target.value })} className="input" />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Storage details</label>
            <input type="text" value={activeCamera.storageDetails || ''} onChange={(e) => onUpdateActiveCamera({ storageDetails: e.target.value })} className="input" placeholder="e.g. NVR, local, 30-day retention" />
          </div>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs font-bold text-ink"><input type="checkbox" checked={activeCamera.aiAnalysis !== false} onChange={(e) => onUpdateActiveCamera({ aiAnalysis: e.target.checked })} aria-label="Analyze with AI" /> Analyze with AI</label>
          <p className="text-[11px] text-ink-muted">{activeCamera.aiAnalysis !== false ? 'The AI model describes the scene, counts people and vehicles and reads faces. Plates are read by the local plate reader either way.' : 'No AI model is used. The server watches this camera locally for movement, movement in a zone and movement across a line, plate reads and offline/online changes. People, faces and scene judgements need AI.'}</p>
          {activeCamera.aiAnalysis === false && <ZoneLineEditor key={activeCamera.id} camera={activeCamera} streamAccessEmail={streamAccessEmail} streamAccessPassword={streamAccessPassword} onChange={(analyzers) => onUpdateActiveCamera({ analyzers })} />}
          {activeCamera.aiAnalysis === false && analysisKnown && (() => {
            const problems = localWatchProblems(activeCamera, serverAnalysisAvailable);
            return (
              <div className="rounded-xl border border-border p-3 space-y-2 text-xs" data-testid="local-watch-status">
                {problems.length === 0
                  ? <p className="text-success font-semibold">The server is watching this camera: a picture every {activeCamera.interval} s, compared with the one before.</p>
                  : problems.map((p) => (
                    <div key={p.id} className="flex flex-wrap items-start justify-between gap-2 text-warning" role="alert">
                      <p className="min-w-0 flex-1 font-medium">{p.text}</p>
                      {p.fix && <button type="button" onClick={() => onUpdateActiveCamera(p.fix!.patch)} className="btn-secondary !py-1 !px-3 text-xs whitespace-nowrap">{p.fix.label}</button>}
                    </div>
                  ))}
                <p className="text-ink-muted">Press <b>Save settings</b> to keep the drawing. What the detector sees appears under <b>Events</b> as Movement, Intrusion (in the zone) and Line crossing. To be alerted, add a rule for those types: Events &gt; Rules.</p>
              </div>
            );
          })()}
        </div>

        <div className="space-y-4">
          <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-critical" strokeWidth={1.75} /> Suspicious rules</label>
          <textarea value={activeCamera.suspiciousRules} onChange={(e) => onUpdateActiveCamera({ suspiciousRules: e.target.value })} className="input min-h-[90px] resize-none" placeholder="e.g. Someone wearing a red hoodie, a package left unattended..." />
        </div>

        <div className="space-y-4">
          <div className="flex justify-between items-center text-xs font-bold text-ink-muted uppercase tracking-widest">
            <label className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-accent" strokeWidth={1.75} /> Detection sensitivity</label>
            <span className="badge badge-accent">{activeCamera.sensitivity}/10</span>
          </div>
          <input type="range" min="1" max="10" value={activeCamera.sensitivity} onChange={(e) => onUpdateActiveCamera({ sensitivity: parseInt(e.target.value) })} className="w-full accent-[var(--accent)]" />
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Users className="w-3.5 h-3.5" strokeWidth={1.75} /> People capacity</label>
            <input type="number" value={activeCamera.peopleThreshold} onChange={(e) => onUpdateActiveCamera({ peopleThreshold: Math.max(0, parseInt(e.target.value) || 0) })} className="input font-bold" />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Truck className="w-3.5 h-3.5" strokeWidth={1.75} /> Vehicle limit</label>
            <input type="number" value={activeCamera.vehicleThreshold} onChange={(e) => onUpdateActiveCamera({ vehicleThreshold: Math.max(0, parseInt(e.target.value) || 0) })} className="input font-bold" />
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" strokeWidth={1.75} /> Sync frequency (seconds)</label>
          <input type="number" value={activeCamera.interval} onChange={(e) => onUpdateActiveCamera({ interval: Math.max(5, parseInt(e.target.value) || 5) })} className="input font-bold" />
        </div>

        {serverAnalysisAvailable && (
          <div className="panel p-5 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-ink block">Analyze on server</span>
                <span className="text-[10px] text-ink-muted">
                  The server captures and analyzes this camera on its sync frequency — no browser tab needs to stay open. Remote link feeds only; save settings to apply.
                </span>
              </div>
              <button
                role="switch"
                aria-checked={Boolean(activeCamera.serverAnalysis)}
                disabled={!activeCamera.useRemoteFeed}
                onClick={() => onUpdateActiveCamera({ serverAnalysis: !activeCamera.serverAnalysis })}
                className={cn('switch-track', activeCamera.serverAnalysis ? 'bg-accent' : 'bg-border', !activeCamera.useRemoteFeed && 'opacity-50')}
              >
                <span className={cn('switch-thumb', activeCamera.serverAnalysis ? 'translate-x-5' : 'translate-x-0.5')} />
              </button>
            </div>
            {activeCamera.serverAnalysis && activeCamera.lastAnalysisError && (
              <p className="text-[10px] text-critical">Last server error: {activeCamera.lastAnalysisError}</p>
            )}
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Camera className="w-3.5 h-3.5" strokeWidth={1.75} /> Feed source</label>
            <button onClick={onOpenSetupGuides} className="text-[10px] font-bold text-accent uppercase">Setup guide</button>
          </div>
          <div className="panel p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-ink block">Remote link feed</span>
                <span className="text-[10px] text-ink-muted">RTSP, snapshot, or WebRTC URL streaming.</span>
              </div>
              <button
                role="switch"
                aria-checked={Boolean(activeCamera.useRemoteFeed)}
                onClick={() => onUpdateActiveCamera({ useRemoteFeed: !activeCamera.useRemoteFeed, useSimulatedFeed: false })}
                className={cn('switch-track', activeCamera.useRemoteFeed ? 'bg-accent' : 'bg-border')}
              >
                <span className={cn('switch-thumb', activeCamera.useRemoteFeed ? 'translate-x-5' : 'translate-x-0.5')} />
              </button>
            </div>
            {activeCamera.useRemoteFeed && (
              <input
                type="text" placeholder="e.g. http://localhost:1984/stream.html?src=cam"
                value={activeCamera.remoteStreamUrl}
                onChange={(e) => onUpdateActiveCamera({ remoteStreamUrl: e.target.value })}
                className="input font-mono text-xs"
              />
            )}
            <div className="border-t border-border pt-4 flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-ink block">Simulate CCTV feed</span>
                <span className="text-[10px] text-ink-muted">Run a demo feed, no camera hardware needed.</span>
              </div>
              <button
                role="switch"
                aria-checked={Boolean(activeCamera.useSimulatedFeed)}
                onClick={() => onUpdateActiveCamera({ useSimulatedFeed: !activeCamera.useSimulatedFeed, useRemoteFeed: false })}
                className={cn('switch-track', activeCamera.useSimulatedFeed ? 'bg-accent' : 'bg-border')}
              >
                <span className={cn('switch-thumb', activeCamera.useSimulatedFeed ? 'translate-x-5' : 'translate-x-0.5')} />
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" strokeWidth={1.75} /> Camera webhook</label>
            {activeCamera.webhookUrl && (
              <button onClick={onTestWebhook} disabled={webhookStatus === 'testing'} className="text-[10px] font-bold uppercase px-3 py-1 rounded-lg btn-ghost">
                {webhookStatus === 'idle' && 'Test endpoint'}
                {webhookStatus === 'testing' && 'Testing...'}
                {webhookStatus === 'success' && 'Success!'}
                {webhookStatus === 'error' && 'Failed'}
              </button>
            )}
          </div>
          <input type="text" placeholder="https://your-api.com/webhooks/cam-1" value={activeCamera.webhookUrl} onChange={(e) => onUpdateActiveCamera({ webhookUrl: e.target.value })} className="input" />
        </div>

                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {filteredCams.length === 0 && <p className="text-center text-xs text-ink-muted py-6">No cameras match "{camSearch}".</p>}
        {filteredCams.length > CAMERA_PAGE_SIZE && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs" data-testid="settings-camera-pager">
            <span className="text-ink-muted">Showing {camPageClamped * CAMERA_PAGE_SIZE + 1}–{Math.min((camPageClamped + 1) * CAMERA_PAGE_SIZE, filteredCams.length)} of {filteredCams.length}</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setCamPage(Math.max(0, camPageClamped - 1))} disabled={camPageClamped === 0} className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40">Previous</button>
              <span className="text-ink-muted font-medium whitespace-nowrap">Page {camPageClamped + 1} of {camPages}</span>
              <button onClick={() => setCamPage(Math.min(camPages - 1, camPageClamped + 1))} disabled={camPageClamped >= camPages - 1} className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Known faces (shared by every camera, so not part of one camera's configuration) */}
      <div className="card p-8">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Users className="w-3.5 h-3.5" strokeWidth={1.75} /> Known family/members</label>
            <div className="relative">
              <input type="file" id="face-upload" className="hidden" accept="image/*" onChange={onFaceUpload} />
              <label htmlFor="face-upload" className="btn-primary !py-2 !px-4 text-xs cursor-pointer whitespace-nowrap active:scale-95 inline-flex items-center">Add face</label>
            </div>
          </div>
          {faceDepartment && <p className="text-[10px] text-ink-muted -mt-2">New faces are shared with everyone in {faceDepartment}.</p>}
          {knownFaces.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {knownFaces.map(face => (
                <div key={face.id} className="relative group aspect-square rounded-xl overflow-hidden border border-border">
                  <img src={face.imageData} alt={face.name} className="w-full h-full object-cover" />
                  <button onClick={() => onRemoveFace(face.id)} className="absolute top-1.5 right-1.5 w-6 h-6 bg-critical rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity active:scale-95" title="Remove face">
                    <Trash2 className="w-3 h-3 text-white" strokeWidth={1.75} />
                  </button>
                  <div className="absolute inset-x-0 bottom-0 p-1.5 bg-black/60 text-[8px] font-bold text-white text-center truncate">{face.name}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 border-2 border-dashed border-border rounded-xl text-center text-ink-muted">
              <p className="text-xs italic">No known faces uploaded yet.</p>
            </div>
          )}
        </div>
      </div>

      {/* Watchlist */}
      <div className="card p-8">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-critical-soft flex items-center justify-center text-critical">
            <ShieldAlert className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-lg font-bold font-display text-ink">Vehicle watchlist</h2>
            <p className="text-xs text-ink-muted">Plates flagged for real-time tracking across every camera{watchDepartment ? `. New plates are shared with everyone in ${watchDepartment}.` : ''}</p>
          </div>
        </div>

        {!isAdmin ? (
          <div className="panel p-6 text-center text-xs text-ink-muted">
            Only Admin accounts can manage the watchlist. Switch your role above if this is your own account.
          </div>
        ) : (
          <>
            <form onSubmit={handleAddWatchlist} className="flex flex-col sm:flex-row gap-3 mb-5">
              <input name="plate" placeholder="Plate, e.g. GJ01AB1234" className="input font-mono uppercase flex-1" />
              <input name="reason" placeholder="Reason (optional)" className="input flex-1" />
              <button type="submit" className="btn-primary !py-2.5 !px-5 text-xs font-semibold whitespace-nowrap active:scale-95 flex items-center justify-center gap-1.5"><Plus className="w-4 h-4" strokeWidth={1.75} /> Add</button>
            </form>
            {watchlist.length === 0 ? (
              <div className="p-6 border-2 border-dashed border-border rounded-xl text-center text-ink-muted">
                <p className="text-xs italic">No plates on the watchlist yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {watchlist.map(entry => (
                  <div key={entry.id} className="panel p-3.5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <ScanLine className="w-4 h-4 text-critical shrink-0" strokeWidth={1.75} />
                      <div>
                        <span className="text-sm font-mono font-bold text-ink block">{entry.plate}</span>
                        {entry.reason && <span className="text-[10px] text-ink-muted">{entry.reason}</span>}
                      </div>
                    </div>
                    <button onClick={() => onRemoveWatchlistEntry(entry.id)} className="btn-ghost !p-2 hover:!text-critical min-w-[36px] min-h-[36px] flex items-center justify-center active:scale-95" title="Remove watchlist entry"><Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </motion.div>

    {/* Sticky save bar — reachable regardless of scroll position, instead of
        the Save action being stranded in a card mid-page. Sits above the
        mobile bottom nav on small screens, flush with the viewport edge
        (offset past the icon sidebar) on desktop. Right padding reserves
        room for the floating chat bubble (fixed bottom-6 right-6, ~72px
        footprint) so the Save button never renders underneath it. */}
    <div className="fixed bottom-16 lg:bottom-0 left-0 lg:left-24 right-0 z-40 bg-surface/95 backdrop-blur-xl border-t border-border pl-6 pr-20 lg:pr-28 py-3.5 flex items-center justify-between gap-4">
      <p className="text-xs text-ink-muted hidden sm:block">
        Changes apply as you go — Save syncs everything to your account.
      </p>
      <button
        onClick={onSaveSettings}
        disabled={isSaveLoading}
        className={cn(
          'w-full sm:w-auto ml-auto px-6 py-3 rounded-xl font-bold text-sm transition-all active:scale-95 flex items-center justify-center gap-2.5',
          saveSuccess === true && 'bg-success text-white',
          saveSuccess === false && 'bg-critical text-white',
          saveSuccess === null && 'btn-primary'
        )}
      >
        {isSaveLoading ? (<><RefreshCw className="w-4 h-4 animate-spin" strokeWidth={1.75} /><span>Saving...</span></>)
          : saveSuccess === true ? (<><Check className="w-4 h-4" strokeWidth={1.75} /><span>Saved!</span></>)
          : saveSuccess === false ? (<><AlertTriangle className="w-4 h-4" strokeWidth={1.75} /><span>Sync error</span></>)
          : (<><Save className="w-4 h-4" strokeWidth={1.75} /><span>Save settings</span></>)}
      </button>
    </div>
    </>
  );
}
