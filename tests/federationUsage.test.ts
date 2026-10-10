/**
 * One contract for the federation usage store (counters and session leases), run on the in-process store always and on Redis when
 * TEST_REDIS_URL is set (the Redis store has NOT been run against a Redis by the author; set it and run this before relying on it).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryUsageStore, createRedisUsageStore, type UsageStore } from '../server/federation/usageStore.ts';
import { createFederationService } from '../server/federation/service.ts';

const T = Date.UTC(2026, 9, 11, 10, 0, 0);
const redisUrl = process.env.TEST_REDIS_URL;

function suite(name: string, make: () => Promise<{ store: UsageStore; other?: () => UsageStore; done?: () => Promise<void> }>, skip?: string) {
  describe(name, { skip }, () => {
    test('events: all-or-nothing against the minute and the day; a refused batch counts for nothing; the window slides', async () => {
      const { store, done } = await make();
      try {
        const id = `c-${randomUUID().slice(0, 8)}`, lim = { perMinute: 5, perDay: 8 };
        assert.deepEqual(await store.reserveEvents(id, 3, lim, T), { ok: true });
        const over = await store.reserveEvents(id, 3, lim, T + 1000);
        assert.equal(over.ok === false && over.which === 'minute' && over.retryAfterMs >= 1000 && over.retryAfterMs <= 60_000, true);
        assert.deepEqual(await store.eventsUsed(id, T + 1000), { minute: 3, day: 3 });
        assert.deepEqual(await store.reserveEvents(id, 2, lim, T + 2000), { ok: true });
        assert.deepEqual(await store.reserveEvents(id, 3, lim, T + 61_000), { ok: true }, 'the first buckets left the minute');
        assert.deepEqual(await store.eventsUsed(id, T + 61_000), { minute: 3, day: 8 });
        const day = await store.reserveEvents(id, 1, lim, T + 130_000);
        assert.equal(day.ok === false && day.which === 'day', true);
        assert.deepEqual(await store.reserveEvents(id, 5, lim, Date.UTC(2026, 9, 12, 0, 0, 5)), { ok: true }, 'a new UTC day');
        await store.unreserveEvents(id, 99, Date.UTC(2026, 9, 12, 0, 0, 5));
        assert.deepEqual(await store.eventsUsed(id, Date.UTC(2026, 9, 12, 0, 0, 6)), { minute: 0, day: 0 }, 'giving back never goes below zero');
      } finally { await done?.(); }
    });

    test('sessions: client cap, department cap, expiry, renew, release, drop', async () => {
      const { store, done } = await make();
      try {
        const sfx = randomUUID().slice(0, 8), a = `a-${sfx}`, b = `b-${sfx}`, o = `o-${sfx}`, dep = `Traffic-${sfx}`;
        const lease = (clientId: string, department = dep) => ({ id: randomUUID().replace(/-/g, '').slice(0, 20), clientId, department, what: 'wall' });
        const l1 = lease(a), l2 = lease(a);
        const r1 = await store.acquire(l1, { client: 2, department: 3 }, T, 60_000);
        assert.equal(r1.ok, true);
        assert.equal((await store.acquire(l2, { client: 2, department: 3 }, T, 60_000)).ok, true);
        const full = await store.acquire(lease(a), { client: 2, department: 3 }, T, 60_000);
        assert.deepEqual([full.ok, full.ok === false && full.max], [false, 2]);
        assert.equal((await store.acquire(lease(b), { client: 2, department: 3 }, T, 60_000)).ok, true);
        const dfull = await store.acquire(lease(b), { client: 2, department: 3 }, T, 60_000);
        assert.deepEqual([dfull.ok, dfull.ok === false && dfull.max], [false, 3], 'the department is at its cap');
        assert.equal((await store.acquire(lease(o, 'Police'), { client: 2, department: 3 }, T, 60_000)).ok, true, 'another department');
        assert.equal(await store.release(b, l1.id), false, 'not b\'s lease');
        assert.equal(await store.renew(b, l1.id, T, 60_000), null);
        assert.equal(await store.activeSessions(a, T), 2);
        const renewed = await store.renew(a, l1.id, T + 45_000, 60_000);
        assert.equal(renewed?.expiresAt, new Date(T + 105_000).toISOString());
        assert.equal(await store.activeSessions(a, T + 70_000), 1, 'the unrenewed one ran out');
        assert.equal((await store.leases(T + 70_000)).some((l) => l.id === l2.id), false);
        assert.equal(await store.release(a, l1.id), true);
        assert.equal(await store.release(a, l1.id), false);
        assert.equal(await store.renew(a, l1.id, T + 80_000, 60_000), null, 'a released lease is gone');
        await store.acquire(lease(o, 'Police'), { client: 5 }, T + 80_000, 60_000);
        await store.dropClient(o);
        assert.equal(await store.activeSessions(o, T + 80_000), 0);
      } finally { await done?.(); }
    });
  });
}

suite('federation usage store: memory', async () => ({ store: createMemoryUsageStore() }));

suite('federation usage store: redis', async () => {
  const { default: IORedis } = await import('ioredis');
  const redis = new IORedis(redisUrl!);
  const prefix = `test:fed:${randomUUID().slice(0, 8)}:`;
  return { store: createRedisUsageStore(redis, { prefix }), done: async () => { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); redis.disconnect(); } };
}, redisUrl ? undefined : 'set TEST_REDIS_URL to run against Redis');

test('two services sharing one store share their limits (what Redis gives several servers)', async () => {
  const store = createMemoryUsageStore();
  const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fedu-'));
  const mk = (file: string) => createFederationService({ file: `${dir}/${file}`, store, emit: async () => undefined, now: () => new Date(T), log: { warn() {}, info() {} } });
  const a = mk('a.json'), b = mk('b.json');
  const { key } = await a.create({ id: 'x', department: 'Traffic', scopes: ['events.push', 'sessions'], quotas: { eventsPerMinute: 4, maxSessions: 1 } }, 'u');
  const { key: keyB } = await b.create({ id: 'x', department: 'Traffic', scopes: ['events.push', 'sessions'], quotas: { eventsPerMinute: 4, maxSessions: 1 } }, 'u'); // same client, as a shared file/db would give
  const body = (n: number) => JSON.stringify({ events: Array.from({ length: n }, (_, i) => ({ id: `${n}-${i}-${Math.random()}`, camera: 'g', type: 'motion' })) });
  assert.equal((await a.push(a.authenticate(key)!, body(3))).status, 'ok');
  assert.equal((await b.push(b.authenticate(keyB)!, body(3))).status, 'quota', 'server B saw the events server A took');
  assert.equal((await a.acquire(a.authenticate(key)!, 'w')).status, 'ok');
  assert.equal((await b.acquire(b.authenticate(keyB)!, 'w')).status, 'cap', 'and the session slot');
});

test('a push the bus refuses gives its quota back', async () => {
  const store = createMemoryUsageStore();
  const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'fedu-'));
  let down = true;
  const svc = createFederationService({ file: `${dir}/c.json`, store, emit: async () => { if (down) throw new Error('bus down'); }, now: () => new Date(T), log: { warn() {}, info() {} } });
  const { key } = await svc.create({ id: 'x', department: 'Traffic', quotas: { eventsPerMinute: 2 } }, 'u');
  const c = svc.authenticate(key)!;
  const body = JSON.stringify({ events: [{ id: 'a', camera: 'g', type: 'motion' }, { id: 'b', camera: 'g', type: 'motion' }] });
  await assert.rejects(svc.push(c, body), /bus down/);
  down = false;
  assert.equal((await svc.push(c, body)).status, 'ok');
});
