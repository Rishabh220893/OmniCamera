import { useEffect, useRef, useState, useCallback, MutableRefObject } from 'react';
import Hls from 'hls.js';
import { AlertTriangle, RefreshCw, Video, Info } from 'lucide-react';
import { CameraConfig, CameraMediaRefs } from '../types';
import { detectStreamType, unsupportedReason } from '../lib/streamAdapters';
import { cn } from '../lib/utils';

export type FeedStatus = 'connecting' | 'live' | 'error';

interface CameraFeedProps {
  camera: CameraConfig;
  /** Renders bounding-box labels and the larger simulated-feed detail; false = compact grid tile. */
  isFocused: boolean;
  isCapturing: boolean;
  /** True for every camera currently targeted by the analysis loop —
   *  independent of isFocused, since grid mode has no single "focused" tile
   *  but analysis still needs each selected camera's live DOM node. */
  reportRefs?: boolean;
  mediaRefs?: MutableRefObject<Map<string, CameraMediaRefs>>;
  onCameraError?: (message: string | null) => void;
  onFallbackToSimulated?: () => void;
  /** Forwarded to the /api/proxy-hls server route, which sends it upstream
   *  as HTTP Basic Auth (empty username) for password-gated CDN hosts. */
  streamAccessPassword?: string;
  /** Lets a grid tile show a real connecting/live/error indicator instead of
   *  either playing video or nothing — a blank tile during a slow upstream
   *  connection otherwise reads as broken rather than working. */
  onStatusChange?: (status: FeedStatus) => void;
}

type SimEntity = {
  id: string; type: 'person' | 'vehicle'; x: number; y: number;
  speed: number; color: string; label: string; dir: 1 | -1;
};

const SIM_SEED: SimEntity[] = [
  { id: '1', type: 'person', x: 80, y: 70, speed: 1.1, color: '#2f5fdd', label: 'Member: Alice (98%)', dir: 1 },
  { id: '2', type: 'person', x: 420, y: 75, speed: 0.8, color: '#c8392a', label: 'Unknown Person', dir: -1 },
  { id: '3', type: 'vehicle', x: -150, y: 120, speed: 2.8, color: '#1f8a5f', label: 'Delivery Truck', dir: 1 }
];

// Per the grid's own integrator guide: "Reconnect automatically, with
// backoff (~2s → cap ~30s). Do not reconnect in a tight loop."
const BASE_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

