import Hls from 'hls.js';

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
 */
export function captureHlsSnapshot(
  url: string,
  opts: { password?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const { password, timeoutMs = 50_000, signal } = opts;
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

    const finish = (err?: Error, dataUrl?: string) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      clearTimeout(overallTimeout);
      signal?.removeEventListener('abort', onAbort);
      hls?.destroy();
      video.remove();
      if (err) reject(err); else resolve(dataUrl!);
    };

    const onAbort = () => finish(new Error('Snapshot aborted'));
    signal?.addEventListener('abort', onAbort);

    const overallTimeout = setTimeout(() => finish(new Error('Snapshot timed out')), timeoutMs);

    const proxiedUrl = `/api/proxy-hls?url=${encodeURIComponent(url)}${password ? `&password=${encodeURIComponent(password)}` : ''}`;

    const capture = () => {
      settleTimer = setTimeout(() => {
        if (!video.videoWidth) { finish(new Error('No frame available to capture')); return; }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) { finish(new Error('Canvas unavailable')); return; }
        ctx.drawImage(video, 0, 0);
        finish(undefined, canvas.toDataURL('image/jpeg', 0.6));
      }, 900);
    };

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
}
