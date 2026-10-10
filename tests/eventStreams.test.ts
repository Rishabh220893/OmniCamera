/**
 * Live event streams from Hikvision and Dahua devices (federation plan step 3): the parsers (events cut across network chunks at every
 * position), the buffer that gives a push feed cursor semantics, the connectors against a fake recorder over real HTTP (login, dropped
 * connections, a silent connection, a refusal, shutdown, read-only), and the whole path from a device event to an alert through the runner,
 * the bus and the alert engine. The device formats are from vendor documentation, not from hardware (see the connector headers).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHikvisionParser, parseHikvisionAlert, kindOfHikvision, hikvisionEventsConnector } from '../server/connectors/vms/hikvisionEvents.ts';
import { createDahuaParser, parseDahuaRecord, kindOfDahua, dahuaEventsConnector } from '../server/connectors/vms/dahuaEvents.ts';
import { createStreamBuffer } from '../server/connectors/vms/streamBuffer.ts';
import { createVmsConnectorTypes, createMemoryCursorStore, VmsError, type VmsEvent, type VmsSystemConfig } from '../server/connectors/vms/index.ts';
import { createVmsService, EVENT_TOPIC } from '../server/connectors/vms/service.ts';
import { createMemoryBus } from '../server/bus/memoryBus.ts';
import { createEventPipeline } from '../server/events/pipeline.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, type Channel } from '../server/events/channels.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { makeEvent, type PlatformEvent } from '../server/events/schema.ts';
import { validateRule } from '../server/events/rules.ts';
import { startFakeNvr, type FakeNvr } from './lab/fakeNvr.ts';

const quiet = { warn() {}, info() {} };
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(`timed out waiting for: ${what}`);
};

// ---- Hikvision documents ------------------------------------------------------------------------------------------------------

const hik = (o: { ch?: number | string; type?: string; state?: string; at?: string; n?: number; desc?: string; extra?: string; dyn?: number } = {}) =>
  `<?xml version="1.0" encoding="UTF-8"?>\r\n<EventNotificationAlert version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">\r\n<ipAddress>10.1.0.11</ipAddress><portNo>80</portNo><protocolType>HTTP</protocolType><macAddress>44:19:b6:00:00:01</macAddress>`
  + `<channelID>${o.ch ?? 1}</channelID>${o.dyn ? `<dynChannelID>${o.dyn}</dynChannelID>` : ''}<dateTime>${o.at ?? '2026-10-10T10:00:00+05:30'}</dateTime><activePostCount>${o.n ?? 1}</activePostCount>`
  + `<eventType>${o.type ?? 'VMD'}</eventType><eventState>${o.state ?? 'active'}</eventState><eventDescription>${o.desc ?? 'Motion alarm'}</eventDescription>${o.extra ?? ''}</EventNotificationAlert>`;

test('hikvision: event codes map to the shared kinds; unknown ones are alarms', () => {
  const k = (t: string) => kindOfHikvision(t);
  assert.deepEqual([k('VMD'), k('linedetection'), k('fielddetection'), k('regionEntrance'), k('shelteralarm'), k('ANPR'), k('videoloss'), k('IO'), k('diskfull')],
    ['motion', 'line_crossing', 'intrusion', 'intrusion', 'tamper', 'plate', 'alarm', 'alarm', 'alarm']);
});

test('hikvision: one notice becomes one event with a stable id; ended and heartbeat notices, and unreadable ones, are ignored', () => {
  const a = parseHikvisionAlert(hik({ ch: 3, type: 'linedetection', n: 7, desc: 'Line crossing' }))!;
  assert.deepEqual([a.cameraId, a.kind, a.vendorCode, a.data.text], ['3', 'line_crossing', 'linedetection', 'Line crossing']);
  assert.equal(a.at.toISOString(), '2026-10-10T04:30:00.000Z', 'the +05:30 in the notice is honoured');
  assert.equal(a.id, parseHikvisionAlert(hik({ ch: 3, type: 'linedetection', n: 7 }))!.id, 'the same notice always gets the same id');
  assert.notEqual(a.id, parseHikvisionAlert(hik({ ch: 3, type: 'linedetection', n: 8 }))!.id);
  assert.equal(parseHikvisionAlert(hik({ state: 'inactive' })), null, 'event ended');
  assert.equal(parseHikvisionAlert(hik({ type: 'heartBeat' })), null);
  assert.equal(parseHikvisionAlert(hik({ type: 'videoloss', state: 'inactive' })), null, 'the videoloss heartbeat some firmware sends');
  assert.equal(parseHikvisionAlert('<EventNotificationAlert><foo/></EventNotificationAlert>'), null);
  assert.equal(parseHikvisionAlert('not xml at all'), null);
  const nvr = parseHikvisionAlert(hik({ ch: 1, dyn: 5 }))!;
  assert.equal(nvr.cameraId, '5', 'an NVR\'s IP channel is named by dynChannelID');
});

test('hikvision: a plate notice carries the plate and a 0-1 confidence; one with no plate is not a plate read; a zone-less time uses the configured offset', () => {
  const p = parseHikvisionAlert(hik({ type: 'ANPR', desc: 'ANPR', extra: '<ANPR><country>IND</country><licensePlate>GJ01AB1234</licensePlate><confidenceLevel>87</confidenceLevel></ANPR>' }))!;
  assert.deepEqual([p.kind, p.data.plate, p.data.confidence], ['plate', 'GJ01AB1234', 0.87]);
  assert.equal(parseHikvisionAlert(hik({ type: 'ANPR' })), null);
  const local = parseHikvisionAlert(hik({ at: '2026-10-10T10:00:00' }), { timezoneOffsetMinutes: 330 })!;
  assert.equal(local.at.toISOString(), '2026-10-10T04:30:00.000Z');
  assert.equal(parseHikvisionAlert(hik({ type: 'weirdThing', desc: '' }))!.data.text, 'Hikvision event weirdThing');
});

/** The parser's answer for a stream cut into chunks of `size` characters. */
const feedHik = (stream: string, size: number) => { const p = createHikvisionParser(); const out: VmsEvent[] = []; for (let i = 0; i < stream.length; i += size) out.push(...p(stream.slice(i, i + size))); return out; };

