import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createConnectorHub } from '../server/connectors/hub.ts';
import { createMockConnectors, createMockEgujcop, createMockSarthi, createMockVahan } from '../server/connectors/mock.ts';
import { createPlateEnricher } from '../server/connectors/enrich.ts';
import { registerConnectorRoutes } from '../server/connectors/routes.ts';
import { ConnectorError, normalisePlate, parseQuery, type Connector } from '../server/connectors/types.ts';
import { makeEvent, type PlatformEvent } from '../server/events/schema.ts';
import { validateRule } from '../server/events/rules.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, type Channel } from '../server/events/channels.ts';

const NOW = new Date('2026-10-10T10:00:00Z');
const ctl = () => new AbortController().signal;
const CAM = { id: 'cam01', name: 'Gate', userId: 'u1', department: 'Traffic' };
const plateRead = (plate: string, confidence = 0.9, ts = NOW): PlatformEvent =>
  makeEvent({ type: 'plate.read', summary: `Plate ${plate} read`, data: { plate }, confidence, dedupeKey: plate }, { source: 'anpr', camera: CAM, ts });

// ---- queries -----------------------------------------------------------------------------------------------------

test('plates and queries are normalised and bad ones refused', () => {
  assert.equal(normalisePlate(' gj 01-ab 1234 '), 'GJ01AB1234');
  assert.deepEqual(parseQuery({ type: 'vehicle', plate: 'gj 01 ab 1234' }), { type: 'vehicle', plate: 'GJ01AB1234' });
  assert.deepEqual(parseQuery({ type: 'licence', number: 'gj01 2021-0001234' }), { type: 'licence', number: 'GJ0120210001234' });
  for (const bad of [undefined, null, {}, { type: 'vehicle' }, { type: 'vehicle', plate: 'AB' }, { type: 'vehicle', plate: 'A'.repeat(13) }, { type: 'vehicle', plate: 7 },
    { type: 'licence', number: 'short' }, { type: 'person', name: 'x' }, { type: 'wanted_vehicle', plate: '!!' }]) {
    assert.throws(() => parseQuery(bad), (e) => e instanceof ConnectorError && e.code === 'bad_query', JSON.stringify(bad));
  }
});

// ---- mocks -------------------------------------------------------------------------------------------------------

test('mock VAHAN: stolen, blacklisted, expired documents are flagged; a clean vehicle has no flags; unknown plates are not invented', async () => {
  const v = createMockVahan({ now: () => NOW });
  const ask = (plate: string) => v.lookup({ type: 'vehicle', plate }, ctl());
  const stolen = await ask('GJ27GH3456');
  assert.deepEqual(stolen.flags.map((f) => [f.code, f.severity]), [['stolen', 'critical']]);
  assert.ok(stolen.mock);
  assert.deepEqual((await ask('GJ03JK7890')).flags.map((f) => f.code), ['blacklisted']);
  assert.deepEqual((await ask('GJ05CD5678')).flags.map((f) => f.code), ['insurance_expired']);
  assert.deepEqual((await ask('GJ18EF9012')).flags.map((f) => f.code), ['fitness_expired']);
  const clean = await ask('gj 01 ab 1234');
  assert.deepEqual([clean.found, clean.flags.length], [true, 0]);
  const none = await ask('ZZ99ZZ9999');
  assert.deepEqual([none.found, none.flags.length], [false, 0]);
  assert.equal(stolen.data.ownerMasked, 'S*** R***', 'the owner is shown masked');
  // The same table a month later: validity moves with the clock, not with the data.
  const at = (d: string) => createMockVahan({ now: () => new Date(d) });
  assert.deepEqual((await at('2027-01-01T00:00:00Z').lookup({ type: 'vehicle', plate: 'GJ01AB1234' }, ctl())).flags.map((f) => f.code), []);
  assert.deepEqual((await at('2027-05-01T00:00:00Z').lookup({ type: 'vehicle', plate: 'GJ01AB1234' }, ctl())).flags.map((f) => f.code), ['insurance_expired']);
});

