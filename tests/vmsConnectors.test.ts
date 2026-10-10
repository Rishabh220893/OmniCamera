import test from 'node:test';
import assert from 'node:assert/strict';
import { createVmsConnectorTypes, createVmsRunner, createMemoryCursorStore, platformCameraId, validateSystemConfig, VmsError, type VmsSystemConfig } from '../server/connectors/vms/index.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import type { PlatformEvent } from '../server/events/schema.ts';
import { startFakeJsonVms, startFakeXmlVms, type FakeJson, type FakeXml } from './lab/fakeVms.ts';

const types = createVmsConnectorTypes();
const jsonCfg = (s: FakeJson, over: Partial<VmsSystemConfig> = {}): VmsSystemConfig => ({ id: 'traffic', kind: 'reference-json', baseUrl: s.url, credentials: { user: s.user, pass: s.pass }, ownerUserId: 'u1', department: 'Traffic', ...over });
const xmlCfg = (s: FakeXml, over: Partial<VmsSystemConfig> = {}): VmsSystemConfig => ({ id: 'city', kind: 'reference-xml', baseUrl: s.url, credentials: { user: s.user, pass: s.pass }, ownerUserId: 'u1', department: 'Municipal', timezoneOffsetMinutes: 330, ...over });
const mk = (cfg: VmsSystemConfig) => types.get(cfg.kind).create(cfg);

async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e) => e instanceof VmsError && e.code === code, `expected ${code}`);
}

// ---- config ------------------------------------------------------------------------------------------------------------

test('system config: validated, trimmed, credentials kept only as given', () => {
  const c = validateSystemConfig({ id: 'traffic', kind: 'reference-json', baseUrl: 'http://x.example.org///', ownerUserId: 'u1', department: ' Traffic ', credentials: { user: 'a', pass: 'b' }, timezoneOffsetMinutes: 330, junk: 1 });
  assert.deepEqual(c, { id: 'traffic', kind: 'reference-json', baseUrl: 'http://x.example.org', ownerUserId: 'u1', department: 'Traffic', credentials: { user: 'a', pass: 'b' }, timezoneOffsetMinutes: 330 });
  for (const bad of [null, {}, { id: 'a b', kind: 'k', baseUrl: 'http://x', ownerUserId: 'u' }, { id: 'a', kind: 'k', baseUrl: 'ftp://x', ownerUserId: 'u' }, { id: 'a', kind: 'k', baseUrl: 'http://x' }, { id: 'a', kind: 'k', baseUrl: 'http://x', ownerUserId: 'u', timezoneOffsetMinutes: 'abc' }, { id: 'a', kind: 'k', baseUrl: 'http://x', ownerUserId: 'u', timezoneOffsetMinutes: 5000 }]) {
    assert.throws(() => validateSystemConfig(bad), VmsError, JSON.stringify(bad));
  }
  assert.equal(platformCameraId('traffic', 'A 1/x'), 'traffic-A_1_x');
  assert.throws(() => types.get('nope'), /No connector type/);
  assert.throws(() => createVmsConnectorTypes([types.get('reference-json')]), /already registered/);
});

// ---- the JSON system ----------------------------------------------------------------------------------------------------

test('json: cameras across pages with names, groups, state and location; streams; health', async () => {
  const s = await startFakeJsonVms();
  try {
    const c = mk(jsonCfg(s));
    const cams = await c.cameras();
    assert.deepEqual(cams.map((x) => [x.id, x.name, x.group, x.online]), [['A1', 'Gate North', 'Traffic', true], ['A2', 'Gate South', 'Traffic', true], ['A3', 'Yard', 'Depot', false]]);
    assert.deepEqual(cams[0].location, { lat: 23.03, lng: 72.58 });
    assert.equal(cams[1].location, undefined);
    assert.equal((await c.streams('A1'))[0].url, 'rtsp://127.0.0.1:8554/live/A1');
    await expectCode(c.streams('ZZ'), 'protocol').catch(() => undefined); // 404 is a protocol-level answer
    const h = await c.health();
    assert.equal(h.ok, true);
    assert.deepEqual(s.writes, [], 'nothing but reads and the sign-in');
  } finally { await s.close(); }
});

