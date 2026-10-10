/**
 * The index over recorded segments, read straight from disk (gap G10). MediaMTX writes one fragmented-MP4 file per segment as
 * `<dir>/<camera>/<YYYY-MM-DD_HH-MM-SS-ffffff>.mp4` (the stamp is the segment's start in the media server's LOCAL time, which a real
 * MediaMTX run showed; see `nameTime`), so the files themselves are the index:
 * nothing can drift out of step with what is really on disk, and a restart loses nothing. Durations come from ffprobe once per
 * finished file and are remembered.
 *
 * Two tiers: `hot` is where MediaMTX writes; an optional `warm` directory (slower, cheaper disk or a mounted share) receives
 * segments older than `hotDays`. Both are read as one timeline. Remote object storage (S3 and the like) is not implemented; the
 * `Tier` shape is what such a backend would have to provide.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ColdTier } from './coldTier';
import { SEGMENT_SECONDS } from './policy';

export interface Segment {
  cameraId: string;
  start: Date;
  /** null while the file is still being written. */
  end: Date | null;
  file: string;
  bytes: number;
  tier: 'hot' | 'warm' | 'cold';
}

export interface Gap { from: Date; to: Date }

export const CAMERA_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.mp4$/;

/**
 * Which clock the stamp in a file name is written in. MediaMTX uses the local time of the machine it runs on, so `local` is right when
 * it runs on the same machine (or time zone) as this server; run both with TZ=UTC and use `utc` to remove the ambiguity (an hour that
 * repeats when clocks go back cannot be told apart in local time).
 */
export type NameTime = 'local' | 'utc';

/** The start time encoded in a segment's file name, or null for any other file. */
export function parseSegmentName(name: string, mode: NameTime = 'local'): Date | null {
  const m = name.match(FILE_RE);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]], ms = Math.floor(+m[7] / 1000);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = mode === 'utc' ? new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms)) : new Date(y, mo - 1, d, h, mi, s, ms);
  const back = mode === 'utc' ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()] : [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  return Number.isNaN(date.getTime()) || back[0] !== y || back[1] !== mo || back[2] !== d ? null : date;
}

export function segmentName(start: Date, mode: NameTime = 'local'): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const u = mode === 'utc';
  const f = { y: u ? start.getUTCFullYear() : start.getFullYear(), mo: u ? start.getUTCMonth() : start.getMonth(), d: u ? start.getUTCDate() : start.getDate(), h: u ? start.getUTCHours() : start.getHours(), mi: u ? start.getUTCMinutes() : start.getMinutes(), s: u ? start.getUTCSeconds() : start.getSeconds(), ms: u ? start.getUTCMilliseconds() : start.getMilliseconds() };
  return `${f.y}-${p(f.mo + 1)}-${p(f.d)}_${p(f.h)}-${p(f.mi)}-${p(f.s)}-${p(f.ms * 1000, 6)}.mp4`;
}

export type DurationProbe = (file: string) => Promise<number | null>;

/** Duration in seconds of a finished MP4, or null when it cannot be read (still being written, or damaged). */
export const ffprobeDuration: DurationProbe = (file) => new Promise((resolve) => {
  const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (b) => { out += b; });
  const t = setTimeout(() => p.kill('SIGKILL'), 15_000);
  p.on('error', () => { clearTimeout(t); resolve(null); });
  p.on('close', () => { clearTimeout(t); const s = parseFloat(out); resolve(Number.isFinite(s) && s > 0 ? s : null); });
});

export interface StoreOptions {
  hotDir: string;
  warmDir?: string;
  /** Object storage for the oldest footage (coldTier.ts). A cold segment is fetched to `cacheDir` when something needs the file. */
  cold?: ColdTier;
  cacheDir?: string;
  /** Downloaded cold segments kept at most this many bytes (oldest-used removed first). Default 2 GB. */
  cacheMaxBytes?: number;
  probe?: DurationProbe;
  /** See NameTime. Default `local`. */
  nameTime?: NameTime;
  now?: () => Date;
  /** A file written to this recently is treated as still open. Default 20 s. */
  openWithinMs?: number;
}