test('mock SARTHI and eGujCop answer their own queries and refuse others', async () => {
  const s = createMockSarthi({ now: () => NOW }), e = createMockEgujcop();
  assert.deepEqual((await s.lookup({ type: 'licence', number: 'GJ1820190009999' }, ctl())).flags.map((f) => f.code), ['licence_suspended']);
  assert.deepEqual((await s.lookup({ type: 'licence', number: 'GJ0520150004321' }, ctl())).flags.map((f) => f.code), ['licence_expired']);
  assert.equal((await s.lookup({ type: 'licence', number: 'GJ0120210001234' }, ctl())).flags.length, 0);
  const w = await e.lookup({ type: 'wanted_vehicle', plate: 'gj09xy0001' }, ctl());
  assert.deepEqual([w.found, w.flags[0].code, w.flags[0].severity], [true, 'wanted', 'critical']);
  await assert.rejects(s.lookup({ type: 'vehicle', plate: 'GJ01AB1234' }, ctl()), (x) => x instanceof ConnectorError && x.code === 'unsupported_query');
  await assert.rejects(e.lookup({ type: 'licence', number: 'GJ0120210001234' }, ctl()), (x) => x instanceof ConnectorError && x.code === 'unsupported_query');
});

// ---- hub ---------------------------------------------------------------------------------------------------------

function counting(over: Partial<Connector> & { fn?: (n: number) => Promise<void> } = {}): Connector & { calls: number } {
  const c = {
    calls: 0, id: 'x', label: 'X', description: 'd', queries: ['vehicle'] as const, mock: true,
    async lookup(q: any) { c.calls++; if (over.fn) await over.fn(c.calls); return { connector: 'x', query: 'vehicle' as const, found: true, flags: [], data: { plate: q.plate }, queriedAt: 't', mock: true }; },
  };
  return Object.assign(c, { ...over, lookup: c.lookup });
}

test('hub: answers are cached, the cache expires, and identical simultaneous calls share one request', async () => {
  let t = 1_000;
  const c = counting({ fn: () => new Promise((r) => setTimeout(r, 20)) });
  const hub = createConnectorHub([c], { cacheTtlMs: 1000, now: () => t });
  const q = { type: 'vehicle', plate: 'GJ01AB1234' } as const;
  const [a, b] = await Promise.all([hub.lookup('x', q), hub.lookup('x', q)]);
  assert.equal(c.calls, 1, 'two at once -> one call');
  assert.equal(a, b);
  const again = await hub.lookup('x', q);
  assert.equal(again.cached, true);
  assert.equal(c.calls, 1);
  t += 1001;
  assert.equal((await hub.lookup('x', q)).cached, undefined);
  assert.equal(c.calls, 2);
  await hub.lookup('x', { type: 'vehicle', plate: 'OTHER00' });
  assert.equal(c.calls, 3, 'a different plate is a different question');
  assert.equal(hub.status()[0].stats.cacheHits, 1);
});

