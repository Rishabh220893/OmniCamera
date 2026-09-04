export type StreamType = 'iframe' | 'image' | 'video' | 'hls' | 'unsupported';

/**
 * Classifies a remote camera URL into the player type needed to render it.
 * Single source of truth for this logic — used both by the live-feed
 * renderer and the frame-capture path, which previously duplicated it.
 */
export function detectStreamType(url: string): StreamType {
  const lower = url.toLowerCase();

  // RTSP and raw WHEP endpoints can't be loaded as a plain browser media
  // source — RTSP needs a native decode pipeline (ffmpeg/GStreamer/OpenCV),
  // and WHEP needs a WebRTC SDP-negotiation client, not just a URL. Flag
  // them clearly instead of silently rendering a broken player.
  if (lower.startsWith('rtsp://') || lower.startsWith('rtsps://')) {
    return 'unsupported';
  }
  if (lower.includes('/whep')) {
    return 'unsupported';
  }

  if (lower.includes('.m3u8')) {
    return 'hls';
  }

  if (
    lower.includes('.html') ||
    lower.includes('mode=webrtc') ||
    lower.includes('mode=mse') ||
    lower.includes('mode=hls') ||
    (lower.includes('/stream') && !lower.includes('.mjpeg'))
  ) {
    return 'iframe';
  }

  if (
    lower.includes('.mjpeg') ||
    lower.includes('stream.mjpeg') ||
    lower.includes('.jpeg') ||
    lower.includes('.jpg') ||
    lower.includes('.png') ||
    lower.includes('format=mjpeg') ||
    lower.includes('/frame.')
  ) {
    return 'image';
  }

  return 'video';
}

/** Human-readable explanation for why a URL was classified 'unsupported'. */
export function unsupportedReason(url: string): string {
  const lower = url.toLowerCase();
  if (lower.startsWith('rtsp://') || lower.startsWith('rtsps://')) {
    return 'RTSP streams need a native decode pipeline (ffmpeg/GStreamer/OpenCV) — browsers cannot play RTSP directly. Use this camera\'s HLS URL instead, or run a bridge like go2rtc and use its browser-playable output.';
  }
  if (lower.includes('/whep')) {
    return 'WHEP requires a WebRTC signaling handshake, not just a URL — a plain <video> tag cannot load it. Use this camera\'s HLS URL instead for browser playback.';
  }
  return 'This stream format is not supported for direct playback.';
}

/**
 * The demo grid's HLS path (cctv.corp8.cloud, fronted by Cloudflare) is
 * throttled at the connection level — even a 16-byte key file takes 20-45s,
 * which rules out bandwidth and points to Cloudflare's bot mitigation, which
 * a spoofed User-Agent can't beat (it scores TLS fingerprint/IP reputation
 * more heavily). The same cameras are also served as WHEP (WebRTC) straight
 * off the raw origin (confirmed directly against the grid's MediaMTX
 * instance at 103.250.160.189, via /api/whep-proxy), bypassing Cloudflare
 * entirely.
 *
 * Recognizes two URL shapes for the same grid: the older Cloudflare-fronted
 * corp8.cloud vanity path (/camNN/index.m3u8), and the grid's own
 * documented pattern straight off the raw origin
 * (<host>/live/stream/<id>/index.m3u8, per its integrator guide) — cameras
 * pulled from /api/sentinel-catalogue use the latter. Any other camera's
 * HLS URL still plays through the plain HLS path unchanged.
 */
export function deriveWhepCamId(hlsUrl: string): string | null {
  try {
    const parsed = new URL(hlsUrl);
    if (/(^|\.)corp8\.cloud$/i.test(parsed.hostname)) {
      const match = parsed.pathname.match(/\/(cam\d{1,3})\/index\.m3u8$/i);
      return match ? match[1] : null;
    }
    if (parsed.hostname === '103.250.160.189') {
      const match = parsed.pathname.match(/\/live\/stream\/([^/]+)\/index\.m3u8$/i);
      return match ? match[1] : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort snapshot endpoint for a go2rtc-style iframe player URL. */
export function buildSnapshotUrl(remoteStreamUrl: string): string | null {
  try {
    const parsed = new URL(remoteStreamUrl);
    const src = parsed.searchParams.get('src');
    return src
      ? `${parsed.origin}/api/frame.jpeg?src=${encodeURIComponent(src)}`
      : `${parsed.origin}/api/frame.jpeg`;
  } catch {
    return null;
  }
}

const LOCAL_NETWORK_MARKERS = [
  'localhost', '127.0.0.1', '192.168.',
  '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.2', '172.30.', '172.31.'
];

export function isLocalNetworkUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return LOCAL_NETWORK_MARKERS.some(marker => lower.includes(marker));
}
