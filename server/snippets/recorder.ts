/**
 * Records a few seconds of a camera's stream into an MP4 file with ffmpeg, then makes a thumbnail, measures the duration and hashes the file.
 * The video is copied, not re-encoded, when the stream allows it (H.264 in RTSP or HLS); the last resort is a quick H.264 re-encode so that
 * odd sources (MJPEG) still give something playable.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, rm, rename, writeFile } from 'node:fs/promises';
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

/** The ffmpeg arguments for one part. There is no fixed `-t` timer: the recorder watches the progress and stops ffmpeg itself once the file holds the wanted seconds of video, counted from the first frame. `-t` is only a distant safety cap. */
export function buildRecordArgs(input: StreamCandidate, seconds: number, outFile: string, transcode: boolean): string[] {
  return [
    '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.25',
    ...(input.isRtsp ? ['-rtsp_transport', 'tcp', '-allowed_media_types', 'video'] : []),
    '-i', input.url,
    '-t', String(Math.ceil(seconds * 3 + 30)),
    '-an',
    ...(transcode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
    // Fragmented, so the file is readable even if ffmpeg has to be killed (a source that went silent); the final file is made from it by a remux.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-flush_packets', '1',
    outFile,
  ];
}

export interface RecordResult { ok: boolean; bytes: number; failure?: string; /** Seconds of video in the file. */ seconds?: number; /** How many connections it took (more than 1 when the source dropped and the recorder reconnected). */ parts?: number }

/** Runs ffmpeg once (a thumbnail, joining parts); kills it if it outlives timeoutMs. Error text is scrubbed of anything in secrets. */
export function runFfmpeg(args: string[], timeoutMs: number, secrets: string[] = []): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stderr = '', timedOut = false, settled = false;
    let child;
    try { child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { resolve({ code: null, stderr: 'spawn: ' + (e instanceof Error ? e.message : e), timedOut: false }); return; }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1500); });
    const done = (code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code, stderr: secrets.filter(Boolean).reduce((t, x) => t.split(x).join('***'), stderr).trim(), timedOut });
    };
    child.on('error', (e) => { stderr += 'spawn: ' + e.message; done(null); });
    child.on('close', (code) => done(code));
  });
}

export interface PartResult { code: number | null; stderr: string; /** Seconds of video written (from ffmpeg's own progress). */ mediaSeconds: number; gotFrames: boolean; why: 'reached' | 'ended' | 'no-frames' | 'stalled' | 'error' }
export interface PartOptions { connectTimeoutMs: number; /** After the first frame, stop waiting after this long in total (a stalled source). */ maxAfterFirstFrameMs: number; secrets?: string[] }

/**
 * Records one part: starts ffmpeg, waits for the FIRST FRAME (connecting and waiting for a keyframe are not part of the length), then stops it
 * cleanly (a "q" on its input, so the MP4 is finished properly) once targetSeconds of video have been written.
 */
export function recordPart(args: string[], targetSeconds: number, o: PartOptions): Promise<PartResult> {
  return new Promise((resolve) => {
    let stderr = '', buf = '', mediaSeconds = 0, gotFrames = false, firstFrameAt = 0, why: PartResult['why'] = 'ended', settled = false, quitSent = false;
    let child;
    try { child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: null, stderr: 'spawn: ' + (e instanceof Error ? e.message : e), mediaSeconds: 0, gotFrames: false, why: 'error' }); return; }
    child.stdin.on('error', () => { /* ffmpeg already gone */ });
    const quit = (reason: PartResult['why']) => {
      if (quitSent) return; quitSent = true; why = reason;
      try { child.stdin.write('q\n'); child.stdin.end(); } catch { /* gone */ }
      setTimeout(() => child.kill('SIGKILL'), 3_000).unref(); // ffmpeg blocked on a silent connection never sees the q: the fragments written so far are kept
    };
    const started = Date.now();
    const watch = setInterval(() => {
      if (!gotFrames && Date.now() - started > o.connectTimeoutMs) { why = 'no-frames'; quitSent = true; child.kill('SIGKILL'); }
      else if (gotFrames && Date.now() - firstFrameAt > o.maxAfterFirstFrameMs) quit('stalled');
    }, 500);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        const m = /^out_time_(us|ms)=(-?\d+)$/.exec(line); // ffmpeg's "ms" is in fact microseconds
        if (m) {
          const t = Number(m[2]) / 1e6;
          if (t > 0 && !gotFrames) { gotFrames = true; firstFrameAt = Date.now(); }
          if (t > mediaSeconds) mediaSeconds = t;
          if (gotFrames && mediaSeconds >= targetSeconds) quit('reached');
        }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-1500); });
    const done = (code: number | null) => {
      if (settled) return; settled = true; clearInterval(watch);
      const reason: PartResult['why'] = why !== 'ended' ? why : (gotFrames || code === 0 ? 'ended' : 'error');
      resolve({ code, stderr: (o.secrets ?? []).filter(Boolean).reduce((t, x) => t.split(x).join('***'), stderr).trim(), mediaSeconds: Math.round(mediaSeconds * 10) / 10, gotFrames, why: reason });
    };
    child.on('error', (e) => { stderr += 'spawn: ' + e.message; done(null); });
    child.on('close', (code) => done(code));
  });
}

