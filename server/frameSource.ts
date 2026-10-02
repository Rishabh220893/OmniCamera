import { spawn } from 'child_process';

/**
 * Server-side still-frame capture (replaces the browser canvas grab for
 * server-side analysis). Shared by /api/camera-snapshot and the analysis
 * worker so both use the exact same ffmpeg invocation.
 */

/** Pulls one JPEG frame out of `inputUrl` with ffmpeg; null on timeout/failure. */
export function extractFrameWithFfmpeg(inputUrl: string, isRtsp: boolean, timeoutMs = 8_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      '-y',
      ...(isRtsp ? ['-rtsp_transport', 'tcp'] : []),
      '-i', inputUrl,
      '-vframes', '1',
      '-f', 'image2',
      '-q:v', '3',
      'pipe:1',
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    ffmpeg.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
    ffmpeg.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export interface FfmpegCheck { available: boolean; version?: string }

let ffmpegCheckCache: Promise<FfmpegCheck> | null = null;

/** Is ffmpeg installed and runnable on this host? Cached for the process lifetime for the default binary. */
export function checkFfmpeg(command = 'ffmpeg'): Promise<FfmpegCheck> {
  const run = () => new Promise<FfmpegCheck>((resolve) => {
    let out = '';
    let child;
    try { child = spawn(command, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve({ available: false }); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ available: false }); }, 5_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ available: false }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { available: true, version: out.split('\n')[0].trim() || undefined } : { available: false });
    });
  });
  if (command !== 'ffmpeg') return run();
  return (ffmpegCheckCache ??= run());
}

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal)$/i;

/**
 * The worker fetches URLs that users stored in their camera records, so
 * obvious internal targets are refused (loopback, link-local/metadata,
 * RFC1918 literals). Hostname-level only — it does not defend against DNS
 * that later resolves to a private address.
 */
export function isSafeCameraUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!['http:', 'https:', 'rtsp:'].includes(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_RE.test(host)) return false;
  if (host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/i.test(host)) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

export interface GridCredentials {
  email: string;
  password: string;
}

export interface FrameRequest {
  /** The camera's remoteStreamUrl. */
  url: string;
  /** Base URL of this server, used to reach its own HLS proxy as a fallback. */
  localBaseUrl: string;
  creds: GridCredentials;
  /** Host:port of the grid's raw RTSP origin, for the fast direct path. */
  gridRtspHost: string;
}

/**
 * Grabs one frame for a registry camera. Order mirrors /api/camera-snapshot:
 * direct RTSP for grid cameras (fast), then the proxied HLS URL; other
 * rtsp:// URLs go straight to ffmpeg, plain images are fetched, anything
 * else http(s) is handed to ffmpeg (HLS / MP4 / MJPEG).
 */
export async function grabFrame(req: FrameRequest): Promise<Buffer> {
  const { url, localBaseUrl, creds, gridRtspHost } = req;
  const camId = url.match(/\/(cam\d+)/i)?.[1];

  let frame: Buffer | null = null;
  if (camId) {
    const rtsp = `rtsp://${encodeURIComponent(creds.email).replace(/@/g, '%40')}:${encodeURIComponent(creds.password)}@${gridRtspHost}/stream/${camId.toLowerCase()}`;
    frame = await extractFrameWithFfmpeg(rtsp, true, 7_000);
    if (!frame) {
      const proxied = `${localBaseUrl}/api/proxy-hls?url=${encodeURIComponent(url)}&password=${encodeURIComponent(creds.password)}&email=${encodeURIComponent(creds.email)}`;
      frame = await extractFrameWithFfmpeg(proxied, false, 15_000);
    }
  } else if (url.startsWith('rtsp://')) {
    frame = await extractFrameWithFfmpeg(url, true, 10_000);
  } else if (/\.(jpe?g|png)(\?|$)/i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) frame = Buffer.from(await res.arrayBuffer());
  } else {
    frame = await extractFrameWithFfmpeg(url, false, 15_000);
  }

  if (!frame || frame.length < 500) throw new Error('Could not capture a frame from the camera stream');
  return frame;
}