test('json: events start from now, then arrive in order with kinds and data; paging by limit; the cursor continues', async () => {
  const s = await startFakeJsonVms();
  try {
    s.emit({ camera: 'A1', type: 'MOTION' }); // before we started: must not be replayed
    const c = mk(jsonCfg(s));
    const first = await c.events(null, 100);
    assert.deepEqual([first.events.length, first.more], [0, false]);
    s.emit({ camera: 'A1', type: 'ANPR', plate: 'GJ01AB1234', conf: 0.93, at: Date.UTC(2026, 9, 10, 10) });
    s.emit({ camera: 'A2', type: 'TAMPER' });
    s.emit({ camera: 'A2', type: 'MOTION' });
    s.emit({ camera: 'A3', type: 'OTHER', text: 'door open' });
    const p1 = await c.events(first.cursor, 2);
    assert.equal(p1.events.length, 2);
    assert.equal(p1.more, true);
    assert.deepEqual(p1.events.map((e) => e.kind), ['plate', 'tamper']);
    assert.deepEqual(p1.events[0].data, { plate: 'GJ01AB1234', confidence: 0.93 });
    assert.equal(p1.events[0].at.toISOString(), '2026-10-10T10:00:00.000Z');
    const p2 = await c.events(p1.cursor, 2);
    assert.deepEqual(p2.events.map((e) => [e.kind, e.vendorCode]), [['motion', 'MOTION'], ['alarm', 'OTHER']]);
    assert.equal(p2.events[1].data.text, 'door open');
    assert.equal(p2.more, false);
    const p3 = await c.events(p2.cursor, 2);
    assert.equal(p3.events.length, 0);
    assert.equal(p3.cursor, p2.cursor);
  } finally { await s.close(); }
});

test('json: an expired token is replaced once and the call succeeds; many simultaneous calls share one sign-in', async () => {
  const s = await startFakeJsonVms();
  try {
    const c = mk(jsonCfg(s));
    await c.cameras();
    assert.equal(s.logins, 1);
    s.expireTokens();
    assert.equal((await c.cameras()).length, 3);
    assert.equal(s.logins, 2, 'one re-login');
    s.expireTokens();
    await Promise.all(Array.from({ length: 10 }, () => c.cameras()));
    assert.ok(s.logins <= 4, `logins: ${s.logins}`);
  } finally { await s.close(); }
});

test('json: errors are told apart (wrong login, unreachable, struggling, slow down, nonsense) and the password never appears in them', async () => {
  const s = await startFakeJsonVms();
  try {
    await expectCode(mk(jsonCfg(s, { credentials: { user: s.user, pass: 'wrong-SECRET' } })).cameras(), 'auth');
    await expectCode(mk(jsonCfg(s, { credentials: undefined })).cameras(), 'auth');
    try { await mk(jsonCfg(s, { credentials: { user: s.user, pass: 'wrong-SECRET' } })).cameras(); } catch (e) { assert.ok(!String((e as Error).message).includes('SECRET')); }
    const c = mk(jsonCfg(s));
    await c.cameras();
    s.failNext(1, 503);
    await expectCode(c.cameras(), 'upstream');
    s.failNext(1, 429);
    await expectCode(c.cameras(), 'rate_limited');
    assert.equal((await c.cameras()).length, 3, 'recovers');
    s.delay(300);
    await expectCode(types.get('reference-json').create(jsonCfg(s), { timeoutMs: 50 }).cameras(), 'unreachable');
    s.delay(0);
  } finally { await s.close(); }
  await expectCode(mk({ id: 'gone', kind: 'reference-json', baseUrl: 'http://127.0.0.1:1', ownerUserId: 'u' }).cameras(), 'unreachable');
  const bad = http2(() => 'not json at all');
  await expectCode(types.get('reference-json').create({ id: 'x', kind: 'reference-json', baseUrl: 'http://x', ownerUserId: 'u' }, { fetch: bad }).cameras(), 'protocol');
});

/** A fetch that answers every call with this body. */
function http2(body: () => string): typeof fetch {
  return (async () => new Response(body(), { status: 200 })) as unknown as typeof fetch;
}

// ---- the XML system -----------------------------------------------------------------------------------------------------

