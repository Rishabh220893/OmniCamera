import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Car, CheckCircle2, ImagePlus, Loader2, Play, ScanFace, Search, ShieldAlert, Square, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { CameraConfig } from '../types';
import { geminiCallsPerMinute, tileSubtitle, tileTitle } from '../lib/panelTiles';
import { ageLabel } from '../lib/cameraProfileView';
import type { TrackAlert, TrackMode, TrackingController } from '../lib/tracking';
import CameraOverlay from './CameraOverlay';

const PAGE_SIZE = 60;

export const MODE_LABEL: Record<TrackMode, string> = { plate: 'Track License Plate', face: 'Track Face', rules: 'Set own rules' };

/** A photo, shrunk so it is sent once and quickly: the longest side at most 1024 px, as a JPEG data URL. */
export function shrinkImage(file: File, maxSide = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * k)); canvas.height = Math.max(1, Math.round(img.height * k));
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image the browser can read.')); };
    img.src = url;
  });
}

interface Props {
  cameras: CameraConfig[];
  activeCamera?: CameraConfig;
  tracking: TrackingController;
  streamAccessEmail: string;
  streamAccessPassword: string;
  /** The camera whose full-screen view is open (set by a click, or by an alert). */
  openCameraId: string | null;
  openAlert: TrackAlert | null;
  onOpenCamera: (id: string) => void;
  onCloseCamera: () => void;
}

/**
 * Feed > Full Panel: every camera as a tile that loads nothing until it is clicked, and three ways to watch all of them
 * at once in the background: a licence plate, a face, or the suspicious-activity rules.
 */