test('hikvision parser: the same events come out however the network cuts the stream, with framing, heartbeats and junk between documents', () => {
  const doc = (o: Parameters<typeof hik>[0]) => `--boundary\r\nContent-Type: application/xml; charset="UTF-8"\r\nContent-Length: ${hik(o).length}\r\n\r\n${hik(o)}\r\n`;
  const stream = doc({ n: 1 }) + doc({ type: 'videoloss', state: 'inactive', n: 2 }) + 'garbage <<< ' + doc({ ch: 2, type: 'fielddetection', n: 3 }) + doc({ type: 'ANPR', n: 4, extra: '<ANPR><licensePlate>MH12XY9999</licensePlate></ANPR>' });
  const want = feedHik(stream, stream.length);
  assert.deepEqual(want.map((e) => [e.cameraId, e.kind]), [['1', 'motion'], ['2', 'intrusion'], ['1', 'plate']]);
  for (const size of [1, 2, 3, 5, 7, 13, 31, 64, 100, 257]) assert.deepEqual(feedHik(stream, size).map((e) => e.id), want.map((e) => e.id), `chunks of ${size}`);
});

test('hikvision parser: a stream with no documents does not grow without bound, and a half document is completed by the next chunk', () => {
  const p = createHikvisionParser();
  for (let i = 0; i < 4000; i++) assert.deepEqual(p('x'.repeat(1024)), []);
  const d = hik({ n: 9 });
  assert.deepEqual(p(d.slice(0, 50)), []);
  assert.equal(p(d.slice(50)).length, 1);
});

// ---- Dahua records -------------------------------------------------------------------------------------------------------------