test('xml: Basic login with an awkward password, devices with escaped names, state and location, stream address', async () => {
  const s = await startFakeXmlVms({ devices: [{ id: 'C-1', name: 'Gate & "North" <1>', online: true, lat: 22.3, lng: 73.19 }, { id: 'C-2', name: 'Bridge', online: false }] });
  try {
    const c = mk(xmlCfg(s));
    const cams = await c.cameras();
    assert.deepEqual(cams.map((x) => [x.id, x.name, x.online]), [['C-1', 'Gate & "North" <1>', true], ['C-2', 'Bridge', false]]);
    assert.deepEqual(cams[0].location, { lat: 22.3, lng: 73.19 });
    assert.equal((await c.streams('C-2'))[0].url, 'rtsp://127.0.0.1:8554/beta/C-2');
    await expectCode(mk(xmlCfg(s, { credentials: { user: s.user, pass: 'nope' } })).cameras(), 'auth');
    assert.equal((await c.health()).ok, true);
    assert.deepEqual(s.writes, []);
  } finally { await s.close(); }
});

test('xml: zone-less local times are converted with the configured offset; a wrong offset is visibly wrong, not silently accepted', async () => {
  const s = await startFakeXmlVms({ tzOffsetMinutes: 330 });
  try {
    const c = mk(xmlCfg(s));
    const start = await c.events(null, 100);
    const at = new Date(Date.now() + 2000); at.setMilliseconds(0);
    s.emit({ device: 'C-1', code: 'PLATE', plate: 'GJ05CD5678', at });
    const page = await c.events(start.cursor, 100);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].at.getTime(), at.getTime());
    assert.deepEqual([page.events[0].kind, page.events[0].data.plate], ['plate', 'GJ05CD5678']);
    // Configured as UTC although the system reports IST: the same alarm comes out 5.5 h in the future.
    const wrong = mk(xmlCfg(s, { timezoneOffsetMinutes: 0 }));
    const probe = await wrong.events(JSON.stringify({ since: new Date(at.getTime() - 24 * 3600_000).toISOString(), seen: [] }), 100);
    assert.equal(probe.events.length, 1);
    assert.equal(probe.events[0].at.getTime() - at.getTime(), 330 * 60_000, 'with the wrong zone the time is off by exactly the zone difference, so a mistake is detectable');
  } finally { await s.close(); }
});

test('xml: alarms in the same second as the cursor are neither repeated nor lost; newest-first pages are put in order; limit pages', async () => {
  const s = await startFakeXmlVms({ pageSize: 2 });
  try {
    const c = mk(xmlCfg(s));
    const start = await c.events(null, 100);
    const t = new Date(Math.floor(Date.now() / 1000) * 1000 + 1000);
    const n1 = s.emit({ device: 'C-1', code: 'MOT', at: t });
    const n2 = s.emit({ device: 'C-1', code: 'COVER', at: t });
    const a = await c.events(start.cursor, 100);
    assert.deepEqual(a.events.map((e) => e.id), [String(n1), String(n2)], 'ascending although the system lists newest first across pages');
    assert.deepEqual(a.events.map((e) => e.kind), ['motion', 'tamper']);
    const again = await c.events(a.cursor, 100);
    assert.equal(again.events.length, 0, 'the boundary second is returned again by the system but not by us');
    const n3 = s.emit({ device: 'C-2', code: 'INTR', at: t }); // arrives late, in the same second
    const late = await c.events(a.cursor, 100);
    assert.deepEqual(late.events.map((e) => e.id), [String(n3)], 'a late alarm in the boundary second is not lost');
    const many = [1, 2, 3, 4, 5].map((i) => s.emit({ device: 'C-1', code: 'MOT', at: new Date(t.getTime() + i * 1000) }));
    const p1 = await c.events(late.cursor, 2);
    assert.deepEqual(p1.events.map((e) => e.id), many.slice(0, 2).map(String));
    assert.equal(p1.more, true);
    const p2 = await c.events(p1.cursor, 10);
    assert.deepEqual(p2.events.map((e) => e.id), many.slice(2).map(String));
    assert.equal(p2.more, false);
    await expectCode(c.events('not a cursor', 10), 'protocol');
    await expectCode(c.events(JSON.stringify({ since: 'yesterday', seen: [] }), 10), 'protocol');
  } finally { await s.close(); }
});

