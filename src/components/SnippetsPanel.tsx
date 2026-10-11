import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Film, Loader2, Play, RefreshCw, Trash2, Video, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';
import { snippetsApi, type SnippetRow } from '../lib/snippetsApi';
import type { CameraConfig } from '../types';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DURATIONS = [10, 20, 30, 60, 120];
const mb = (b: number) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);

/** A picture from the server (it needs the sign-in header, so it is fetched and shown as an object URL). */
function Thumb({ s }: { s: SnippetRow }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!s.thumbUrl) return;
    let dead = false, url: string | null = null;
    snippetsApi.blobUrl(s.thumbUrl).then((u) => { if (dead) URL.revokeObjectURL(u); else { url = u; setSrc(u); } }).catch(() => undefined);
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [s.thumbUrl]);
  return src
    ? <img src={src} alt="" className="w-28 h-16 object-cover rounded-lg bg-surface-muted shrink-0" />
    : <div className="w-28 h-16 rounded-lg bg-surface-muted shrink-0 flex items-center justify-center text-ink-muted"><Film className="w-5 h-5" strokeWidth={1.5} /></div>;
}

/**
 * Registry > Recorded snippets: record a few seconds from a camera's stream on the server, keep it, play it back, download it. The video is a file on
 * the server and its details are a row in the database (docs/snippets.md). Needs a signed-in account whose role may export recordings.
 */