const dahuaPart = (body: string, withLength = true) => `--myboundary\r\nContent-Type: text/plain${withLength ? `\r\nContent-Length: ${Buffer.byteLength(body)}` : ''}\r\n\r\n${body}\r\n\r\n`;
const feedDahua = (stream: string, size: number) => { const p = createDahuaParser(); const out: VmsEvent[] = []; for (let i = 0; i < stream.length; i += size) out.push(...p(stream.slice(i, i + size))); return out; };

test('dahua: codes map to the shared kinds', () => {
  const k = (c: string) => kindOfDahua(c);
  assert.deepEqual([k('VideoMotion'), k('SmartMotionHuman'), k('CrossLineDetection'), k('CrossRegionDetection'), k('VideoBlind'), k('TrafficJunction'), k('AlarmLocal'), k('StorageFailure')],
    ['motion', 'motion', 'line_crossing', 'intrusion', 'tamper', 'plate', 'alarm', 'alarm']);
});

test('dahua: records become events (channel index + 1); stop notices and heartbeats are ignored; the device\'s UTC stamp is used', () => {
  const m = parseDahuaRecord('Code=VideoMotion;action=Start;index=2')!;
  assert.deepEqual([m.cameraId, m.kind, m.vendorCode], ['3', 'motion', 'VideoMotion']);
  assert.equal(parseDahuaRecord('Code=VideoMotion;action=Stop;index=2'), null);
  assert.equal(parseDahuaRecord('Heartbeat'), null);
  assert.equal(parseDahuaRecord('nonsense'), null);
  const c = parseDahuaRecord('Code=CrossLineDetection;action=Pulse;index=0;data={\n   "UTC" : 1760090000,\n   "EventID" : 77,\n   "Name" : "Gate line"\n}')!;
  assert.deepEqual([c.kind, c.at.toISOString(), c.id], ['line_crossing', new Date(1760090000 * 1000).toISOString(), 'CrossLineDetection:0:Pulse:77']);
  const bad = parseDahuaRecord('Code=VideoMotion;action=Start;index=0;data={ not json')!;
  assert.equal(bad.kind, 'motion', 'a damaged detail does not lose the event');
});

test('dahua: a plate is found wherever the traffic event puts it; one without a plate is not a plate read', () => {
  const a = parseDahuaRecord('Code=TrafficJunction;action=Pulse;index=1;data={ "UTC": 1760090001, "TrafficCar": { "PlateNumber": "GJ05CD4321" } }')!;
  assert.deepEqual([a.kind, a.data.plate], ['plate', 'GJ05CD4321']);
  const b = parseDahuaRecord('Code=TrafficJunction;action=Pulse;index=1;data={ "Object": { "ObjectType": "Plate", "Text": "KA01EF0001" } }')!;
  assert.equal(b.data.plate, 'KA01EF0001');
  assert.equal(parseDahuaRecord('Code=TrafficJunction;action=Pulse;index=1;data={ "Vehicle": {} }'), null);
});

test('dahua parser: the same events come out however the network cuts the stream, with and without Content-Length, multi-byte text included', () => {
  const recs = [
    'Code=VideoMotion;action=Start;index=0', 'Heartbeat', 'Code=VideoMotion;action=Stop;index=0',
    'Code=TrafficJunction;action=Pulse;index=1;data={\n "UTC" : 1760090005,\n "TrafficCar" : { "PlateNumber" : "ગુજરાત12" }\n}', 'Code=CrossLineDetection;action=Start;index=3',
  ];
  for (const withLength of [true, false]) {
    const stream = recs.map((r) => dahuaPart(r, withLength)).join('') + dahuaPart('Heartbeat', withLength); // a final boundary closes the last record when there is no length
    const want = feedDahua(stream, stream.length);
    assert.deepEqual(want.map((e) => [e.cameraId, e.kind]), [['1', 'motion'], ['2', 'plate'], ['4', 'line_crossing']], `length ${withLength}`);
    assert.equal(want[1].data.plate, 'ગુજરાત12', 'multi-byte text survives');
    const shape = (l: VmsEvent[]) => l.map((e) => [e.cameraId, e.kind, e.vendorCode, e.data.plate]);
    for (const size of [1, 2, 3, 5, 7, 11, 29, 64, 128]) assert.deepEqual(shape(feedDahua(stream, size)), shape(want), `chunks of ${size}, length ${withLength}`);
    assert.equal(new Set(want.map((e) => e.id)).size, want.length, 'ids are distinct');
  }
});

