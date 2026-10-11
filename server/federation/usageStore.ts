/**
 * Where the federation service keeps its counters and session leases. Two implementations behind one contract
 * (`tests/federationUsageConformance.ts`):
 *   - memory: this process only (the default);
 *   - Redis: shared by every server process, so a quota or a session cap holds across several servers (FEDERATION_STORE=redis + REDIS_URL).
 *
 * *** The Redis store was NOT RUN against a Redis (none was available when it was written). *** It is exercised by the conformance suite
 * only when TEST_REDIS_URL is set; run that before relying on it. Each multi-step decision is one Lua script, so two servers cannot both
 * take the last slot or the last events of a quota.
 *
 * Events are counted in ten-second buckets over the last minute (so "per minute" is a sliding minute with ten-second steps) and per UTC day.
 */
import type { Redis } from 'ioredis';

export interface Lease { id: string; clientId: string; what: string; expiresAt: string }

export type ReserveResult = { ok: true } | { ok: false; which: 'minute' | 'day'; retryAfterMs: number };
export type AcquireResult = { ok: true; lease: Lease } | { ok: false; max: number };

export interface UsageStore {
  readonly kind: 'memory' | 'redis';
  /** Counts `n` events if both limits allow it (all or nothing). */
  reserveEvents(clientId: string, n: number, limits: { perMinute: number; perDay: number }, nowMs: number): Promise<ReserveResult>;
  /** Gives back events counted by `reserveEvents` (the bus then refused them). Never goes below zero. */
  unreserveEvents(clientId: string, n: number, nowMs: number): Promise<void>;
  eventsUsed(clientId: string, nowMs: number): Promise<{ minute: number; day: number }>;
  /** Takes a session slot if the client (and, when `departmentCap` is set, the department) is under its cap. */
  acquire(l: { id: string; clientId: string; department: string; what: string }, caps: { client: number; department?: number }, nowMs: number, ttlMs: number): Promise<AcquireResult>;
  renew(clientId: string, leaseId: string, nowMs: number, ttlMs: number): Promise<Lease | null>;
  release(clientId: string, leaseId: string): Promise<boolean>;
  activeSessions(clientId: string, nowMs: number): Promise<number>;
  leases(nowMs: number): Promise<Lease[]>;
  /** A client was removed or switched off: forget its leases. */
  dropClient(clientId: string): Promise<void>;
}

export const BUCKET_MS = 10_000;
export const BUCKETS = 6;
const bucketOf = (ms: number) => Math.floor(ms / BUCKET_MS);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The retry time for a daily quota: the next UTC midnight. */
const untilMidnight = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - ms; };

// ---- memory ----------------------------------------------------------------------------------------------------------------------

export function createMemoryUsageStore(): UsageStore {
  const buckets = new Map<string, Map<number, number>>();
  const days = new Map<string, { day: string; n: number }>();
  const held = new Map<string, Lease & { until: number; department: string }>();
  const sweep = (now: number) => { for (const [id, l] of held) if (l.until <= now) held.delete(id); };
  const minuteOf = (id: string, now: number) => {
    const b = buckets.get(id); if (!b) return { sum: 0, oldest: null as number | null };
    const first = bucketOf(now) - (BUCKETS - 1); let sum = 0, oldest: number | null = null;
    for (const [k, n] of b) { if (k < first) { b.delete(k); continue; } sum += n; if (oldest === null || k < oldest) oldest = k; }
    return { sum, oldest };
  };
  const dayCount = (id: string, now: number) => { const d = days.get(id); return d && d.day === dayOf(now) ? d.n : 0; };
  const pub = ({ until: _u, department: _d, ...l }: Lease & { until: number; department: string }): Lease => l;

  return {
    kind: 'memory',
    async reserveEvents(id, n, lim, now) {
      const m = minuteOf(id, now);
      if (m.sum + n > lim.perMinute) return { ok: false, which: 'minute', retryAfterMs: m.oldest === null ? BUCKET_MS : Math.max(1000, (m.oldest + BUCKETS) * BUCKET_MS - now) };
      if (dayCount(id, now) + n > lim.perDay) return { ok: false, which: 'day', retryAfterMs: untilMidnight(now) };
      const b = buckets.get(id) ?? new Map<number, number>(); buckets.set(id, b);
      b.set(bucketOf(now), (b.get(bucketOf(now)) ?? 0) + n);
      days.set(id, { day: dayOf(now), n: dayCount(id, now) + n });
      return { ok: true };
    },
    async unreserveEvents(id, n, now) {
      const b = buckets.get(id), k = bucketOf(now);
      if (b?.has(k)) b.set(k, Math.max(0, b.get(k)! - n));
      const d = days.get(id); if (d && d.day === dayOf(now)) d.n = Math.max(0, d.n - n);
    },
    async eventsUsed(id, now) { return { minute: minuteOf(id, now).sum, day: dayCount(id, now) }; },
    async acquire(l, caps, now, ttl) {
      sweep(now);
      const mine = [...held.values()].filter((x) => x.clientId === l.clientId).length;
      if (mine >= caps.client) return { ok: false, max: caps.client };
      if (caps.department !== undefined && [...held.values()].filter((x) => x.department === l.department).length >= caps.department) return { ok: false, max: caps.department };
      const rec = { id: l.id, clientId: l.clientId, what: l.what, department: l.department, until: now + ttl, expiresAt: new Date(now + ttl).toISOString() };
      held.set(l.id, rec);
      return { ok: true, lease: pub(rec) };
    },
    async renew(clientId, leaseId, now, ttl) {
      sweep(now);
      const l = held.get(leaseId);
      if (!l || l.clientId !== clientId) return null;
      l.until = now + ttl; l.expiresAt = new Date(l.until).toISOString();
      return pub(l);
    },
    async release(clientId, leaseId) { const l = held.get(leaseId); return !!l && l.clientId === clientId && held.delete(leaseId); },
    async activeSessions(clientId, now) { sweep(now); return [...held.values()].filter((x) => x.clientId === clientId).length; },
    async leases(now) { sweep(now); return [...held.values()].map(pub); },
    async dropClient(clientId) { for (const [id, l] of held) if (l.clientId === clientId) held.delete(id); buckets.delete(clientId); days.delete(clientId); },
  };
}

