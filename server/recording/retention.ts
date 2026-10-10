/**
 * Keeps recordings for as long as policy says and no longer, except where a hold says otherwise (gap G10).
 *   - older than `hotDays`  -> moved to the warm tier (when there is one)
 *   - older than `keepDays` -> deleted
 *   - anything under a hold (evidence) is never moved or deleted until the hold is released
 *   - a segment still being written is never touched
 * Policies and holds live in small JSON files written atomically, so they survive restarts and can be read by a person.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecordingStore, Segment } from './store';
import { parsePolicy, type RecordingPolicy } from './policy';

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; }
}
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

// ---- policies ----------------------------------------------------------------------------------------------------------

export interface PolicyFile { default: RecordingPolicy; cameras: Record<string, RecordingPolicy> }
const OFF: RecordingPolicy = { mode: 'off', keepDays: 7 };

export function createPolicyStore(file: string) {
  let cache: PolicyFile | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<PolicyFile> => {
    if (cache) return cache;
    const raw = await readJson<Partial<PolicyFile>>(file, {});
    cache = { default: raw.default ? parsePolicy(raw.default) : OFF, cameras: Object.fromEntries(Object.entries(raw.cameras ?? {}).map(([id, p]) => [id, parsePolicy(p)])) };
    return cache;
  };
  const change = <T>(fn: (p: PolicyFile) => T): Promise<T> => {
    const run = chain.then(async () => { const p = await load(); const r = fn(p); await writeJsonAtomic(file, p); return r; });
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    load,
    /** The policy that applies to a camera (its own, else the default). Needs `load()` to have run. */
    forCamera: (id: string): RecordingPolicy => cache?.cameras[id] ?? cache?.default ?? OFF,
    setCamera: (id: string, policy: RecordingPolicy) => change((p) => { p.cameras[id] = policy; }),
    clearCamera: (id: string) => change((p) => { delete p.cameras[id]; }),
    setDefault: (policy: RecordingPolicy) => change((p) => { p.default = policy; }),
  };
}
export type PolicyStore = ReturnType<typeof createPolicyStore>;

// ---- holds ---------------------------------------------------------------------------------------------------------------

export interface Hold { id: string; cameraId: string; from: string; to: string; reason: string; by: string; createdAt: string; releasedAt?: string; releasedBy?: string }

export function createHoldStore(file: string, now: () => Date = () => new Date()) {
  let chain: Promise<unknown> = Promise.resolve();
  const change = <T>(fn: (h: Hold[]) => T): Promise<T> => {
    const run = chain.then(async () => { const h = await readJson<Hold[]>(file, []); const r = fn(h); await writeJsonAtomic(file, h); return r; });
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    list: async (cameraId?: string, includeReleased = false) => (await readJson<Hold[]>(file, [])).filter((h) => (!cameraId || h.cameraId === cameraId) && (includeReleased || !h.releasedAt)),
    add: (h: { cameraId: string; from: Date; to: Date; reason: string; by: string }) => change((all) => {
      const hold: Hold = { id: randomUUID(), cameraId: h.cameraId, from: h.from.toISOString(), to: h.to.toISOString(), reason: h.reason.slice(0, 300), by: h.by, createdAt: now().toISOString() };
      all.push(hold);
      return hold;
    }),
    release: (id: string, by: string) => change((all) => {
      const hold = all.find((x) => x.id === id && !x.releasedAt);
      if (!hold) return null;
      hold.releasedAt = now().toISOString(); hold.releasedBy = by;
      return hold;
    }),
  };
}
export type HoldStore = ReturnType<typeof createHoldStore>;

// ---- the retention run --------------------------------------------------------------------------------------------------

export interface RetentionOptions {
  store: RecordingStore;
  policyFor(cameraId: string): RecordingPolicy;
  holds: HoldStore;
  /** Segments older than this many days go to the warm tier; ignored without one. Default: never (everything stays hot until deleted). */
  hotDays?: number;
  /** Segments older than this many days go to the object store (needs one). From hot or warm, whichever they are in. */
  coldDays?: number;
  now?: () => Date;
  /** Count what would happen without doing it. */
  dryRun?: boolean;
  log?: Pick<Console, 'warn'>;
}

export interface RetentionReport { examined: number; moved: number; movedToCold: number; deleted: number; heldKept: number; openKept: number; errors: number; freedBytes: number; dryRun: boolean }

export async function runRetention(o: RetentionOptions): Promise<RetentionReport> {
  const now = (o.now ?? (() => new Date()))();
  const log = o.log ?? console;
  const r: RetentionReport = { examined: 0, moved: 0, movedToCold: 0, deleted: 0, heldKept: 0, openKept: 0, errors: 0, freedBytes: 0, dryRun: !!o.dryRun };
  const holds = await o.holds.list();
  for (const cameraId of await o.store.cameras()) {
    const policy = o.policyFor(cameraId);
    const keepMs = policy.keepDays * 86_400_000;
    const camHolds = holds.filter((h) => h.cameraId === cameraId).map((h) => [new Date(h.from).getTime(), new Date(h.to).getTime()] as const);
    for (const s of await o.store.all(cameraId)) {
      r.examined++;
      if (s.end === null) { r.openKept++; continue; }
      const held = camHolds.some(([a, b]) => s.start.getTime() < b && s.end!.getTime() > a);
      const age = now.getTime() - s.end.getTime();
      const wantDelete = age > keepMs;
      const wantCold = !wantDelete && o.store.hasCold && o.coldDays !== undefined && s.tier !== 'cold' && age > o.coldDays * 86_400_000;
      const wantMove = !wantDelete && !wantCold && !!o.store.warmDir && o.hotDays !== undefined && s.tier === 'hot' && age > o.hotDays * 86_400_000;
      if (!wantDelete && !wantMove && !wantCold) continue;
      if (held) { r.heldKept++; continue; }
      try {
        if (wantDelete) { if (!o.dryRun) await o.store.remove(s); r.deleted++; r.freedBytes += s.bytes; }
        else if (wantCold) { if (!o.dryRun) await o.store.moveToCold(s); r.movedToCold++; }
        else { if (!o.dryRun) await o.store.moveToWarm(s); r.moved++; }
      } catch (e) { r.errors++; log.warn(`[RECORDING] could not ${wantDelete ? 'delete' : wantCold ? 'upload' : 'move'} ${path.basename(s.file)} of ${cameraId}: ${e instanceof Error ? e.message : e}`); }
    }
  }
  return r;
}

/** Whether a time range overlaps an active hold on the camera (used by routes to say so). */
export const overlapsHold = (holds: Hold[], s: Pick<Segment, 'cameraId' | 'start' | 'end'>) =>
  holds.some((h) => !h.releasedAt && h.cameraId === s.cameraId && s.start.getTime() < new Date(h.to).getTime() && (s.end?.getTime() ?? Date.now()) > new Date(h.from).getTime());
