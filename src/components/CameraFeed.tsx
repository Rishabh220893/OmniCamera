import { useEffect, useRef, useState, useCallback, MutableRefObject } from 'react';
import Hls from 'hls.js';
import { AlertTriangle, RefreshCw, Video, Info } from 'lucide-react';
import { CameraConfig, CameraMediaRefs } from '../types';
import { detectStreamType, unsupportedReason } from '../lib/streamAdapters';
import { cn } from '../lib/utils';

interface CameraFeedProps {
  camera: CameraConfig;
  /** Renders bounding-box labels and the larger simulated-feed detail; false = compact grid tile. */
  isFocused: boolean;
  isCapturing: boolean;
  /** True only for the camera currently targeted by the analysis loop — independent
   *  of isFocused, since grid mode has no single "focused" tile but analysis still
   *  needs one camera's live DOM node to capture from. */
  reportRefs?: boolean;
  mediaRefs?: MutableRefObject<CameraMediaRefs>;
  onCameraError?: (message: string | null) => void;
  onFallbackToSimulated?: () => void;
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

export default function CameraFeed({ camera, isFocused, isCapturing, reportRefs, mediaRefs, onCameraError, onFallbackToSimulated }: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteImgRef = useRef<HTMLImageElement>(null);
  const simCanvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<SimEntity[]>([]);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const isSimulated = !!camera.useSimulatedFeed;
  const isRemote = !!camera.useRemoteFeed && !!camera.remoteStreamUrl;
  const streamType = isRemote ? detectStreamType(camera.remoteStreamUrl) : null;

  // Report live DOM refs upward only while this instance is the analysis target.
  useEffect(() => {
    if (!mediaRefs || !reportRefs) return;
    mediaRefs.current = { video: videoRef.current, img: remoteImgRef.current, canvas: simCanvasRef.current };
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
    try {
      if (activeStreamRef.current) activeStreamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: camera.facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      activeStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setLocalError(null);
      onCameraError?.(null);
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

    let hls: Hls | null = null;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = camera.remoteStreamUrl;
    } else if (Hls.isSupported()) {
      hls = new Hls({ maxLiveSyncPlaybackRate: 1.5 });
      hls.loadSource(camera.remoteStreamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setRemoteError(`HLS playback error (${data.type}): ${data.details}`);
        }
      });
    } else {
      setRemoteError('This browser does not support HLS playback.');
    }

    return () => { hls?.destroy(); };
  }, [isRemote, streamType, camera.remoteStreamUrl]);

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
      return <img key={camera.id} ref={remoteImgRef} src={camera.remoteStreamUrl} crossOrigin="anonymous" className="w-full h-full object-cover" alt={camera.name} />;
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
    return <video key={camera.id} ref={videoRef} src={streamType === 'hls' ? undefined : camera.remoteStreamUrl} autoPlay playsInline muted crossOrigin="anonymous" className="w-full h-full object-cover" />;
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