const MAX_PARTS = 4;

/**
 * Records seconds of video into outFile. The length is counted from the first frame, so the time spent connecting does not shorten the clip,
 * and if the source ends or drops before the length is reached the recorder reconnects and carries on (the parts are joined without re-encoding).
 * Tries each way of reading the stream in turn; the first that gives video is kept for the reconnects.
 */
export async function recordClip(candidates: StreamCandidate[], seconds: number, outFile: string, o: { connectTimeoutMs?: number; secrets?: string[]; part?: typeof recordPart; tolerance?: number; stallAfterMs?: number } = {}): Promise<RecordResult> {
  if (!candidates.length) return { ok: false, bytes: 0, failure: 'This camera has no stream address that can be recorded (a still-image address cannot).' };
  const part = o.part ?? recordPart;
  const connectTimeoutMs = o.connectTimeoutMs ?? 30_000;
  const tolerance = o.tolerance ?? 0.4;
  const plans: Array<{ c: StreamCandidate; transcode: boolean }> = candidates.map((c) => ({ c, transcode: false }));
  plans.push({ c: candidates[candidates.length - 1], transcode: true }); // last resort: re-encode what the last source gives
  const partFiles: string[] = [];
  const cleanup = async () => { for (const p of partFiles) await rm(p, { force: true }); partFiles.length = 0; await rm(outFile, { force: true }); };
  let last = 'no attempt was made';
  for (const { c, transcode } of plans) {
    let total = 0, usable = false, misses = 0, stalled = false;
    // The same source again after a drop; stop after MAX_PARTS connections or when a connection gives nothing.
    while (total < seconds - tolerance && partFiles.length < MAX_PARTS && misses < 1 && !stalled) {
      const file = outFile + '.part' + (partFiles.length + 1) + '.mp4';
      await rm(file, { force: true });
      const want = Math.max(1, seconds - total);
      const r = await part(buildRecordArgs(c, want, file, transcode), want, { connectTimeoutMs, maxAfterFirstFrameMs: o.stallAfterMs ?? want * 2000 + 20_000, secrets: o.secrets });
      const size = await stat(file).then((x) => x.size, () => 0);
      if (r.gotFrames && size > 2_000) { partFiles.push(file); total += r.mediaSeconds; usable = true; if (r.why === 'stalled') stalled = true; }
      else {
        misses++;
        await rm(file, { force: true });
        last = r.why === 'no-frames' ? c.label + ': no video within ' + Math.round(connectTimeoutMs / 1000) + ' s' : c.label + (transcode ? ' (re-encoded)' : '') + ': ' + (r.stderr.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) || 'ffmpeg exit ' + r.code);
        // A refusal for credentials will not get better by trying again another way.
        if (/\b401\b|Unauthorized/i.test(r.stderr)) { await cleanup(); return { ok: false, bytes: 0, failure: c.label + ': the stream answered 401 Unauthorized (check the stream access email and password)' }; }
      }
    }
    if (!usable) continue;
    const usedParts = partFiles.length;
    if (total < Math.min(3, seconds)) { last = c.label + ': the stream gave only ' + total.toFixed(1) + ' s of video'; await cleanup(); continue; }
    // The parts are fragmented MP4 (they survive an ffmpeg that has to be killed). The final file is made from them with a remux, no re-encoding:
    // one part or several joined, finished properly (index at the front), and cut to the length asked for when a source delivered faster than real time
    // (a recorded file, the backlog a live HLS stream sends first) and overshot before the stop landed.
    const cut = total > seconds + 0.5 ? ['-t', String(seconds)] : [];
    let input: string[];
    const list = outFile + '.list.txt';
    if (partFiles.length === 1) input = ['-i', partFiles[0]];
    else {
      await writeFile(list, partFiles.map((p) => "file '" + p.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n'));
      input = ['-f', 'concat', '-safe', '0', '-i', list];
    }
    const j = await runFfmpeg(['-y', '-loglevel', 'error', ...input, ...cut, '-c', 'copy', '-movflags', '+faststart', outFile], 120_000);
    await rm(list, { force: true });
    for (const p of partFiles) await rm(p, { force: true });
    partFiles.length = 0;
    const size = await stat(outFile).then((x) => x.size, () => 0);
    if (j.code !== 0 || size < 2_000) { await rm(outFile, { force: true }); return { ok: false, bytes: 0, failure: 'The recording could not be finished: ' + j.stderr.slice(-200) }; }
    return { ok: true, bytes: size, seconds: cut.length ? seconds : Math.round(total * 10) / 10, parts: usedParts };
  }
  await cleanup();
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
