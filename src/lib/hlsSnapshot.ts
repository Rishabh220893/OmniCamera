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
 */
export function captureHlsSnapshot(
  url: string,
  opts: { password?: string; email?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const { password, email, timeoutMs = 50_000, signal } = opts;
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
    let hls: Hls | null = null;
    // Not assigned until the capture slot below comes through — see the
    // identical pattern (and its reasoning) in captureWhepSnapshot.
    let releaseCaptureSlot: (() => void) | null = null;

    const finish = (err?: Error, dataUrl?: string) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(overallTimeout);
      signal?.removeEventListener('abort', onAbort);
      hls?.destroy();
      releaseCaptureSlot?.();
      video.remove();
      if (err) reject(err); else resolve(dataUrl!);
    };

    const onAbort = () => finish(new Error('Snapshot aborted'));
    signal?.addEventListener('abort', onAbort);

    const overallTimeout = setTimeout(() => finish(new Error('Snapshot timed out')), timeoutMs);

    const proxiedUrl = `/api/proxy-hls?url=${encodeURIComponent(url)}${password ? `&password=${encodeURIComponent(password)}` : ''}${email ? `&email=${encodeURIComponent(email)}` : ''}`;

    // See captureWhepSnapshot's identical use of this — a fixed settle
    // delay alone wasn't reliably enough to skip a transient black
    // decoder frame (a screen recording caught one accepted as a normal
    // successful capture), so this also checks the frame isn't still
    // blank once the settle elapses before accepting it.
    const capture = () => {
      settleTimer = setTimeout(() => {
        captureFrameAllowingSettle(video).then(
          (dataUrl) => finish(undefined, dataUrl),
          (err) => finish(err instanceof Error ? err : new Error('Capture failed'))
        );
      }, 900);
    };

    hlsCaptureGate.acquire().then((release) => {
      // Settled (timed out, aborted) while still queued for a slot — hand
      // the slot straight back instead of starting a fetch nothing is
      // waiting on anymore.
      if (settled) { release(); return; }
      releaseCaptureSlot = release;

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = proxiedUrl;
        video.addEventListener('playing', capture, { once: true });
      } else if (Hls.isSupported()) {
        hls = new Hls({
          manifestLoadingTimeOut: timeoutMs,
          manifestLoadingMaxRetry: 0,
          levelLoadingTimeOut: timeoutMs,
          levelLoadingMaxRetry: 0,
          fragLoadingTimeOut: timeoutMs,
          fragLoadingMaxRetry: 0,
          xhrSetup: (xhr) => {
            if (password) xhr.setRequestHeader('X-Stream-Password', password);
            if (email) xhr.setRequestHeader('X-Stream-Email', email);
          },
        });
        hls.loadSource(proxiedUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) finish(new Error(`HLS playback error (${data.type}): ${data.details}`));
        });
        video.addEventListener('playing', capture, { once: true });
      } else {
        finish(new Error('This browser does not support HLS playback.'));
      }
    });
  });
}