test('hub: a slow system times out; repeated failures pause it; it comes back after the pause; a good call resets the count', async () => {
  let t = 0;
  let mode: 'slow' | 'fail' | 'ok' = 'slow';
  const c = counting({
    fn: async () => { if (mode === 'slow') await new Promise((r) => setTimeout(r, 200)); if (mode === 'fail') throw new Error('upstream 500'); },
  });
  const hub = createConnectorHub([c], { timeoutMs: 30, cacheTtlMs: 0, failuresToOpen: 3, breakMs: 10_000, now: () => t });
  const q = (n: number) => ({ type: 'vehicle', plate: `AB${1000 + n}` } as const);

  await assert.rejects(hub.lookup('x', q(1)), (e) => e instanceof ConnectorError && e.code === 'timeout');
  mode = 'fail';
  await assert.rejects(hub.lookup('x', q(2)), /upstream 500/);
  assert.equal(hub.status()[0].state, 'failing');
  mode = 'ok';
  await hub.lookup('x', q(3));
  assert.equal(hub.status()[0].state, 'ok', 'a success resets the count');

  mode = 'fail';
  for (let i = 4; i < 7; i++) await assert.rejects(hub.lookup('x', q(i)));
  assert.equal(hub.status()[0].state, 'open');
  const before = c.calls;
  await assert.rejects(hub.lookup('x', q(7)), (e) => e instanceof ConnectorError && e.code === 'circuit_open');
  assert.equal(c.calls, before, 'a paused system is not called');
  t += 10_001;
  mode = 'ok';
  await hub.lookup('x', q(8));
  assert.equal(hub.status()[0].state, 'ok');
});

test('hub: a bad question does not count against the system; too many calls at once are refused, not queued; unknown ids are clear', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const c = counting({ fn: () => gate });
  const hub = createConnectorHub([c], { maxInFlight: 2, cacheTtlMs: 0, failuresToOpen: 1 });
  await assert.rejects(hub.lookup('x', { type: 'licence', number: 'GJ0120210001234' }), (e) => e instanceof ConnectorError && e.code === 'unsupported_query');
  assert.equal(hub.status()[0].state, 'ok');
  const a = hub.lookup('x', { type: 'vehicle', plate: 'AAAA1111' }), b = hub.lookup('x', { type: 'vehicle', plate: 'BBBB2222' });
  await assert.rejects(hub.lookup('x', { type: 'vehicle', plate: 'CCCC3333' }), (e) => e instanceof ConnectorError && e.code === 'unavailable');
  release();
  await Promise.all([a, b]);
  await assert.rejects(hub.lookup('nope', { type: 'vehicle', plate: 'AAAA1111' }), (e) => e instanceof ConnectorError && e.code === 'unknown_connector');
  assert.throws(() => createConnectorHub([counting(), counting()]), /share an id/);
});

// ---- enrichment ----------------------------------------------------------------------------------------------------

function enricher(over: { hub?: ReturnType<typeof createConnectorHub>; now?: () => number; minConfidence?: number } = {}) {
  const emitted: PlatformEvent[][] = [];
  const warnings: string[] = [];
  const hub = over.hub ?? createConnectorHub(createMockConnectors({ now: () => NOW }));
  const e = createPlateEnricher({ hub, emit: async (evs) => { emitted.push(evs); }, now: over.now, minConfidence: over.minConfidence, log: { warn: (m: string) => warnings.push(m) } });
  return { e, emitted, warnings, hub };
}

test('enrichment: a stolen, wanted plate becomes a registry event and a police event, marked MOCK, with the original camera and time', async () => {
  const { e, emitted } = enricher();
  const out = await e.enrich([plateRead('GJ27GH3456')]);
  assert.deepEqual(out.map((x) => x.type).sort(), ['plate.vehicle_flagged', 'plate.wanted']);
  const flagged = out.find((x) => x.type === 'plate.vehicle_flagged')!;
  assert.equal(flagged.severity, 'critical');
  assert.equal(flagged.cameraId, 'cam01');
  assert.equal(flagged.userId, 'u1');
  assert.equal(flagged.department, 'Traffic');
  assert.equal(flagged.ts, NOW.toISOString());
  assert.ok(flagged.summary.startsWith('[MOCK]'));
  assert.ok(flagged.tags.includes('mock') && flagged.tags.includes('stolen') && flagged.tags.includes('vahan'));
  assert.equal(flagged.source, 'connector:vahan');
  assert.equal(flagged.data.mock, true);
  assert.deepEqual(emitted.flat().map((x) => x.id).sort(), out.map((x) => x.id).sort());
  const wanted = out.find((x) => x.type === 'plate.wanted')!;
  assert.equal(wanted.severity, 'critical');
  assert.match(wanted.summary, /DEMO-FIR-0001/);
});

