/**
 * Decides which cameras to probe again, and when (docs/camera-onboarding-plan.md sections 7 and 9). The streams are real time,
 * a probe takes ~30 s per camera, and the grid limits how much one account may watch, so this is light by design:
 * a small budget per hour, never while a probe is already running, the cameras that need news first.
 *
 * Pure selection plus a small timer wrapper with an injected clock, like server/probeJob.ts (which does the probing).
 */
import type { ProfileRow } from './cameraProfile';

export interface ReprobeConfig {
  /** A camera that is healthy. */
  healthyEveryMs: number;
  /** A camera whose last probe failed but whose stored profile is still the earlier good one. */
  failingEveryMs: number;
  /** A camera self-healing moved down: it can only come back after 24 h anyway, so there is no point probing it hourly. */
  healedEveryMs: number;
  /** A camera stored as having no video. */
  unsupportedEveryMs: number;
  /** At most this many cameras are started per rolling hour. */
  perHour: number;
  /** At most this many go into one probe run. */
  batch: number;
}

export const DEFAULT_REPROBE_CONFIG: ReprobeConfig = {
  healthyEveryMs: 24 * 3_600_000, failingEveryMs: 3_600_000, healedEveryMs: 6 * 3_600_000, unsupportedEveryMs: 6 * 3_600_000, perHour: 6, batch: 2,
};

export function reprobeEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return (env.MEDIA_REPROBE ?? '').trim().toLowerCase() === 'on';
}

export function reprobeConfigFromEnv(env: Record<string, string | undefined>): ReprobeConfig {
  const num = (k: string, scale: number, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n * scale : d; };
  const d = DEFAULT_REPROBE_CONFIG;
  return {
    healthyEveryMs: num('MEDIA_REPROBE_HOURS', 3_600_000, d.healthyEveryMs),
    failingEveryMs: num('MEDIA_REPROBE_FAILING_MIN', 60_000, d.failingEveryMs),
    healedEveryMs: num('MEDIA_REPROBE_HEALED_HOURS', 3_600_000, d.healedEveryMs),
    unsupportedEveryMs: num('MEDIA_REPROBE_UNSUPPORTED_HOURS', 3_600_000, d.unsupportedEveryMs),
    perHour: Math.round(num('MEDIA_REPROBE_PER_HOUR', 1, d.perHour)),
    batch: Math.round(num('MEDIA_REPROBE_BATCH', 1, d.batch)),
  };
}

export type ReprobeClass = 'failing' | 'healed' | 'unsupported' | 'healthy';
const RANK: Record<ReprobeClass, number> = { failing: 0, healed: 1, unsupported: 2, healthy: 3 };

export function classOf(row: ProfileRow): ReprobeClass {
  if (row.report.failure) return 'unsupported';
  if (row.lastFailure) return 'failing';
  if (row.healFloor) return 'healed';
  return 'healthy';
}

const intervalOf = (c: ReprobeClass, cfg: ReprobeConfig) =>
  c === 'failing' ? cfg.failingEveryMs : c === 'healed' ? cfg.healedEveryMs : c === 'unsupported' ? cfg.unsupportedEveryMs : cfg.healthyEveryMs;

export interface Due { cameraId: string; cls: ReprobeClass; overdueMs: number }

/** Cameras whose time has come, most pressing first: failing before healed before unsupported before healthy, then the most overdue. */
export function dueForReprobe(rows: ProfileRow[], now: number, cfg: ReprobeConfig): Due[] {
  const due: Due[] = [];
  for (const row of rows) {
    const cls = classOf(row);
    // The time of the last attempt: a failed probe leaves the old profile in place, so its own time is in lastFailure.
    const last = Math.max(Date.parse(row.report.probedAt) || 0, row.lastFailure ? Date.parse(row.lastFailure.probedAt) || 0 : 0);
    const overdueMs = now - last - intervalOf(cls, cfg);
    if (overdueMs >= 0) due.push({ cameraId: row.report.cameraId, cls, overdueMs });
  }
  return due.sort((a, b) => RANK[a.cls] - RANK[b.cls] || b.overdueMs - a.overdueMs || a.cameraId.localeCompare(b.cameraId, undefined, { numeric: true }));
}

export interface SchedulerDeps {
  list: () => Promise<ProfileRow[]>;
  /** Starts a probe run over these cameras; false when one is already running. */
  start: (ids: string[]) => boolean | Promise<boolean>;
  /** True while a probe run is going (from anyone), so the scheduler waits. */
  busy: () => boolean;
  cfg?: ReprobeConfig;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SchedulerStatus { enabled: boolean; lastRunAt: string | null; lastIds: string[]; startedLastHour: number; nextDue: Due[]; error: string | null }

export interface ReprobeScheduler {
  /** One look at what is due; starts at most one batch. Called by the timer, and directly by tests. */
  tick(): Promise<string[]>;
  startTimer(everyMs?: number): void;
  stop(): void;
  status(): Promise<SchedulerStatus>;
}

export function createReprobeScheduler(d: SchedulerDeps): ReprobeScheduler {
  const cfg = d.cfg ?? DEFAULT_REPROBE_CONFIG;
  const now = d.now ?? (() => Date.now());
  const log = d.log ?? (() => {});
  const started: number[] = []; // when each camera was handed to a probe run, for the hourly budget
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRunAt: number | null = null, lastIds: string[] = [], error: string | null = null;
  const budgetLeft = () => {
    const cut = now() - 3_600_000;
    while (started.length && started[0] < cut) started.shift();
    return cfg.perHour - started.length;
  };

  async function tick() {
    try {
      if (d.busy()) return [];
      const left = budgetLeft();
      if (left <= 0) return [];
      const ids = dueForReprobe(await d.list(), now(), cfg).slice(0, Math.min(left, cfg.batch)).map((x) => x.cameraId);
      if (ids.length === 0) return [];
      if (!(await d.start(ids))) return [];
      for (let i = 0; i < ids.length; i++) started.push(now());
      lastRunAt = now(); lastIds = ids; error = null;
      log(`[REPROBE] probing ${ids.join(', ')}`);
      return ids;
    } catch (e) { error = e instanceof Error ? e.message : String(e); log(`[REPROBE] ${error}`); return []; }
  }

  return {
    tick,
    startTimer(everyMs = 5 * 60_000) { if (!timer) { timer = setInterval(() => { void tick(); }, everyMs); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    async status() {
      let nextDue: Due[] = [];
      try { nextDue = dueForReprobe(await d.list(), now(), cfg).slice(0, 5); } catch (e) { error = e instanceof Error ? e.message : String(e); }
      budgetLeft();
      return { enabled: timer !== null, lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null, lastIds, startedLastHour: started.length, nextDue, error };
    },
  };
}
