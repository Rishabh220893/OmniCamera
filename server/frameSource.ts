import { spawn } from 'child_process';

/**
 * Server-side still-frame capture (replaces the browser canvas grab for
 * server-side analysis). Shared by /api/camera-snapshot and the analysis
 * worker so both use the exact same ffmpeg invocation.
 */

export interface FrameResult {
  buffer: Buffer | null;
  ms: number;
  /** Why there is no frame: 'timeout', 'exit <code>', 'spawn: <message>'. Undefined on success. */
  failure?: string;
  /** Last lines ffmpeg printed on stderr, for diagnosing a failure. May contain the input URL. */
  stderrTail: string;
}

/** Like extractFrameWithFfmpeg but also reports how long it took and why it failed. */
export function extractFrameDetailed(inputUrl: string, isRtsp: boolean, timeoutMs = 8_000): Promise<FrameResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [
      '-y',
      '-loglevel', 'error',
      // RTSP: the stream's codec details come with the session setup, so a long probe only delays the first
      // frame (ffmpeg's default analyses up to 5 s of video before decoding anything).
      // - skip_frame nokey: decode only keyframes. Joining a stream mid-sequence otherwise decodes every
      //   frame (and prints "co located POCs unavailable" / "reference picture missing") until the next
      //   keyframe, which on a small CPU is most of the time these snapshots were taking.
      // - allowed_media_types video: do not set up the audio track at all.
      ...(isRtsp ? ['-rtsp_transport', 'tcp', '-allowed_media_types', 'video', '-fflags', 'nobuffer', '-analyzeduration', '1000000', '-probesize', '500000', '-skip_frame', 'nokey'] : []),
      '-i', inputUrl,
      '-vframes', '1',
      '-f', 'image2',
      '-q:v', '3',
      'pipe:1',
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1500); });
    let done = false;
    const finish = (buffer: Buffer | null, failure?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ buffer, ms: Date.now() - started, failure, stderrTail: stderr.trim() });
    };
    const timer = setTimeout(() => {
      ffmpeg.kill('SIGKILL');
      finish(null, 'timeout');
    }, timeoutMs);
    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length > 0) finish(Buffer.concat(chunks));
      else finish(null, `exit ${code}`);
    });
    ffmpeg.on('error', (err) => finish(null, `spawn: ${err.message}`));
  });
}

/** Pulls one JPEG frame out of `inputUrl` with ffmpeg; null on timeout/failure. */
export async function extractFrameWithFfmpeg(inputUrl: string, isRtsp: boolean, timeoutMs = 8_000): Promise<Buffer | null> {
  return (await extractFrameDetailed(inputUrl, isRtsp, timeoutMs)).buffer;
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

// Shared with the browser so the UI never hands the server a camera it would refuse.
export { isSafeCameraUrl } from '../src/lib/cameraUrl';

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