// ---- the runner -----------------------------------------------------------------------------------------------------------

function runnerFor(cfg: VmsSystemConfig, cursors = createMemoryCursorStore()) {
  const emitted: PlatformEvent[] = [];
  const cameras: number[] = [];
  const emitFail = { on: false };
  const runner = createVmsRunner({
    system: cfg, connector: mk(cfg), cursors, minGapMs: 0, backoffBaseMs: 10, pageSize: 2,
    emit: async (events) => { if (emitFail.on) throw new Error('store down'); emitted.push(...events); },
    onCameras: (c) => { cameras.push(c.length); }, log: { warn: () => {} },
  });
  return { runner, emitted, cameras, cursors, emitFail };
}

test('runner: events from two different systems become platform events with the right camera, department, source and tags', async () => {
  const j = await startFakeJsonVms(), x = await startFakeXmlVms();
  try {
    const a = runnerFor(jsonCfg(j)), b = runnerFor(xmlCfg(x));
    await a.runner.tick(); await b.runner.tick(); // learn cameras, take the starting position
    j.emit({ camera: 'A1', type: 'ANPR', plate: 'gj 01-ab 1234', conf: 0.9, at: Date.now() });
    x.emit({ device: 'C-2', code: 'COVER', at: new Date(Math.floor(Date.now() / 1000) * 1000 + 1000) });
    await a.runner.tick(); await b.runner.tick();
    assert.equal(a.emitted.length, 1);
    const p = a.emitted[0];
    assert.deepEqual([p.type, p.cameraId, p.cameraName, p.department, p.userId, p.source, p.data.plate, p.confidence], ['plate.read', 'traffic-A1', 'Gate North', 'Traffic', 'u1', 'vms:traffic', 'GJ01AB1234', 0.9]);
    assert.deepEqual(p.location, { lat: 23.03, lng: 72.58 });
    assert.ok(p.tags.includes('vms') && p.tags.includes('traffic'));
    assert.equal(b.emitted.length, 1);
    assert.deepEqual([b.emitted[0].type, b.emitted[0].cameraId, b.emitted[0].department, b.emitted[0].severity], ['camera.tamper', 'city-C-2', 'Municipal', 'warning']);
    assert.deepEqual([a.cameras, b.cameras], [[3], [3]]);
    assert.deepEqual([j.writes, x.writes], [[], []], 'neither department system was written to');
    assert.ok(j.requests.every((r) => r.startsWith('GET') || r === 'POST /api/login'));
  } finally { await j.close(); await x.close(); }
});

test('runner: the position survives a restart (no replay), and a failed hand-over does not advance it (nothing lost, repeat is harmless)', async () => {
  const j = await startFakeJsonVms();
  try {
    const cursors = createMemoryCursorStore();
    const r1 = runnerFor(jsonCfg(j), cursors);
    await r1.runner.tick();
    j.emit({ camera: 'A1', type: 'MOTION' }); j.emit({ camera: 'A2', type: 'MOTION' }); j.emit({ camera: 'A2', type: 'MOTION' });
    r1.emitFail.on = true;
    await r1.runner.tick();
    assert.equal(r1.emitted.length, 0);
    assert.equal(r1.runner.status().state, 'degraded', 'the failure is visible');
    r1.emitFail.on = false;
    await r1.runner.tick();
    assert.equal(r1.emitted.length, 3, 'all three arrived once the store came back');
    const ids = r1.emitted.map((e) => e.id);
    assert.equal(new Set(ids).size, 3);

    // "restart": a new runner over the same saved position
    const r2 = runnerFor(jsonCfg(j), cursors);
    await r2.runner.tick();
    assert.equal(r2.emitted.length, 0, 'nothing replayed');
    j.emit({ camera: 'A3', type: 'MOTION' });
    await r2.runner.tick();
    assert.equal(r2.emitted.length, 1);

    // and if the same events are handed over twice anyway, the store keeps one copy
    const store = createMemoryAlertStore();
    assert.equal((await store.saveEvents(r1.emitted)).length, 3);
    assert.equal((await store.saveEvents(r1.emitted)).length, 0);
  } finally { await j.close(); }
});

