import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertTriangle, CheckCircle2, Loader2, Maximize2, Minimize2, RefreshCw, X, XCircle, Circle } from 'lucide-react';
import { cn } from '../lib/utils';
import { CameraConfig } from '../types';
import { gridCamId, mediaAuthHeader, mediaPlaylistUrl, useMediaConfig, type MediaConfig } from '../lib/mediaServer';
import { startWhep } from '../lib/whepClient';
import { plannedRecipes, RECIPE_LABEL, type RecipeId } from '../lib/panelTiles';
import type { TrackAlert } from '../lib/tracking';

const STILL_REFRESH_MS = 4_000;
const RECIPE_TIMEOUT_MS: Record<RecipeId, number> = { media: 45_000, whep: 25_000, proxy: 60_000, stills: 30_000 };

type StepState = 'waiting' | 'trying' | 'failed' | 'ok';
interface Step { recipe: RecipeId; state: StepState; note: string }

interface Attempt { ready: Promise<void>; cleanup: () => void }

/** Resolves once the video really plays (frames advancing), rejects after `ms`. */
function waitForPlaying(video: HTMLVideoElement, ms: number): { promise: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const started = Date.now();
    let last = -1, advances = 0;
    const t = setInterval(() => {
      if (!video.paused && video.videoWidth > 0 && video.readyState >= 2) {
        if (video.currentTime > last && video.currentTime > 0) advances++;
        last = video.currentTime;
        if (advances >= 2) { clearInterval(t); resolve(); return; }
      }
      if (Date.now() - started > ms) { clearInterval(t); reject(new Error(`no picture after ${Math.round(ms / 1000)} s`)); }
    }, 700);
    cancel = () => clearInterval(t);
  });
  return { promise, cancel };
}

interface Ctx { camera: CameraConfig; camId: string | null; media: MediaConfig | null; email: string; password: string; video: HTMLVideoElement; setStill: (url: string | null) => void }

function startHls(video: HTMLVideoElement, src: string, headers: Record<string, string>, ms: number): Attempt {
  const hls = new Hls({ manifestLoadingTimeOut: 35_000, manifestLoadingMaxRetry: 2, levelLoadingTimeOut: 35_000, fragLoadingTimeOut: 40_000, fragLoadingMaxRetry: 3, liveSyncDurationCount: 3, capLevelToPlayerSize: true,
    xhrSetup: (xhr) => { for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v); } });
  video.muted = true; video.playsInline = true;
  const wait = waitForPlaying(video, ms);
  const fatal = new Promise<never>((_, reject) => hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) reject(new Error(`${d.type}: ${d.details}`)); }));
  hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
  hls.loadSource(src); hls.attachMedia(video);
  return { ready: Promise.race([wait.promise, fatal]), cleanup: () => { wait.cancel(); hls.destroy(); video.removeAttribute('src'); video.load(); } };
}

