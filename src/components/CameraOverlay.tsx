import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertTriangle, CheckCircle2, History, Loader2, Maximize2, Minimize2, RefreshCw, Sparkles, X, XCircle, Circle } from 'lucide-react';
import { cn } from '../lib/utils';
import { CameraConfig, LogEntry } from '../types';
import { gridCamId, mediaPathId, mediaAuthHeader, mediaPlaylistUrl, useMediaConfig, type MediaConfig } from '../lib/mediaServer';
import { startWhep } from '../lib/whepClient';
import { plannedRecipes, RECIPE_LABEL, type RecipeId } from '../lib/panelTiles';
import type { TrackAlert } from '../lib/tracking';
import { captureFrame, setLastFrame } from '../lib/lastFrame';
import { factsFromAnswer, markOf, shouldRecord, type LiveMark } from '../lib/liveAnalysis';

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

interface Ctx { camera: CameraConfig; camId: string | null; mediaId: string | null; media: MediaConfig | null; email: string; password: string; video: HTMLVideoElement; setStill: (url: string | null) => void }

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
  if (recipe === 'media' && c.media && c.mediaId) {
    return startHls(c.video, mediaPlaylistUrl(c.media, c.mediaId), { Authorization: mediaAuthHeader(c.media) }, RECIPE_TIMEOUT_MS.media);
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

const AI_INTERVAL_MS = 10_000;
const AI_MAX_SIDE = 1024;

/** What the scene analysis said about one frame, as shown in the caption. */
interface Caption { summary: string; people: number; vehicles: number; plates: string[]; alerts: string[]; unusual: boolean; at: Date; saved?: boolean }

/** The picture now on screen (the playing video, or the refreshed still) as base64 JPEG, at most 1024 px on the long side. */
function grabBase64(el: HTMLVideoElement | HTMLImageElement | null): string {
  if (!el) throw new Error('There is no picture to analyse yet.');
  const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth, h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  if (!w || !h) throw new Error('There is no picture to analyse yet.');
  const k = Math.min(1, AI_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  const b64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  if (!b64) throw new Error('Could not capture the picture.');
  return b64;
}

interface Props {
  camera: CameraConfig;
  streamAccessEmail: string;
  streamAccessPassword: string;
  alert?: TrackAlert | null;
  onClose: () => void;
  /** The Logs entries of this camera (the same list as the Logs section), newest first: shown in the History sidebar. */
  history?: LogEntry[];
  /** Saves what the AI view says about the picture as a log entry, like every other analysis. */
  onAnalysis?: (camera: CameraConfig, data: Record<string, unknown>) => Promise<void> | void;
}

/**
 * One camera, full screen. Nothing loads until it is opened; then each way of playing it is tried in turn
 * (media server, WebRTC, the app's proxy, refreshed stills) until one shows a picture, and the list shows how far it got.
 */
export default function CameraOverlay({ camera, streamAccessEmail, streamAccessPassword, alert, onClose, history = [], onAnalysis }: Props) {
  const media = useMediaConfig();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stillRef = useRef<HTMLImageElement | null>(null);
  const [aiOn, setAiOn] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const markRef = useRef<LiveMark | null>(null);
  const onAnalysisRef = useRef(onAnalysis);
  onAnalysisRef.current = onAnalysis;
  const [aiBusy, setAiBusy] = useState(false);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [still, setStill] = useState<string | null>(null);
  const [playing, setPlaying] = useState<RecipeId | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [round, setRound] = useState(0);
  const [full, setFull] = useState(false);
  const camId = gridCamId(camera.remoteStreamUrl);
  const mediaId = mediaPathId(camera.remoteStreamUrl);
  const hasLogin = !!(streamAccessEmail && streamAccessPassword);

  const recipes = useMemo(
    () => (media === null ? null : plannedRecipes({ camId, mediaId, url: camera.remoteStreamUrl, hlsSupported: Hls.isSupported(), media, hasLogin })),
    [media, camId, mediaId, camera.remoteStreamUrl, hasLogin],
  );

  const goFullscreen = useCallback(() => { rootRef.current?.requestFullscreen?.().catch(() => { /* needs a click: the overlay still fills the window */ }); }, []);
  useEffect(() => {
    goFullscreen();
    const onChange = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => { document.removeEventListener('fullscreenchange', onChange); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); };
  }, [goFullscreen]);
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
        const attempt = startRecipe(recipes[i], { camera, camId, mediaId, media, email: streamAccessEmail, password: streamAccessPassword, video, setStill });
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
  }, [recipes, round, camera, camId, mediaId, media, streamAccessEmail, streamAccessPassword]);

  // AI captions: while the button is on and the camera shows a picture, one frame every 10 s goes to the scene analysis (one at a time),
  // and what it says is shown at the bottom. Off when the camera closes or the button is pressed again; nothing is stored from here.
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // The last frame, for the camera's tile. While a picture shows, a small copy of it is kept every 2 s; when the window closes (the button, Escape,
  // or the parent removing it) the newest frame is stored for this camera, and only then does its tile in Feed > Full Panel change.
  const lastShotRef = useRef<string | null>(null);
  useEffect(() => {
    if (!playing) return;
    const snap = () => { const url = captureFrame(playing === 'stills' ? stillRef.current : videoRef.current); if (url) lastShotRef.current = url; };
    snap();
    const t = setInterval(snap, 2000);
    return () => clearInterval(t);
  }, [playing]);
  const keepLast = useCallback(() => {
    const live = playingRef.current === 'stills' ? stillRef.current : videoRef.current;
    const url = captureFrame(live) ?? lastShotRef.current;
    lastShotRef.current = null; // written once
    if (url) setLastFrame(camera.id, url);
  }, [camera.id]);
  const close = useCallback(() => { keepLast(); onClose(); }, [keepLast, onClose]);
  useEffect(() => () => { keepLast(); }, [keepLast]); // closed from outside (for example an alert opened another camera)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => {
    setCaption(null); setAiError(null);
    markRef.current = null; // the first answer of a new run is always saved
    if (!aiOn) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (playingRef.current) {
        setAiBusy(true);
        try {
          const jpeg = grabBase64(playingRef.current === 'stills' ? stillRef.current : videoRef.current);
          const res = await fetch('/api/gemini/analyze-frame', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: jpeg, knownFaces: [], watchlist: [], camera: { id: camera.id, name: camera.name, sensitivity: camera.sensitivity, peopleThreshold: camera.peopleThreshold, vehicleThreshold: camera.vehicleThreshold, suspiciousRules: camera.suspiciousRules, aiAnalysis: camera.aiAnalysis } }),
          });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `The analysis answered ${res.status}.`);
          const d = await res.json();
          if (!stopped) {
            setCaption({
              summary: String(d.summary ?? '').trim() || 'Nothing to report.', people: Number(d.counts?.people) || 0, vehicles: Number(d.counts?.vehicles) || 0,
              plates: Array.isArray(d.detected_plates) ? d.detected_plates.map(String).slice(0, 4) : [], alerts: Array.isArray(d.alerts) ? d.alerts.map(String).slice(0, 3) : [], unusual: !!d.isUnusual, at: new Date(),
            });
            setAiError(null);
            // Save it as a log entry (Logs section, this camera's history) when it is the first, when what it reports has changed, or once a minute.
            const facts = factsFromAnswer(d), nowMs = Date.now();
            if (onAnalysisRef.current && shouldRecord(markRef.current, facts, nowMs)) {
              markRef.current = markOf(facts, nowMs);
              Promise.resolve(onAnalysisRef.current(camera, d)).then(() => { if (!stopped) setCaption((c) => (c ? { ...c, saved: true } : c)); }).catch(() => { if (!stopped) setAiError('The description could not be saved to the Logs.'); });
            }
          }
        } catch (e) { if (!stopped) setAiError(e instanceof Error ? e.message : 'The analysis failed.'); }
        finally { if (!stopped) setAiBusy(false); }
      }
      if (!stopped) timer = setTimeout(() => void tick(), AI_INTERVAL_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); setAiBusy(false); };
  }, [aiOn, camera.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <button onClick={() => setHistoryOpen((v) => !v)} className={cn('h-9 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5', historyOpen ? 'bg-accent text-white' : 'bg-white/10 hover:bg-white/20')} aria-pressed={historyOpen} title="Earlier analyses of this camera (the same entries as the Logs section)" data-testid="overlay-history">
            <History className="w-4 h-4" /> History{history.length > 0 && <span className="ml-0.5 rounded-full bg-white/20 px-1.5 text-[10px]">{history.length}</span>}
          </button>
          <button onClick={() => (full ? document.exitFullscreen?.() : goFullscreen())} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center" aria-label={full ? 'Leave full screen' : 'Full screen'}>
            {full ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button onClick={close} className="w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center" aria-label="Close camera"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {alert && (
        <div role="alert" className="flex items-start gap-2.5 px-4 py-2.5 bg-red-600 text-white text-sm font-semibold">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0"><span className="uppercase tracking-wide mr-2">{alert.title}</span><span className="font-normal opacity-95">{alert.detail}</span></span>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
      <div className="relative flex-1 min-w-0 bg-black">
        <video ref={videoRef} className={cn('absolute inset-0 w-full h-full object-contain', playing === 'stills' && 'hidden')} autoPlay muted playsInline />
        {playing === 'stills' && still && <img ref={stillRef} src={still} alt={`${title} latest picture`} className="absolute inset-0 w-full h-full object-contain" />}

        {playing && (
          <button
            onClick={() => setAiOn((v) => !v)}
            className={cn('absolute top-3 left-1/2 -translate-x-1/2 z-10 h-9 px-4 rounded-full text-xs font-semibold flex items-center gap-2 border backdrop-blur', aiOn ? 'bg-accent text-white border-accent' : 'bg-black/60 text-white border-white/25 hover:bg-black/80')}
            aria-pressed={aiOn} title={aiOn ? 'Stop the AI captions' : 'Describe what the camera sees, every 10 seconds'} data-testid="overlay-ai"
          >
            {aiBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            AI {aiOn ? 'on' : 'off'}
          </button>
        )}

        {aiOn && playing && (aiError || caption || aiBusy) && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-[min(90%,52rem)] pointer-events-none" data-testid="overlay-caption" aria-live="polite">
            <div className={cn('rounded-xl px-4 py-3 text-center backdrop-blur-md border', aiError || caption?.unusual ? 'bg-red-950/80 border-red-400/50' : 'bg-black/75 border-white/15')}>
              {aiError ? (
                <p className="text-sm text-red-200">AI analysis: {aiError}</p>
              ) : caption ? (<>
                <p className="text-sm sm:text-base leading-snug">{caption.summary}</p>
                <p className="mt-1.5 text-[11px] text-white/70 flex flex-wrap justify-center gap-x-3 gap-y-0.5">
                  <span>{caption.people} {caption.people === 1 ? 'person' : 'people'}</span><span>{caption.vehicles} {caption.vehicles === 1 ? 'vehicle' : 'vehicles'}</span>
                  {caption.plates.length > 0 && <span className="font-mono">{caption.plates.join(' · ')}</span>}
                  <span>{caption.at.toLocaleTimeString()}{aiBusy ? ' · updating…' : ''}{caption.saved ? ' · saved to Logs' : ''}</span>
                </p>
                {caption.alerts.length > 0 && <p className="mt-1 text-xs font-semibold text-red-300">{caption.alerts.join(' · ')}</p>}
              </>) : <p className="text-sm text-white/80">Analysing the first picture…</p>}
            </div>
          </div>
        )}

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
      {historyOpen && (
        <aside className="w-80 max-w-[85vw] shrink-0 border-l border-white/10 bg-black/90 flex flex-col" aria-label={`Analysis history of ${title}`} data-testid="overlay-history-panel">
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10">
            <p className="text-sm font-semibold flex items-center gap-2"><History className="w-4 h-4" /> History <span className="text-white/50 font-normal">{history.length}</span></p>
            <button onClick={() => setHistoryOpen(false)} className="w-7 h-7 rounded-md bg-white/10 hover:bg-white/20 flex items-center justify-center" aria-label="Close history"><X className="w-3.5 h-3.5" /></button>
          </div>
          <p className="px-4 py-2 text-[11px] text-white/50">The same entries as the Logs section, for this camera, newest first. Turn AI on to add to it.</p>
          {history.length === 0 && <p className="px-4 py-6 text-xs text-white/60" data-testid="overlay-history-empty">No analysis of this camera yet.</p>}
          <ul className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
            {history.map((l) => (
              <li key={l.id} className={cn('rounded-lg border px-3 py-2 text-xs', l.isUnusual || l.isWatchlistMatch ? 'border-red-400/50 bg-red-950/50' : 'border-white/10 bg-white/5')} data-testid="overlay-history-item">
                <p className="text-[10px] text-white/50">{new Date(l.timestamp).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}{l.isWatchlistMatch ? ' · watchlist hit' : l.isUnusual ? ' · unusual' : ''}</p>
                <p className="mt-0.5 leading-snug">{l.summary.replace(/\s*People: N\/A$/, '')}</p>
                <p className="mt-1 text-[10px] text-white/60 flex flex-wrap gap-x-2">
                  <span>{l.counts.people} people</span><span>{l.counts.vehicles} vehicles</span>
                  {l.detectedPlates && l.detectedPlates.length > 0 && <span className="font-mono">{l.detectedPlates.join(' · ')}</span>}
                </p>
                {l.alerts.length > 0 && <p className="mt-1 text-[11px] font-semibold text-red-300">{l.alerts.join(' · ')}</p>}
              </li>
            ))}
          </ul>
        </aside>
      )}
      </div>
    </div>
  );
}