// ---- Redis -----------------------------------------------------------------------------------------------------------------------

/**
 * KEYS: the six minute buckets (oldest first), the day key. ARGV: n, perMinute, perDay, nowMs, bucketMs, bucketTtlS, dayTtlS, currentBucketIndex(1-6)
 * Returns {1} ok, {0,'minute',retryMs}, {0,'day'}.
 */
const RESERVE = `
local n = tonumber(ARGV[1]); local perMin = tonumber(ARGV[2]); local perDay = tonumber(ARGV[3])
local now = tonumber(ARGV[4]); local bucketMs = tonumber(ARGV[5])
local sum = 0; local oldest = -1
for i = 1, 6 do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 and oldest < 0 then oldest = i end
  sum = sum + v
end
if sum + n > perMin then
  local retry = bucketMs
  if oldest > 0 then retry = math.max(1000, oldest * bucketMs - (now % bucketMs)) end
  return {0, 'minute', retry}
end
local day = tonumber(redis.call('GET', KEYS[7]) or '0')
if day + n > perDay then return {0, 'day', 0} end
redis.call('INCRBY', KEYS[6], n); redis.call('EXPIRE', KEYS[6], tonumber(ARGV[6]))
redis.call('INCRBY', KEYS[7], n); redis.call('EXPIRE', KEYS[7], tonumber(ARGV[7]))
return {1}
`;

/** KEYS: current bucket, day key. ARGV: n. Lowers each by n, not below zero. */
const UNRESERVE = `
for i = 1, 2 do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then redis.call('SET', KEYS[i], math.max(0, v - tonumber(ARGV[1])), 'KEEPTTL') end
end
return 1
`;

/**
 * KEYS: client zset, department zset, all-leases zset, lease hash. ARGV: now, ttlMs, clientCap, deptCap (0 = none), leaseId, clientId, what, member.
 * Returns {1, expiresMs} or {0, max}.
 */
const ACQUIRE = `
local now = tonumber(ARGV[1]); local ttl = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now); redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return {0, tonumber(ARGV[3])} end
local dcap = tonumber(ARGV[4])
if dcap > 0 and redis.call('ZCARD', KEYS[2]) >= dcap then return {0, dcap} end
local exp = now + ttl
redis.call('ZADD', KEYS[1], exp, ARGV[5]); redis.call('ZADD', KEYS[2], exp, ARGV[5]); redis.call('ZADD', KEYS[3], exp, ARGV[8])
redis.call('HSET', KEYS[4], 'clientId', ARGV[6], 'what', ARGV[7])
redis.call('PEXPIRE', KEYS[4], ttl * 4)
return {1, exp}
`;

/** KEYS: client zset, department zset, all zset. ARGV: now, ttlMs, leaseId, member. Returns the new expiry or -1. */
const RENEW = `
local now = tonumber(ARGV[1]); local cur = redis.call('ZSCORE', KEYS[1], ARGV[3])
if not cur or tonumber(cur) <= now then return -1 end
local exp = now + tonumber(ARGV[2])
redis.call('ZADD', KEYS[1], 'XX', exp, ARGV[3]); redis.call('ZADD', KEYS[2], 'XX', exp, ARGV[3]); redis.call('ZADD', KEYS[3], 'XX', exp, ARGV[4])
return exp
`;

export interface RedisUsageOptions { prefix?: string }