function startRecipe(recipe: RecipeId, c: Ctx): Attempt {
  if (recipe === 'media' && c.media && c.camId) {
    return startHls(c.video, mediaPlaylistUrl(c.media, c.camId), { Authorization: mediaAuthHeader(c.media) }, RECIPE_TIMEOUT_MS.media);
  }
  if (recipe === 'proxy') {
    const src = `/api/proxy-hls?url=${encodeURIComponent(c.camera.remoteStreamUrl)}&password=${encodeURIComponent(c.password)}&email=${encodeURIComponent(c.email)}`;
    return startHls(c.video, src, { 'X-Stream-Password': c.password, 'X-Stream-Email': c.email }, RECIPE_TIMEOUT_MS.proxy);
  }
  if (recipe === 'whep') {
    const whepId = c.camId!;
    c.video.muted = true; c.video.playsInline = true;
    let fail!: (e: Error) => void;
    const failed = new Promise<never>((_, reject) => { fail = reject; });
    const session = startWhep(whepId, c.video, (state) => { if (state === 'failed' || state === 'closed') fail(new Error(`connection ${state}`)); }, c.password, c.email);
    session.ready.catch((e: unknown) => fail(e instanceof Error ? e : new Error('negotiation failed')));
    const wait = waitForPlaying(c.video, RECIPE_TIMEOUT_MS.whep);
    return { ready: Promise.race([wait.promise, failed]), cleanup: () => { wait.cancel(); session.close(); c.video.srcObject = null; } };
  }
  // stills: fetch a snapshot now and every few seconds. Ready as soon as the first one arrives.
  const abort = new AbortController();
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fetchOne = async () => {
    const r = await fetch(`/api/camera-snapshot?camId=${encodeURIComponent(c.camId!)}&url=${encodeURIComponent(c.camera.remoteStreamUrl)}`, {
      headers: { 'X-Stream-Password': c.password, 'X-Stream-Email': c.email }, signal: abort.signal,
    });
    if (!r.ok) throw new Error(`snapshot ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    if (current) URL.revokeObjectURL(current);
    current = url; c.setStill(url);
  };
  const ready = Promise.race([
    fetchOne(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no picture after ${Math.round(RECIPE_TIMEOUT_MS.stills / 1000)} s`)), RECIPE_TIMEOUT_MS.stills)),
  ]).then(() => {
    const loop = () => { timer = setTimeout(() => { fetchOne().catch(() => {}).finally(() => { if (!abort.signal.aborted) loop(); }); }, STILL_REFRESH_MS); };
    loop();
  });
  return { ready, cleanup: () => { abort.abort(); if (timer) clearTimeout(timer); if (current) URL.revokeObjectURL(current); c.setStill(null); } };
}

interface Props {
  camera: CameraConfig;
  streamAccessEmail: string;
  streamAccessPassword: string;
  alert?: TrackAlert | null;
  onClose: () => void;
}

/**
 * One camera, full screen. Nothing loads until it is opened; then each way of playing it is tried in turn
 * (media server, WebRTC, the app's proxy, refreshed stills) until one shows a picture, and the list shows how far it got.
 */
