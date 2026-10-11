/**
 * Records a few seconds of a camera's stream into an MP4 file with ffmpeg, then makes a thumbnail, measures the duration and hashes the file.
 * The video is copied, not re-encoded, when the stream allows it (H.264 in RTSP or HLS); the last resort is a quick H.264 re-encode so that
 * odd sources (MJPEG) still give something playable.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, rm } from 'node:fs/promises';
import { gridCameraId } from '../frameSource';

export interface StreamCandidate { url: string; isRtsp: boolean; label: string }

/**
 * Where to read the stream from, best first; the same order the frame grabber uses: the grid's RTSP origin for grid cameras, then the
 * proxied HLS; any other rtsp:// address directly; any other http(s) address as HLS/MP4/MJPEG. A still-image address cannot be recorded.
 */
export function streamCandidates(o: { url: string; creds: { email: string; password: string }; gridRtspHost: string; localBaseUrl: string }): StreamCandidate[] {
  const { url, creds, gridRtspHost, localBaseUrl } = o;
  const grid = gridCameraId(url);
  if (grid) {
    return [
      { url: `rtsp://${encodeURIComponent(creds.email).replace(/@/g, '%40')}:${encodeURIComponent(creds.password)}@${gridRtspHost}/stream/${encodeURIComponent(grid)}`, isRtsp: true, label: 'RTSP' },
      { url: `${localBaseUrl}/api/proxy-hls?url=${encodeURIComponent(url)}&password=${encodeURIComponent(creds.password)}&email=${encodeURIComponent(creds.email)}`, isRtsp: false, label: 'HLS' },
    ];
  }
  if (/\.(jpe?g|png)(\?|$)/i.test(url)) return [];
  if (url.startsWith('rtsp://')) return [{ url, isRtsp: true, label: 'RTSP' }];
  return [{ url, isRtsp: false, label: 'HTTP' }];
}

export function buildRecordArgs(input: StreamCandidate, seconds: number, outFile: string, transcode: boolean): string[] {
  return [
    '-y', '-loglevel', 'error',
    ...(input.isRtsp ? ['-rtsp_transport', 'tcp', '-allowed_media_types', 'video'] : []),
    '-i', input.url,
    '-t', String(seconds),
    '-an',
    ...(transcode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
    '-movflags', '+faststart',
    outFile,
  ];
}

export interface RecordResult { ok: boolean; bytes: number; failure?: string }

/** Runs ffmpeg once; kills it if it outlives `timeoutMs`. Error text is scrubbed of anything in `secrets`. */
export function runFfmpeg(args: string[], timeoutMs: number, secrets: string[] = []): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stderr = '', timedOut = false, settled = false;
    let child;
    try { child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { resolve({ code: null, stderr: `spawn: ${e instanceof Error ? e.message : e}`, timedOut: false }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1500); });
    const done = (code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code, stderr: secrets.filter(Boolean).reduce((t, s) => t.split(s).join('***'), stderr).trim(), timedOut });
    };
    child.on('error', (e) => { stderr += `spawn: ${e.message}`; done(null); });
    child.on('close', (code) => done(code));
  });
}

/** Tries each way of reading the stream in turn; the first that gives a playable file wins. */
export async function recordClip(candidates: StreamCandidate[], seconds: number, outFile: string, o: { connectTimeoutMs?: number; secrets?: string[]; run?: typeof runFfmpeg } = {}): Promise<RecordResult> {
  if (!candidates.length) return { ok: false, bytes: 0, failure: 'This camera has no stream address that can be recorded (a still-image address cannot).' };
  const run = o.run ?? runFfmpeg;
  const budget = seconds * 1000 + (o.connectTimeoutMs ?? 30_000);
  let last = 'no attempt was made';
  const plans: Array<{ c: StreamCandidate; transcode: boolean }> = [];
  for (const c of candidates) plans.push({ c, transcode: false });
  plans.push({ c: candidates[candidates.length - 1], transcode: true }); // last resort: re-encode what the last source gives
  for (const { c, transcode } of plans) {
    await rm(outFile, { force: true });
    const r = await run(buildRecordArgs(c, seconds, outFile, transcode), budget, o.secrets);
    const size = await stat(outFile).then((s) => s.size, () => 0);
    if (r.code === 0 && size > 2_000) return { ok: true, bytes: size };
    last = r.timedOut ? `${c.label}: no video within ${Math.round(budget / 1000)} s` : `${c.label}${transcode ? ' (re-encoded)' : ''}: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) || `ffmpeg exit ${r.code}`}`;
    // A refusal for credentials will not get better by trying again another way.
    if (/\b401\b|Unauthorized/i.test(r.stderr)) return { ok: false, bytes: 0, failure: `${c.label}: the stream answered 401 Unauthorized (check the stream access email and password)` };
  }
  await rm(outFile, { force: true });
  return { ok: false, bytes: 0, failure: last };
}

export function probeSeconds(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(null); return; }
    const t = setTimeout(() => p.kill('SIGKILL'), 15_000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => { clearTimeout(t); const n = parseFloat(out); resolve(Number.isFinite(n) ? Math.round(n * 10) / 10 : null); });
  });
}

export async function makeThumbnail(file: string, out: string, atSeconds: number): Promise<boolean> {
  const r = await runFfmpeg(['-y', '-loglevel', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', file, '-vframes', '1', '-vf', 'scale=320:-2', '-q:v', '4', out], 20_000);
  const size = await stat(out).then((s) => s.size, () => 0);
  return r.code === 0 && size > 200;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}