// ---- the buffer ----------------------------------------------------------------------------------------------------------------

const ev = (id: string): VmsEvent => ({ id, cameraId: '1', at: new Date(), kind: 'motion', vendorCode: 'x', data: {} });

test('buffer: the first read is from now; later reads continue exactly; paging says when there is more', () => {
  const b = createStreamBuffer({ epoch: 'e1' });
  b.push(ev('a'));
  const first = b.read(null, 10);
  assert.deepEqual(first.events, [], 'events before the reader existed are not replayed');
  b.push(ev('b')); b.push(ev('c')); b.push(ev('d'));
  const p1 = b.read(first.cursor, 2);
  assert.deepEqual([p1.events.map((e) => e.id), p1.more], [['b', 'c'], true]);
  const p2 = b.read(p1.cursor, 2);
  assert.deepEqual([p2.events.map((e) => e.id), p2.more], [['d'], false]);
  assert.deepEqual(b.read(p2.cursor, 2).events, []);
});

test('buffer: a cursor from another life of the buffer starts from now; falling behind drops the oldest and counts them', () => {
  const old = createStreamBuffer({ epoch: 'before' });
  old.push(ev('x'));
  const saved = old.read(null, 5).cursor;
  const fresh = createStreamBuffer({ epoch: 'after' });
  fresh.push(ev('y'));
  assert.deepEqual(fresh.read(saved, 5).events, [], 'a restart does not replay or repeat');
  const small = createStreamBuffer({ capacity: 10, epoch: 'e' });
  const c0 = small.read(null, 5).cursor;
  for (let i = 0; i < 25; i++) small.push(ev(`e${i}`));
  const page = small.read(c0, 100);
  assert.equal(page.events.length, 10);
  assert.equal(page.events[0].id, 'e15', 'the newest ten are kept');
  assert.equal(small.dropped(), 15);
});

// ---- the connectors against a fake recorder ------------------------------------------------------------------------------------

const system = (id: string, kind: string, nvr: FakeNvr, o: Partial<VmsSystemConfig> = {}): VmsSystemConfig => ({
  id, kind, baseUrl: `http://127.0.0.1:${nvr.port}`, credentials: { user: 'admin', pass: 'P@ss w0rd%1' }, ownerUserId: 'owner-1', department: 'Traffic',
  options: { backoffBaseMs: 20, backoffMaxMs: 80, firstConnectWaitMs: 2000, idleTimeoutMs: 5000 }, ...o,
});
const types = createVmsConnectorTypes();
const create = (cfg: VmsSystemConfig) => types.get(cfg.kind).create(cfg) as ReturnType<typeof hikvisionEventsConnector.create> & { close(): Promise<void>; status(): any };

/** Reads events until `n` have arrived (the connector is polled the way the runner polls it). */
async function collect(c: ReturnType<typeof create>, cursor: { v: string | null }, n: number): Promise<VmsEvent[]> {
  const got: VmsEvent[] = [];
  await until(`${n} events`, async () => { const p = await c.events(cursor.v, 50); cursor.v = p.cursor; got.push(...p.events); return got.length >= n; });
  return got;
}

