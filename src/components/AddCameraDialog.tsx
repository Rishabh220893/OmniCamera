import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { isSafeCameraUrl } from '../lib/cameraUrl';
import { sourcesApi, type OnboardResponse } from '../lib/sourcesApi';
import type { CameraConfig, CameraType } from '../types';

type SourceKind = 'url' | 'onvif' | 'rtsp' | 'webcam' | 'simulated';

const SOURCES: Array<{ kind: SourceKind; label: string; hint: string; admin?: boolean }> = [
  { kind: 'url', label: 'Stream address (HLS, MJPEG, image, RTSP)', hint: 'The camera is played and analysed from this address, for example https://host/cam1/index.m3u8.' },
  { kind: 'onvif', label: 'ONVIF camera (by IP address and port)', hint: 'The server finds the stream on the device and adds it to the media server. Administrators only.', admin: true },
  { kind: 'rtsp', label: 'RTSP camera through the media server', hint: 'An rtsp:// address; the media server pulls it and the camera plays in the browser. Administrators only.', admin: true },
  { kind: 'webcam', label: 'This computer\'s webcam', hint: 'Uses the camera of the device this page is open on.' },
  { kind: 'simulated', label: 'Simulated demo feed', hint: 'A placeholder picture, for trying the app without a camera.' },
];
const TYPES: Array<{ value: CameraType; label: string }> = [
  { value: 'fixed', label: 'Fixed' }, { value: 'ptz', label: 'PTZ' }, { value: 'dome', label: 'Dome' }, { value: 'bullet', label: 'Bullet' }, { value: 'other', label: 'Other' },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const field = 'text-[10px] font-bold text-ink-muted uppercase tracking-widest';

/**
 * Settings > Add camera: asks for what a camera needs (name, type, where its picture comes from, address / port / login, position) before it is created.
 * Stream addresses, webcam and simulated cameras are created here in the app; ONVIF and RTSP devices go to the server's onboarding (docs/adapters.md), which probes them and stores the login sealed.
 */
export default function AddCameraDialog({ isAdmin, onClose, onCreate, onOnboarded }: {
  isAdmin: boolean;
  onClose: () => void;
  /** Creates a camera record with these fields. */
  onCreate: (fields: Partial<CameraConfig>) => void;
  /** A device camera was added through the server; the registry listener brings it into the list. */
  onOnboarded: () => void;
}) {
  const [kind, setKind] = useState<SourceKind>('url');
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [cameraType, setCameraType] = useState<CameraType>('fixed');
  const [url, setUrl] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sources = SOURCES.filter((s) => !s.admin || isAdmin);
  const current = SOURCES.find((s) => s.kind === kind)!;
  const usesAddress = kind === 'url' || kind === 'rtsp';
  const usesHost = kind === 'onvif';
  const usesLogin = kind === 'onvif' || kind === 'rtsp';

  const submit = async () => {
    setError(null);
    const label = name.trim();
    if (!label) { setError('Give the camera a name.'); return; }
    const latN = lat.trim() === '' ? null : Number(lat); const lngN = lng.trim() === '' ? null : Number(lng);
    if ((latN !== null && !Number.isFinite(latN)) || (lngN !== null && !Number.isFinite(lngN)) || ((latN === null) !== (lngN === null))) { setError('Enter both latitude and longitude as numbers, or leave both empty.'); return; }
    if (latN !== null && (Math.abs(latN) > 90 || Math.abs(lngN!) > 180)) { setError('Latitude must be within ±90 and longitude within ±180.'); return; }
    if (usesAddress && !url.trim()) { setError('Enter the stream address.'); return; }
    if (kind === 'url' && !isSafeCameraUrl(url.trim())) { setError('That address is not allowed. Use an http(s):// or rtsp:// address of a camera on a public or private network.'); return; }
    if (kind === 'rtsp' && !/^rtsp:\/\//i.test(url.trim())) { setError('An RTSP address starts with rtsp://'); return; }
    if (usesHost && !host.trim()) { setError('Enter the camera\'s IP address or host name.'); return; }
    const portN = port.trim() === '' ? undefined : Number(port);
    if (portN !== undefined && (!Number.isInteger(portN) || portN < 1 || portN > 65535)) { setError('The port must be a whole number from 1 to 65535.'); return; }

    if (usesHost || kind === 'rtsp') {
      setBusy(true);
      try {
        const r: OnboardResponse = await sourcesApi.onboard({
          camera: { id: 'device', adapter: kind, ...(kind === 'rtsp' ? { url: url.trim() } : { host: host.trim(), ...(portN ? { port: portN } : {}) }), ...(user ? { credentials: { user, pass } } : {}), name: label },
          name: label,
        });
        if (r.ok === false) { setError(r.error); return; }
        onOnboarded(); onClose();
      } catch (e) { setError(errText(e)); } finally { setBusy(false); }
      return;
    }

    const fields: Partial<CameraConfig> = {
      name: label, cameraType, ...(department.trim() ? { department: department.trim() } : {}),
      ...(latN !== null ? { location: { lat: latN, lng: lngN! } } : {}),
    };
    if (kind === 'url') Object.assign(fields, { useRemoteFeed: true, useSimulatedFeed: false, remoteStreamUrl: url.trim() });
    else if (kind === 'webcam') Object.assign(fields, { useRemoteFeed: false, useSimulatedFeed: false });
    else Object.assign(fields, { useRemoteFeed: false, useSimulatedFeed: true });
    onCreate(fields); onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Add camera" data-testid="add-camera-dialog" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="card w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold font-display text-ink">Add camera</h2>
            <p className="text-xs text-ink-muted">Tell the app where the picture comes from. Everything else can be changed later in the camera's settings.</p>
          </div>
          <button onClick={onClose} disabled={busy} className="btn-ghost !p-1.5" aria-label="Close"><X className="w-4 h-4" strokeWidth={1.75} /></button>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-2 sm:col-span-2">
            <label className={field}>Camera name *</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="e.g. Main gate" data-testid="add-camera-name" />
          </div>
          <div className="space-y-2">
            <label className={field}>Camera type</label>
            <select value={cameraType} onChange={(e) => setCameraType(e.target.value as CameraType)} className="input">
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className={field}>Department</label>
            <input value={department} onChange={(e) => setDepartment(e.target.value)} className="input" placeholder="e.g. Transport" disabled={usesHost || kind === 'rtsp'} title={usesHost || kind === 'rtsp' ? 'An administrator gives device cameras to a department in the Registry.' : undefined} />
          </div>
        </div>

        <div className="space-y-2">
          <label className={field}>Where the picture comes from</label>
          <select value={kind} onChange={(e) => { setKind(e.target.value as SourceKind); setError(null); }} className="input" data-testid="add-camera-source">
            {sources.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
          </select>
          <p className="text-[11px] text-ink-muted">{current.hint}</p>
        </div>

        {usesAddress && (
          <div className="space-y-2">
            <label className={field}>{kind === 'rtsp' ? 'RTSP address *' : 'Stream address *'}</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="input font-mono text-xs" placeholder={kind === 'rtsp' ? 'rtsp://192.168.1.20:554/Streaming/Channels/101' : 'https://host/cam1/index.m3u8'} data-testid="add-camera-url" />
          </div>
        )}
        {usesHost && (
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2 col-span-2">
              <label className={field}>IP address or host *</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} className="input font-mono text-xs" placeholder="192.168.1.20" />
            </div>
            <div className="space-y-2">
              <label className={field}>Port</label>
              <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" className="input font-mono text-xs" placeholder="80" />
            </div>
          </div>
        )}
        {usesLogin && (
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className={field}>Camera username</label>
              <input value={user} onChange={(e) => setUser(e.target.value)} className="input" autoComplete="off" />
            </div>
            <div className="space-y-2">
              <label className={field}>Camera password</label>
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} className="input" autoComplete="new-password" />
            </div>
            <p className="sm:col-span-2 text-[10px] text-ink-muted italic">The login is sent to the server, stored sealed and never shown again. Recorders (Hikvision, Dahua) with many channels are added in Registry &gt; Add cameras from a device or recorder.</p>
          </div>
        )}

        <div className="space-y-2">
          <label className={field}>Position on the map (optional)</label>
          <div className="grid grid-cols-2 gap-4">
            <input value={lat} onChange={(e) => setLat(e.target.value)} className="input" inputMode="decimal" placeholder="Latitude, e.g. 23.0225" />
            <input value={lng} onChange={(e) => setLng(e.target.value)} className="input" inputMode="decimal" placeholder="Longitude, e.g. 72.5714" />
          </div>
        </div>

        {error && <p role="alert" className="text-xs text-critical" data-testid="add-camera-error">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={busy} className="btn-secondary !py-2 !px-4 text-xs">Cancel</button>
          <button onClick={submit} disabled={busy} className={cn('btn-primary !py-2 !px-4 text-xs', busy && 'opacity-70')} data-testid="add-camera-submit">
            {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Adding...</> : 'Add camera'}
          </button>
        </div>
      </div>
    </div>
  );
}