export default function CameraOverlay({ camera, streamAccessEmail, streamAccessPassword, alert, onClose }: Props) {
  const media = useMediaConfig();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [still, setStill] = useState<string | null>(null);
  const [playing, setPlaying] = useState<RecipeId | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [round, setRound] = useState(0);
  const [full, setFull] = useState(false);
  const camId = gridCamId(camera.remoteStreamUrl);
  const hasLogin = !!(streamAccessEmail && streamAccessPassword);

  const recipes = useMemo(
    () => (media === null ? null : plannedRecipes({ camId, url: camera.remoteStreamUrl, hlsSupported: Hls.isSupported(), media, hasLogin })),
    [media, camId, camera.remoteStreamUrl, hasLogin],
  );

  const goFullscreen = useCallback(() => { rootRef.current?.requestFullscreen?.().catch(() => { /* needs a click: the overlay still fills the window */ }); }, []);
  useEffect(() => {
    goFullscreen();
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => { document.removeEventListener('fullscreenchange', onChange); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };
  }, [goFullscreen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [round, camera.id]);

  useEffect(() => {
    if (!recipes) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    setElapsed(0); setPlaying(null); setStill(null);
    setSteps(recipes.map((recipe) => ({ recipe, state: 'waiting', note: '' })));
    const mark = (i: number, state: StepState, note = '') => setSteps((prev) => prev.map((s, k) => (k === i ? { ...s, state, note } : s)));
    (async () => {
      for (let i = 0; i < recipes.length && !cancelled; i++) {
        mark(i, 'trying');
        const attempt = startRecipe(recipes[i], { camera, camId, media, email: streamAccessEmail, password: streamAccessPassword, video, setStill });
        cleanup = attempt.cleanup;
        try {
          await attempt.ready;
          if (cancelled) return;
          mark(i, 'ok'); setPlaying(recipes[i]);
          // Stay on the recipe that worked; if its picture stops for 20 s, start the whole list again.
          if (recipes[i] !== 'stills') {
            let last = -1, stale = 0;
            await new Promise<void>((resolve) => {
              const t = setInterval(() => {
                if (cancelled) { clearInterval(t); resolve(); return; }
                if (video.currentTime > last) { stale = 0; last = video.currentTime; } else if (++stale >= 7) { clearInterval(t); resolve(); }
              }, 3000);
            });
            if (!cancelled) { attempt.cleanup(); cleanup = null; setRound((r) => r + 1); }
          }
          return;
        } catch (e) {
          attempt.cleanup(); cleanup = null;
          if (cancelled) return;
          mark(i, 'failed', e instanceof Error ? e.message : 'failed');
        }
      }
    })();
    return () => { cancelled = true; cleanup?.(); };
  }, [recipes, round, camera, camId, media, streamAccessEmail, streamAccessPassword]);

  const allFailed = recipes !== null && steps.length > 0 && steps.every((s) => s.state === 'failed');
  const title = (camId ?? camera.name).toUpperCase();

  return (
    <div ref={rootRef} style={{ top: 'var(--alert-h, 0px)' }} className="fixed inset-x-0 bottom-0 z-[90] bg-black text-white flex flex-col" role="dialog" aria-label={`Camera ${title}`} data-testid="camera-overlay">
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-black/80 border-b border-white/10">
        <div className="min-w-0">
          <p className="text-sm font-bold font-mono truncate">{title} <span className="font-sans font-normal text-white/60">{camera.name.replace(new RegExp(`^${title}\\s*[-–:]?\\s*`, 'i'), '')}</span></p>
          <p className="text-[11px] text-white/60" aria-live="polite">
            {playing ? `Playing through: ${RECIPE_LABEL[playing]}` : allFailed ? 'No way of playing this camera worked' : recipes === null ? 'Preparing…' : `Trying each way of playing it… ${elapsed} s`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(allFailed || playing) && <button onClick={() => setRound((r) => r + 1)} className="h-9 px-3 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold flex items-center gap-1.5" title="Start again from the first way of playing"><RefreshCw className="w-3.5 h-3.5" /> Retry</button>}
          <button onClick={() => (full ? document.exitFullscreen?.() : goFullscreen())} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center" aria-label={full ? 'Leave full screen' : 'Full screen'}>
            {full ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={onClose} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center" aria-label="Close camera"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {alert && (
        <div role="alert" className="flex items-start gap-2.5 px-4 py-2.5 bg-red-600 text-white text-sm font-semibold">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0"><span className="uppercase tracking-wide mr-2">{alert.title}</span><span className="font-normal opacity-95">{alert.detail}</span></span>
        </div>
      )}

      <div className="relative flex-1 min-h-0 bg-black">
        <video ref={videoRef} className={cn('absolute inset-0 w-full h-full object-contain', playing === 'stills' && 'hidden')} autoPlay muted playsInline />
        {playing === 'stills' && still && <img src={still} alt={`${title} latest picture`} className="absolute inset-0 w-full h-full object-contain" />}

        {!playing && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="w-full max-w-md rounded-2xl bg-black/80 border border-white/15 p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {allFailed ? <XCircle className="w-4 h-4 text-red-400" /> : <Loader2 className="w-4 h-4 animate-spin" />}
                {allFailed ? 'This camera did not open' : `Opening ${title}…`}
              </div>
              {recipes !== null && recipes.length === 0 && (
                <p className="text-xs text-white/70">There is no way to play this camera from here: enter the stream access email and password under Settings, or turn on the media server.</p>
              )}
              <ol className="space-y-1.5 text-xs">
                {steps.map((s) => (
                  <li key={s.recipe} className="flex items-start gap-2">
                    {s.state === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-emerald-400" /> : s.state === 'failed' ? <XCircle className="w-3.5 h-3.5 mt-0.5 text-red-400" /> : s.state === 'trying' ? <Loader2 className="w-3.5 h-3.5 mt-0.5 animate-spin" /> : <Circle className="w-3.5 h-3.5 mt-0.5 text-white/30" />}
                    <span className={cn(s.state === 'waiting' && 'text-white/40')}>{RECIPE_LABEL[s.recipe]}{s.state === 'trying' ? ' — trying' : ''}{s.state === 'failed' ? ` — failed (${s.note})` : ''}</span>
                  </li>
                ))}
              </ol>
              {!allFailed && <p className="text-[11px] text-white/50">Slow cameras can take up to a minute. It tries the next way automatically.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
