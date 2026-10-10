/**
 * Cuts a stretch of one camera's recordings into a single MP4 (gap G10): for quick playback and for evidence exports. The video is
 * copied, not re-encoded, so it is fast and exactly what the camera sent; the cut therefore starts at the keyframe at or before the
 * requested time (the manifest says where it really starts). An evidence export also gets a manifest with a SHA-256 of the file and of
 * every source segment, so a later copy can be checked against what was exported.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { RecordingStore, Segment } from './store';

export class ClipError extends Error {
  constructor(message: string, readonly code: 'no_footage' | 'too_long' | 'bad_range' | 'ffmpeg') { super(message); this.name = 'ClipError'; }
}

export const sha256File = (file: string): Promise<string> => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
});

const run = (args: string[], timeoutMs: number): Promise<{ code: number | null; err: string }> => new Promise((resolve) => {
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
  const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
  p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, err: String(e) }); });
  p.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
});

export interface ClipResult {
  file: string;
  bytes: number;
  requestedFrom: string;
  requestedTo: string;
  /** Where the video really starts: the first segment may begin after `from`, and the cut snaps to a keyframe. */
  actualFrom: string;
  durationSec: number;
  segments: Array<{ name: string; start: string; end: string | null; sha256?: string }>;
  /** Stretches inside the range with no recording, so a viewer is told about the holes rather than shown a seamless clip. */
  gaps: Array<{ from: string; to: string }>;
  sha256?: string;
}

export async function makeClip(store: RecordingStore, o: { cameraId: string; from: Date; to: Date; outFile: string; maxSeconds: number; hash?: boolean; timeoutMs?: number }): Promise<ClipResult> {
  const spanSec = (o.to.getTime() - o.from.getTime()) / 1000;
  if (!(spanSec > 0)) throw new ClipError("'to' must be after 'from'.", 'bad_range');
  if (spanSec > o.maxSeconds) throw new ClipError(`A clip can be at most ${Math.round(o.maxSeconds / 60)} minutes.`, 'too_long');
  const cov = await store.coverage(o.cameraId, o.from, o.to);
  const segs: Segment[] = cov.segments.filter((s) => s.end !== null || s.bytes > 0);
  if (!segs.length) throw new ClipError('There is no recording for that camera in that time.', 'no_footage');

  await fs.mkdir(path.dirname(o.outFile), { recursive: true });
  // Segments in the object store are fetched to local files first (the cutter reads files).
  const files = new Map<Segment, string>();
  const pinned = new Set<string>();
  for (const s of segs) files.set(s, await store.materialize(s, pinned));
  const listFile = `${o.outFile}.list.txt`;
  // The concat demuxer's quoting: single quotes, with ' written as '\''.
  await fs.writeFile(listFile, segs.map((s) => `file '${path.resolve(files.get(s)!).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const offsetSec = Math.max(0, (o.from.getTime() - segs[0].start.getTime()) / 1000);
  const lastEnd = Math.min(o.to.getTime(), segs[segs.length - 1].end?.getTime() ?? o.to.getTime());
  const wantSec = Math.max(0.1, (lastEnd - Math.max(o.from.getTime(), segs[0].start.getTime())) / 1000);
  const tmp = `${o.outFile}.part.mp4`;
  try {
    const r = await run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-ss', offsetSec.toFixed(3), '-t', wantSec.toFixed(3), '-c', 'copy', '-movflags', '+faststart', tmp], o.timeoutMs ?? 120_000);
    if (r.code !== 0) throw new ClipError(`ffmpeg could not build the clip (${r.err.trim().split('\n').pop() || `exit ${r.code}`}).`, 'ffmpeg');
    await fs.rename(tmp, o.outFile);
  } finally { await fs.unlink(listFile).catch(() => undefined); await fs.unlink(tmp).catch(() => undefined); }

  const st = await fs.stat(o.outFile);
  const actualFrom = new Date(Math.max(o.from.getTime(), segs[0].start.getTime()));
  const result: ClipResult = {
    file: o.outFile, bytes: st.size, requestedFrom: o.from.toISOString(), requestedTo: o.to.toISOString(), actualFrom: actualFrom.toISOString(), durationSec: wantSec,
    segments: [], gaps: cov.gaps.map((g) => ({ from: g.from.toISOString(), to: g.to.toISOString() })),
  };
  for (const s of segs) result.segments.push({ name: path.basename(s.file), start: s.start.toISOString(), end: s.end ? s.end.toISOString() : null, ...(o.hash ? { sha256: await sha256File(files.get(s)!) } : {}) });
  if (o.hash) result.sha256 = await sha256File(o.outFile);
  return result;
}