export default function FullPanel({ cameras, activeCamera, tracking, streamAccessEmail, streamAccessPassword, openCameraId, openAlert, onOpenCamera, onCloseCamera }: Props) {
  const { status, alerts } = tracking;
  const running = status?.active === true;
  const [mode, setMode] = useState<TrackMode | null>(null);
  const [plate, setPlate] = useState('');
  const [rules, setRules] = useState(activeCamera?.suspiciousRules ?? '');
  const [face, setFace] = useState<{ dataUrl: string; label: string } | null>(null);
  const [faceError, setFaceError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [, setTick] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 5000); return () => clearInterval(t); }, []);
  // A job that was already running (the page was reloaded) shows its own mode.
  useEffect(() => { if (running && status?.mode) setMode(status.mode); }, [running, status?.mode]);

  const watchable = useMemo(() => cameras.filter((c) => c.useRemoteFeed && c.remoteStreamUrl), [cameras]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? cameras.filter((c) => `${tileTitle(c)} ${c.name} ${c.department ?? ''}`.toLowerCase().includes(q)) : cameras;
  }, [cameras, filter]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = shown.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const byId = useMemo(() => new Map((status?.cameras ?? []).map((c) => [c.id, c])), [status?.cameras]);
  const alerting = useMemo(() => {
    const now = Date.now();
    return new Set(alerts.filter((a) => now - Date.parse(a.at) < 120_000).map((a) => a.cameraId));
  }, [alerts, status]);

  const canStart = !!mode && !running && !tracking.busy && watchable.length > 0 && (
    mode === 'plate' ? plate.replace(/[^A-Za-z0-9]/g, '').length >= 4 : mode === 'face' ? !!face : rules.trim().length >= 5);

  const start = () => {
    if (!mode) return;
    void tracking.start({
      mode,
      ...(mode === 'plate' ? { plate } : mode === 'face' ? { faceImage: face!.dataUrl, faceLabel: face!.label } : { rules }),
      cameras: watchable.map((c) => ({ id: c.id, name: c.name, url: c.remoteStreamUrl })),
    });
  };

  const onFile = async (file: File | undefined) => {
    setFaceError(null);
    if (!file) return;
    try { setFace({ dataUrl: await shrinkImage(file), label: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Tracked person' }); }
    catch (e) { setFaceError(e instanceof Error ? e.message : 'Could not read that image.'); }
  };

  const openCamera = openCameraId ? cameras.find((c) => c.id === openCameraId) : undefined;
  const modeBtn = (m: TrackMode, icon: React.ReactNode) => (
    <button key={m} onClick={() => !running && setMode(mode === m ? null : m)} disabled={running && mode !== m} aria-pressed={mode === m}
      className={cn('flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-all active:scale-95 whitespace-nowrap disabled:opacity-40',
        mode === m ? 'bg-accent border-accent text-white shadow-xs' : 'bg-surface border-border text-ink hover:border-accent/50')}>
      {icon}{MODE_LABEL[m]}
    </button>
  );

  return (
    <div className="space-y-5" data-testid="full-panel">
      <div className="card p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="What to track">
          {modeBtn('plate', <Car className="w-4 h-4" strokeWidth={1.75} />)}
          {modeBtn('face', <ScanFace className="w-4 h-4" strokeWidth={1.75} />)}
          {modeBtn('rules', <ShieldAlert className="w-4 h-4" strokeWidth={1.75} />)}
        </div>

        {mode === 'plate' && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold text-ink space-y-1">
              <span className="block">Licence plate to find</span>
              <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} disabled={running} maxLength={16} placeholder="GJ05AB1234" aria-label="Licence plate" className="input !py-2.5 text-sm font-mono tracking-wider w-56" />
            </label>
            <p className="text-xs text-ink-muted max-w-md pb-2">The plate reader looks at every camera in the background, even the ones you are not watching. Spaces and capitals do not matter.</p>
          </div>
        )}

        {mode === 'face' && (
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex items-center gap-3">
              {face ? <img src={face.dataUrl} alt="The face to find" className="w-16 h-16 rounded-xl object-cover border border-border" /> : <div className="w-16 h-16 rounded-xl border border-dashed border-border flex items-center justify-center text-ink-muted"><ScanFace className="w-6 h-6" strokeWidth={1.5} /></div>}
              <div className="space-y-1">
                <input ref={fileRef} type="file" accept="image/*" className="hidden" aria-label="Upload a photo of the face" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
                <button onClick={() => fileRef.current?.click()} disabled={running} className="btn-secondary !py-2 !px-3 text-xs flex items-center gap-1.5"><ImagePlus className="w-3.5 h-3.5" strokeWidth={1.75} /> {face ? 'Change photo' : 'Upload a photo'}</button>
                {face && <input value={face.label} onChange={(e) => setFace({ ...face, label: e.target.value })} disabled={running} maxLength={40} aria-label="Name for this person" className="input !py-1.5 text-xs w-44" />}
              </div>
            </div>
            <p className="text-xs text-ink-muted max-w-md pb-2">Gemini compares every camera with this photo in the background. A clear, front-facing photo works best.</p>
            {faceError && <p role="alert" className="text-xs text-critical w-full">{faceError}</p>}
          </div>
        )}

        {mode === 'rules' && (
          <div className="space-y-2">
            <label className="text-xs font-semibold text-ink space-y-1 block">
              <span className="block">What should raise an alert on any camera? (the same kind of text as a camera's Suspicious Rules)</span>
              <textarea value={rules} onChange={(e) => setRules(e.target.value)} disabled={running} rows={3} maxLength={1000} placeholder="e.g. a person climbing a fence, an unattended bag, anyone carrying a weapon" aria-label="Suspicious rules" className="input !py-2.5 text-sm w-full max-w-2xl" />
            </label>
            {cameras.some((c) => c.suspiciousRules?.trim()) && !running && (
              <select value="" onChange={(e) => { const c = cameras.find((x) => x.id === e.target.value); if (c) setRules(c.suspiciousRules); }} aria-label="Load the rules of a camera" className="input !py-1.5 !px-3 text-xs !w-auto cursor-pointer">
                <option value="">Load the rules of a camera…</option>
                {cameras.filter((c) => c.suspiciousRules?.trim()).map((c) => <option key={c.id} value={c.id}>{tileTitle(c)}: {c.suspiciousRules.slice(0, 50)}</option>)}
              </select>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {!running ? (
            <button onClick={start} disabled={!canStart} className="btn-primary !py-2.5 !px-5 text-sm flex items-center gap-2 disabled:opacity-40">
              {tracking.busy ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} /> : <Play className="w-4 h-4" strokeWidth={1.75} />}
              Start watching {watchable.length} camera{watchable.length === 1 ? '' : 's'}
            </button>
          ) : (
            <button onClick={() => { void tracking.stop(); }} disabled={tracking.busy} className="btn-secondary !py-2.5 !px-5 text-sm flex items-center gap-2"><Square className="w-4 h-4" strokeWidth={1.75} /> Stop</button>
          )}
          {!mode && !running && <span className="text-xs text-ink-muted">Pick what to track: a licence plate, a face, or your own rules.</span>}
          {(mode === 'face' || mode === 'rules') && !running && watchable.length > 0 && (
            <span className="text-xs text-ink-muted max-w-md">Uses Gemini: up to about {geminiCallsPerMinute(watchable.length)} calls a minute for {watchable.length} cameras. Scenes that have not changed are skipped.</span>
          )}
          {watchable.length < cameras.length && <span className="text-xs text-ink-muted">{cameras.length - watchable.length} camera{cameras.length - watchable.length === 1 ? ' is' : 's are'} not remote feeds and cannot be watched from the server.</span>}
        </div>

        {tracking.error && (
          <div role="alert" className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-xs font-semibold bg-warning-soft text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.75} /><span className="flex-1">{tracking.error}</span>
            <button onClick={tracking.clearError} className="underline font-bold shrink-0">Dismiss</button>
          </div>
        )}
        {tracking.rejected.length > 0 && <p className="text-xs text-warning">{tracking.rejected.length} camera{tracking.rejected.length === 1 ? ' was' : 's were'} left out: {tracking.rejected.slice(0, 3).map((r) => `${r.id} (${r.why})`).join('; ')}.</p>}

        {running && status && (
          <div className="rounded-xl bg-surface-muted px-4 py-3 text-xs space-y-1" role="status" aria-live="polite" data-testid="tracking-status">
            <p className="font-semibold text-ink flex items-center gap-2 flex-wrap">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              Watching {status.cameras.length} cameras for {status.mode === 'plate' ? `plate ${status.target}` : status.mode === 'face' ? status.target : 'your rules'}
              <span className="font-normal text-ink-muted">· every {status.intervalSec} s{status.measuredCycleSec ? `, measured ${status.measuredCycleSec} s` : ''}</span>
            </p>
            <p className="text-ink-muted">
              {status.counters.checks} checks · {status.counters.alerts} alert{status.counters.alerts === 1 ? '' : 's'} · {status.counters.failures} could not be captured
              {status.counters.anprCalls > 0 && ` · ${status.counters.anprCalls} plate reads`}
              {status.counters.geminiCalls > 0 && ` · ${status.counters.geminiCalls} Gemini calls`}
              {status.counters.skippedUnchanged > 0 && ` · ${status.counters.skippedUnchanged} unchanged scenes skipped`}
            </p>
            {status.mode === 'plate' && status.plateReader === 'gemini' && <p className="text-warning">The plate reader (ANPR) is not set up, so Gemini reads the plates (unverified). Start the demo with <span className="font-mono">--anpr</span> for the plate reader.</p>}
            {alerts.length > 0 && (
              <div className="pt-2" data-testid="recent-alerts">
                <p className="font-semibold text-ink mb-1">Alerts</p>
                <ul className="space-y-1">
                  {alerts.slice(0, 6).map((a) => (
                    <li key={a.id} className="flex items-center gap-2 rounded-lg bg-critical-soft px-2.5 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-critical shrink-0" strokeWidth={1.75} />
                      <span className="font-semibold text-critical shrink-0">{a.cameraId.toUpperCase()}</span>
                      <span className="truncate text-ink" title={a.detail}>{a.certainty === 'possible' ? 'Possible: ' : ''}{a.title}</span>
                      <span className="ml-auto text-ink-muted shrink-0">{new Date(a.at).toLocaleTimeString()}</span>
                      <button onClick={() => onOpenCamera(a.cameraId)} className="underline font-bold text-critical shrink-0">Open</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {status.late > 0 && <p className="text-warning">{status.late} camera{status.late === 1 ? ' is' : 's are'} behind schedule: the grid is slower than one check per {status.intervalSec} s for all cameras.</p>}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-bold text-ink">Camera Grid <span className="font-normal text-ink-muted ml-2">{cameras.length} camera{cameras.length === 1 ? '' : 's'} · nothing loads until you click one</span></h3>
        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-ink-muted absolute left-3.5 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
          <input value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} placeholder="Filter by camera name or location" aria-label="Filter cameras" className="input !py-2 !px-4 !pl-9 text-xs" />
        </div>
      </div>

      <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3" data-testid="panel-grid">
        {visible.map((c) => {
          const st = byId.get(c.id);
          const hot = alerting.has(c.id);
          return (
            <li key={c.id}>
              <button
                onClick={() => onOpenCamera(c.id)}
                data-testid={`tile-${c.id}`}
                aria-label={`Open ${tileTitle(c)} ${tileSubtitle(c)}`}
                className={cn('group relative w-full min-h-[132px] rounded-xl border bg-surface p-3 text-center flex flex-col items-center justify-center gap-1.5 transition-all hover:border-accent/60 hover:-translate-y-0.5 active:scale-[0.98]',
                  hot ? 'border-critical ring-2 ring-critical/50 incident-pulse' : 'border-border')}
              >
                <span className="absolute top-2.5 left-3 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-success">
                  <span className={cn('w-1.5 h-1.5 rounded-full', st?.state === 'error' ? 'bg-warning' : 'bg-success')} />{st?.state === 'error' ? 'NO SIGNAL' : 'LIVE'}
                </span>
                {hot && <span className="absolute top-2 right-2.5 badge badge-critical !py-0.5 animate-pulse">ALERT</span>}
                <span className="text-base font-bold text-ink font-display">{tileTitle(c)}</span>
                <span className="text-xs text-accent/90 truncate max-w-full">{tileSubtitle(c)}</span>
                <span className="mt-1 px-2.5 py-0.5 rounded-full border border-border text-[10px] text-ink-muted group-hover:text-ink group-hover:border-accent/50">hover · click to open</span>
                {running && (
                  <span className={cn('absolute bottom-1.5 inset-x-2 text-[9px] truncate', st?.state === 'error' ? 'text-warning' : 'text-ink-muted')} title={st?.lastError || st?.lastNote || ''}>
                    {!st || st.state === 'waiting' ? 'waiting for the first check' : st.state === 'error' ? `can't capture: ${st.lastError}` : <><CheckCircle2 className="inline w-2.5 h-2.5 mr-0.5 -mt-0.5 text-success" />{ageLabel(st.lastCheckedAt)} · {st.lastNote}</>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="text-center text-xs text-ink-muted py-8">No cameras match "{filter}".</p>}
      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-ink-muted">
          <span>{current * PAGE_SIZE + 1}–{Math.min(shown.length, (current + 1) * PAGE_SIZE)} of {shown.length}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(current - 1)} disabled={current === 0} className="btn-secondary !py-1.5 !px-3 text-xs">Previous</button>
            <span>Page {current + 1} of {pages}</span>
            <button onClick={() => setPage(current + 1)} disabled={current >= pages - 1} className="btn-secondary !py-1.5 !px-3 text-xs">Next</button>
          </div>
        </div>
      )}

      {openCamera && (
        <CameraOverlay key={openCamera.id} camera={openCamera} streamAccessEmail={streamAccessEmail} streamAccessPassword={streamAccessPassword} alert={openAlert && openAlert.cameraId === openCamera.id ? openAlert : null} onClose={onCloseCamera} />
      )}
      {openCameraId && !openCamera && <button onClick={onCloseCamera} className="sr-only"><X /> Close</button>}
    </div>
  );
}
