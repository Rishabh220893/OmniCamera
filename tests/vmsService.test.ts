import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createMemoryBus } from '../server/bus/memoryBus.ts';
import { createVmsConnectorTypes } from '../server/connectors/vms/index.ts';
import { createFileCursorStore, createVmsService, EVENT_TOPIC } from '../server/connectors/vms/service.ts';
import { registerVmsRoutes, type VmsPermission } from '../server/connectors/vms/routes.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, type Channel } from '../server/events/channels.ts';
import { validateRule } from '../server/events/rules.ts';
import type { PlatformEvent } from '../server/events/schema.ts';
import { startFakeJsonVms, startFakeXmlVms } from './lab/fakeVms.ts';

const root = mkdtempSync(path.join(tmpdir(), 'vms-svc-'));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* locked on Windows */ } });
const until = async (c: () => boolean, ms = 5000, what = 'condition') => { const t = Date.now(); while (!c()) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); } };

async function setup(over: { allowPrivate?: boolean; dir?: string } = {}) {
  const dir = over.dir ?? mkdtempSync(path.join(root, 's-'));
  const bus = createMemoryBus({ log: { warn: () => {} } });
  const store = createMemoryAlertStore();
  const sent: PlatformEvent[] = [];
  const channel: Channel = { type: 'log', check: () => null, deliver: async (_c, d) => { sent.push(d.event); return { attempts: 1 }; } };
  const engine = createAlertEngine({ store, channels: createChannelRegistry([channel]) });
  const consumer = await bus.subscribe<PlatformEvent>(EVENT_TOPIC, 'alerting', async (msgs) => { await engine.ingest(msgs.map((m) => m.value)); }, { from: 'earliest' });
  const service = createVmsService({
    types: createVmsConnectorTypes(), bus, systemsFile: path.join(dir, 'systems.json'), cursors: createFileCursorStore(path.join(dir, 'cursors.json')),
    allowPrivate: over.allowPrivate ?? true, pollIntervalMs: 40, minGapMs: 0, log: { warn: () => {}, info: () => {} },
  });
  return { dir, bus, store, engine, sent, service, consumer, async close() { await service.stop(); await consumer.stop(); await bus.close(); } };
}

test('end to end: two different systems added, their events cross the bus, become alerts through an ordinary rule, and neither system is written to', async () => {
  const j = await startFakeJsonVms(), x = await startFakeXmlVms();
  const w = await setup();
  try {
    await w.store.saveRule(validateRule({ name: 'Tamper anywhere', match: { types: ['camera.tamper'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] } }, { userId: 'u1', id: 'r1', now: new Date() }));
    await w.service.load();
    await w.service.add({ id: 'traffic', kind: 'reference-json', baseUrl: j.url, credentials: { user: j.user, pass: j.pass }, ownerUserId: 'u1', department: 'Traffic' });
    await w.service.add({ id: 'city', kind: 'reference-xml', baseUrl: x.url, credentials: { user: x.user, pass: x.pass }, ownerUserId: 'u1', department: 'Municipal', timezoneOffsetMinutes: 330 });
    await until(() => w.service.list().every((s) => s.status?.state === 'ok' && s.status.cameras === 3), 5000, 'both systems synced');

    j.emit({ camera: 'A2', type: 'TAMPER' });
    j.emit({ camera: 'A1', type: 'ANPR', plate: 'GJ05CD5678', conf: 0.95 });
    x.emit({ device: 'C-9', code: 'COVER', at: new Date(Math.floor(Date.now() / 1000) * 1000 + 1000) });
    await until(() => w.sent.length >= 2, 6000, 'two tamper alerts');
    assert.deepEqual(w.sent.map((e) => [e.cameraId, e.department]).sort(), [['city-C-9', 'Municipal'], ['traffic-A2', 'Traffic']]);

    const events = await w.store.queryEvents({ userId: 'u1', types: [], limit: 50 });
    assert.ok(events.some((e) => e.type === 'plate.read' && e.data.plate === 'GJ05CD5678' && e.source === 'vms:traffic'));
    const alerts = await w.store.listAlerts({ userId: 'u1', limit: 10 });
    assert.equal(alerts.length, 2);
    assert.deepEqual([j.writes, x.writes], [[], []]);
  } finally { await w.close(); await j.close(); await x.close(); }
});

test('systems and positions survive a restart: no replay of old events, new ones still arrive', async () => {
  const j = await startFakeJsonVms();
  const w1 = await setup();
  try {
    await w1.service.load();
    await w1.service.add({ id: 'traffic', kind: 'reference-json', baseUrl: j.url, credentials: { user: j.user, pass: j.pass }, ownerUserId: 'u1' });
    await until(() => w1.service.get('traffic')?.status?.state === 'ok', 5000, 'first sync');
    j.emit({ camera: 'A1', type: 'MOTION' });
    await until(() => w1.service.get('traffic')!.status!.eventsForwarded === 1, 5000, 'first event');
    await w1.close();

    const w2 = await setup({ dir: w1.dir });
    try {
      await w2.service.load();
      assert.equal(w2.service.list().length, 1, 'the system was remembered');
      await until(() => w2.service.get('traffic')?.status?.state === 'ok', 5000, 'sync after restart');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(w2.service.get('traffic')!.status!.eventsForwarded, 0, 'the old event was not replayed');
      j.emit({ camera: 'A2', type: 'MOTION' });
      await until(() => w2.service.get('traffic')!.status!.eventsForwarded === 1, 5000, 'new event');
    } finally { await w2.close(); }
  } finally { await j.close(); }
});

