/**
 * Protects the camera grid's per-account viewing-time allowance from the analysis (docs/analytics.md, "Grid guard").
 *
 * The grid caps how long one account may watch. Past the cap it refuses the account (HLS "watch time limit reached", RTSP/WHEP "401"),
 * for a cooldown it does not announce, and every further attempt only adds load. Analysis used to hammer the grid regardless: every
 * camera, every interval, whatever the answer. This does three things:
 *   1. a limit on grabs per minute (GRID_GRABS_PER_MIN, default 10). A grab holds a grid session for several seconds, so the limit
 *      is a limit on session time; excess grabs wait their turn instead of failing;
 *   2. once the grid refuses the account, no grid grab is attempted until the cooldown has passed (5 min, doubling per repeat up to
 *      30 min), and the analysis reports "paused" instead of failure, so cameras are not marked offline and do not back off;
 *   3. the state (pause and recent grabs) is kept in a store that several server processes can share (Redis when configured), so the
 *      Health tab, which is served by another process than the worker that grabs, can show it, and the limit holds across workers.
 */
export class PauseError extends Error {
  readonly retryAfterMs: number;
  /** The same text without any countdown, so saving it on the camera only changes when the cause does. */
  readonly reason: string;
  constructor(message: string, retryAfterMs: number, reason = message) {
    super(message);
    this.name = 'PauseError';
    this.retryAfterMs = Math.max(1_000, Math.round(retryAfterMs));
    this.reason = reason;
  }
}

/** The grid answered that the account is refused (HTTP 403 "watch time limit", RTSP 401). */
export class GridRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'GridRefusedError'; }
}

export interface GridState { blockedUntil: number; trips: number; message: string; refusals: number; lastRefusalAt: number; /** When grabs started (ms, oldest first), kept for an hour. */ grabs: number[] }
const EMPTY: GridState = { blockedUntil: 0, trips: 0, message: '', refusals: 0, lastRefusalAt: 0, grabs: [] };

export interface GridStateStore {
  readonly kind: string;
  load(): Promise<GridState>;
  save(s: GridState): Promise<void>;
}

export function createMemoryGridStore(): GridStateStore {
  let s: GridState = { ...EMPTY };
  return { kind: 'memory', async load() { return { ...s, grabs: [...s.grabs] }; }, async save(next) { s = { ...next, grabs: [...next.grabs] }; } };
}

/** Anything with Redis' get and set (ioredis qualifies). The value expires on its own after a day. */
export function createRedisGridStore(redis: { get(k: string): Promise<string | null>; set(k: string, v: string, mode: 'EX', seconds: number): Promise<unknown> }, key = 'omnisee:grid:state'): GridStateStore {
  return {
    kind: 'redis',
    async load() {
      try { const raw = await redis.get(key); return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<GridState>) } : { ...EMPTY }; }
      catch { return { ...EMPTY }; }
    },
    async save(s) { try { await redis.set(key, JSON.stringify(s), 'EX', 86_400); } catch { /* the guard still works in this process without it */ } },
  };
}

export interface GridStatus {
  blocked: boolean;
  retryAfterSec: number;
  message: string;
  /** Times the grid refused the account in a row without a good grab in between (drives the length of the pause). */
  trips: number;
  refusals: number;
  lastRefusalAt: string | null;
  grabsLastMinute: number;
  grabsLastHour: number;
  limitPerMinute: number;
  store: string;
}

export interface GridGuardOptions {
  perMinute?: number;
  cooldownMs?: number;
  /** A grab that would have to wait longer than this is paused instead (the camera tries again later). */
  maxWaitMs?: number;
  store?: GridStateStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Pick<Console, 'warn'>;
}

