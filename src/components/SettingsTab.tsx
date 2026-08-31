import { motion } from 'motion/react';
import {
  Settings2, Eye, AlertTriangle, Activity, Clock, FolderHeart, ExternalLink, BarChart2,
  Camera, HelpCircle, Plus, Trash2, Settings, ShieldCheck, Users, Truck, RefreshCw, Check,
  Save, MapPin, Building2, ScanLine, ShieldAlert
} from 'lucide-react';
import { cn } from '../lib/utils';
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
  cameras: CameraConfig[];
  activeCameraId: string;
  onSelectCamera: (id: string) => void;
  onAddCamera: () => void;
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
  userDepartment: string;
  userRole: 'operator' | 'admin';
  onUpdateUserProfile: (updates: { department?: string; role?: 'operator' | 'admin' }) => void;
  isAdmin: boolean;
}

export default function SettingsTab(props: SettingsTabProps) {
  const {
    theme, onToggleTheme, notificationPrefs, onUpdateNotifyPrefs, user, onSaveSettings,
    isSaveLoading, saveSuccess, googleSheetsId, onChangeGoogleSheetsId, cameras, activeCameraId,
    onSelectCamera, onAddCamera, onRemoveCamera, onUpdateActiveCamera, onOpenSetupGuides,
    webhookStatus, onTestWebhook, knownFaces, onFaceUpload, onRemoveFace,
    watchlist, onAddWatchlistEntry, onRemoveWatchlistEntry,
    userDepartment, userRole, onUpdateUserProfile, isAdmin
  } = props;

  const activeCamera = cameras.find(c => c.id === activeCameraId) || cameras[0];

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
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      key="settings" className="max-w-4xl mx-auto space-y-6 pb-20"
    >
      {/* System Preferences */}
      <div className="card p-8">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
            <Settings2 className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-ink">System preferences</h2>
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
              <button onClick={onToggleTheme} className="btn-secondary !py-1.5 !px-3.5 text-xs">
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
              ].map((pref) => (
                <button
                  key={pref.key}
                  onClick={() => onUpdateNotifyPrefs({ [pref.key]: !notificationPrefs[pref.key as keyof NotificationPrefs] })}
                  className="w-full flex items-center justify-between p-3.5 panel hover:border-accent/30 transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <pref.icon className={cn('w-4.5 h-4.5', notificationPrefs[pref.key as keyof NotificationPrefs] ? 'text-accent' : 'text-ink-muted')} strokeWidth={1.75} />
                    <span className="text-sm font-semibold text-ink">{pref.label}</span>
                  </div>
                  <div className={cn('w-9 h-5 rounded-full relative transition-colors', notificationPrefs[pref.key as keyof NotificationPrefs] ? 'bg-accent' : 'bg-border')}>
                    <div className={cn('absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all', notificationPrefs[pref.key as keyof NotificationPrefs] ? 'left-4.5' : 'left-0.5')} />
                  </div>
                </button>
              ))}
            </div>

            {notificationPrefs.quietHoursEnabled && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="grid grid-cols-2 gap-3 p-4 panel">
                <div className="space-y-1.5">
                  <label className="text-[9px] font-bold text-ink-muted uppercase">Start time</label>
                  <input type="time" value={notificationPrefs.quietHoursStart} onChange={(e) => onUpdateNotifyPrefs({ quietHoursStart: e.target.value })} className="input !py-2" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[9px] font-bold text-ink-muted uppercase">End time</label>
                  <input type="time" value={notificationPrefs.quietHoursEnd} onChange={(e) => onUpdateNotifyPrefs({ quietHoursEnd: e.target.value })} className="input !py-2" />
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
            <h2 className="text-lg font-bold text-ink">Department &amp; access</h2>
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
            <select
              value={userRole}
              onChange={(e) => onUpdateUserProfile({ role: e.target.value as 'operator' | 'admin' })}
              className="input"
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        <p className="text-[10px] text-ink-muted italic mt-4">Only Admin accounts can manage the vehicle watchlist below.</p>
      </div>

      {/* Save panel */}
      <div className="card p-8 relative overflow-hidden">
        <div className="flex flex-col md:flex-row items-center justify-between gap-5">
          <div className="flex items-center gap-4 text-left">
            <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
              <FolderHeart className="w-5.5 h-5.5" strokeWidth={1.75} />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">Cloud settings sync</h2>
              <p className="text-xs text-ink-muted">
                {user?.uid === 'demo-guest' ? 'Running in offline guest bypass mode' : `Signed in as: ${user?.email}`}
              </p>
            </div>
          </div>

          <button
            onClick={onSaveSettings}
            disabled={isSaveLoading}
            className={cn(
              'w-full md:w-auto px-7 py-3.5 rounded-2xl font-bold text-sm transition-all active:scale-95 flex items-center justify-center gap-2.5',
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
      </div>

      {/* Sheets link */}
      <div className="card p-8">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-success-soft flex items-center justify-center text-success">
            <BarChart2 className="w-5.5 h-5.5" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-ink">Google Sheets export</h2>
            <p className="text-xs text-ink-muted">Export surveillance logs to a spreadsheet</p>
          </div>
        </div>
        <div className="p-5 panel space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <p className="text-xs font-semibold text-ink">Spreadsheet link</p>
            {googleSheetsId && (
              <button onClick={() => window.open(`https://docs.google.com/spreadsheets/d/${googleSheetsId}`, '_blank')} className="btn-secondary !py-1.5 !px-3 text-xs">
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

      {/* Camera nodes */}
      <div className="card p-8">
        <div className="flex items-center justify-between mb-7 flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent">
              <Camera className="w-5.5 h-5.5" strokeWidth={1.75} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink">Node management</h2>
              <p className="text-xs text-ink-muted">Configure multiple surveillance endpoints</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onOpenSetupGuides} className="btn-secondary !py-2 text-xs"><HelpCircle className="w-3.5 h-3.5" strokeWidth={1.75} /> Setup guides</button>
            <button onClick={onAddCamera} className="btn-primary !py-2 text-xs"><Plus className="w-3.5 h-3.5" strokeWidth={1.75} /> Add node</button>
          </div>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {cameras.map(cam => (
            <div
              key={cam.id}
              onClick={() => onSelectCamera(cam.id)}
              className={cn('p-4 rounded-2xl border cursor-pointer relative group', activeCameraId === cam.id ? 'bg-accent border-accent' : 'bg-surface-muted border-border hover:border-accent/30')}
            >
              <div className="flex flex-col gap-0.5">
                <span className={cn('text-xs font-bold', activeCameraId === cam.id ? 'text-white' : 'text-ink')}>{cam.name}</span>
                <span className={cn('text-[9px] font-medium', activeCameraId === cam.id ? 'text-white/70' : 'text-ink-muted')}>{cam.useRemoteFeed ? 'Remote feed' : 'Local feed'}</span>
              </div>
              {isAdmin && cameras.length > 1 && (
                <button onClick={(e) => { e.stopPropagation(); onRemoveCamera(cam.id); }} className="absolute top-3 right-3 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 bg-black/15 hover:bg-critical hover:text-white transition-all">
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Node configuration */}
      <div className="card p-8 space-y-8">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center">
            <Settings className="w-7 h-7 text-white" strokeWidth={1.75} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-ink">Node configuration</h2>
            <p className="text-ink-muted text-sm">Targeting: {activeCamera.name}</p>
          </div>
        </div>

        <div className="space-y-4">
          <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Node identifier</label>
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
                onClick={() => onUpdateActiveCamera({ useRemoteFeed: !activeCamera.useRemoteFeed, useSimulatedFeed: false })}
                className={cn('w-11 h-6 rounded-full relative transition-colors', activeCamera.useRemoteFeed ? 'bg-accent' : 'bg-border')}
              >
                <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all', activeCamera.useRemoteFeed ? 'left-6' : 'left-1')} />
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
                onClick={() => onUpdateActiveCamera({ useSimulatedFeed: !activeCamera.useSimulatedFeed, useRemoteFeed: false })}
                className={cn('w-11 h-6 rounded-full relative transition-colors', activeCamera.useSimulatedFeed ? 'bg-accent' : 'bg-border')}
              >
                <div className={cn('absolute top-1 w-4 h-4 bg-white rounded-full transition-all', activeCamera.useSimulatedFeed ? 'left-6' : 'left-1')} />
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" strokeWidth={1.75} /> Node webhook</label>
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

        <div className="space-y-5 pt-6 border-t border-border">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold text-ink-muted uppercase tracking-widest flex items-center gap-1.5"><Users className="w-3.5 h-3.5" strokeWidth={1.75} /> Known family/members</label>
            <div className="relative">
              <input type="file" id="face-upload" className="hidden" accept="image/*" onChange={onFaceUpload} />
              <label htmlFor="face-upload" className="btn-primary !py-2 !px-3.5 text-xs cursor-pointer">Add face</label>
            </div>
          </div>
          {knownFaces.length > 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {knownFaces.map(face => (
                <div key={face.id} className="relative group aspect-square rounded-xl overflow-hidden border border-border">
                  <img src={face.imageData} alt={face.name} className="w-full h-full object-cover" />
                  <button onClick={() => onRemoveFace(face.id)} className="absolute top-1.5 right-1.5 w-6 h-6 bg-critical rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Trash2 className="w-3 h-3 text-white" strokeWidth={1.75} />
                  </button>
                  <div className="absolute inset-x-0 bottom-0 p-1.5 bg-black/60 text-[8px] font-bold text-white text-center truncate">{face.name}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-6 border-2 border-dashed border-border rounded-2xl text-center text-ink-muted">
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
            <h2 className="text-lg font-bold text-ink">Vehicle watchlist</h2>
            <p className="text-xs text-ink-muted">Plates flagged for real-time tracking across every node</p>
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
              <button type="submit" className="btn-primary !px-5"><Plus className="w-4 h-4" strokeWidth={1.75} /> Add</button>
            </form>
            {watchlist.length === 0 ? (
              <div className="p-6 border-2 border-dashed border-border rounded-2xl text-center text-ink-muted">
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
                    <button onClick={() => onRemoveWatchlistEntry(entry.id)} className="btn-ghost !p-1.5 hover:!text-critical"><Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