test('adding is validated: bad config, unknown kind, duplicate id, private address when not allowed; the login is stored but never returned', async () => {
  const j = await startFakeJsonVms();
  const w = await setup({ allowPrivate: false });
  try {
    await w.service.load();
    const good = { id: 'traffic', kind: 'reference-json', baseUrl: j.url, credentials: { user: j.user, pass: 'TOPSECRET' }, ownerUserId: 'u1' };
    await assert.rejects(w.service.add(good), /private network/);
    await assert.rejects(w.service.add({ ...good, id: 'a b' }), /'id'/);
    await assert.rejects(w.service.add({ ...good, kind: 'nope' }), /No connector type/);
    await w.close();

    const w2 = await setup({ allowPrivate: true });
    try {
      await w2.service.load();
      const v = await w2.service.add(good);
      assert.equal(v.hasCredentials, true);
      assert.ok(!JSON.stringify(v).includes('TOPSECRET'));
      assert.ok(!JSON.stringify(w2.service.list()).includes('TOPSECRET'));
      await assert.rejects(w2.service.add(good), /already exists/);
    } finally { await w2.close(); }
  } finally { await j.close(); }
});

test('a dead department does not stop the others, and removing a system stops its calls', async () => {
  const j = await startFakeJsonVms(), x = await startFakeXmlVms();
  const w = await setup();
  try {
    await w.service.load();
    await w.service.add({ id: 'dead', kind: 'reference-json', baseUrl: 'http://127.0.0.1:1', ownerUserId: 'u1' });
    await w.service.add({ id: 'city', kind: 'reference-xml', baseUrl: x.url, credentials: { user: x.user, pass: x.pass }, ownerUserId: 'u1' });
    await until(() => w.service.get('city')?.status?.state === 'ok', 5000, 'city ok');
    await until(() => (w.service.get('dead')?.status?.consecutiveFailures ?? 0) >= 1, 5000, 'dead failing');
    assert.ok(['degraded', 'down'].includes(w.service.get('dead')!.status!.state));
    x.emit({ device: 'C-1', code: 'MOT', at: new Date(Math.floor(Date.now() / 1000) * 1000 + 1000) });
    await until(() => w.service.get('city')!.status!.eventsForwarded >= 1, 6000, 'city still delivering');

    assert.equal(await w.service.remove('city'), true);
    assert.equal(await w.service.remove('city'), false);
    await new Promise((r) => setTimeout(r, 150));
    const n = x.requests.length;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(x.requests.length, n, 'no calls after removal');
    assert.equal(JSON.parse(readFileSync(path.join(w.dir, 'systems.json'), 'utf8')).length, 1);
    void j;
  } finally { await w.close(); await j.close(); await x.close(); }
});

test('routes: list, add (admin), health, cameras, sync, remove; permissions and bad input', async () => {
  const j = await startFakeJsonVms();
  const w = await setup();
  const app = express();
  app.use(express.json());
  const allowed = new Set<string>(['vms.view', 'vms.manage']);
  registerVmsRoutes(app, { service: w.service, allow: async (_q, res, p: VmsPermission) => { if (!allowed.has(p)) { res.status(403).json({ error: 'no' }); return null; } return { uid: 'u1' }; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: (await r.json()) as any }; };
  try {
    await w.service.load();
    const list = await call('GET', '/api/vms');
    assert.deepEqual(list.json.types.map((t: any) => t.kind), ['reference-json', 'reference-xml', 'hikvision-events', 'dahua-events', 'onvif-events']);
    const add = await call('POST', '/api/vms/systems', { id: 'traffic', kind: 'reference-json', baseUrl: j.url, credentials: { user: j.user, pass: j.pass }, ownerUserId: 'u1' });
    assert.equal(add.status, 201);
    assert.ok(!JSON.stringify(add.json).includes(j.pass));
    assert.equal((await call('POST', '/api/vms/systems', { id: 'traffic', kind: 'reference-json', baseUrl: j.url, ownerUserId: 'u1' })).status, 400, 'duplicate');
    assert.equal((await call('POST', '/api/vms/systems', {})).status, 400);
    assert.equal((await call('GET', '/api/vms/systems/traffic/health')).json.health.ok, true);
    const cams = await call('GET', '/api/vms/systems/traffic/cameras');
    assert.equal(cams.json.count, 3);
    assert.equal((await call('POST', '/api/vms/systems/traffic/sync')).json.system.status.state, 'ok');
    assert.equal((await call('GET', '/api/vms/systems/nope/health')).status, 404);
    assert.equal((await call('GET', '/api/vms/systems/..%2Fx/health')).status, 404);
    allowed.delete('vms.manage');
    assert.equal((await call('POST', '/api/vms/systems', { id: 'x' })).status, 403);
    assert.equal((await call('DELETE', '/api/vms/systems/traffic')).status, 403);
    assert.equal((await call('GET', '/api/vms')).status, 200, 'viewing is still allowed');
    allowed.add('vms.manage');
    assert.equal((await call('DELETE', '/api/vms/systems/traffic')).status, 200);
    assert.equal((await call('GET', '/api/vms')).json.systems.length, 0);
  } finally { server.close(); await w.close(); await j.close(); }
});