export default function SnippetsPanel({ cameras, streamAccessEmail, streamAccessPassword, signedIn }: { cameras: CameraConfig[]; streamAccessEmail: string; streamAccessPassword: string; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SnippetRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraId, setCameraId] = useState('');
  const [seconds, setSeconds] = useState(30);
  const [title, setTitle] = useState('');
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const playingRef = useRef<string | null>(null);

  const recordable = useMemo(() => cameras.filter((c) => c.remoteStreamUrl && !c.useSimulatedFeed), [cameras]);
  useEffect(() => { if (!cameraId && recordable.length) setCameraId(recordable[0].id); }, [recordable, cameraId]);

  const load = useCallback(async () => {
    try { setRows(await snippetsApi.list()); setLoadError(null); } catch (e) { setLoadError(errText(e)); }
  }, []);
  useEffect(() => { if (open && signedIn) void load(); }, [open, signedIn, load]);

  // While something is recording: refresh the list every 2 seconds and tick the clock.
  const recordingCount = rows.filter((r) => r.status === 'recording').length;
  useEffect(() => {
    if (!open || !recordingCount) return;
    const t = setInterval(() => { setNow(Date.now()); void load(); }, 2000);
    return () => clearInterval(t);
  }, [open, recordingCount, load]);

  useEffect(() => () => { if (playingRef.current) URL.revokeObjectURL(playingRef.current); }, []);

  const start = async () => {
    if (!cameraId) return;
    setBusy(true); setNotice(null);
    try {
      const s = await snippetsApi.start(cameraId, seconds, title, { email: streamAccessEmail, password: streamAccessPassword });
      setRows((r) => [s, ...r]); setTitle('');
      setNotice({ ok: true, text: `Recording ${seconds} seconds from ${s.cameraName}. It appears below when it is ready.` });
    } catch (e) { setNotice({ ok: false, text: errText(e) }); }
    finally { setBusy(false); }
  };

  const play = async (s: SnippetRow) => {
    if (!s.fileUrl) return;
    try {
      const url = await snippetsApi.blobUrl(s.fileUrl);
      if (playingRef.current) URL.revokeObjectURL(playingRef.current);
      playingRef.current = url; setPlaying({ id: s.id, url });
    } catch (e) { setNotice({ ok: false, text: errText(e) }); }
  };

  const remove = async (s: SnippetRow) => {
    if (!window.confirm(`Delete "${s.title}"? The video is removed from the server.`)) return;
    try {
      await snippetsApi.remove(s.id);
      if (playing?.id === s.id) { if (playingRef.current) URL.revokeObjectURL(playingRef.current); playingRef.current = null; setPlaying(null); }
      await load();
    } catch (e) { setNotice({ ok: false, text: errText(e) }); }
  };

  return (
    <div className="card p-6">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between" aria-expanded={open}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent"><Video className="w-5 h-5" strokeWidth={1.75} /></div>
          <div className="text-left">
            <h3 className="text-sm font-bold font-display text-ink">Recorded snippets</h3>
            <p className="text-xs text-ink-muted">Record a few seconds from a camera, keep it, play it back or download it.</p>
          </div>
        </div>
        {open ? <ChevronDown className="w-4 h-4 text-ink-muted" strokeWidth={1.75} /> : <ChevronRight className="w-4 h-4 text-ink-muted" strokeWidth={1.75} />}
      </button>

      {open && (
        <div className="mt-5 space-y-4">
          {!signedIn ? (
            <p className="text-xs text-ink-muted">Recording is done by the server for a signed-in account; the offline demo has none. Sign in with an operator or administrator account.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs space-y-1 min-w-[200px] flex-1"><span className="font-semibold text-ink-muted">Camera</span>
                  <select value={cameraId} onChange={(e) => setCameraId(e.target.value)} className="input !py-2 text-sm w-full" aria-label="Camera to record">
                    {recordable.length === 0 && <option value="">No camera with a stream address</option>}
                    {recordable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select></label>
                <label className="text-xs space-y-1"><span className="font-semibold text-ink-muted">Length</span>
                  <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className="input !py-2 text-sm" aria-label="Seconds to record">
                    {DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
                  </select></label>
                <label className="text-xs space-y-1 min-w-[180px] flex-1"><span className="font-semibold text-ink-muted">Title (optional)</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} className="input !py-2 text-sm w-full" placeholder="Gate 1, evening traffic" aria-label="Snippet title" /></label>
                <button onClick={start} disabled={busy || !cameraId} className="btn-primary !py-2 !px-4 text-xs flex items-center gap-1.5 whitespace-nowrap">
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Video className="w-3.5 h-3.5" strokeWidth={1.75} />} Record
                </button>
                <button onClick={() => void load()} className="btn-ghost !p-2" aria-label="Refresh the list" title="Refresh"><RefreshCw className="w-4 h-4" strokeWidth={1.75} /></button>
              </div>

              {notice && <p role={notice.ok ? 'status' : 'alert'} className={cn('text-xs flex items-start gap-2', notice.ok ? 'text-ink' : 'text-critical')}>{!notice.ok && <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}{notice.text}</p>}
              {loadError && <p role="alert" className="text-xs text-critical">{loadError}</p>}

              {playing && (
                <div className="space-y-2">
                  <video key={playing.url} src={playing.url} controls autoPlay className="w-full max-h-[420px] rounded-xl bg-black" data-testid="snippet-player" />
                  <button onClick={() => { if (playingRef.current) URL.revokeObjectURL(playingRef.current); playingRef.current = null; setPlaying(null); }} className="btn-ghost !py-1 !px-3 text-xs">Close player</button>
                </div>
              )}

              {rows.length === 0 && !loadError && <p className="text-xs text-ink-muted">No snippets yet. Pick a camera and press Record.</p>}
              <ul className="space-y-2">
                {rows.map((s) => {
                  const elapsed = Math.max(0, Math.min(s.requestedSeconds, Math.round((now - new Date(s.createdAt).getTime()) / 1000)));
                  return (
                    <li key={s.id} className="panel p-3 flex items-center gap-3">
                      <Thumb s={s} />
                      <div className="min-w-0 flex-1 text-xs">
                        <p className="font-semibold text-ink truncate">{s.title}</p>
                        <p className="text-ink-muted truncate">{s.cameraName}{s.department ? ` · ${s.department}` : ''} · {new Date(s.createdAt).toLocaleString()}</p>
                        <p className="text-ink-muted">
                          {s.status === 'recording' && <span className="inline-flex items-center gap-1 text-warning font-semibold"><Loader2 className="w-3 h-3 animate-spin" />Recording {elapsed} of {s.requestedSeconds} s</span>}
                          {s.status === 'ready' && <span className="text-success font-semibold">Ready · {s.actualSeconds ?? s.requestedSeconds} s · {mb(s.bytes)}{s.sha256 ? ` · SHA-256 ${s.sha256.slice(0, 8)}…` : ''}</span>}
                          {s.status === 'failed' && <span className="text-critical font-semibold" title={s.error ?? undefined}>Failed: {s.error ?? 'unknown'}</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {s.status === 'ready' && <button onClick={() => void play(s)} className="btn-ghost !p-2" aria-label={`Play ${s.title}`} title="Play"><Play className="w-4 h-4" strokeWidth={1.75} /></button>}
                        {s.status === 'ready' && <button onClick={() => void snippetsApi.download(s).catch((e) => setNotice({ ok: false, text: errText(e) }))} className="btn-ghost !p-2" aria-label={`Download ${s.title}`} title="Download"><Download className="w-4 h-4" strokeWidth={1.75} /></button>}
                        {s.status !== 'recording' && <button onClick={() => void remove(s)} className="btn-ghost !p-2 text-critical" aria-label={`Delete ${s.title}`} title="Delete"><Trash2 className="w-4 h-4" strokeWidth={1.75} /></button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="text-[11px] text-ink-muted">The server copies the camera's video without re-encoding, so a snippet plays in a browser only if the camera sends H.264. The grid's own cameras count this against the account's viewing time while recording.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