export default function CameraFeed({ camera, isFocused, isCapturing, reportRefs, mediaRefs, onCameraError, onFallbackToSimulated, streamAccessPassword, onStatusChange }: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteImgRef = useRef<HTMLImageElement>(null);
  const simCanvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<SimEntity[]>([]);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const retryDelayRef = useRef(BASE_RETRY_DELAY_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  const isSimulated = !!camera.useSimulatedFeed;
  const isRemote = !!camera.useRemoteFeed && !!camera.remoteStreamUrl;
  const streamType = isRemote ? detectStreamType(camera.remoteStreamUrl) : null;

  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);
  // A simulated feed "connects" instantly — it's a local canvas animation,
  // never a real network round-trip.
  useEffect(() => { if (isSimulated) setStatus('live'); }, [isSimulated]);
  // 'unsupported' can never play; 'iframe' has no cross-origin load signal
  // to hook into, so it's treated as live on a best-effort basis.
  useEffect(() => {
    if (streamType === 'unsupported') setStatus('error');
    else if (streamType === 'iframe') setStatus('live');
  }, [streamType]);

  // Report live DOM refs upward only while this instance is an analysis
  // target, keyed by camera id so multiple cameras can report concurrently.
  useEffect(() => {
    if (!mediaRefs || !reportRefs) return;
    mediaRefs.current.set(camera.id, { video: videoRef.current, img: remoteImgRef.current, canvas: simCanvasRef.current });
    return () => { mediaRefs.current.delete(camera.id); };
  });

  // Local webcam lifecycle
  const startCamera = useCallback(async () => {
    if (isRemote || isSimulated) {
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
        activeStreamRef.current = null;
      }
      return;
    }
    setStatus('connecting');
    try {
      if (activeStreamRef.current) activeStreamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camera.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      activeStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setLocalError(null);
      onCameraError?.(null);
      setStatus('live');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown camera error';
      const lower = msg.toLowerCase();
      const isHardwareIssue = ['device not found', 'devices not found', 'notfounderror', 'permission denied', 'notreadableerror', 'overconstrainederror'].some(m => lower.includes(m));
      if (isHardwareIssue) {
        onFallbackToSimulated?.();
        setLocalError(null);
        onCameraError?.(null);
      } else {
        setLocalError(msg);
        onCameraError?.(msg);
        setStatus('error');
      }
    }
  }, [camera.facingMode, isRemote, isSimulated, onCameraError, onFallbackToSimulated]);

  useEffect(() => {
    startCamera();
    return () => {
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(t => t.stop());
        activeStreamRef.current = null;
      }
    };
  }, [camera.id, camera.facingMode, isRemote, isSimulated, startCamera]);

  // HLS playback — browsers don't decode .m3u8 natively (except Safari),
  // so this feeds the same <video> element via MediaSource Extensions.
  // Frame capture (App.tsx captureAndAnalyze) draws from that same element,
  // so nothing else needs to know HLS is involved.
  useEffect(() => {
    if (!isRemote || streamType !== 'hls') return;
    const video = videoRef.current;
    if (!video) return;
    setRemoteError(null);
    setStatus('connecting');
    let cancelled = false;
    let verifyTimer: ReturnType<typeof setInterval> | null = null;

    // The integrator guide for this grid is explicit: "attaching mid-stream
    // can produce decoder messages ... until the first IDR frame arrives.
    // This is normal and self-corrects." hls.js's own 'playing' event fires
    // the instant the video starts consuming data — it says nothing about
    // whether the decoded frame is an actual picture or a corrupt/black one
    // from exactly that join hiccup. That gap is why the UI could show a
    // camera as "live" while it was really a frozen black frame. Before
    // trusting "live", confirm the visible frame is actually changing.
    const startFrameVerification = () => {
      if (verifyTimer || cancelled) return;
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { setStatus('live'); return; }
      let lastSample: Uint8ClampedArray | null = null;
      let staleCycles = 0;
      let everConfirmedLive = false;
      // Runs for the connection's whole lifetime, not just once at attach —
      // a HAR capture showed segments succeeding but taking ~30s to
      // download 6s of video, which starves playback just as surely as an
      // outright failure once the initial buffer runs dry. Without an
      // ongoing check, a feed that verified live and later froze would
      // stay marked "live" forever.
      verifyTimer = setInterval(() => {
        let current: Uint8ClampedArray | null = null;
        try {
          ctx.drawImage(video, 0, 0, 16, 16);
          current = ctx.getImageData(0, 0, 16, 16).data;
        } catch { /* video not ready for this sample yet */ }
        if (current && lastSample) {
          let diff = 0;
          for (let i = 0; i < current.length; i += 4) diff += Math.abs(current[i] - lastSample[i]);
          if (diff > 40) {
            staleCycles = 0;
            if (!everConfirmedLive) { everConfirmedLive = true; retryDelayRef.current = BASE_RETRY_DELAY_MS; }
            setStatus('live');
          } else if (everConfirmedLive) {
            staleCycles += 1;
            if (staleCycles >= 4) { // ~6s with no visible change after having been genuinely live
              if (verifyTimer) { clearInterval(verifyTimer); verifyTimer = null; }
              scheduleReconnect('Stream stalled — no new frames arriving.');
            }
          }
        }
        if (current) lastSample = current;
      }, 1500);
    };
    const handlePlaying = () => startFrameVerification();
    video.addEventListener('playing', handlePlaying);

    // The guide: "Reconnect automatically, with backoff (~2s → cap ~30s).
    // Do not reconnect in a tight loop." A manual-only retry button doesn't
    // meet that, and hls.js only reports a fatal error after exhausting its
    // own retry budget — which at this origin's ~45-50s per-attempt timeouts
    // can take minutes — so a watchdog also triggers reconnection if nothing
    // has actually confirmed live by then.
    const scheduleReconnect = (message: string) => {
      if (cancelled) return;
      setRemoteError(message);
      setStatus('error');
      if (retryTimerRef.current) return; // a reconnect is already pending
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        retryDelayRef.current = Math.min(MAX_RETRY_DELAY_MS, retryDelayRef.current * 2);
        setRetryGeneration((g) => g + 1);
      }, retryDelayRef.current);
    };
    const watchdog = setTimeout(() => {
      scheduleReconnect('Timed out waiting for a real picture from this stream.');
    }, 90_000);
    const clearWatchdog = () => clearTimeout(watchdog);
    video.addEventListener('playing', clearWatchdog);

    // Always routed through our own server, never fetched by the browser
    // directly — a cross-origin camera CDN without CORS headers blocks
    // hls.js (and even a plain <video> load) outright otherwise, and this
    // also keeps the access password off the wire between browser and
    // camera host entirely.
    const proxiedUrl = (url: string, extraPasswordQuery: boolean) =>
      `/api/proxy-hls?url=${encodeURIComponent(url)}${extraPasswordQuery && streamAccessPassword ? `&password=${encodeURIComponent(streamAccessPassword)}` : ''}`;

    let hls: Hls | null = null;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari's native HLS has no request-interception hook to attach a
      // header, so the password (if any) rides as a query param instead —
      // the proxy rewrites it onto every segment URL it returns too.
      video.src = proxiedUrl(camera.remoteStreamUrl, true);
    } else if (Hls.isSupported()) {
      hls = new Hls({
        maxLiveSyncPlaybackRate: 1.5,
        // hls.js's defaults (manifestLoadingTimeOut: 10s, fragLoadingTimeOut:
        // 20s) are shorter than this origin's real response times (its
        // manifest alone can take 20-45s) — hls.js was very likely aborting
        // and retrying on its own schedule before the server-side proxy
        // timeout ever got a chance to respond. These give the real
        // round-trip room to complete instead of racing it.
        // maxRetry is 0 everywhere — hls.js retrying internally at the full
        // 50s timeout, on top of the backoff-reconnect wrapper below (which
        // fully re-creates hls.js after a fatal error), was compounding:
        // a single failing camera could pay a 2-retry, ~100s+ tax per
        // stage before ever reaching fatal and letting the backoff logic
        // run at all. One clean attempt per stage, then hand off to the
        // properly-paced (2s → 30s) reconnect instead.
        manifestLoadingTimeOut: 50_000,
        manifestLoadingMaxRetry: 0,
        levelLoadingTimeOut: 50_000,
        levelLoadingMaxRetry: 0,
        // A HAR capture showed every segment request needing as long as a
        // manifest fetch on this origin (both ~20-45s) — matching that here
        // too, since 25s was cutting segments off before the proxy's own
        // (now 45s) attempt could ever complete.
        fragLoadingTimeOut: 50_000,
        fragLoadingMaxRetry: 0,
        xhrSetup: (xhr) => {
          if (streamAccessPassword) xhr.setRequestHeader('X-Stream-Password', streamAccessPassword);
        },
      });
      hls.loadSource(proxiedUrl(camera.remoteStreamUrl, false));
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Non-fatal errors (including the "Could not find ref with POC" /
        // RPS-construction warnings the guide calls out as normal on join,
        // before the first IDR arrives) are deliberately ignored here —
        // hls.js recovers from those on its own, and escalating them would
        // do exactly what the guide warns against: "pipelines that abort on
        // the first decoder error will bounce on those streams."
        if (data.fatal) {
          clearWatchdog();
          const authHint = data.response?.code === 401 || data.response?.code === 403
            ? ' — check the Stream Access Password in Setup.'
            : '';
          scheduleReconnect(`HLS playback error (${data.type}): ${data.details}${authHint}`);
        }
      });
    } else {
      setRemoteError('This browser does not support HLS playback.');
      setStatus('error');
      clearWatchdog();
    }

    return () => {
      cancelled = true;
      clearWatchdog();
      if (verifyTimer) clearInterval(verifyTimer);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('playing', clearWatchdog);
      hls?.destroy();
    };
  }, [isRemote, streamType, camera.remoteStreamUrl, streamAccessPassword, retryGeneration]);

  // Simulated feed animation loop — self-contained per instance so grid tiles
  // each animate independently.
  useEffect(() => {
    if (!isSimulated) return;
    const canvas = simCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (entitiesRef.current.length === 0) entitiesRef.current = SIM_SEED.map(e => ({ ...e }));

    let raf: number;
    const draw = () => {
      if (canvas.width !== 640) { canvas.width = 640; canvas.height = 360; }
      const w = canvas.width, h = canvas.height;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, h - 100, w, 100);
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 3;
      ctx.strokeRect(w / 2 - 40, h - 180, 80, 80);
      ctx.fillStyle = '#020617';
      ctx.fillRect(w / 2 - 40, h - 180, 80, 80);

      entitiesRef.current.forEach(ent => {
        ent.x += ent.speed * ent.dir;
        if (ent.dir === 1 && ent.x > w + 120) ent.x = -80;
        if (ent.dir === -1 && ent.x < -120) ent.x = w + 80;

        ctx.save();
        if (ent.type === 'person') {
          const py = h - 100;
          ctx.fillStyle = ent.color;
          ctx.beginPath(); ctx.arc(ent.x, py - 35, 9, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath();
          ctx.moveTo(ent.x - 10, py - 24); ctx.lineTo(ent.x + 10, py - 24);
          ctx.lineTo(ent.x + 7, py + 10); ctx.lineTo(ent.x - 7, py + 10);
          ctx.closePath(); ctx.fill();

          const walk = Math.sin(Date.now() * 0.008 * ent.speed) * 6;
          ctx.strokeStyle = ent.color; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(ent.x - 3, py + 10); ctx.lineTo(ent.x - 3 + walk, py + 26); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(ent.x + 3, py + 10); ctx.lineTo(ent.x + 3 - walk, py + 26); ctx.stroke();

          ctx.strokeStyle = ent.color; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
          ctx.strokeRect(ent.x - 18, py - 48, 36, 78); ctx.setLineDash([]);

          if (isFocused) {
            ctx.fillStyle = ent.color; ctx.font = 'bold 9px monospace';
            const tw = ctx.measureText(ent.label).width;
            ctx.fillRect(ent.x - 18, py - 60, tw + 6, 12);
            ctx.fillStyle = '#ffffff'; ctx.fillText(ent.label, ent.x - 15, py - 51);
          }
        } else {
          const vy = h - 75;
          ctx.fillStyle = ent.color;
          ctx.fillRect(ent.x - 30, vy - 15, 60, 20);
          ctx.fillRect(ent.x - 15, vy - 25, 30, 11);
          ctx.fillStyle = '#020617';
          ctx.beginPath(); ctx.arc(ent.x - 18, vy + 7, 6, 0, Math.PI * 2); ctx.arc(ent.x + 18, vy + 7, 6, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = ent.color; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
          ctx.strokeRect(ent.x - 33, vy - 28, 66, 38); ctx.setLineDash([]);

          if (isFocused) {
            ctx.fillStyle = ent.color; ctx.font = 'bold 9px monospace';
            const tw = ctx.measureText(ent.label).width;
            ctx.fillRect(ent.x - 33, vy - 40, tw + 6, 12);
            ctx.fillStyle = '#ffffff'; ctx.fillText(ent.label, ent.x - 30, vy - 31);
          }
        }
        ctx.restore();
      });

      ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
      ctx.fillRect(0, 0, w, 24);
      ctx.fillStyle = '#10b981'; ctx.font = '9px monospace';
      ctx.fillText('SIMULATED_FEED // ANALYZING', 10, 15);
      if (Math.floor(Date.now() / 600) % 2 === 0) {
        ctx.fillStyle = '#ef4444';
        ctx.beginPath(); ctx.arc(w - 16, 12, 3, 0, Math.PI * 2); ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [isSimulated, isFocused]);

  if (isSimulated) {
    return <canvas ref={simCanvasRef} className="w-full h-full object-cover" />;
  }

  if (isRemote) {
    if (streamType === 'unsupported') {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-surface-muted gap-3">
          <Info className="w-6 h-6 text-ink-muted" strokeWidth={1.75} />
          <p className="text-xs text-ink-muted max-w-sm leading-relaxed">{unsupportedReason(camera.remoteStreamUrl)}</p>
        </div>
      );
    }
    if (streamType === 'iframe') {
      return (
        <iframe
          key={camera.id}
          src={camera.remoteStreamUrl}
          className="w-full h-full border-none bg-surface-muted"
          allow="autoplay; fullscreen; camera; microphone"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
        />
      );
    }
    if (streamType === 'image') {
      return (
        <img
          key={camera.id} ref={remoteImgRef} src={camera.remoteStreamUrl} crossOrigin="anonymous"
          className="w-full h-full object-cover" alt={camera.name}
          onLoad={() => setStatus('live')} onError={() => setStatus('error')}
        />
      );
    }
    if (remoteError && isFocused) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-surface-muted gap-3">
          <AlertTriangle className="w-6 h-6 text-critical" strokeWidth={1.75} />
          <p className="text-xs text-critical max-w-sm leading-relaxed">{remoteError}</p>
        </div>
      );
    }
    // 'hls' and plain 'video' both render into the same element — HLS is
    // attached via the effect above instead of a bare src for non-Safari browsers.
    return (
      <video
        key={camera.id} ref={videoRef} src={streamType === 'hls' ? undefined : camera.remoteStreamUrl}
        autoPlay playsInline muted crossOrigin="anonymous" className="w-full h-full object-cover"
        onPlaying={() => setStatus('live')}
        onError={() => { if (streamType !== 'hls') setStatus('error'); }}
      />
    );
  }

  if (localError && isFocused) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center bg-surface-muted">
        <div className="w-14 h-14 rounded-2xl bg-critical-soft flex items-center justify-center mb-4">
          <AlertTriangle className="w-7 h-7 text-critical" strokeWidth={1.75} />
        </div>
        <h3 className="text-sm font-bold text-ink mb-1">Camera access error</h3>
        <p className="text-critical text-xs max-w-md mb-4">{localError}</p>
        <button onClick={startCamera} className="btn-secondary text-xs">
          <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} /> Retry connection
        </button>
      </div>
    );
  }

  if (localError) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-surface-muted text-ink-muted">
        <Video className="w-6 h-6" strokeWidth={1.5} />
      </div>
    );
  }

  return <video key={camera.id} ref={videoRef} autoPlay playsInline muted className={cn('w-full h-full object-cover', !isCapturing && 'grayscale-[0.2]')} />;
}
