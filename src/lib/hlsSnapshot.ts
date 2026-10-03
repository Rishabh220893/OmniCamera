import Hls from 'hls.js';
import { hlsCaptureGate } from './captureConcurrency';
import { captureFrameAllowingSettle } from './frameCapture';

/**
 * One-shot HLS snapshot: connect, capture a single frame, tear down.
 * Mirrors captureWhepSnapshot's connect-capture-disconnect shape, for the
 * fixed subset of cameras whose source codec WHEP/WebRTC can never play
 * (MediaMTX rejects them with a permanent "codecs not supported" 400) —
 * those still have to fall back to HLS to show anything at all.
 *
 * This origin's HLS path is the slow, Cloudflare-throttled one (manifests
 * and segments both routinely take 20-45s), so timeoutMs defaults high and
 * callers should refresh far less often than the WHEP snapshot path does.
 *
 * Runs behind its own single-flight gate (see captureConcurrency.ts) —
 * serialized against other HLS captures, but deliberately a separate lane
 * from captureWhepSnapshot's, not a shared one. They were merged into one
 * slot for a while (a HAR had caught a 12.6s HLS fetch overlapping fresh
 * WHEP negotiations that failed outright), but that starved the rest of
 * the grid instead: a single codec-fallback camera's HLS turn routinely
 * takes ~57s end-to-end on this slow origin, and holding one shared slot
 * for that long blocked every other tile — including fast WHEP cameras —
 * from getting a turn at all. Two independent lanes keep both problems
 * fixed: HLS no longer runs unthrottled, and it no longer blocks WHEP.
 *
 * That ~57s end-to-end figure was already on record here, yet the overall
 * timeoutMs below was still only 50s — a real HAR from this exact origin
 * (scripts/verify-live-grid.mjs) later caught the consequence directly: a
 * manifest fetch that took 24.9s, then a key (12.2s) and segment (12.7s)
 * that both came back 200 with real bytes — genuinely successful, ~49.7s
 * in — only for the wrapper's own 50s deadline to fire a beat later and
 * discard all of it as "Snapshot timed out" before decode ever reached
 * 'playing'. STAGE_TIMEOUT_MS below is what actually bounds each fetch —
 * matching our own /api/proxy-hls's fetch timeout (server.ts), since a
 * client-side stage timeout shorter than the server's own abort ceiling
 * would just cut a request off before the server had even given up on it.
 * The overall budget needs enough room for manifest + key + segment +
 * decode to land in sequence without the wrapper cutting it off first, so
 * it's set well above their observed combined worst case rather than
 * equal to one stage.
 */
const STAGE_TIMEOUT_MS = 38_000;

export function captureHlsSnapshot(
  url: string,
  opts: { password?: string; email?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const { password, email, timeoutMs = 90_000, signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Snapshot aborted')); return; }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);

    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimeout: ReturnType<typeof setTimeout> | null = null;
    let queueTimeout: ReturnType<typeof setTimeout> | null = null;
    let hls: Hls | null = null;
    // Not assigned until the capture slot below comes through — see the
    // identical pattern (and its reasoning) in captureWhepSnapshot.
    let releaseCaptureSlot: (() => void) | null = null;

    const finish = (err?: Error, dataUrl?: string) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (overallTimeout) clearTimeout(overallTimeout);
      if (queueTimeout) clearTimeout(queueTimeout);
      signal?.removeEventListener('abort', onAbort);
      hls?.destroy();
      releaseCaptureSlot?.();
      video.remove();
      if (err) reject(err); else resolve(dataUrl!);
    };

    const onAbort = () => finish(new Error('Snapshot aborted'));
    signal?.addEventListener('abort', onAbort);

    // Queue wait timeout prevents getting queued indefinitely behind other cameras
    queueTimeout = setTimeout(() => finish(new Error('Snapshot queue wait timed out')), 180_000);

    // Fast path: the server grabs one still over RTSP (a second or two), skipping the browser's HLS
    // machinery entirely. It needs the grid credentials, so they travel as headers. The heavy
    // browser-side HLS load below only runs if this fails, never alongside it: every tile doing both
    // opened a full HLS session per tile, which is what the grid's per-account limits cannot take.
    const tryFastSnapshot = async (): Promise<string | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        const res = await fetch(`/api/camera-snapshot?url=${encodeURIComponent(url)}`, {
          signal: controller.signal,
          headers: {
            ...(password ? { 'X-Stream-Password': password } : {}),
            ...(email ? { 'X-Stream-Email': email } : {}),
          },
        });
        if (!res.ok) return null;
        const blob = await res.blob();
        if (!blob || blob.size <= 500) return null;
        return await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    };

    const proxiedUrl = `/api/proxy-hls?url=${encodeURIComponent(url)}${password ? `&password=${encodeURIComponent(password)}` : ''}${email ? `&email=${encodeURIComponent(email)}` : ''}`;

    // See captureWhepSnapshot's identical use of this — a fixed settle
    // delay alone wasn't reliably enough to skip a transient black
    // decoder frame (a screen recording caught one accepted as a normal
    // successful capture), so this also checks the frame isn't still
    // blank once the settle elapses before accepting it.
    const capture = () => {
      if (settleTimer || settled) return;
      settleTimer = setTimeout(() => {
        captureFrameAllowingSettle(video).then(
          (dataUrl) => finish(undefined, dataUrl),
          (err) => finish(err instanceof Error ? err : new Error('Capture failed'))
        );
      }, 500);
    };

    hlsCaptureGate.acquire().then((release) => {
      if (queueTimeout) { clearTimeout(queueTimeout); queueTimeout = null; }
      // Settled (timed out, aborted) while still queued for a slot — hand
      // the slot straight back instead of starting a fetch nothing is
      // waiting on anymore.
      if (settled) { release(); return; }
      releaseCaptureSlot = release;

      overallTimeout = setTimeout(() => finish(new Error('Snapshot timed out')), timeoutMs);

      tryFastSnapshot().then((fast) => {
        if (settled) return;
        if (fast) { finish(undefined, fast); return; }
        startHls();
      });
    });

    const startHls = () => {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = proxiedUrl;
        video.addEventListener('playing', capture, { once: true });
        video.addEventListener('loadeddata', () => { video.play().catch(() => {}); });
        video.addEventListener('timeupdate', () => {
          if (video.currentTime > 0.05) capture();
        });
        video.play().catch(() => {});
      } else if (Hls.isSupported()) {
        hls = new Hls({
          manifestLoadingTimeOut: STAGE_TIMEOUT_MS,
          manifestLoadingMaxRetry: 0,
          levelLoadingTimeOut: STAGE_TIMEOUT_MS,
          levelLoadingMaxRetry: 0,
          fragLoadingTimeOut: STAGE_TIMEOUT_MS,
          fragLoadingMaxRetry: 0,
          xhrSetup: (xhr) => {
            if (password) xhr.setRequestHeader('X-Stream-Password', password);
            if (email) xhr.setRequestHeader('X-Stream-Email', email);
          },
        });
        hls.loadSource(proxiedUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.FRAG_LOADED, () => {
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) finish(new Error(`HLS playback error (${data.type}): ${data.details}`));
        });
        video.addEventListener('playing', capture, { once: true });
        video.addEventListener('loadeddata', () => { video.play().catch(() => {}); });
        video.addEventListener('timeupdate', () => {
          if (video.currentTime > 0.05) capture();
        });
      } else {
        finish(new Error('This browser does not support HLS playback.'));
      }
    };
  });
}
