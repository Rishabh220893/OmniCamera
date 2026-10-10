/**
 * ONVIF live events through a PullPoint subscription (federation plan step 3): the message parsing, and the connector against a fake ONVIF
 * device over real HTTP (login, source mapping, renewal, a device that forgets its subscriptions, a refusal, shutdown, which operations are
 * ever sent), then the path from a device event to an alert. Message shapes are from the ONVIF specifications, not from hardware.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOnvifLineParser, eventFromNotification, kindOfOnvifTopic, onvifEventsConnector, parseEventsXAddr, parseNotifications, parseSubscriptionAddress, parseVideoSources,
} from '../server/connectors/vms/onvifEvents.ts';
import { createMemoryCursorStore, createVmsConnectorTypes, VmsError, type VmsEvent, type VmsSystemConfig } from '../server/connectors/vms/index.ts';
import { createVmsService } from '../server/connectors/vms/service.ts';
import { createMemoryBus } from '../server/bus/memoryBus.ts';
import { createEventPipeline } from '../server/events/pipeline.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, type Channel } from '../server/events/channels.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { validateRule } from '../server/events/rules.ts';
import { startFakeOnvif, type FakeOnvif } from './lab/fakeOnvif.ts';

const quiet = { warn() {}, info() {} };
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 15)); } assert.fail(`timed out: ${what}`); };

// ---- parsing -------------------------------------------------------------------------------------------------------------------

const note = (topic: string, source: Record<string, string>, data: Record<string, string>, o: { op?: string; utc?: string } = {}) =>
  `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="${o.utc ?? '2026-10-10T10:00:00Z'}" PropertyOperation="${o.op ?? 'Changed'}">`
  + `<tt:Source>${Object.entries(source).map(([k, v]) => `<tt:SimpleItem Name="${k}" Value="${v}"/>`).join('')}</tt:Source><tt:Data>${Object.entries(data).map(([k, v]) => `<tt:SimpleItem Name="${k}" Value="${v}"/>`).join('')}</tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
const pullReply = (...n: string[]) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><tev:PullMessagesResponse xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tt="http://www.onvif.org/ver10/schema"><tev:CurrentTime>x</tev:CurrentTime>${n.join('')}</tev:PullMessagesResponse></s:Body></s:Envelope>`;

test('onvif: topics map to the shared kinds; anything else is an alarm', () => {
  const k = kindOfOnvifTopic;
  assert.deepEqual([k('tns1:RuleEngine/CellMotionDetector/Motion'), k('tns1:VideoSource/MotionAlarm'), k('tns1:RuleEngine/LineDetector/Crossed'), k('tns1:RuleEngine/FieldDetector/ObjectsInside'), k('tns1:RuleEngine/TamperDetector/Tamper'), k('tns1:VideoSource/GlobalSceneChange/ImagingService'), k('tns1:Device/Trigger/DigitalInput')],
    ['motion', 'motion', 'line_crossing', 'intrusion', 'tamper', 'tamper', 'alarm']);
});

test('onvif: a pull reply is read into notifications whatever the XML prefixes; service and subscription addresses are found', () => {
  const xml = pullReply(
    note('tns1:RuleEngine/CellMotionDetector/Motion', { VideoSourceConfigurationToken: 'vsc_1', Rule: 'MyMotionRule' }, { IsMotion: 'true' }),
    note('tns1:RuleEngine/LineDetector/Crossed', { VideoSourceConfigurationToken: 'vsc_2' }, { ObjectId: '12' }),
  );
  const ns = parseNotifications(xml);
  assert.deepEqual(ns.map((n) => [n.topic, n.source.VideoSourceConfigurationToken, n.data.IsMotion ?? n.data.ObjectId, n.operation]), [['tns1:RuleEngine/CellMotionDetector/Motion', 'vsc_1', 'true', 'Changed'], ['tns1:RuleEngine/LineDetector/Crossed', 'vsc_2', '12', 'Changed']]);
  assert.deepEqual(parseNotifications(pullReply()), []);
  assert.equal(parseEventsXAddr('<tds:Capabilities><tt:Events><tt:XAddr>http://10.0.0.5/onvif/event_service</tt:XAddr></tt:Events></tds:Capabilities>'), 'http://10.0.0.5/onvif/event_service');
  assert.equal(parseSubscriptionAddress('<tev:SubscriptionReference><wsa:Address>http://10.0.0.5/onvif/subscription/3</wsa:Address></tev:SubscriptionReference>'), 'http://10.0.0.5/onvif/subscription/3');
  assert.equal(parseSubscriptionAddress('<other/>'), null);
});

test('onvif: video sources come from the profiles, several profiles of one source count once, and configuration tokens map to their source', () => {
  const xml = '<trt:Profiles token="p1"><tt:VideoSourceConfiguration token="vsc_A"><tt:Name>Gate</tt:Name><tt:SourceToken>src_A</tt:SourceToken></tt:VideoSourceConfiguration></trt:Profiles>'
    + '<trt:Profiles token="p2"><tt:VideoSourceConfiguration token="vsc_A"><tt:Name>Gate</tt:Name><tt:SourceToken>src_A</tt:SourceToken></tt:VideoSourceConfiguration></trt:Profiles>'
    + '<trt:Profiles token="p3"><tt:VideoSourceConfiguration token="vsc_B"><tt:Name>Yard</tt:Name><tt:SourceToken>src_B</tt:SourceToken></tt:VideoSourceConfiguration></trt:Profiles>';
  const s = parseVideoSources(xml);
  assert.deepEqual(s.cameras.map((c) => [c.id, c.name]), [['src_A', 'Gate'], ['src_B', 'Yard']]);
  assert.equal(s.byConfigToken.get('vsc_B'), 'src_B');
});

test('onvif: a notification is an event only when something happened - not when it ended, not the initial state, not without a source; ids are stable', () => {
  const map = new Map([['vsc_1', 'src_1']]);
  const n = (o: Partial<ReturnType<typeof parseNotifications>[number]> = {}) => ({ topic: 'tns1:RuleEngine/CellMotionDetector/Motion', utcTime: '2026-10-10T10:00:00Z', operation: 'Changed', source: { VideoSourceConfigurationToken: 'vsc_1' }, data: { IsMotion: 'true' }, ...o });
  const e = eventFromNotification(n(), map)!;
  assert.deepEqual([e.cameraId, e.kind, e.vendorCode, e.at.toISOString()], ['src_1', 'motion', 'RuleEngine/CellMotionDetector/Motion', '2026-10-10T10:00:00.000Z'], 'the configuration token is replaced by the source it belongs to');
  assert.equal(eventFromNotification(n(), map)!.id, e.id);
  assert.notEqual(eventFromNotification(n({ utcTime: '2026-10-10T10:00:01Z' }), map)!.id, e.id);
  assert.equal(eventFromNotification(n({ data: { IsMotion: 'false' } }), map), null, 'ended');
  assert.equal(eventFromNotification(n({ operation: 'Initialized' }), map), null, 'initial state, not an event');
  assert.equal(eventFromNotification(n({ source: {} }), map), null);
  assert.equal(eventFromNotification(n({ source: { VideoSourceToken: 'raw_tok' } }), map)!.cameraId, 'raw_tok', 'an unknown token is used as it is');
  assert.equal(eventFromNotification(n({ topic: 'tns1:RuleEngine/LineDetector/Crossed', data: { ObjectId: '4' } }), map)!.kind, 'line_crossing', 'a pulse with no state flag still counts');
  assert.equal(eventFromNotification(n({ topic: 'tns1:Device/Trigger/DigitalInput', data: { LogicalState: 'true' } }), map)!.data.text, 'ONVIF event Device/Trigger/DigitalInput');
});

test('onvif: the line parser rebuilds events from JSON lines however they are cut, and a damaged line costs only itself', () => {
  const ev = (id: string): VmsEvent => ({ id, cameraId: 'c', at: new Date('2026-10-10T10:00:00Z'), kind: 'motion', vendorCode: 'x', data: {} });
  const text = `${JSON.stringify([ev('a'), ev('b')])}\n\n{broken\n${JSON.stringify([ev('c')])}\n`;
  for (const size of [1, 3, 7, 50, text.length]) {
    const p = createOnvifLineParser(); const out: VmsEvent[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...p(text.slice(i, i + size)));
    assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c'], `chunks of ${size}`);
    assert.equal(out[0].at.toISOString(), '2026-10-10T10:00:00.000Z');
  }
});

// ---- the connector against a fake device ------------------------------------------------------------------------------------------

const PROFILES = [
  { token: 'main', name: 'MainStream', codec: 'H264', width: 1920, height: 1080, source: 'src_gate' },
  { token: 'yard', name: 'YardStream', codec: 'H264', width: 1280, height: 720, source: 'src_yard' },
];
const device = (o: Parameters<typeof startFakeOnvif>[0] = {}) => startFakeOnvif({ auth: 'wsse', user: 'admin', pass: 'secret', events: true, profiles: PROFILES, streamHost: '127.0.0.1', ...o });
const system = (dev: FakeOnvif, o: Partial<VmsSystemConfig> = {}): VmsSystemConfig => ({
  id: 'cam-hall', kind: 'onvif-events', baseUrl: dev.url, credentials: { user: 'admin', pass: 'secret' }, ownerUserId: 'owner-1', department: 'Traffic',
  options: { backoffBaseMs: 20, backoffMaxMs: 80, firstConnectWaitMs: 2000, idleTimeoutMs: 5000, minPullGapMs: 10, renewEveryMs: 60_000 }, ...o,
});
const create = (cfg: VmsSystemConfig) => onvifEventsConnector.create(cfg) as ReturnType<typeof onvifEventsConnector.create> & { close(): Promise<void>; status(): any };

async function collect(c: ReturnType<typeof create>, cur: { v: string | null }, n: number): Promise<VmsEvent[]> {
  const got: VmsEvent[] = [];
  await until(`${n} events`, async () => { const p = await c.events(cur.v, 50); cur.v = p.cursor; got.push(...p.events); return got.length >= n; });
  return got;
}

const ALLOWED = ['GetSystemDateAndTime', 'GetCapabilities', 'GetProfiles', 'GetDeviceInformation', 'GetStreamUri', 'CreatePullPointSubscription', 'PullMessages', 'Renew', 'Unsubscribe'];

test('onvif connector: logs in, subscribes, delivers events by video source, lists sources and streams, and sends only reading operations and its own subscription calls', async () => {
  const dev = await device();
  const c = create(system(dev));
  try {
    const cur = { v: (await c.events(null, 10)).cursor as string | null };
    assert.equal(dev.events.alive(), 1);
    dev.events.push('tns1:RuleEngine/FieldDetector/ObjectsInside', { VideoSourceConfigurationToken: 'vsc_src_yard' }, { IsInside: 'true' });
    dev.events.push('tns1:RuleEngine/CellMotionDetector/Motion', { VideoSourceConfigurationToken: 'vsc_src_gate' }, { IsMotion: 'true' });
    dev.events.push('tns1:RuleEngine/CellMotionDetector/Motion', { VideoSourceConfigurationToken: 'vsc_src_gate' }, { IsMotion: 'false' });
    dev.events.push('tns1:RuleEngine/CellMotionDetector/Motion', { VideoSourceConfigurationToken: 'vsc_src_gate' }, { IsMotion: 'true' }, { operation: 'Initialized' });
    const got = await collect(c, cur, 2);
    assert.deepEqual(got.map((e) => [e.cameraId, e.kind]), [['src_yard', 'intrusion'], ['src_gate', 'motion']], 'the ended event and the initial state are not events');
    assert.deepEqual((await c.cameras()).map((x) => [x.id, x.name]), [['src_gate', 'Source src_gate'], ['src_yard', 'Source src_yard']]);
    assert.ok((await c.streams('src_gate')).every((s) => s.protocol === 'rtsp' && s.url.startsWith('rtsp://')));
    const h = await c.health();
    assert.equal(h.ok, true);
  } finally { await c.close(); }
  await until('unsubscribed', () => dev.events.alive() === 0);
  assert.ok(dev.events.unsubscribed >= 1, 'closing ends the subscription the connector made');
  assert.deepEqual(dev.calls.filter((o) => !ALLOWED.includes(o)), [], 'no operation outside the reading ones and the subscription\'s own');
  await dev.close();
});

test('onvif connector: a wrong login is an auth failure; a device that will not create a subscription says so, and recovers when it does', async () => {
  const dev = await device();
  const bad = create(system(dev, { credentials: { user: 'admin', pass: 'nope' } }));
  try {
    await assert.rejects(bad.events(null, 10), (e) => e instanceof VmsError && e.code === 'auth');
    assert.equal(bad.status().state, 'auth_failed');
  } finally { await bad.close(); }
  dev.events.refuseCreate(true);
  const c = create(system(dev));
  try {
    await until('the failure to show', async () => { try { await c.events(null, 10); return false; } catch (e) { return e instanceof VmsError && e.code === 'upstream'; } });
    assert.equal((await c.health()).ok, false);
    dev.events.refuseCreate(false);
    await until('recovery', async () => { try { await c.events(null, 10); return true; } catch { return false; } });
    assert.equal(dev.events.alive(), 1);
  } finally { await c.close(); await dev.close(); }
});

test('onvif connector: the subscription is renewed while it runs', async () => {
  const dev = await device();
  const c = create(system(dev, { options: { backoffBaseMs: 20, firstConnectWaitMs: 2000, idleTimeoutMs: 5000, minPullGapMs: 10, renewEveryMs: 80 } }));
  try {
    await c.events(null, 10);
    await until('renewals', () => dev.events.renews >= 2);
    assert.equal(c.status().state, 'connected');
  } finally { await c.close(); await dev.close(); }
});

test('onvif connector: a device that forgets its subscriptions (a restart) is subscribed to again, nothing is repeated, and events keep coming', async () => {
  const dev = await device();
  const c = create(system(dev));
  try {
    const cur = { v: (await c.events(null, 10)).cursor as string | null };
    dev.events.push('tns1:RuleEngine/CellMotionDetector/Motion', { VideoSourceConfigurationToken: 'vsc_src_gate' }, { IsMotion: 'true' }, { utc: '2026-10-10T10:00:01Z' });
    assert.equal((await collect(c, cur, 1)).length, 1);
    dev.events.killAll();
    await until('a new subscription', () => dev.events.created >= 2 && dev.events.alive() === 1);
    dev.events.push('tns1:RuleEngine/CellMotionDetector/Motion', { VideoSourceConfigurationToken: 'vsc_src_gate' }, { IsMotion: 'true' }, { utc: '2026-10-10T10:00:02Z' });
    const after = await collect(c, cur, 1);
    assert.equal(after[0].at.toISOString(), '2026-10-10T10:00:02.000Z', 'only the new one');
    assert.ok(c.status().reconnects >= 1);
  } finally { await c.close(); await dev.close(); }
});

test('an ONVIF intrusion becomes an alert for the department\'s rule through the runner, the bus and alerting', async () => {
  const dev = await device();
  const dir = mkdtempSync(join(tmpdir(), 'onvifev-'));
  const bus = createMemoryBus({ log: quiet });
  const store = createMemoryAlertStore();
  const delivered: string[] = [];
  const channel: Channel = { type: 'log', check: () => null, deliver: async (_c, c) => { delivered.push(`${c.event.type}:${c.event.cameraId}:${c.event.cameraName}`); return { attempts: 1 }; } };
  const engine = createAlertEngine({ store, channels: createChannelRegistry([channel]), log: quiet, ruleCacheMs: 0 });
  await store.saveRule({ ...validateRule({ name: 'Intrusion', match: { types: ['vms.intrusion'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera'] } }, { userId: 'dept:Traffic', id: 'r1', now: new Date(), department: 'Traffic' }) });
  const pipeline = await createEventPipeline({ bus, ingest: (e) => engine.ingest(e) });
  const service = createVmsService({ types: createVmsConnectorTypes(), bus, systemsFile: join(dir, 's.json'), cursors: createMemoryCursorStore(), allowPrivate: true, pollIntervalMs: 30, minGapMs: 0, log: quiet });
  try {
    await service.add(system(dev));
    await until('subscription', () => dev.events.alive() === 1);
    await new Promise((r) => setTimeout(r, 120));
    dev.events.push('tns1:RuleEngine/FieldDetector/ObjectsInside', { VideoSourceConfigurationToken: 'vsc_src_yard' }, { IsInside: 'true' });
    dev.events.push('tns1:RuleEngine/CellMotionDetector/Motion', { VideoSourceConfigurationToken: 'vsc_src_gate' }, { IsMotion: 'true' });
    await until('the alert', async () => (await store.listAlerts({ userId: 'x', departments: ['Traffic'] })).length === 1);
    assert.deepEqual(delivered, ['vms.intrusion:cam-hall-src_yard:Source src_yard']);
    assert.equal((await store.queryEvents({ userId: 'x', departments: ['Traffic'] })).length, 2, 'the motion was stored as well');
    await service.remove('cam-hall');
    await until('the subscription to end', () => dev.events.alive() === 0);
  } finally { await service.stop(); await pipeline.stop(); await bus.close(); await dev.close(); }
});
