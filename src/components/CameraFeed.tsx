import { useEffect, useRef, useState, useCallback, MutableRefObject } from 'react';
import Hls from 'hls.js';
import { AlertTriangle, RefreshCw, Video, Info } from 'lucide-react';
import { CameraConfig, CameraMediaRefs } from '../types';
import { detectStreamType, unsupportedReason, deriveWhepCamId } from '../lib/streamAdapters';
import { startWhep, captureWhepSnapshot } from '../lib/whepClient';
import { captureHlsSnapshot } from '../lib/hlsSnapshot';
import { getCachedSnapshot, setCachedSnapshot, hasCachedSnapshot } from '../lib/snapshotCache';
import { useMediaConfig, mediaFailedCameras, gridCamId, mediaPlaylistUrl, mediaAuthHeader, noteMediaFailure, noteMediaPlaying } from '../lib/mediaServer';
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
   *  as HTTP Basic Auth and via the CDN's cookie login (email:password —
   *  see streamAccessEmail) for password-gated CDN hosts. */
  streamAccessPassword?: string;
  /** Both RTSP/WHEP on the grid's raw origin and the HLS CDN's login form
   *  authenticate with email:password (email as username / login field) —
   *  forwarded to /api/whep-proxy and /api/proxy-hls alongside the password. */
  streamAccessEmail?: string;
  /** Lets a grid tile show a real connecting/live/error indicator instead of
   *  either playing video or nothing — a blank tile during a slow upstream
   *  connection otherwise reads as broken rather than working. */
  onStatusChange?: (status: FeedStatus) => void;
  /** Gates remote (WHEP/HLS) playback — false means "don't connect yet".
   *  Used to only decode cameras actually scrolled into view (see
   *  MonitorTab's useInViewport usage); decoding all 30 grid cameras at
   *  once saturates the browser regardless of how healthy each individual
   *  connection is. Ignored for simulated/local-webcam/iframe/image feeds,
   *  which don't carry that cost. Defaults to true so this is opt-in. */
  shouldConnect?: boolean;
  /** false = show a periodically-refreshed still image instead of a live
   *  decode, for cameras on the demo grid (WHEP-capable). A registry that
   *  scales to tens of thousands of cameras can never have more than a
   *  handful genuinely live-decoding in one browser tab at once — that's a
   *  hardware ceiling, not a tuning problem — so most grid tiles run in
   *  this mode; only the focused camera and anything selected for
   *  analysis need `liveVideo`. Ignored for simulated/local/image/iframe
   *  feeds, which are already cheap. Defaults to true so this is opt-in. */
  liveVideo?: boolean;
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

// Remember cameras where WHEP failed to avoid repeating failed WHEP connection cycles
const whepFailedCameras = new Set<string>();