export function createRedisUsageStore(redis: Redis, o: RedisUsageOptions = {}): UsageStore {
  const p = o.prefix ?? 'fed:';
  const kMin = (id: string, b: number) => `${p}ev:${id}:m:${b}`;
  const kDay = (id: string, day: string) => `${p}ev:${id}:d:${day}`;
  const kClient = (id: string) => `${p}ls:c:${id}`;
  const kDept = (d: string) => `${p}ls:d:${d}`;
  const kAll = `${p}ls:all`;
  const kLease = (id: string) => `${p}ls:h:${id}`;
  const run = (redis as unknown as { eval(script: string, n: number, ...a: Array<string | number>): Promise<unknown> }).eval.bind(redis);
  const deptOfLease = (id: string) => redis.hget(kLease(id), 'department');

  return {
    kind: 'redis',
    async reserveEvents(id, n, lim, now) {
      const cur = bucketOf(now);
      const keys = Array.from({ length: BUCKETS }, (_, i) => kMin(id, cur - (BUCKETS - 1) + i));
      const r = (await run(RESERVE, 7, ...keys, kDay(id, dayOf(now)), n, lim.perMinute, lim.perDay, now, BUCKET_MS, 70, 2 * 86_400, 0)) as [number, string?, number?];
      if (r[0] === 1) return { ok: true };
      if (r[1] === 'day') return { ok: false, which: 'day', retryAfterMs: untilMidnight(now) };
      return { ok: false, which: 'minute', retryAfterMs: Math.max(1000, Number(r[2] ?? BUCKET_MS)) };
    },
    async unreserveEvents(id, n, now) { await run(UNRESERVE, 2, kMin(id, bucketOf(now)), kDay(id, dayOf(now)), n); },
    async eventsUsed(id, now) {
      const cur = bucketOf(now);
      const vals = await redis.mget(...Array.from({ length: BUCKETS }, (_, i) => kMin(id, cur - (BUCKETS - 1) + i)), kDay(id, dayOf(now)));
      const nums = vals.map((v) => Number(v ?? 0));
      return { minute: nums.slice(0, BUCKETS).reduce((a, b) => a + b, 0), day: nums[BUCKETS] };
    },
    async acquire(l, caps, now, ttl) {
      const member = `${l.clientId}|${l.id}`;
      await redis.hset(kLease(l.id), 'department', l.department);
      const r = (await run(ACQUIRE, 4, kClient(l.clientId), kDept(l.department), kAll, kLease(l.id), now, ttl, caps.client, caps.department ?? 0, l.id, l.clientId, l.what, member)) as [number, number];
      if (r[0] !== 1) { await redis.del(kLease(l.id)); return { ok: false, max: r[1] }; }
      return { ok: true, lease: { id: l.id, clientId: l.clientId, what: l.what, expiresAt: new Date(r[1]).toISOString() } };
    },
    async renew(clientId, leaseId, now, ttl) {
      const dept = await deptOfLease(leaseId);
      if (!dept) return null;
      const exp = Number(await run(RENEW, 3, kClient(clientId), kDept(dept), kAll, now, ttl, leaseId, `${clientId}|${leaseId}`));
      if (exp < 0) return null;
      await redis.pexpire(kLease(leaseId), ttl * 4);
      const what = (await redis.hget(kLease(leaseId), 'what')) ?? 'session';
      return { id: leaseId, clientId, what, expiresAt: new Date(exp).toISOString() };
    },
    async release(clientId, leaseId) {
      // Only the client that holds the lease may end it: a refusal must leave the lease (and the department's count) untouched.
      if ((await redis.zrem(kClient(clientId), leaseId)) === 0) return false;
      const dept = await deptOfLease(leaseId);
      if (dept) await redis.zrem(kDept(dept), leaseId);
      await redis.zrem(kAll, `${clientId}|${leaseId}`);
      await redis.del(kLease(leaseId));
      return true;
    },
    async activeSessions(clientId, now) { await redis.zremrangebyscore(kClient(clientId), '-inf', now); return redis.zcard(kClient(clientId)); },
    async leases(now) {
      await redis.zremrangebyscore(kAll, '-inf', now);
      const rows = (await (redis as unknown as { zrange(k: string, a: number, b: number, w: string): Promise<string[]> }).zrange(kAll, 0, -1, 'WITHSCORES'));
      const out: Lease[] = [];
      for (let i = 0; i < rows.length; i += 2) {
        const [clientId, id] = rows[i].split('|');
        out.push({ id, clientId, what: (await redis.hget(kLease(id), 'what')) ?? 'session', expiresAt: new Date(Number(rows[i + 1])).toISOString() });
      }
      return out;
    },
    async dropClient(clientId) {
      const ids = await redis.zrange(kClient(clientId), '0', '-1');
      for (const id of ids) { const d = await deptOfLease(id); if (d) await redis.zrem(kDept(d), id); await redis.zrem(kAll, `${clientId}|${id}`); await redis.del(kLease(id)); }
      await redis.del(kClient(clientId));
    },
  };
}