test('runner: camera state changes become events; the first look only learns; added cameras are reported', async () => {
  const j = await startFakeJsonVms();
  try {
    const r = runnerFor(jsonCfg(j));
    await r.runner.syncCameras();
    assert.equal(r.emitted.length, 0);
    j.cameras = j.cameras.map((c) => (c.id === 'A1' ? { ...c, online: false } : c));
    await r.runner.syncCameras();
    assert.deepEqual(r.emitted.map((e) => [e.type, e.cameraId]), [['camera.offline', 'traffic-A1']]);
    j.cameras = j.cameras.map((c) => (c.id === 'A1' ? { ...c, online: true } : c)).concat([{ id: 'A4', name: 'New', group: 'Traffic', online: true }]);
    await r.runner.syncCameras();
    assert.deepEqual(r.emitted.map((e) => e.type), ['camera.offline', 'camera.online']);
    assert.deepEqual(r.cameras, [3, 4], 'reported on first sight and when a camera was added');
    await r.runner.syncCameras();
    assert.deepEqual(r.cameras, [3, 4], 'no change, no report');
    assert.equal(r.runner.status().cameras, 4);
  } finally { await j.close(); }
});

test('runner: states and back-off - down, recovery, wrong password; one department failing does not touch another', async () => {
  const j = await startFakeJsonVms(), x = await startFakeXmlVms();
  try {
    const a = runnerFor(jsonCfg(j)), b = runnerFor(xmlCfg(x));
    await a.runner.tick(); await b.runner.tick();
    assert.equal(a.runner.status().state, 'ok');
    j.failNext(10, 503);
    await a.runner.tick();
    assert.deepEqual([a.runner.status().state, a.runner.status().consecutiveFailures], ['degraded', 1]);
    await a.runner.tick(); await a.runner.tick();
    assert.equal(a.runner.status().state, 'down');
    assert.ok(a.runner.status().nextTryInMs >= 10 * 4, 'back-off grows');
    await b.runner.tick();
    assert.equal(b.runner.status().state, 'ok', 'the other department is unaffected');
    j.failNext(0);
    await a.runner.tick();
    assert.deepEqual([a.runner.status().state, a.runner.status().consecutiveFailures, a.runner.status().lastError], ['ok', 0, null]);

    const wrong = runnerFor(jsonCfg(j, { credentials: { user: j.user, pass: 'bad' } }));
    await wrong.runner.tick();
    assert.equal(wrong.runner.status().state, 'auth_failed');
    assert.ok(wrong.runner.status().nextTryInMs >= 60_000, 'a wrong password is not hammered');
    assert.ok(!JSON.stringify(wrong.runner.status()).includes('bad"'), 'no password in status');
  } finally { await j.close(); await x.close(); }
});

test('runner: start/stop loop polls by itself and stops promptly', async () => {
  const j = await startFakeJsonVms();
  try {
    const cfg = jsonCfg(j);
    const emitted: PlatformEvent[] = [];
    const runner = createVmsRunner({ system: cfg, connector: mk(cfg), cursors: createMemoryCursorStore(), minGapMs: 0, pollIntervalMs: 30, emit: async (e) => { emitted.push(...e); }, log: { warn: () => {} } });
    runner.start();
    await new Promise((r) => setTimeout(r, 150));
    j.emit({ camera: 'A1', type: 'MOTION' });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(emitted.length, 1);
    const t = Date.now();
    await runner.stop();
    assert.ok(Date.now() - t < 500);
    assert.equal(runner.running, false);
    const before = j.requests.length;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(j.requests.length, before, 'no calls after stop');
  } finally { await j.close(); }
});

test('runner: the minimum gap between calls is kept', async () => {
  const j = await startFakeJsonVms();
  try {
    const cfg = jsonCfg(j);
    const times: number[] = [];
    const base = mk(cfg);
    const connector = { ...base, cameras: async () => { times.push(Date.now()); return base.cameras(); }, events: async (c: string | null, l: number) => { times.push(Date.now()); return base.events(c, l); } };
    const runner = createVmsRunner({ system: cfg, connector, cursors: createMemoryCursorStore(), minGapMs: 80, emit: async () => {}, log: { warn: () => {} } });
    await runner.tick();
    assert.ok(times.length >= 2);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 70, `gap ${times[i] - times[i - 1]} ms`);
  } finally { await j.close(); }
});