test('enrichment: severity is the worst flag; clean, unknown and doubtful reads produce nothing', async () => {
  const { e } = enricher();
  const warn = await e.enrich([plateRead('GJ05CD5678')]);
  assert.deepEqual(warn.map((x) => [x.type, x.severity]), [['plate.vehicle_flagged', 'warning']]);
  assert.deepEqual(await e.enrich([plateRead('GJ01AB1234')]), [], 'clean');
  assert.deepEqual(await e.enrich([plateRead('ZZ99ZZ9999')]), [], 'unknown to the registry: not invented');
  const lowConf = enricher();
  assert.deepEqual(await lowConf.e.enrich([plateRead('GJ27GH3456', 0.3)]), [], 'a doubtful read must not raise "stolen vehicle"');
  assert.equal(lowConf.e.stats().skippedLowConfidence, 1);
  assert.deepEqual(await enricher().e.enrich([makeEvent({ type: 'scene.unusual', summary: 's' }, { source: 's', camera: CAM, ts: NOW })]), []);
});

test('enrichment: the same plate on the same camera is checked once per interval, not per frame; a failed check is retried at the next sighting', async () => {
  let t = 0;
  const { e, hub } = enricher({ now: () => t });
  hub.clearCache();
  await e.enrich([plateRead('GJ27GH3456'), plateRead('GJ27GH3456')]);
  const first = e.stats().checked;
  assert.equal(first, 2, 'one registry + one police lookup for two identical reads');
  await e.enrich([plateRead('GJ27GH3456')]);
  assert.equal(e.stats().checked, first, 'inside the interval');
  t += 61_000;
  await e.enrich([plateRead('GJ27GH3456')]);
  assert.equal(e.stats().checked, first + 2);

  const failing = enricher({ hub: createConnectorHub(createMockConnectors({ failWith: 'down' }), { failuresToOpen: 100, cacheTtlMs: 0 }) });
  assert.deepEqual(await failing.e.enrich([plateRead('GJ27GH3456')]), []);
  assert.equal(failing.e.stats().lookupFailures, 2);
  assert.ok(failing.warnings.length >= 1);
  await failing.e.enrich([plateRead('GJ27GH3456')]);
  assert.equal(failing.e.stats().lookupFailures, 4, 'tried again straight away');
});

test('enrichment: a dead system never delays or loses the original events; failures are contained', async () => {
  const slow = createMockConnectors({ delayMs: 500 });
  const hub = createConnectorHub(slow, { timeoutMs: 20 });
  const order: string[] = [];
  const enr = createPlateEnricher({ hub, emit: async () => { order.push('derived'); }, log: { warn: () => {} } });
  const emit = enr.wrapEmit(async (events) => { order.push(`base:${events.length}`); });
  const started = Date.now();
  await emit([plateRead('GJ27GH3456')]);
  assert.ok(Date.now() - started < 100, 'the caller was not held up by the slow systems');
  assert.deepEqual(order, ['base:1']);
  // a failing base emit still rejects (the caller must know), and does not start enrichment
  const bad = enr.wrapEmit(async () => { throw new Error('store down'); });
  await assert.rejects(bad([plateRead('GJ27GH3456')]), /store down/);
  // a failing derived emit does not throw into anything
  const enr2 = createPlateEnricher({ hub: createConnectorHub(createMockConnectors()), emit: async () => { throw new Error('alert store down'); }, log: { warn: () => {} } });
  assert.equal((await enr2.enrich([plateRead('GJ27GH3456')])).length, 2);
});

// ---- all the way to an alert ------------------------------------------------------------------------------------------------

