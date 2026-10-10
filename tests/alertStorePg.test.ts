/**
 * The alert store (server/events/store.ts) and the event store (server/eventStore.ts) against a REAL PostgreSQL, with the same expectations the
 * in-memory store is tested with. Skipped unless a database is given:
 *
 *   TEST_DATABASE_URL=postgres://... node --import tsx --test tests/alertStorePg.test.ts
 *
 * Everything is written under throwaway user ids and removed afterwards. The tables themselves (created with IF NOT EXISTS, as the app does on start) stay.
 * Neon and similar hosts need TLS; put sslmode=require in the URL or set TEST_DATABASE_SSL=true.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPostgresAlertStore, departmentOwner } from '../server/events/store.ts';
import { createPostgresEventStore } from '../server/eventStore.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, createLogChannel } from '../server/events/channels.ts';
import { validateRule } from '../server/events/rules.ts';
import { makeEvent } from '../server/events/schema.ts';
import { buildLogDocument } from '../server/logEntry.ts';
import type { Alert } from '../server/events/channels.ts';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'set TEST_DATABASE_URL to run against PostgreSQL';
const T0 = new Date('2026-10-10T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const suffix = randomBytes(4).toString('hex');
const U1 = `pgtest-${suffix}-a`, U2 = `pgtest-${suffix}-b`, U3 = `pgtest-${suffix}-c`;
const DEPT = `pgtest-${suffix}-dept`, DEPT2 = `pgtest-${suffix}-dept2`;
// Department rules and their alerts live under the owner key `dept:<name>`.
// This department test uses ids of its own (UA..UC): the other tests count what each of U1..U3 owns.
const UA = `pgtest-${suffix}-x`, UB = `pgtest-${suffix}-y`, UC = `pgtest-${suffix}-z`;
const users = [U1, U2, U3, UA, UB, UC, departmentOwner(DEPT), departmentOwner(DEPT2)];
let pool: import('pg').Pool | null = null;

async function db() {
  if (pool) return pool;
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString: URL, max: 5, ssl: process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  return pool;
}

after(async () => {
  if (!pool) return;
  for (const t of ['platform_events', 'alert_rules', 'alerts', 'analysis_logs', 'plate_sightings']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [users]).catch(() => {});
  }
  await pool.end();
});

const cam = (userId: string, id = 'cam01') => ({ id, name: `Cam ${id}`, userId, department: 'Traffic' });
const ev = (userId: string, type: string, o: { plate?: string; ms?: number; severity?: 'info' | 'notice' | 'warning' | 'critical'; camId?: string } = {}) =>
  makeEvent({ type, summary: `${type} ${o.plate ?? ''}`.trim(), severity: o.severity, data: o.plate ? { plate: o.plate } : {}, dedupeKey: o.plate }, { source: 't', camera: cam(userId, o.camId), ts: at(o.ms ?? 0) });
const rule = (userId: string, id: string, over: Record<string, unknown> = {}) =>
  validateRule({ name: id, match: { types: ['plate.*'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] }, ...over }, { userId, id, now: T0 });
const alert = (userId: string, id: string, key: string, o: Partial<Alert> = {}): Alert => ({
  id, userId, ruleId: 'r1', ruleName: 'r1', key, state: 'open', severity: 'info', title: id, cameraId: 'c', cameraName: 'c', firstEventId: 'e', lastEventId: 'e', eventCount: 1,
  createdAt: T0.toISOString(), lastEventAt: T0.toISOString(), deliveries: [], ...o,
});

test('postgres alert store: events - stored once, filtered, ordered, per user', { skip }, async () => {
  const store = createPostgresAlertStore(await db());
  await store.ensureSchema();
  await store.ensureSchema(); // safe to run on every start
  const events = [
    ev(U1, 'plate.read', { plate: 'A', ms: 0 }), ev(U1, 'plate.watchlist_match', { plate: 'A', ms: 1000 }), ev(U1, 'scene.unusual', { ms: 2000, camId: 'cam02' }),
    ev(U1, 'person.unknown', { ms: 3000, severity: 'critical' }), ev(U2, 'plate.read', { plate: 'Z', ms: 500 }),
  ];
  assert.equal((await store.saveEvents(events)).length, 5);
  assert.deepEqual((await store.saveEvents(events)).length, 0, 'the same events again are not new');
  const mixed = await store.saveEvents([events[0], ev(U1, 'plate.read', { plate: 'NEW', ms: 4000 })]);
  assert.equal(mixed.length, 1, 'only the genuinely new one is reported');
  assert.deepEqual(await store.saveEvents([]), []);

  const q = async (o: Record<string, unknown>) => (await store.queryEvents({ userId: U1, ...o })).map((e) => `${e.type}${e.data.plate ? ':' + e.data.plate : ''}`);
  assert.deepEqual(await q({}), ['plate.read:NEW', 'person.unknown', 'scene.unusual', 'plate.watchlist_match:A', 'plate.read:A'], 'newest first');
  assert.deepEqual(await q({ types: ['plate.*'] }), ['plate.read:NEW', 'plate.watchlist_match:A', 'plate.read:A']);
  assert.deepEqual(await q({ types: ['scene.unusual', 'person.unknown'] }), ['person.unknown', 'scene.unusual']);
  assert.deepEqual(await q({ cameraId: 'cam02' }), ['scene.unusual']);
  assert.deepEqual(await q({ minSeverity: 'warning' }), ['person.unknown', 'scene.unusual', 'plate.watchlist_match:A']);
  assert.deepEqual(await q({ from: at(1000), to: at(3000) }), ['scene.unusual', 'plate.watchlist_match:A']);
  assert.deepEqual(await q({ before: at(2000), limit: 1 }), ['plate.watchlist_match:A']);
  assert.deepEqual(await q({ limit: 2 }), ['plate.read:NEW', 'person.unknown']);
  assert.equal((await store.queryEvents({ userId: U1, limit: 99999 })).length, 5, 'the page size is capped, not the data');
  assert.deepEqual((await store.queryEvents({ userId: U2 })).map((e) => e.data.plate), ['Z'], 'users only see their own');
  const back = (await store.queryEvents({ userId: U1, types: ['plate.watchlist_match'] }))[0];
  assert.equal(back.department, 'Traffic');
  assert.equal(back.ts, at(1000).toISOString(), 'the document comes back exactly as stored');
  assert.equal((await store.queryEvents({ userId: U1, types: ["x'; DROP TABLE platform_events;--"] })).length, 0, 'values are parameters');
});

test('postgres alert store: rules - saved, updated only by their owner, deleted only by their owner', { skip }, async () => {
  const store = createPostgresAlertStore(await db());
  await store.saveRule(rule(U1, `r-${suffix}-1`));
  await store.saveRule(rule(U1, `r-${suffix}-2`, { name: 'second' }));
  assert.deepEqual((await store.listRules(U1)).map((r) => r.id), [`r-${suffix}-1`, `r-${suffix}-2`]);
  assert.equal((await store.getRule(U1, `r-${suffix}-2`))!.name, 'second');
  assert.equal(await store.getRule(U2, `r-${suffix}-1`), null);
  await store.saveRule({ ...(await store.getRule(U1, `r-${suffix}-1`))!, name: 'renamed', enabled: false });
  const r1 = (await store.getRule(U1, `r-${suffix}-1`))!;
  assert.deepEqual([r1.name, r1.enabled], ['renamed', false]);
  // another user trying to overwrite the same id changes nothing
  await store.saveRule({ ...r1, userId: U2, name: 'hijacked' });
  assert.equal((await store.getRule(U1, `r-${suffix}-1`))!.name, 'renamed');
  assert.equal(await store.deleteRule(U2, `r-${suffix}-1`), false);
  assert.equal(await store.deleteRule(U1, `r-${suffix}-1`), true);
  assert.equal(await store.deleteRule(U1, `r-${suffix}-1`), false);
  assert.deepEqual((await store.listRules(U1)).map((r) => r.id), [`r-${suffix}-2`]);
});

test('postgres alert store: department scope - "all", department rules, alerts for a department and by id', { skip }, async () => {
  const store = createPostgresAlertStore(await db());
  const camA = `pgtest-${suffix}-camA`, camB = `pgtest-${suffix}-camB`;
  const evd = (userId: string, camId: string, department: string | undefined, ms: number) => makeEvent({ type: 'plate.read', summary: 'p', data: {} }, { source: 't', camera: { id: camId, name: camId, userId, ...(department ? { department } : {}) }, ts: at(ms) });
  await store.saveEvents([evd(UA, camA, DEPT, 0), evd(UB, camB, DEPT2, 1000), evd(UC, `${camA}-none`, undefined, 2000)]);
  const mine = (list: Array<{ cameraId: string }>) => list.map((e) => e.cameraId).filter((c) => c.startsWith(`pgtest-${suffix}`)).sort();
  assert.deepEqual(mine(await store.queryEvents({ userId: 'x', all: true, limit: 500 })), [camA, `${camA}-none`, camB].sort(), 'all: every owner, with and without a department');
  assert.deepEqual(mine(await store.queryEvents({ userId: 'x', departments: [DEPT] })), [camA], 'a department: whoever owns the camera');
  assert.deepEqual(mine(await store.queryEvents({ userId: 'x', all: true, cameraId: camB })), [camB], 'all, with another filter');

  // department rules: stored under the department's owner key, listed by department, edited by whoever covers it
  await store.saveRule({ ...rule(departmentOwner(DEPT), `r-${suffix}-d1`), department: DEPT });
  await store.saveRule({ ...rule(departmentOwner(DEPT2), `r-${suffix}-d2`), department: DEPT2 });
  await store.saveRule(rule(UA, `r-${suffix}-own`));
  assert.deepEqual((await store.listDepartmentRules([DEPT])).map((r) => r.id), [`r-${suffix}-d1`]);
  assert.deepEqual((await store.listDepartmentRules([DEPT, DEPT2])).map((r) => r.id).sort(), [`r-${suffix}-d1`, `r-${suffix}-d2`]);
  assert.deepEqual((await store.listDepartmentRules([])), []);
  assert.ok((await store.listDepartmentRules(null)).map((r) => r.id).includes(`r-${suffix}-d1`), 'null: every department\'s');
  assert.equal((await store.listDepartmentRules(null)).some((r) => r.id === `r-${suffix}-own`), false, 'a personal rule is not a department rule');
  await store.saveRule({ ...(await store.getRule(departmentOwner(DEPT), `r-${suffix}-d1`))!, name: 'edited by a teammate' });
  assert.equal((await store.getRule(departmentOwner(DEPT), `r-${suffix}-d1`))!.name, 'edited by a teammate');

  // alerts: by department, everything, and by id
  const a1 = alert(departmentOwner(DEPT), `al-${suffix}-1`, 'k1', { department: DEPT, cameraId: camA });
  const a2 = alert(UB, `al-${suffix}-2`, 'k2', { department: DEPT2, cameraId: camB, lastEventAt: at(5000).toISOString() });
  const a3 = alert(UC, `al-${suffix}-3`, 'k3', { cameraId: `${camA}-none`, lastEventAt: at(9000).toISOString() });
  for (const a of [a1, a2, a3]) await store.saveAlert(a);
  const ids = (l: Alert[]) => l.map((a) => a.id).filter((i) => i.startsWith(`al-${suffix}`)).sort();
  assert.deepEqual(ids(await store.listAlerts({ userId: 'x', departments: [DEPT] })), [a1.id]);
  assert.deepEqual(ids(await store.listAlerts({ userId: 'x', all: true, limit: 500 })), [a1.id, a2.id, a3.id].sort());
  assert.deepEqual(ids(await store.listAlerts({ userId: UC })), [a3.id], 'a person\'s own alerts, as before');
  assert.equal((await store.getAlertAny(a3.id))!.id, a3.id);
  assert.equal((await store.getAlertForDepartments([DEPT], a1.id))!.id, a1.id);
  assert.equal(await store.getAlertForDepartments([DEPT], a2.id), null);
  assert.equal(await store.getAlertAny(`al-${suffix}-nope`), null);
});

test('postgres alert store: alerts - live lookup by rule and key, window, resolution, owner, listing', { skip }, async () => {
  const store = createPostgresAlertStore(await db());
  const live = async (key: string, since = 0, user = U1) => (await store.findLiveAlert(user, 'r1', key, since))?.id ?? null;
  await store.saveAlert(alert(U1, `${suffix}-old`, 'k1', { createdAt: at(0).toISOString(), lastEventAt: at(0).toISOString() }));
  assert.equal(await live('k1'), `${suffix}-old`);
  assert.equal(await live('k1', T0.getTime() + 1000), null, 'quiet for longer than the window');
  await store.saveAlert(alert(U1, `${suffix}-new`, 'k1', { createdAt: at(5000).toISOString(), lastEventAt: at(5000).toISOString(), eventCount: 3 }));
  assert.equal(await live('k1'), `${suffix}-new`, 'the most recent one for the key');
  assert.equal((await store.getAlert(U1, `${suffix}-new`))!.eventCount, 3);
  await store.saveAlert({ ...alert(U1, `${suffix}-new`, 'k1', { createdAt: at(5000).toISOString(), lastEventAt: at(6000).toISOString() }), state: 'acknowledged', ackBy: 'op' });
  assert.equal(await live('k1'), `${suffix}-new`, 'an acknowledged alert is still live');
  assert.equal((await store.getAlert(U1, `${suffix}-new`))!.ackBy, 'op');
  await store.saveAlert({ ...alert(U1, `${suffix}-new`, 'k1', { lastEventAt: at(6000).toISOString() }), state: 'resolved' });
  assert.equal(await live('k1'), `${suffix}-old`, 'a resolved alert is not live; the older one is, if it is inside the window');
  assert.equal(await live('k1', T0.getTime() + 1000), null, 'and not once it has been quiet for longer than the window');
  assert.equal(await store.findLiveAlert(U1, 'other-rule', 'k1', 0), null);
  assert.equal(await live('k1', 0, U2), null, 'another user never sees it');
  assert.equal(await store.getAlert(U2, `${suffix}-new`), null);
  // another user cannot overwrite it by saving the same id
  await store.saveAlert({ ...alert(U2, `${suffix}-new`, 'k1'), state: 'open', title: 'hijacked' });
  assert.equal((await store.getAlert(U1, `${suffix}-new`))!.title, `${suffix}-new`);

  await store.saveAlert(alert(U1, `${suffix}-x`, 'k2', { lastEventAt: at(9000).toISOString() }));
  assert.deepEqual((await store.listAlerts({ userId: U1 })).map((a) => a.id), [`${suffix}-x`, `${suffix}-new`, `${suffix}-old`], 'newest activity first');
  assert.deepEqual((await store.listAlerts({ userId: U1, state: 'open' })).map((a) => a.id), [`${suffix}-x`, `${suffix}-old`]);
  assert.deepEqual((await store.listAlerts({ userId: U1, state: 'resolved' })).map((a) => a.id), [`${suffix}-new`]);
  assert.deepEqual((await store.listAlerts({ userId: U1, before: at(6000), limit: 5 })).map((a) => a.id), [`${suffix}-old`]);
  assert.equal((await store.listAlerts({ userId: U2 })).length, 0);
});

test('postgres alert store + engine: events become one alert, repeats fold, concurrent batches do not duplicate it', { skip }, async () => {
  const store = createPostgresAlertStore(await db());
  const delivered: string[] = [];
  const engine = createAlertEngine({
    store, channels: createChannelRegistry([{ type: 'log', deliver: async (_c: unknown, ctx: { alert: Alert }) => { delivered.push(ctx.alert.id); return { attempts: 1 }; } } as never, createLogChannel({ warn() {} }) as never].slice(0, 1)),
    log: { warn() {}, info() {} }, ruleCacheMs: 0,
  });
  await store.saveRule(rule(U3, `eng-${suffix}`, { match: { types: ['plate.read'] }, throttle: { windowMs: 600_000, by: ['camera', 'type'] } }));
  const events = Array.from({ length: 12 }, (_, i) => ev(U3, 'plate.read', { plate: `P${i}`, ms: 10_000 + i * 100 }));
  await Promise.all(events.map((e) => engine.ingest([e])));
  await engine.idle();
  const alerts = await store.listAlerts({ userId: U3 });
  assert.equal(alerts.length, 1, 'one alert for twelve concurrent events');
  assert.equal(alerts[0].eventCount, 12);
  assert.equal(delivered.length, 1);
  const again = await engine.ingest(events);
  assert.equal(again.stored, 0, 'a retried batch stores nothing new and alerts nothing');
  assert.equal((await store.queryEvents({ userId: U3, limit: 100 })).length, 12);
});

test('postgres event store: logs and plate sightings round-trip, repeat sightings are not doubled', { skip }, async () => {
  const store = createPostgresEventStore(await db());
  await store.ensureSchema();
  const base = { id: 'cam01', name: 'Gate', sensitivity: 5, userId: U1 };
  const doc = (n: number, o: Record<string, unknown> = {}) => buildLogDocument(base, { summary: `log ${n}`, counts: { people: 1, vehicles: 1, other: 0 }, detected_plates: ['GJ05AB1234'], plate_source: 'anpr', ...o }, at(n * 1000));
  await store.writeLog(doc(1));
  await store.writeLog(doc(2, { isUnusual: true, isUnusualReason: 'fence' }));
  await store.writeLog({ ...doc(3), cameraId: 'cam02' });
  await store.writeLog({ ...doc(4), userId: U2 });
  const all = await store.queryLogs({ userId: U1 });
  assert.deepEqual(all.map((l: any) => l.summary.slice(0, 5)), ['log 3', 'log 2', 'log 1'].map((s) => s.slice(0, 5)));
  assert.equal(all.length, 3);
  assert.deepEqual((await store.queryLogs({ userId: U1, onlyNotable: true })).map((l: any) => l.isUnusual), [true]);
  assert.equal((await store.queryLogs({ userId: U1, cameraId: 'cam02' })).length, 1);
  assert.equal((await store.queryLogs({ userId: U1, before: at(2000) })).length, 1);
  assert.equal((await store.queryLogs({ userId: U1, from: at(2000), to: at(3500) })).length, 2);
  assert.equal((await store.queryLogs({ userId: U2 })).length, 1);
  assert.ok(typeof (all[0] as any).timestamp === 'string', 'dates come back as ISO text in the stored document');

  const s = (id: string, ms: number) => ({ id, plate: 'GJ05AB1234', cameraId: 'cam01', cameraName: 'Gate', timestamp: at(ms), confidence: 0.9, source: 'anpr' as const });
  await store.writeSightings(U1, [s(`${suffix}-s1`, 0), s(`${suffix}-s2`, 1000)]);
  await store.writeSightings(U1, [s(`${suffix}-s2`, 1000), s(`${suffix}-s3`, 2000)]);
  await store.writeSightings(U1, []);
  assert.deepEqual((await store.querySightings(U1, 'GJ05AB1234')).map((x: any) => x.id), [`${suffix}-s3`, `${suffix}-s2`, `${suffix}-s1`], 'a repeated sighting id is stored once');
  assert.equal((await store.querySightings(U2, 'GJ05AB1234')).length, 0);
});

test('postgres: how fast it is from here (printed, not asserted)', { skip, timeout: 120_000 }, async () => {
  const store = createPostgresAlertStore(await db());
  const pg = await db();
  const t0 = performance.now();
  await pg.query('SELECT 1');
  const roundTripMs = performance.now() - t0;

  const N = 2000, BATCH = 100;
  const events = Array.from({ length: N }, (_, i) => ev(U1, i % 3 === 0 ? 'plate.read' : 'person.unknown', { plate: `BENCH${i}`, ms: 100_000 + i * 10, camId: `cam${i % 20}` }));
  const w0 = performance.now();
  for (let i = 0; i < N; i += BATCH) await store.saveEvents(events.slice(i, i + BATCH));
  const batchedMs = performance.now() - w0;

  const c0 = performance.now();
  const parallel = Array.from({ length: 800 }, (_, i) => ev(U2, 'plate.read', { plate: `PAR${i}`, ms: 200_000 + i * 10, camId: `cam${i % 20}` }));
  await Promise.all(Array.from({ length: 8 }, (_, k) => store.saveEvents(parallel.slice(k * 100, (k + 1) * 100))));
  const parallelMs = performance.now() - c0;

  const lat: number[] = [];
  for (let i = 0; i < 20; i++) { const a = performance.now(); await store.queryEvents({ userId: U1, types: ['plate.*'], limit: 100 }); lat.push(performance.now() - a); }
  lat.sort((a, b) => a - b);
  const one: number[] = [];
  for (let i = 0; i < 10; i++) { const a = performance.now(); await store.saveEvents([ev(U1, 'plate.read', { plate: `ONE${i}`, ms: 300_000 + i })]); one.push(performance.now() - a); }
  one.sort((a, b) => a - b);
  const f = (n: number) => Math.round(n);
  console.log(`      Neon from this machine: round trip ${f(roundTripMs)} ms (first, includes connecting)`);
  console.log(`      ${N} events in batches of ${BATCH}: ${f(batchedMs)} ms = ${f((N / batchedMs) * 1000)} rows/s, ${f(batchedMs / (N / BATCH))} ms per batch`);
  console.log(`      800 events as 8 parallel batches of 100: ${f(parallelMs)} ms = ${f((800 / parallelMs) * 1000)} rows/s`);
  console.log(`      single-event write: median ${f(one[5])} ms; list 100 events by type: median ${f(lat[10])} ms, worst ${f(lat[19])} ms`);
  assert.equal((await store.queryEvents({ userId: U1, limit: 500 })).length, 500);
});