export interface GridGuard {
  /** Waits for a free slot, or throws PauseError (the grid is refusing the account, or the wait would be too long). */
  take(): Promise<void>;
  /** The grid refused the account: pause every grid grab. Returns the pause in seconds. */
  trip(message: string, source?: string): Promise<number>;
  /** A grab worked: the account is fine. */
  ok(): Promise<void>;
  status(): Promise<GridStatus>;
  useStore(store: GridStateStore): void;
}

export function createGridGuard(o: GridGuardOptions = {}): GridGuard {
  const perMinute = Math.max(1, Math.floor(o.perMinute ?? 10));
  const cooldownMs = Math.max(10_000, o.cooldownMs ?? 5 * 60_000);
  const maxWaitMs = Math.max(1_000, o.maxWaitMs ?? 45_000);
  const now = o.now ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? console;
  let store: GridStateStore = o.store ?? createMemoryGridStore();
  let chain: Promise<unknown> = Promise.resolve();
  const recentGrabs = (grabs: number[]) => grabs.filter((t) => t > now() - 3_600_000);

  async function takeNow(): Promise<void> {
    for (;;) {
      const s = await store.load();
      if (now() < s.blockedUntil) throw new PauseError(`The camera grid is refusing this account (${s.message || 'viewing-time limit'}); not asking it again for ${Math.ceil((s.blockedUntil - now()) / 1000)}s.`, s.blockedUntil - now(), `Paused: the camera grid is refusing this account (${s.message || 'viewing-time limit'}). Analysis resumes by itself.`);
      const grabs = recentGrabs(s.grabs);
      const recent = grabs.filter((t) => t > now() - 60_000);
      if (recent.length < perMinute) { await store.save({ ...s, grabs: [...grabs, now()] }); return; }
      const waitMs = recent[0] + 60_000 - now();
      if (waitMs > maxWaitMs) throw new PauseError(`Too many camera-grid grabs this minute (limit ${perMinute}); waiting for a free slot.`, waitMs, `Waiting its turn: at most ${perMinute} camera-grid grabs a minute are allowed, to protect the account's viewing time.`);
      await sleep(Math.max(50, waitMs));
    }
  }

  return {
    take() {
      // One at a time, so a burst of waiters does not all wake at once and overshoot the limit.
      const run = chain.then(takeNow);
      chain = run.catch(() => undefined);
      return run;
    },
    async trip(message, source = 'grid') {
      const s = await store.load();
      // A refusal soon after the previous pause ended is a repeat: the pause doubles (up to six times the base).
      const repeat = s.blockedUntil > 0 && now() < s.blockedUntil + 60_000;
      const trips = repeat ? s.trips + 1 : 0;
      const ms = Math.min(cooldownMs * 2 ** Math.min(trips, 3), cooldownMs * 6);
      if (now() >= s.blockedUntil) log.warn(`[GRID] ${source}: the grid refused this account (${message}). Pausing every grid grab for ${Math.round(ms / 1000)}s.`);
      await store.save({ ...s, blockedUntil: Math.max(s.blockedUntil, now() + ms), trips, message: message.slice(0, 200), refusals: s.refusals + 1, lastRefusalAt: now() });
      return Math.round(ms / 1000);
    },
    async ok() {
      const s = await store.load();
      if (s.trips > 0 && now() >= s.blockedUntil) await store.save({ ...s, trips: 0 });
    },
    async status() {
      const s = await store.load();
      const grabs = recentGrabs(s.grabs);
      const blocked = now() < s.blockedUntil;
      return {
        blocked, retryAfterSec: blocked ? Math.ceil((s.blockedUntil - now()) / 1000) : 0, message: blocked ? s.message : '', trips: s.trips, refusals: s.refusals,
        lastRefusalAt: s.lastRefusalAt ? new Date(s.lastRefusalAt).toISOString() : null, grabsLastMinute: grabs.filter((t) => t > now() - 60_000).length, grabsLastHour: grabs.length, limitPerMinute: perMinute, store: store.kind,
      };
    },
    useStore(next) { store = next; },
  };
}