test('hikvision connector: logs in with Digest, reads live events, lists channels and streams, reports health, and only ever sends GET', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const c = create(system('traffic', 'hikvision-events', nvr));
  try {
    const cur = { v: null as string | null };
    assert.deepEqual((await c.events(null, 10)).events, [], 'the first read waits for the connection, then starts from now');
    cur.v = (await c.events(null, 10)).cursor;
    assert.equal(nvr.events.open(), 1);
    nvr.events.part(hik({ ch: 1, type: 'VMD', n: 1 }));
    nvr.events.part(hik({ ch: 2, type: 'linedetection', n: 2 }));
    const got = await collect(c, cur, 2);
    assert.deepEqual(got.map((e) => [e.cameraId, e.kind]), [['1', 'motion'], ['2', 'line_crossing']]);
    assert.deepEqual((await c.cameras()).map((x) => [x.id, x.name, x.online]), [['1', 'Gate', true], ['2', 'Yard', false]]);
    assert.ok((await c.streams('1')).every((s) => s.protocol === 'rtsp'));
    const h = await c.health();
    assert.equal(h.ok, true);
    assert.match(h.detail!, /event stream connected/);
  } finally { await c.close(); await nvr.close(); }
  assert.deepEqual([...new Set(nvr.methods)], ['GET'], 'nothing but GET was ever sent to the device');
  assert.ok(nvr.refused >= 1, 'the Digest challenge was answered (the first request of each call is refused)');
});

test('hikvision connector: a wrong login is an auth failure that says so; a device with no event service is a protocol error', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const bad = create(system('traffic', 'hikvision-events', nvr, { credentials: { user: 'admin', pass: 'wrong' } }));
  try {
    await assert.rejects(bad.events(null, 10), (e) => e instanceof VmsError && e.code === 'auth' && /login/i.test(e.message));
    assert.equal(bad.status().state, 'auth_failed');
  } finally { await bad.close(); }
  nvr.events.refuse(404);
  const noService = create(system('traffic2', 'hikvision-events', nvr));
  try { await assert.rejects(noService.events(null, 10), (e) => e instanceof VmsError && e.code === 'protocol' && /event stream/.test(e.message)); }
  finally { await noService.close(); await nvr.close(); }
});

test('hikvision connector: after a dropped connection it reconnects by itself, loses nothing it had, and repeats nothing', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const c = create(system('traffic', 'hikvision-events', nvr));
  try {
    const cur = { v: (await c.events(null, 10)).cursor as string | null };
    nvr.events.part(hik({ n: 1 }));
    assert.equal((await collect(c, cur, 1)).length, 1);
    nvr.events.drop();
    await until('reconnect', () => nvr.events.total >= 2 && nvr.events.open() === 1);
    nvr.events.part(hik({ n: 2 }));
    nvr.events.part(hik({ n: 3 }));
    const after = await collect(c, cur, 2);
    assert.deepEqual(after.map((e) => e.id.split(':').pop()), ['2', '3'], 'only the new ones; the first was not delivered again');
    assert.ok(c.status().reconnects >= 1);
    assert.equal(c.status().state, 'connected');
  } finally { await c.close(); await nvr.close(); }
});

test('hikvision connector: while the device is unreachable the system shows as failing (not silently healthy), and recovers when it returns', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const c = create(system('traffic', 'hikvision-events', nvr));
  try {
    const cur = { v: (await c.events(null, 10)).cursor as string | null };
    nvr.events.refuse(503);
    nvr.events.drop();
    await until('the failure to show', async () => { try { await c.events(cur.v, 10); return false; } catch (e) { return e instanceof VmsError && e.code === 'rate_limited'; } });
    assert.equal((await c.health()).ok, false);
    nvr.events.refuse(null);
    await until('recovery', async () => { try { await c.events(cur.v, 10); return true; } catch { return false; } });
    nvr.events.part(hik({ n: 5 }));
    assert.equal((await collect(c, cur, 1)).length, 1);
  } finally { await c.close(); await nvr.close(); }
});

test('hikvision connector: a connection that goes silent is torn down and re-opened (its heartbeat stopped)', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const c = create(system('traffic', 'hikvision-events', nvr, { options: { backoffBaseMs: 20, firstConnectWaitMs: 2000, idleTimeoutMs: 250 } }));
  try {
    await c.events(null, 10);
    await until('a second connection after silence', () => nvr.events.total >= 2, 5000);
    assert.match(String(c.status().lastError ?? ''), /heartbeat|No data/);
  } finally { await c.close(); await nvr.close(); }
});

