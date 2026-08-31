export type StreamType = 'iframe' | 'image' | 'video';

/**
 * Classifies a remote camera URL into the player type needed to render it.
 * Single source of truth for this logic — used both by the live-feed
 * renderer and the frame-capture path, which previously duplicated it.
 */
export function detectStreamType(url: string): StreamType {
  const lower = url.toLowerCase();

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