export interface RecordingStore {
  cameras(): Promise<string[]>;
  segments(cameraId: string, from: Date, to: Date): Promise<Segment[]>;
  all(cameraId: string): Promise<Segment[]>;
  coverage(cameraId: string, from: Date, to: Date, minGapMs?: number): Promise<{ segments: Segment[]; gaps: Gap[]; recordedMs: number }>;
  usage(): Promise<{ cameras: Array<{ cameraId: string; bytes: number; segments: number; oldest: Date | null; newest: Date | null }>; totalBytes: number; freeBytes: { hot: number | null; warm: number | null } }>;
  /** Moves a segment to the warm tier. */
  moveToWarm(s: Segment): Promise<void>;
  /** Uploads a segment to the cold tier and, once the object store confirms it, deletes the local copy. */
  moveToCold(s: Segment): Promise<void>;
  remove(s: Segment): Promise<void>;
  /** A local path to the segment's file: its own for hot/warm, a downloaded copy for cold. */
  materialize(s: Segment, pinned?: Set<string>): Promise<string>;
  readonly hotDir: string;
  readonly warmDir?: string;
  readonly hasCold: boolean;
}

export function createRecordingStore(o: StoreOptions): RecordingStore {
  const probe = o.probe ?? ffprobeDuration;
  const now = o.now ?? (() => new Date());
  const openWithin = o.openWithinMs ?? 20_000;
  const durations = new Map<string, number>();
  const nameTime = o.nameTime ?? 'local';

  async function listTier(dir: string, tier: 'hot' | 'warm', cameraId: string): Promise<Segment[]> {
    const camDir = path.join(dir, cameraId);
    let names: string[];
    try { names = await fs.readdir(camDir); } catch { return []; }
    const out: Segment[] = [];
    for (const n of names) {
      const start = parseSegmentName(n, nameTime);
      if (!start) continue;
      const file = path.join(camDir, n);
      try { const st = await fs.stat(file); if (st.isFile()) out.push({ cameraId, start, end: null, file, bytes: st.size, tier }); } catch { /* removed while listing */ }
    }
    return out;
  }

  async function all(cameraId: string): Promise<Segment[]> {
    if (!CAMERA_RE.test(cameraId)) return [];
    const local = [...await listTier(o.hotDir, 'hot', cameraId), ...(o.warmDir ? await listTier(o.warmDir, 'warm', cameraId) : [])];
    const have = new Set(local.map((s) => path.basename(s.file)));
    const remote: Segment[] = [];
    if (o.cold) {
      for (const obj of await o.cold.list(cameraId)) {
        const start = parseSegmentName(obj.name, nameTime);
        // A file that is still local (an upload in progress, or one being moved) wins over its copy in the object store.
        if (!start || have.has(obj.name)) continue;
        remote.push({ cameraId, start, end: new Date(start.getTime() + (obj.durationSec ?? SEGMENT_SECONDS) * 1000), file: `cold://${cameraId}/${obj.name}`, bytes: obj.bytes, tier: 'cold' });
      }
    }
    const segs = [...local, ...remote].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.tier === 'cold') continue; // its end came with the listing
      const st = await fs.stat(s.file).catch(() => null);
      if (!st) continue;
      const key = `${s.file}\u0000${st.size}\u0000${st.mtimeMs}`;
      const isOpen = now().getTime() - st.mtimeMs < openWithin;
      if (isOpen) { s.end = null; continue; }
      let d = durations.get(key);
      if (d === undefined) {
        const probed = await probe(s.file);
        if (probed === null) {
          // Unreadable: bound it by the next segment's start (or its own last write) so the timeline stays honest about a hole.
          const next = segs[i + 1];
          s.end = new Date(next ? Math.min(next.start.getTime(), st.mtimeMs) : st.mtimeMs);
          continue;
        }
        d = probed; durations.set(key, d);
        if (durations.size > 50_000) durations.delete(durations.keys().next().value as string);
      }
      s.end = new Date(s.start.getTime() + d * 1000);
    }
    return segs;
  }

  const endOf = (s: Segment) => (s.end ?? now()).getTime();

  const cacheDir = o.cacheDir ?? path.join(os.tmpdir(), 'omnisee-cold-cache');
  const cacheMax = o.cacheMaxBytes ?? 2 * 1024 ** 3;
  /** Makes room for `incoming` bytes by deleting the least recently used downloaded segments (never the pinned ones, so a clip can exceed the bound). */
  async function evictCache(incoming: number, pinned?: Set<string>): Promise<void> {
    const files: Array<{ file: string; size: number; used: number }> = [];
    for (const cam of await fs.readdir(cacheDir).catch(() => [] as string[])) {
      for (const n of await fs.readdir(path.join(cacheDir, cam)).catch(() => [] as string[])) {
        if (!FILE_RE.test(n)) continue;
        const st = await fs.stat(path.join(cacheDir, cam, n)).catch(() => null);
        if (st) files.push({ file: path.join(cacheDir, cam, n), size: st.size, used: st.mtimeMs });
      }
    }
    let total = files.reduce((n, f) => n + f.size, 0) + incoming;
    for (const f of files.sort((a, b) => a.used - b.used)) {
      if (total <= cacheMax) break;
      if (pinned?.has(f.file)) continue; // part of the clip being built right now
      await fs.unlink(f.file).catch(() => undefined);
      total -= f.size;
    }
  }

  return {
    hotDir: o.hotDir, warmDir: o.warmDir, all,
    async cameras() {
      const names = new Set<string>();
      for (const dir of [o.hotDir, o.warmDir]) {
        if (!dir) continue;
        for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && CAMERA_RE.test(e.name) && e.name !== 'exports') names.add(e.name); // 'exports' is where evidence clips go
      }
      for (const c of (await o.cold?.cameras().catch(() => [])) ?? []) if (CAMERA_RE.test(c)) names.add(c);
      return [...names].sort();
    },
    async segments(cameraId, from, to) {
      return (await all(cameraId)).filter((s) => s.start.getTime() < to.getTime() && endOf(s) > from.getTime());
    },
    async coverage(cameraId, from, to, minGapMs = 2000) {
      const segments = await this.segments(cameraId, from, to);
      const gaps: Gap[] = [];
      let cursor = from.getTime(), recorded = 0;
      for (const s of segments) {
        const a = Math.max(s.start.getTime(), from.getTime()), b = Math.min(endOf(s), to.getTime());
        if (a - cursor >= minGapMs) gaps.push({ from: new Date(cursor), to: new Date(a) });
        recorded += Math.max(0, b - Math.max(a, cursor));
        cursor = Math.max(cursor, b);
      }
      if (to.getTime() - cursor >= minGapMs) gaps.push({ from: new Date(cursor), to });
      return { segments, gaps, recordedMs: recorded };
    },
    async usage() {
      const cams = [];
      let total = 0;
      for (const cameraId of await this.cameras()) {
        const segs = await all(cameraId);
        const bytes = segs.reduce((n, s) => n + s.bytes, 0);
        total += bytes;
        cams.push({ cameraId, bytes, segments: segs.length, oldest: segs[0]?.start ?? null, newest: segs.length ? segs[segs.length - 1].start : null });
      }
      const free = async (dir?: string) => { if (!dir) return null; try { const s = await fs.statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; } };
      return { cameras: cams, totalBytes: total, freeBytes: { hot: await free(o.hotDir), warm: await free(o.warmDir) } };
    },
    async moveToWarm(s) {
      if (!o.warmDir || s.tier !== 'hot') return;
      const dest = path.join(o.warmDir, s.cameraId, path.basename(s.file));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try { await fs.rename(s.file, dest); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        // Another disk: copy to a temporary name, then rename into place, then delete the original, so a crash never leaves half a file under the real name.
        const tmp = `${dest}.part`;
        await fs.copyFile(s.file, tmp);
        await fs.rename(tmp, dest);
        await fs.unlink(s.file);
      }
    },
    hasCold: !!o.cold,
    async moveToCold(s) {
      if (!o.cold || s.tier === 'cold') return;
      const d = s.end ? (s.end.getTime() - s.start.getTime()) / 1000 : null;
      await o.cold.put(s.cameraId, path.basename(s.file), s.file, d, s.bytes);
      await this.remove(s);
    },
    async materialize(s, pinned) {
      if (s.tier !== 'cold') return s.file;
      if (!o.cold) throw new Error('This segment is in the object store, which is not configured.');
      const name = path.basename(s.file);
      const dir = path.join(cacheDir, s.cameraId);
      const dest = path.join(dir, name);
      await fs.mkdir(dir, { recursive: true });
      const have = await fs.stat(dest).catch(() => null);
      pinned?.add(dest);
      if (have && have.size === s.bytes) { const t = new Date(); await fs.utimes(dest, t, t).catch(() => undefined); return dest; }
      await evictCache(s.bytes, pinned);
      await o.cold.download(s.cameraId, name, dest);
      return dest;
    },
    async remove(s) {
      if (s.tier === 'cold') {
        if (!o.cold) throw new Error('This segment is in the object store, which is not configured.');
        const name = path.basename(s.file);
        if (!FILE_RE.test(name) || !CAMERA_RE.test(s.cameraId)) throw new Error('Refusing to delete an object that is not a recorded segment.');
        await o.cold.remove(s.cameraId, name);
        await fs.unlink(path.join(cacheDir, s.cameraId, name)).catch(() => undefined);
        return;
      }
      const root = path.resolve(s.tier === 'hot' ? o.hotDir : o.warmDir ?? '');
      const abs = path.resolve(s.file);
      if (!root || !abs.startsWith(root + path.sep) || !FILE_RE.test(path.basename(abs))) throw new Error('Refusing to delete a file that is not a recorded segment.');
      await fs.unlink(abs);
    },
  };
}