test('hikvision connector: events cut across network chunks still arrive whole; closing the connector closes the connection', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const c = create(system('traffic', 'hikvision-events', nvr));
  const cur = { v: (await c.events(null, 10)).cursor as string | null };
  const doc = `--boundary\r\nContent-Type: application/xml\r\nContent-Length: ${hik({ n: 11 }).length}\r\n\r\n${hik({ n: 11 })}\r\n`;
  for (let i = 0; i < doc.length; i += 17) { nvr.events.write(doc.slice(i, i + 17)); await new Promise((r) => setTimeout(r, 2)); }
  assert.equal((await collect(c, cur, 1))[0].id.split(':').pop(), '11');
  await c.close();
  await until('the connection to be closed', () => nvr.events.open() === 0);
  assert.equal(c.status().state, 'closed');
  await nvr.close();
});

test('dahua connector: Basic login, live events with a plate, channel list, and only GET', async () => {
  const nvr = await startFakeNvr({ vendor: 'dahua', auth: 'basic' });
  const c = create(system('depot', 'dahua-events', nvr));
  try {
    const cur = { v: (await c.events(null, 10)).cursor as string | null };
    nvr.events.part('Code=VideoMotion;action=Start;index=0');
    nvr.events.part('Code=VideoMotion;action=Stop;index=0');
    nvr.events.part('Code=TrafficJunction;action=Pulse;index=1;data={ "UTC" : 1760090100, "TrafficCar" : { "PlateNumber" : "GJ01AB1234" } }');
    nvr.events.part('Heartbeat');
    const got = await collect(c, cur, 2);
    assert.deepEqual(got.map((e) => [e.cameraId, e.kind, e.data.plate]), [['1', 'motion', undefined], ['2', 'plate', 'GJ01AB1234']]);
    assert.deepEqual((await c.cameras()).map((x) => x.id), ['1', '2']);
    assert.equal((await c.health()).ok, true);
  } finally { await c.close(); await nvr.close(); }
  assert.deepEqual([...new Set(nvr.methods)], ['GET']);
  assert.ok(nvr.paths.some((p) => p.startsWith('/cgi-bin/eventManager.cgi?action=attach')));
});

// ---- the whole path: device -> runner -> bus -> alerting -> alert -----------------------------------------------------------------

function alerting() {
  const store = createMemoryAlertStore();
  const delivered: string[] = [];
  const channel: Channel = { type: 'log', check: () => null, deliver: async (_c, ctx) => { delivered.push(`${ctx.rule.name}:${ctx.event.type}:${ctx.event.cameraId}`); return { attempts: 1 }; } };
  const engine = createAlertEngine({ store, channels: createChannelRegistry([channel]), log: quiet, ruleCacheMs: 0 });
  return { store, engine, delivered };
}

test('a device event raises an alert for the department\'s rule, whoever owns the camera, with the vendor kept on the event', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const dir = mkdtempSync(join(tmpdir(), 'evstream-'));
  const bus = createMemoryBus({ log: quiet });
  const a = alerting();
  await a.store.saveRule({ ...validateRule({ name: 'Traffic intrusion', match: { types: ['vms.intrusion', 'plate.read'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] } }, { userId: 'dept:Traffic', id: 'r1', now: new Date(), department: 'Traffic' }) });
  const pipeline = await createEventPipeline({ bus, ingest: (events) => a.engine.ingest(events) });
  const service = createVmsService({
    types, bus, systemsFile: join(dir, 'systems.json'), cursors: createMemoryCursorStore(), allowPrivate: true, pollIntervalMs: 30, minGapMs: 0, log: quiet,
  });
  try {
    await service.add(system('traffic', 'hikvision-events', nvr));
    await until('the stream to open', () => nvr.events.open() === 1);
    await new Promise((r) => setTimeout(r, 120)); // the runner's first read is "from now"
    nvr.events.part(hik({ ch: 1, type: 'fielddetection', n: 41, desc: 'Intrusion' }));
    nvr.events.part(hik({ ch: 2, type: 'ANPR', n: 42, extra: '<ANPR><licensePlate>GJ01AB1234</licensePlate><confidenceLevel>93</confidenceLevel></ANPR>' }));
    nvr.events.part(hik({ ch: 1, type: 'VMD', n: 43 })); // motion: no rule asks for it
    await until('two alerts', async () => (await a.store.listAlerts({ userId: 'x', departments: ['Traffic'] })).length === 2);
    assert.deepEqual(a.delivered.sort(), ['Traffic intrusion:plate.read:traffic-2', 'Traffic intrusion:vms.intrusion:traffic-1']);
    const events = await a.store.queryEvents({ userId: 'x', departments: ['Traffic'] });
    assert.equal(events.length, 3, 'the motion event is stored too, it just raised no alert');
    const plate = events.find((e) => e.type === 'plate.read')!;
    assert.deepEqual([plate.data.plate, plate.source, plate.department, plate.cameraName], ['GJ01AB1234', 'vms:traffic', 'Traffic', 'Yard']);
    assert.equal(service.get('traffic')!.status!.state, 'ok');
    // removing the system closes the connection to the device
    await service.remove('traffic');
    await until('the device connection to close', () => nvr.events.open() === 0);
  } finally { await service.stop(); await pipeline.stop(); await bus.close(); await nvr.close(); }
});