test('end to end: a plate.read for a stolen vehicle opens a critical alert through an ordinary rule and webhook-style channel, once', async () => {
  const store = createMemoryAlertStore();
  const sent: Array<{ type: string; severity: string }> = [];
  const channel: Channel = { type: 'log', check: () => null, deliver: async (_cfg, d) => { sent.push({ type: d.event.type, severity: d.event.severity }); return { attempts: 1 }; } };
  const channels = createChannelRegistry([channel]);
  const engine = createAlertEngine({ store, channels, now: () => NOW });
  await store.saveRule(validateRule({ name: 'Flagged vehicles', match: { types: ['plate.vehicle_flagged', 'plate.wanted'], minSeverity: 'critical' }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] } }, { userId: 'u1', id: 'r1', now: NOW }));

  const hub = createConnectorHub(createMockConnectors({ now: () => NOW }));
  const enr = createPlateEnricher({ hub, emit: (evs) => engine.ingest(evs), log: { warn: () => {} } });
  const emit = enr.wrapEmit((evs) => engine.ingest(evs));
  await emit([plateRead('GJ27GH3456'), plateRead('GJ01AB1234')]);
  await new Promise((r) => setTimeout(r, 50));
  await engine.idle?.();
  assert.deepEqual(sent.map((s) => s.type).sort(), ['plate.vehicle_flagged', 'plate.wanted']);
  const alerts = await store.listAlerts({ userId: 'u1', limit: 10 });
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((a) => a.state === 'open'));
  // the clean plate raised nothing, and the base plate.read events themselves were stored
  const events = await store.queryEvents({ userId: 'u1', types: [], limit: 50 });
  assert.equal(events.filter((x) => x.type === 'plate.read').length, 2);
  assert.equal(events.filter((x) => x.type === 'plate.vehicle_flagged').length, 1);
});

// ---- routes ---------------------------------------------------------------------------------------------------------------

test('routes: list, lookup, validation, unknown connector, timeouts, and permission', async () => {
  const hub = createConnectorHub([...createMockConnectors({ now: () => NOW }), counting({ id: 'slow', fn: () => new Promise((r) => setTimeout(r, 300)) })], { timeoutMs: 30 });
  let allowed = true;
  const app = express();
  app.use(express.json());
  registerConnectorRoutes(app, { hub, allow: async (_q, res) => { if (!allowed) { res.status(403).json({ error: 'no' }); return false; } return true; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  try {
    const list = await call('GET', '/api/connectors');
    assert.deepEqual(list.json.connectors.map((c: any) => c.id), ['vahan', 'sarthi', 'egujcop', 'slow']);
    assert.ok(list.json.connectors.every((c: any) => c.mock === true));
    const ok = await call('POST', '/api/connectors/vahan/lookup', { query: { type: 'vehicle', plate: 'gj 27 gh 3456' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.result.flags.map((f: any) => f.code), ['stolen']);
    assert.equal((await call('POST', '/api/connectors/vahan/lookup', { query: { type: 'vehicle', plate: 'x' } })).status, 400);
    assert.equal((await call('POST', '/api/connectors/vahan/lookup', {})).status, 400);
    assert.equal((await call('POST', '/api/connectors/nope/lookup', { query: { type: 'vehicle', plate: 'GJ27GH3456' } })).status, 404);
    assert.equal((await call('POST', '/api/connectors/..%2Fx/lookup', { query: { type: 'vehicle', plate: 'GJ27GH3456' } })).status, 404);
    assert.equal((await call('POST', '/api/connectors/sarthi/lookup', { query: { type: 'vehicle', plate: 'GJ27GH3456' } })).status, 422);
    assert.equal((await call('POST', '/api/connectors/slow/lookup', { query: { type: 'vehicle', plate: 'GJ27GH3456' } })).status, 504);
    allowed = false;
    assert.equal((await call('GET', '/api/connectors')).status, 403);
    assert.equal((await call('POST', '/api/connectors/vahan/lookup', { query: { type: 'vehicle', plate: 'GJ27GH3456' } })).status, 403);
  } finally { server.close(); }
});