export default function CameraFeed({ camera, isFocused, isCapturing, reportRefs, mediaRefs, onCameraError, onFallbackToSimulated, streamAccessPassword, streamAccessEmail, onStatusChange, shouldConnect: shouldConnectProp = true, liveVideo = true }: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaCfg = useMediaConfig();
  const remoteImgRef = useRef<HTMLImageElement>(null);
  const simCanvasRef = useRef<HTMLCanvasElement>(null);
  const entitiesRef = useRef<SimEntity[]>([]);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(() => getCachedSnapshot(camera.id) || null);
  const retryDelayRef = useRef(BASE_RETRY_DELAY_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  // WHEP (WebRTC) is tried first for cameras on the demo grid — it bypasses
  // Cloudflare's connection-level throttling on the HLS path entirely (see
  // deriveWhepCamId). If it can't establish a real connection after a couple
  // of tries, this permanently drops to the existing HLS path for the rest
  // of this mount rather than retrying a route that isn't working — e.g. a
  // network that blocks outbound WebRTC/UDP.
  const [playbackMode, setPlaybackMode] = useState<'whep' | 'hls'>(() => {
    return whepFailedCameras.has(camera.id) ? 'hls' : 'whep';
  });
  const whepRetryDelayRef = useRef(BASE_RETRY_DELAY_MS);
  const whepRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const whepFailCountRef = useRef(0);
  const [whepRetryGeneration, setWhepRetryGeneration] = useState(0);

  const isSimulated = !!camera.useSimulatedFeed;
  const isRemote = !!camera.useRemoteFeed && !!camera.remoteStreamUrl;
  const streamType = isRemote ? detectStreamType(camera.remoteStreamUrl) : null;
  const whepCamId = isRemote && streamType === 'hls' ? deriveWhepCamId(camera.remoteStreamUrl) : null;

  // The grid needs the account's email and password and the app no longer ships any default, so a remote
  // grid tile without them must not try to connect (every attempt would be refused and counted against
  // the grid's request limits). It says so instead.
  // A live tile that plays from the media server needs no grid login in the browser: the media server holds
  // it. So those tiles wait for the media config (instead of failing) and then connect without credentials.
  const credsEmpty = !streamAccessPassword || !streamAccessEmail;
  const mediaWillServe = liveVideo && !!mediaCfg?.enabled && !!gridCamId(camera.remoteStreamUrl) && !mediaFailedCameras.has(camera.id);
  const waitingForMediaConfig = liveVideo && mediaCfg === null && credsEmpty;
  const credsMissing = isRemote && streamType === 'hls' && credsEmpty && !mediaWillServe && !waitingForMediaConfig;
  const shouldConnect = shouldConnectProp && !credsMissing && !(isRemote && streamType === 'hls' && waitingForMediaConfig);
  useEffect(() => {
    if (!credsMissing) return;
    setStatus('error');
    setRemoteError('Stream access email and password are not set. Add them under Settings → stream access.');
  }, [credsMissing]);

  // A fresh camera (or one whose URL changed) always gets a clean shot at
  // WHEP again — unless it has already proven to fail WHEP.
  useEffect(() => {
    setPlaybackMode(whepFailedCameras.has(camera.id) ? 'hls' : 'whep');
    whepRetryDelayRef.current = BASE_RETRY_DELAY_MS;
    whepFailCountRef.current = 0;
    setSnapshotUrl(getCachedSnapshot(camera.id) || null);
  }, [camera.id, camera.remoteStreamUrl]);

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

  // Snapshot mode — the scalable path for a grid tile that isn't the
  // focused camera or an analysis target (see the `liveVideo` prop doc).
  // Instead of holding a live decode open, this repeatedly does a brief
  // connect-capture-disconnect cycle via WHEP and shows the result as a
  // plain image, refreshed on an interval. Each cycle only occupies a
  // signaling slot for a couple of seconds rather than a decode session
  // indefinitely, so this scales to however many tiles are in the current
  // page/viewport regardless of total registry size.
  //
  // This is the target cadence each tile asks for independently — it is
  // not the cadence actually achieved on a full page. captureWhepSnapshot's
  // own concurrency gate (MAX_CONCURRENT_CAPTURES, currently 1: see its doc
  // comment in whepClient.ts) serializes every tile's actual connect
  // attempt behind however many others also want a turn right now, to
  // avoid the resource contention that was starving most of a full grid
  // page out of ever getting a real frame. That trades cadence for
  // reliability: with N tiles all wanting a turn, a tile's realized refresh
  // interval is roughly N times one capture's duration, not a flat 20s —
  // slower to look fresh, but every tile gets its own uncontended shot
  // instead of most of them losing a fight for bandwidth/CPU forever.
  const SNAPSHOT_REFRESH_MS = 20_000;
  // Same throttled Cloudflare-fronted origin the live-video HLS fallback
  // uses (see fallbackToHls below) — its manifests/segments routinely take
  // 20-45s, so a snapshot cycle over it is refreshed far less often than
  // the WHEP path to avoid stacking up overlapping slow requests.
  // Every snapshot is a short viewing session on the grid, which caps how much one account may watch, so
  // refreshes are deliberately slow; a tab nobody is looking at does not refresh at all.
  const HLS_SNAPSHOT_REFRESH_MS = 300_000;
  useEffect(() => {
    if (liveVideo || !isRemote || streamType !== 'hls' || !shouldConnect) return;
    // Cameras without a WHEP id (WHEP is opt-in per URL) take stills over the server's RTSP/HLS path.
    const mode: 'whep' | 'hls' = whepCamId ? playbackMode : 'hls';
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A ref, not the snapshotUrl state itself, so a failed refresh can tell
    // "never got one" from "have a slightly stale one" without needing
    // snapshotUrl in this effect's own dependencies — that would restart
    // the whole capture loop (a fresh connect-capture cycle) on every
    // single successful capture, which defeats the point of it.
    let hasSnapshot = false;
    // Lets cleanup actually stop an in-flight capture (see the AbortSignal
    // doc on captureWhepSnapshot) rather than just ignoring its result —
    // otherwise a scrolled-away tile, or React StrictMode's dev-only
    // double-invoke, leaves a real WHEP negotiation running to completion
    // for a capture nothing is waiting on anymore. Reassigned per attempt
    // (an AbortController is one-shot) — cleanup always aborts whichever
    // one is currently in flight via this binding.
    let currentAbortController: AbortController | null = null;
    // A real-network HAR (scripts/verify-live-grid.mjs) traced "Snapshot
    // timed out" all the way through: TURN relay candidates are gathered
    // correctly now, the origin's answer does include a host candidate on
    // its real public IP, and ICE still never completes — the signature
    // of the origin's firewall only accepting inbound media traffic
    // (UDP/TCP 8189) from specific source IPs, which a TURN relay's IP is
    // no more likely to be on than anyone else's. That's not fixable from
    // here. HLS (cctv.corp8.cloud, Cloudflare-fronted, already proven
    // working — see fetchSentinelCatalogue/hlsSnapshot) is a completely
    // different host and doesn't hit that port at all, so it keeps
    // working regardless. This tracks consecutive non-permanent WHEP
    // failures (timeouts, ICE/connection failures — anything other than
    // the codec-unsupported 400 case just below, which already switches
    // immediately) and falls back the same way once they look
    // structural rather than a one-off blip.
    const captureLoop = async () => {
      if (cancelled) return;
      if (document.hidden) { timer = setTimeout(captureLoop, 15_000); return; }
      if (!hasSnapshot && !hasCachedSnapshot(camera.id)) {
        setStatus((s) => (s === 'live' ? s : 'connecting'));
      }
      const abortController = new AbortController();
      currentAbortController = abortController;
      // Set only when switching transport mid-cycle, so the effect's own
      // re-run (triggered by the playbackMode dependency below) is what
      // schedules the next attempt — not this stale closure's delay.
      let switchingToHls = false;
      let retryAfterMs = 0;
      try {
        const url = mode === 'hls'
          ? await captureHlsSnapshot(camera.remoteStreamUrl, { password: streamAccessPassword, email: streamAccessEmail, signal: abortController.signal })
          : await captureWhepSnapshot(whepCamId!, { signal: abortController.signal, streamAccessPassword, streamAccessEmail });
        if (cancelled) return;
        hasSnapshot = true;
        setCachedSnapshot(camera.id, url);
        setSnapshotUrl(url);
        setStatus('live');
        setRemoteError(null);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Snapshot unavailable.';
        retryAfterMs = (err as { retryAfterMs?: number } | null)?.retryAfterMs ?? 0;
        // If WHEP fails for any reason (timeout, ICE blocked, or 400 codec rejection),
        // seamlessly switch this tile's snapshot loop to HLS instead of stalling in error.
        if (mode === 'whep') {
          whepFailedCameras.add(camera.id);
          switchingToHls = true;
          setPlaybackMode('hls');
          console.warn(`[CameraFeed] ${camera.id} (whep) capture unavailable (${message}) — falling back to HLS.`);
        } else {
          // A stale-but-present image beats hiding it behind an error state
          // over one missed refresh cycle — only surface an error once
          // we've never managed to get a picture at all.
          if (!hasSnapshot && !hasCachedSnapshot(camera.id)) {
            setStatus('error');
          } else {
            setStatus('connecting');
          }
          setRemoteError(message);
          console.warn(`[CameraFeed] ${camera.id} (${mode}) capture unavailable: ${message}`);
        }
      } finally {
        if (!cancelled && !switchingToHls) {
          // A tile that has no picture yet retries sooner than one that is just refreshing.
          const delay = Math.max(retryAfterMs, mode === 'hls' ? (hasSnapshot || hasCachedSnapshot(camera.id) ? HLS_SNAPSHOT_REFRESH_MS : 90_000) : SNAPSHOT_REFRESH_MS);
          timer = setTimeout(captureLoop, delay);
        }
      }
    };
    captureLoop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      currentAbortController?.abort();
    };
  }, [liveVideo, isRemote, streamType, whepCamId, shouldConnect, playbackMode, camera.remoteStreamUrl, streamAccessPassword, streamAccessEmail]);

  // WHEP (WebRTC) playback — tried before HLS for any camera on the demo
  // grid (see whepCamId). Falls back to the existing HLS path only after
  // several failed attempts, not a couple — HLS is the strictly slower,
  // Cloudflare-throttled path this whole thing exists to avoid, so bailing
  // to it too eagerly during a transient rough patch (e.g. all 30 cameras
  // connecting at once) trades a recoverable WHEP hiccup for the old
  // unreliable path permanently for that camera's mount lifetime.
  const MAX_WHEP_ATTEMPTS_BEFORE_FALLBACK = 2;
  // A queued negotiation (see whepClient's concurrency limiter) can wait
  // several seconds behind other cameras before it even starts when all 30
  // connect at once — the connect timeout has to comfortably outlast that
  // queueing delay, not just the negotiation itself.
  const WHEP_CONNECT_TIMEOUT_MS = 30_000;
  // WebRTC's 'disconnected' state is commonly a brief, self-recovering
  // blip (a missed STUN check under momentary load), not a real failure —
  // only 'failed' means ICE has actually given up. Tearing the connection
  // down immediately on 'disconnected' was turning transient congestion
  // (expected with many cameras streaming at once) into unnecessary
  // reconnect churn, which only added more load and made it worse. Give it
  // a grace window to recover on its own before treating it as a failure.
  // A production HAR showed working cameras reconnecting every 10-70s even
  // after this was first added — a full WHEP renegotiation is much more
  // disruptive to watch than a few extra seconds of staying on a connection
  // that's about to recover on its own, so this errs generous.
  const DISCONNECTED_GRACE_MS = 10_000;
  useEffect(() => {
    if (!isRemote || streamType !== 'hls' || !whepCamId || playbackMode !== 'whep' || !shouldConnect || !liveVideo) return;
    const video = videoRef.current;
    if (!video) return;
    setRemoteError(null);
    setStatus('connecting');
    let cancelled = false;
    let disconnectedGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let verifyTimer: ReturnType<typeof setInterval> | null = null;

    const fallbackToHls = (message: string) => {
      console.warn(`[WHEP] ${message} — falling back to HLS for ${camera.id}.`);
      setPlaybackMode('hls');
    };

    const scheduleWhepRetry = (message: string) => {
      if (cancelled) return;
      setRemoteError(message);
      setStatus('error');
      whepFailCountRef.current += 1;
      if (whepFailCountRef.current > MAX_WHEP_ATTEMPTS_BEFORE_FALLBACK) {
        fallbackToHls(message);
        return;
      }
      if (whepRetryTimerRef.current) return;
      // Jittered so 30 cameras that all failed around the same moment
      // (e.g. a shared burst of congestion) don't all retry in lockstep
      // and immediately recreate the exact same thundering herd.
      const jitter = 0.75 + Math.random() * 0.5;
      whepRetryTimerRef.current = setTimeout(() => {
        whepRetryTimerRef.current = null;
        whepRetryDelayRef.current = Math.min(MAX_RETRY_DELAY_MS, whepRetryDelayRef.current * 2);
        setWhepRetryGeneration((g) => g + 1);
      }, whepRetryDelayRef.current * jitter);
    };

    const connectTimeout = setTimeout(() => {
      scheduleWhepRetry('Timed out waiting for a WebRTC connection.');
    }, WHEP_CONNECT_TIMEOUT_MS);

    const clearDisconnectedGrace = () => {
      if (disconnectedGraceTimer) { clearTimeout(disconnectedGraceTimer); disconnectedGraceTimer = null; }
    };

    // pc.connectionState can stay 'connected' while the picture itself is
    // frozen or black — e.g. decode falling behind under the load of many
    // simultaneous streams. ICE/DTLS being healthy says nothing about
    // whether real, changing frames are actually reaching the screen, which
    // is the same class of gap the HLS path below already guards against.
    // Without this, a decode-starved tile would sit on a dead frame forever
    // since nothing here would ever call it out as failed.
    const startFrameVerification = () => {
      if (verifyTimer || cancelled) return;
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { setStatus('live'); return; }
      let lastSample: Uint8ClampedArray | null = null;
      let lastCurrentTime = -1;
      let staleCycles = 0;
      let everConfirmedLive = false;
      verifyTimer = setInterval(() => {
        let current: Uint8ClampedArray | null = null;
        try {
          ctx.drawImage(video, 0, 0, 16, 16);
          current = ctx.getImageData(0, 0, 16, 16).data;
        } catch { /* video not ready for this sample yet */ }
        const isTimeAdvancing = video.currentTime > lastCurrentTime && video.currentTime > 0;
        lastCurrentTime = video.currentTime;
        if (current && lastSample) {
          let diff = 0;
          for (let i = 0; i < current.length; i += 4) diff += Math.abs(current[i] - lastSample[i]);
          if (diff > 40 || isTimeAdvancing) {
            staleCycles = 0;
            if (!everConfirmedLive) { everConfirmedLive = true; whepFailCountRef.current = 0; whepRetryDelayRef.current = BASE_RETRY_DELAY_MS; }
            setStatus('live');
          } else if (everConfirmedLive) {
            staleCycles += 1;
            if (staleCycles >= 20) { // ~30s with no visible change AND no playback advance
              if (verifyTimer) { clearInterval(verifyTimer); verifyTimer = null; }
              scheduleWhepRetry('Stream stalled — no new frames arriving.');
            }
          }
        }
        if (current) lastSample = current;
      }, 1500);
    };

    const handlePlaying = () => {
      clearTimeout(connectTimeout);
      clearDisconnectedGrace();
      startFrameVerification();
    };
    video.addEventListener('playing', handlePlaying);

    // Created synchronously (not awaited) so cleanup below can close() it
    // immediately, before negotiation ever reaches setRemoteDescription —
    // see the comment on startWhep for why that matters.
    const session = startWhep(whepCamId, video, (state) => {
      if (cancelled) return;
      if (state === 'connected') {
        clearDisconnectedGrace();
        return;
      }
      if (state === 'failed' || state === 'closed') {
        clearTimeout(connectTimeout);
        clearDisconnectedGrace();
        scheduleWhepRetry(`WebRTC connection ${state}.`);
        return;
      }
      if (state === 'disconnected' && !disconnectedGraceTimer) {
        disconnectedGraceTimer = setTimeout(() => {
          disconnectedGraceTimer = null;
          if (cancelled) return;
          clearTimeout(connectTimeout);
          scheduleWhepRetry('WebRTC connection disconnected.');
        }, DISCONNECTED_GRACE_MS);
      }
    }, streamAccessPassword, streamAccessEmail);
    session.ready.catch((err: unknown) => {
      if (cancelled) return;
      clearTimeout(connectTimeout);
      const message = err instanceof Error ? err.message : 'WHEP connection failed.';
      const isAuthError = /WHEP negotiation failed \((401|403)\)/.test(message) || /authentication error/i.test(message);
      if (isAuthError) {
        const authMsg = 'Stream credentials rejected by camera network (401). Check Settings > Stream Access Password or switch to simulated feed.';
        setRemoteError(authMsg);
        setStatus('error');
        onCameraError?.(authMsg);
        return;
      }
      // A HAR capture showed a fixed subset of cameras always getting
      // rejected with HTTP 400 and "codecs not supported by client" -
      // MediaMTX telling us that camera's source codec has no match in our
      // WebRTC offer (likely a codec outside VP8/VP9/H264/AV1 entirely, not
      // something retrying can ever fix). Retrying 6 times anyway before
      // falling back just made those specific cameras' first picture show
      // up over a minute later than necessary — skip straight to HLS.
      if (/WHEP negotiation failed \(400\)/.test(message)) {
        fallbackToHls(message);
        return;
      }
      scheduleWhepRetry(message);
    });

    return () => {
      cancelled = true;
      clearTimeout(connectTimeout);
      clearDisconnectedGrace();
      if (verifyTimer) clearInterval(verifyTimer);
      if (whepRetryTimerRef.current) { clearTimeout(whepRetryTimerRef.current); whepRetryTimerRef.current = null; }
      video.removeEventListener('playing', handlePlaying);
      session.close();
    };
  }, [isRemote, streamType, whepCamId, playbackMode, whepRetryGeneration, camera.id, shouldConnect, liveVideo, streamAccessPassword, streamAccessEmail]);

  // HLS playback — browsers don't decode .m3u8 natively (except Safari),
  // so this feeds the same <video> element via MediaSource Extensions.
  // Frame capture (App.tsx captureAndAnalyze) draws from that same element,
  // so nothing else needs to know HLS is involved. Runs when this camera has
  // no WHEP path at all, or WHEP repeatedly failed and playbackMode fell
  // back to 'hls'.
  useEffect(() => {
    if (!isRemote || streamType !== 'hls' || !shouldConnect || !liveVideo) return;
    if (whepCamId && playbackMode !== 'hls') return;
    // Wait for the media server answer (it arrives once) so a tile does not first connect through the proxy.
    if (mediaCfg === null) return;
    const video = videoRef.current;
    if (!video) return;
    setRemoteError(null);
    setStatus('connecting');
    let cancelled = false;
    let verifyTimer: ReturnType<typeof setInterval> | null = null;

    // Play from the media server when there is one: it pulls each camera once and serves any number of
    // viewers, so this tile adds no load to the grid or to this app's server. Safari's native HLS cannot
    // send the viewer login, and a camera whose media-server stream failed uses the app's proxy instead.
    const mediaCamId = gridCamId(camera.remoteStreamUrl);
    // Prefer hls.js wherever it runs: recent Chrome also plays HLS natively (canPlayType says 'maybe'), but the
    // native player cannot send the media server's login header, so it would silently bypass the media server.
    const nativeHls = !Hls.isSupported() && !!video.canPlayType('application/vnd.apple.mpegurl');
    const useMedia = !!(mediaCfg?.enabled && mediaCamId && !mediaFailedCameras.has(camera.id) && !nativeHls);

    const startFrameVerification = () => {
      if (verifyTimer || cancelled) return;
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { setStatus('live'); return; }
      let lastCurrentTime = -1;
      let staleCycles = 0;
      let everConfirmedLive = false;

      verifyTimer = setInterval(() => {
        if (cancelled || !video) return;

        // Video must be playing, have real pixel dimensions, and have data buffered
        if (video.paused || video.videoWidth === 0 || video.readyState < 2) {
          if (everConfirmedLive) {
            staleCycles += 1;
            if (staleCycles >= 8) { // 12s without play
              setStatus('connecting');
            }
          }
          return;
        }

        const isTimeAdvancing = video.currentTime > lastCurrentTime && video.currentTime > 0;
        lastCurrentTime = video.currentTime;

        let hasImageContent = false;
        try {
          ctx.drawImage(video, 0, 0, 16, 16);
          const imgData = ctx.getImageData(0, 0, 16, 16).data;
          let nonZero = 0;
          for (let i = 0; i < imgData.length; i += 4) {
            if (imgData[i] > 15 || imgData[i + 1] > 15 || imgData[i + 2] > 15) nonZero++;
          }
          hasImageContent = nonZero > 8;
        } catch { /* video frame not ready yet */ }

        if (isTimeAdvancing && hasImageContent) {
          staleCycles = 0;
          if (!everConfirmedLive) {
            everConfirmedLive = true;
            retryDelayRef.current = BASE_RETRY_DELAY_MS;
          }
          setStatus('live');
          setRemoteError(null);
        } else if (everConfirmedLive) {
          staleCycles += 1;
          if (staleCycles >= 8) { // ~12s stalled
            setStatus('connecting');
          }
          if (staleCycles >= 25) { // ~37s stalled
            if (verifyTimer) { clearInterval(verifyTimer); verifyTimer = null; }
            scheduleReconnect('Stream stalled — video frames stopped advancing.');
          }
        }
      }, 1500);
    };
    const handlePlaying = () => {
      if (useMedia) noteMediaPlaying(camera.id);
      setStatus('live');
      setRemoteError(null);
      startFrameVerification();
    };
    const handleLoadedMetadata = () => {
      video.play().catch(() => {});
    };
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);

    // The guide: "Reconnect automatically, with backoff (~2s → cap ~30s).
    // Do not reconnect in a tight loop." A manual-only retry button doesn't
    // meet that, and hls.js only reports a fatal error after exhausting its
    // own retry budget — which at this origin's ~45-75s per-attempt timeouts
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
    // Above the manifest and fragment stage timeouts combined
    // (A media-server camera can need longer: some grid cameras only send a keyframe every 20-40 s.)
    const watchdog = setTimeout(() => {
      if (useMedia) noteMediaFailure(camera.id, !!(streamAccessPassword && streamAccessEmail));
      scheduleReconnect('Timed out waiting for a real picture from this stream.');
    }, useMedia ? 90_000 : 60_000);
    const clearWatchdog = () => clearTimeout(watchdog);
    video.addEventListener('playing', clearWatchdog);

    const effectivePwd = streamAccessPassword || '';
    const effectiveEml = streamAccessEmail || '';

    const proxiedUrl = (url: string) =>
      `/api/proxy-hls?url=${encodeURIComponent(url)}&password=${encodeURIComponent(effectivePwd)}&email=${encodeURIComponent(effectiveEml)}`;

    let hls: Hls | null = null;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;

    if (nativeHls) {
      video.src = proxiedUrl(camera.remoteStreamUrl);
    } else if (Hls.isSupported()) {
      hls = new Hls({
        maxLiveSyncPlaybackRate: 1.5,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        manifestLoadingTimeOut: 35_000,
        manifestLoadingMaxRetry: 3,
        levelLoadingTimeOut: 35_000,
        levelLoadingMaxRetry: 3,
        fragLoadingTimeOut: 40_000,
        fragLoadingMaxRetry: 4,
        capLevelToPlayerSize: true,
        startPosition: -1,
        xhrSetup: (xhr) => {
          if (useMedia && mediaCfg) {
            xhr.setRequestHeader('Authorization', mediaAuthHeader(mediaCfg));
          } else {
            xhr.setRequestHeader('X-Stream-Password', effectivePwd);
            xhr.setRequestHeader('X-Stream-Email', effectiveEml);
          }
        },
      });
      hls.loadSource(useMedia && mediaCfg && mediaCamId ? mediaPlaylistUrl(mediaCfg, mediaCamId) : proxiedUrl(camera.remoteStreamUrl));
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        startFrameVerification();
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        clearWatchdog();
        if (video.paused) video.play().catch(() => {});
        startFrameVerification();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        // Non-fatal errors (including the "Could not find ref with POC" /
        // RPS-construction warnings the guide calls out as normal on join,
        // before the first IDR arrives) are deliberately ignored here —
        // hls.js recovers from those on its own, and escalating them would
        // do exactly what the guide warns against: "pipelines that abort on
        // the first decoder error will bounce on those streams."
        if (data.fatal) {
          clearWatchdog();
          // A failed media-server stream is retried (the media server pulls the camera again on the next
          // request). Only after repeated failures, and only if this browser has a grid login for it, does the
          // camera switch to the app's own proxy.
          if (useMedia) {
            const switched = noteMediaFailure(camera.id, !!(streamAccessPassword && streamAccessEmail));
            scheduleReconnect(`Media server stream failed (${data.details}); ${switched ? 'using the direct route' : 'retrying'}.`);
            return;
          }
          const isAuth = data.response?.code === 401 || data.response?.code === 403;
          if (isAuth) {
            const authMsg = 'Stream credentials rejected by camera network (401). Check Settings > Stream Access Password or switch to simulated feed.';
            setRemoteError(authMsg);
            setStatus('error');
            onCameraError?.(authMsg);
            return;
          }
          scheduleReconnect(`HLS playback error (${data.type}): ${data.details}`);
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
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('playing', clearWatchdog);
      hls?.destroy();
    };
  }, [isRemote, streamType, camera.remoteStreamUrl, streamAccessPassword, streamAccessEmail, retryGeneration, whepCamId, playbackMode, shouldConnect, liveVideo, mediaCfg]);

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
    // Snapshot mode (see `liveVideo`) — a plain refreshed still image
    // instead of a live decode. CameraTile already renders its own
    // connecting/error overlay from `status` for a non-focused tile, same
    // as it does for every other feed type, so this only needs to show
    // whatever the last successful capture was (or nothing yet).
    if (streamType === 'hls' && !liveVideo) {
      const activeUrl = snapshotUrl || getCachedSnapshot(camera.id);
      return activeUrl ? (
        <img key={camera.id} src={activeUrl} className="w-full h-full object-cover" alt={camera.name} />
      ) : (
        <div className="absolute inset-0 bg-surface-muted" />
      );
    }
    if (remoteError && isFocused) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-surface-muted gap-3">
          <AlertTriangle className="w-6 h-6 text-critical" strokeWidth={1.75} />
          <p className="text-xs text-critical max-w-sm leading-relaxed">{remoteError}</p>
          {onFallbackToSimulated && (
            <button
              onClick={onFallbackToSimulated}
              className="mt-2 btn-secondary !py-2 !px-4 text-xs"
            >
              Switch to simulated feed
            </button>
          )}
        </div>
      );
    }
    // 'hls' and plain 'video' both render into the same element — HLS is
    // attached via the effect above instead of a bare src for non-Safari browsers.
    const activeSnapshot = snapshotUrl || getCachedSnapshot(camera.id);
    return (
      <div className="relative w-full h-full overflow-hidden bg-black">
        {activeSnapshot && (
          <img
            src={activeSnapshot}
            alt={camera.name}
            className={cn(
              "absolute inset-0 w-full h-full object-cover transition-opacity duration-500",
              status === 'live' ? "opacity-0 pointer-events-none" : "opacity-100"
            )}
          />
        )}
        <video
          key={camera.id}
          ref={videoRef}
          src={streamType === 'hls' ? undefined : camera.remoteStreamUrl}
          autoPlay
          playsInline
          muted
          loop
          crossOrigin="anonymous"
          className={cn(
            "w-full h-full object-cover transition-opacity duration-300",
            status === 'live' ? "opacity-100" : activeSnapshot ? "opacity-0" : "opacity-100"
          )}
          onError={() => { if (streamType !== 'hls') setStatus('error'); }}
        />
      </div>
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
        <button onClick={startCamera} className="btn-secondary !py-2.5 !px-5 text-xs">
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