test('a server restart does not replay or repeat device events: the saved position is from another life of the stream', async () => {
  const nvr = await startFakeNvr({ vendor: 'hikvision' });
  const cursors = createMemoryCursorStore();
  const seen: PlatformEvent[] = [];
  const run = async (n: number) => {
    const bus = createMemoryBus({ log: quiet });
    const sub = await bus.subscribe<PlatformEvent>(EVENT_TOPIC, 'c', async (m) => { seen.push(...m.map((x) => x.value)); }, { from: 'earliest' });
    const dir = mkdtempSync(join(tmpdir(), 'evstream-'));
    const service = createVmsService({ types, bus, systemsFile: join(dir, 's.json'), cursors, allowPrivate: true, pollIntervalMs: 30, minGapMs: 0, log: quiet });
    await service.add(system('traffic', 'hikvision-events', nvr));
    await until('stream', () => nvr.events.open() === 1);
    await new Promise((r) => setTimeout(r, 120));
    nvr.events.part(hik({ n }));
    await until(`event ${n}`, () => seen.some((e) => e.id && String(e.data.vendorEventId).endsWith(`:${n}`)));
    await service.stop(); await sub.stop(); await bus.close();
    await until('closed', () => nvr.events.open() === 0);
  };
  try {
    await run(1);
    await run(2);
    assert.deepEqual(seen.map((e) => String(e.data.vendorEventId).split(':').pop()), ['1', '2'], 'each event delivered once across the restart');
  } finally { await nvr.close(); }
});

// ---- the pipeline (every producer publishes; one consumer alerts) --------------------------------------------------------------------

const pe = (cam: string, type = 'camera.tamper', id?: string): PlatformEvent => ({ ...makeEvent({ type, summary: `${type} ${cam}`, dedupeKey: cam }, { source: 't', camera: { id: cam, name: cam, userId: 'u1', department: 'Traffic' }, ts: new Date('2026-10-10T10:00:00Z') }), ...(id ? { id } : {}) });
const RULE = { name: 'Tamper', match: { types: ['camera.tamper'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] } };

test('pipeline: published events are stored and alerted on; an empty publish is a no-op; the same event twice opens one alert', async () => {
  const bus = createMemoryBus({ log: quiet });
  const a = alerting();
  await a.store.saveRule(validateRule(RULE, { userId: 'u1', id: 'r1', now: new Date() }));
  const p = await createEventPipeline({ bus, ingest: (e) => a.engine.ingest(e) });
  try {
    await p.publish([]);
    const e = pe('gate');
    await p.publish([e]);
    await p.publish([e]);
    await until('an alert', async () => (await a.store.listAlerts({ userId: 'u1' })).length === 1);
    await until('both deliveries consumed', () => p.stats().delivered >= 2);
    assert.equal((await a.store.listAlerts({ userId: 'u1' }))[0].eventCount, 1, 'the repeat was recognised by its id');
    assert.deepEqual(a.delivered, ['Tamper:camera.tamper:gate']);
  } finally { await p.stop(); await bus.close(); }
});

