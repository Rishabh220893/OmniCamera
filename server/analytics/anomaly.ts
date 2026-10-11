/**
 * Turns counts into `count.anomaly` events (gap A17). It listens to the events the scene analysis and the detectors already produce
 * (`person.seen`, `vehicle.seen`, each carrying a count), keeps each camera's usual for the hour of the week (`baseline.ts`), and raises an event when a
 * count is far above (a crowd, a jam) or, for a camera that is normally busy, far below (a blocked or switched-off view that still sends frames) what
 * is usual for that hour.
 *
 * One event per camera and metric per `cooldownMs`, so a crowd that stays does not raise an event every frame. State is saved to a file now and then so
 * a restart does not forget what was learned.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeEvent, type PlatformEvent } from '../events/schema';
import { createBaseline, hourOfWeek, type Baseline, type BucketState, type Metric } from './baseline';

export interface AnomalyOptions {
  /** Standard deviations from usual that count as unusual. Default 3. */
  sigma?: number;
  /** A count must also differ from the usual by at least this many (people or vehicles): 1 more than usual on a quiet street is not news. Default 4. */
  minDifference?: number;
  /** Quiet periods (counts far below usual) are reported only for cameras whose usual is at least this. Default 5. */
  minUsualForLow?: number;
  /** Least time between two events for the same camera and metric. Default 15 minutes. */
  cooldownMs?: number;
  /** An unusual value is NOT learned (or a crowd would become the new normal after a few frames); but if a camera stays at the new level for this many
   * values in a row it is accepted as the new usual (a changed road layout, a new market). Default 60. */
  acceptAfter?: number;
  /** Where to keep what was learned (JSON). Optional. */
  stateFile?: string;
  baseline?: Baseline;
  now?: () => Date;
  log?: Pick<Console, 'warn'>;
}

const METRIC_OF: Record<string, Metric | undefined> = { 'person.seen': 'people', 'vehicle.seen': 'vehicles' };
const WORD: Record<Metric, string> = { people: 'people', vehicles: 'vehicles' };

export function createAnomalyDetector(o: AnomalyOptions = {}) {
  const sigma = o.sigma ?? 3, minDiff = o.minDifference ?? 4, minLow = o.minUsualForLow ?? 5, cooldownMs = o.cooldownMs ?? 15 * 60_000;
  const baseline = o.baseline ?? createBaseline();
  const log = o.log ?? console;
  const acceptAfter = o.acceptAfter ?? 60;
  const lastRaised = new Map<string, number>();
  const streak = new Map<string, number>();
  let dirty = false, saving: Promise<void> | null = null;

  async function load() {
    if (!o.stateFile) return;
    try { baseline.import(JSON.parse(await fs.readFile(o.stateFile, 'utf8')) as Record<string, BucketState>); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`[ANOMALY] could not read ${o.stateFile}: ${e instanceof Error ? e.message : e}`); }
  }

  async function save() {
    if (!o.stateFile || !dirty) return;
    dirty = false;
    saving = (async () => {
      await fs.mkdir(path.dirname(o.stateFile!), { recursive: true });
      const tmp = `${o.stateFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(baseline.export()));
      await fs.rename(tmp, o.stateFile!);
    })().catch((e) => { dirty = true; log.warn(`[ANOMALY] could not save: ${e instanceof Error ? e.message : e}`); });
    await saving;
  }

  /** Looks at a batch of events; returns the anomaly events it raises (to be published by the caller). */
  function handle(events: PlatformEvent[]): PlatformEvent[] {
    const out: PlatformEvent[] = [];
    for (const e of events) {
      const metric = METRIC_OF[e.type];
      const value = Number(e.data?.count);
      if (!metric || !Number.isFinite(value) || value < 0) continue;
      const at = new Date(e.ts);
      const obs = { key: e.cameraId, metric, at, value };
      const s = baseline.score(obs);
      const k = `${e.cameraId}|${metric}`;
      const high = s.z !== null && s.z >= sigma && value - s.expected >= minDiff;
      const low = s.z !== null && s.z <= -sigma && s.expected >= minLow && s.expected - value >= minDiff;
      // Judged before it is learned, and an unusual value is learned only once it has lasted (see `acceptAfter`).
      const run = high || low ? (streak.get(k) ?? 0) + 1 : 0;
      streak.set(k, run);
      if (run === 0 || run > acceptAfter) { baseline.observe(obs); dirty = true; }
      if (!high && !low) continue;
      const t = at.getTime();
      if (t - (lastRaised.get(k) ?? -Infinity) < cooldownMs) continue;
      lastRaised.set(k, t);
      const hw = hourOfWeek(at);
      out.push(makeEvent({
        type: 'count.anomaly', severity: high ? 'warning' : 'notice',
        summary: high
          ? `Unusually many ${WORD[metric]} at ${e.cameraName}: ${value} (usually about ${Math.round(s.expected)} at this hour)`
          : `Unusually few ${WORD[metric]} at ${e.cameraName}: ${value} (usually about ${Math.round(s.expected)} at this hour)`,
        data: { metric, count: value, expected: Math.round(s.expected * 10) / 10, stdev: Math.round(s.stdev * 100) / 100, sigma: Math.round(s.z * 10) / 10, direction: high ? 'high' : 'low', hourOfWeek: hw, basedOn: s.samples },
        tags: ['anomaly', metric], dedupeKey: `${metric}:${Math.floor(t / cooldownMs)}`,
      }, { source: 'anomaly-baseline', camera: { id: e.cameraId, name: e.cameraName, userId: e.userId, department: e.department, location: e.location }, ts: at }));
    }
    return out;
  }

  return { handle, load, save, baseline, flushed: () => saving ?? Promise.resolve() };
}
export type AnomalyDetector = ReturnType<typeof createAnomalyDetector>;