test('pipeline: a batch that keeps failing goes to the dead-letter topic and does not block later events', async () => {
  const bus = createMemoryBus({ log: quiet });
  let fail = true;
  const ingested: string[] = [];
  const p = await createEventPipeline({ bus, ingest: async (events) => { if (fail && events.some((e) => e.cameraId === 'bad')) throw new Error('store down'); ingested.push(...events.map((e) => e.cameraId)); }, maxAttempts: 2, retryMs: 5, batch: 1 });
  try {
    await p.publish([pe('bad')]);
    await p.publish([pe('good')]);
    await until('the good event', () => ingested.includes('good'));
    await until('dead letter', () => p.stats().deadLettered >= 1);
    const dlq = await bus.read(`${EVENT_TOPIC}.dlq`, null, 10);
    assert.equal(dlq.length, 1);
    fail = false;
  } finally { await p.stop(); await bus.close(); }
});

// ---- the analysis worker and the gateways publish to the same bus ------------------------------------------------------------------

test('the analysis worker publishes its events to the bus; alerting picks them up from there, the same as for devices', async () => {
  const { createAnalysisWorker } = await import('../server/analysisWorker.ts');
  const bus = createMemoryBus({ log: quiet });
  const a = alerting();
  await a.store.saveRule(validateRule({ name: 'Watchlist', match: { types: ['plate.watchlist_match'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['event'] } }, { userId: 'u1', id: 'r1', now: new Date() }));
  const pipeline = await createEventPipeline({ bus, ingest: (events) => a.engine.ingest(events) });
  const logs: unknown[] = [];
  const worker = createAnalysisWorker({
    now: () => Date.now(), subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: ['GJ05AB1234'] }), grabFrame: async () => Buffer.from('frame'),
    analyze: async () => ({ summary: 's', counts: { people: 0, vehicles: 1, other: 0 }, detected_plates: ['GJ05AB1234'], watchlistMatches: ['GJ05AB1234'], plate_reads: [{ plate: 'GJ05AB1234', confidence: 0.93, formatValid: true, corrected: false }], plate_source: 'anpr' }),
    writeLog: async (d) => { logs.push(d); }, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {},
    emitEvents: (events) => pipeline.publish(events), log: { info() {}, warn() {}, error() {} },
  } as never, { concurrency: 1 });
  try {
    worker._applyCameras([{ id: 'c1', userId: 'u1', name: 'Gate', remoteStreamUrl: 'https://x.test/c', interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '' }]);
    worker._tick();
    await worker._idle();
    await until('the alert', async () => (await a.store.listAlerts({ userId: 'u1' })).length === 1);
    assert.deepEqual(a.delivered, ['Watchlist:plate.watchlist_match:c1']);
    assert.equal(logs.length, 1, 'the log was written as before');
  } finally { await pipeline.stop(); await bus.close(); }
});

test('events published while the alert store is down are not lost: they are retried and alerted once it is back', async () => {
  const bus = createMemoryBus({ log: quiet });
  const a = alerting();
  await a.store.saveRule(validateRule(RULE, { userId: 'u1', id: 'r1', now: new Date() }));
  let down = true;
  const pipeline = await createEventPipeline({ bus, ingest: async (events) => { if (down) throw new Error('store down'); await a.engine.ingest(events); }, retryMs: 10, maxAttempts: 50 });
  try {
    await pipeline.publish([pe('gate')]);
    await until('failures to be seen', () => pipeline.stats().failures >= 2);
    assert.equal((await a.store.listAlerts({ userId: 'u1' })).length, 0);
    down = false;
    await until('the alert after recovery', async () => (await a.store.listAlerts({ userId: 'u1' })).length === 1);
    assert.equal(pipeline.stats().deadLettered, 0);
  } finally { await pipeline.stop(); await bus.close(); }
});
