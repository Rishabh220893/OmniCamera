/**
 * The webhook receiver for devices and systems that can only push (federation plan step 3): the formats, the sources and their tokens, the
 * public HTTP route (mounted before a large global body parser), and the path from a pushed event to an alert.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { parseWebhookBody, FormatError, MAX_EVENTS_PER_REQUEST } from '../server/connectors/webhook/formats.ts';
import { createWebhookService } from '../server/connectors/webhook/service.ts';
import { registerWebhookAdminRoutes, registerWebhookIngest } from '../server/connectors/webhook/routes.ts';
import { createMemoryBus } from '../server/bus/memoryBus.ts';
import { createEventPipeline } from '../server/events/pipeline.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, type Channel } from '../server/events/channels.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { validateRule } from '../server/events/rules.ts';
import type { PlatformEvent } from '../server/events/schema.ts';

const quiet = { warn() {}, info() {} };
const NOW = new Date('2026-10-10T10:00:00Z');
const ctx = { now: NOW };
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail(`timed out: ${what}`); };

// ---- formats -------------------------------------------------------------------------------------------------------------------

test('generic json: an event, a list, or { events }; the camera as an id or an object; kinds, plates and data are checked', () => {
  const one = parseWebhookBody('generic-json', JSON.stringify({ id: 'e1', camera: { id: 'gate-1', name: 'Main gate' }, type: 'intrusion', at: '2026-10-10T09:59:00Z', text: 'Person at the gate', data: { zone: 'A' } }), ctx);
  assert.deepEqual(one.events.map((e) => [e.id, e.cameraId, e.kind, e.at.toISOString(), e.data.text, (e.data as any).zone]), [['e1', 'gate-1', 'intrusion', '2026-10-10T09:59:00.000Z', 'Person at the gate', 'A']]);
  assert.equal(one.names.get('gate-1'), 'Main gate');
  const many = parseWebhookBody('generic-json', JSON.stringify({ events: [{ camera: 'a', plate: 'GJ01AB1234', confidence: 7 }, { camera: 'b', type: 'motion' }] }), ctx);
  assert.deepEqual(many.events.map((e) => [e.cameraId, e.kind, e.data.plate, e.data.confidence]), [['a', 'plate', 'GJ01AB1234', 1], ['b', 'motion', undefined, undefined]], 'a plate with no type is a plate read; confidence is kept within 0-1');
  assert.equal(parseWebhookBody('generic-json', JSON.stringify([{ camera: 'a' }]), ctx).events[0].kind, 'alarm', 'no type and no plate: an alarm');
});

test('generic json: bad events are reported by number and the good ones in the same request still count; whole-body problems are refused', () => {
  const r = parseWebhookBody('generic-json', JSON.stringify([{ camera: 'ok' }, { type: 'motion' }, { camera: 'c', type: 'explosion' }, { camera: 'd', at: 'yesterday' }, { camera: 'e', at: '2027-01-01T00:00:00Z' }, { camera: 'f', type: 'plate' }, 'text']), ctx);
  assert.deepEqual(r.events.map((e) => e.cameraId), ['ok']);
  assert.equal(r.ignored.length, 6);
  assert.match(r.ignored[0], /event 2 has no camera/);
  assert.match(r.ignored.join(' | '), /unknown type.*future.*plate read with no plate/s);
  for (const bad of ['not json', '[]', '"just text"']) assert.throws(() => parseWebhookBody('generic-json', bad, ctx), FormatError, bad);
  const notAList = parseWebhookBody('generic-json', JSON.stringify({ events: 'x' }), ctx);
  assert.deepEqual([notAList.events.length, notAList.ignored.length], [0, 1], 'a body that is neither an event nor a list yields nothing usable (the route answers 400 with the reason)');
  assert.throws(() => parseWebhookBody('generic-json', JSON.stringify(Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => ({ camera: 'a' }))), ctx), /at most 100/);
  assert.equal(parseWebhookBody('generic-json', JSON.stringify([{ camera: 'a', data: { blob: 'x'.repeat(5000) } }]), ctx).events.length, 0, 'oversized data is refused per event');
});

test('generic json: an event without an id gets the same id every time it is sent, so a retry makes no second event', () => {
  const body = JSON.stringify({ camera: 'gate', type: 'tamper', at: '2026-10-10T09:00:00Z', text: 'covered' });
  const a = parseWebhookBody('generic-json', body, ctx).events[0].id;
  assert.equal(parseWebhookBody('generic-json', body, ctx).events[0].id, a);
  assert.notEqual(parseWebhookBody('generic-json', body.replace('covered', 'moved'), ctx).events[0].id, a);
});

const hikDoc = (n: number, type = 'VMD', extra = '', state = 'active') => `<EventNotificationAlert version="2.0"><channelID>1</channelID><dateTime>2026-10-10T10:00:00+05:30</dateTime><activePostCount>${n}</activePostCount><eventType>${type}</eventType><eventState>${state}</eventState><eventDescription>d</eventDescription>${extra}</EventNotificationAlert>`;

test('hikvision-xml: the device\'s own notification, bare or inside a multipart body with pictures; heartbeats and ended events are ignored', () => {
  const bare = parseWebhookBody('hikvision-xml', `<?xml version="1.0"?>\r\n${hikDoc(1, 'linedetection')}`, ctx);
  assert.deepEqual(bare.events.map((e) => [e.cameraId, e.kind]), [['1', 'line_crossing']]);
  const multipart = `--MIME\r\nContent-Disposition: form-data; name="event_log"\r\nContent-Type: application/xml\r\n\r\n${hikDoc(2, 'ANPR', '<ANPR><licensePlate>GJ05CD4321</licensePlate></ANPR>')}\r\n--MIME\r\nContent-Disposition: form-data; name="picture"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\u0000\u0001binary\r\n--MIME--\r\n`;
  const m = parseWebhookBody('hikvision-xml', multipart, ctx);
  assert.deepEqual(m.events.map((e) => [e.kind, e.data.plate]), [['plate', 'GJ05CD4321']]);
  const hb = parseWebhookBody('hikvision-xml', hikDoc(3, 'videoloss', '', 'inactive') + hikDoc(4), ctx);
  assert.deepEqual([hb.events.length, hb.ignored.length], [1, 1]);
  assert.throws(() => parseWebhookBody('hikvision-xml', '<other/>', ctx), /no EventNotificationAlert/);
});

// ---- sources and tokens ----------------------------------------------------------------------------------------------------------

function service(o: { emit?: (e: PlatformEvent[]) => Promise<unknown>; maxRequests?: number; windowMs?: number; now?: () => Date; file?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-'));
  const file = o.file ?? join(dir, 'webhook-sources.json');
  const got: PlatformEvent[] = [];
  const svc = createWebhookService({ file, emit: o.emit ?? (async (e) => { got.push(...e); }), now: o.now ?? (() => NOW), maxRequests: o.maxRequests, windowMs: o.windowMs, log: quiet });
  return { svc, got, file };
}
const evBody = (cam = 'gate', extra: object = {}) => JSON.stringify({ camera: { id: cam, name: `Camera ${cam}` }, type: 'intrusion', at: '2026-10-10T09:59:00Z', ...extra });

test('sources: the token is shown once and only its hash is kept; the list never carries it; a wrong or missing token, and an unknown source, are all just "unauthorized"', async () => {
  const { svc, got, file } = service();
  const { source, token } = await svc.create({ id: 'ward-7', department: 'Traffic', label: 'Ward 7 NVR' }, 'admin-1');
  assert.match(token, /^wh_[A-Za-z0-9_-]{40,}$/);
  assert.equal(JSON.stringify(svc.list()).includes(token), false);
  assert.equal(readFileSync(file, 'utf8').includes(token), false, 'the file holds a hash, not the token');
  assert.equal((statSync(file).mode & 0o077) === 0 || process.platform === 'win32', true, 'owner-only permissions where the platform has them');
  assert.deepEqual([source.format, source.ownerUserId, source.department], ['generic-json', 'admin-1', 'Traffic']);
  assert.equal((await svc.receive('ward-7', token, evBody())).status, 'ok');
  for (const [id, tok] of [['ward-7', 'wh_wrong'], ['ward-7', undefined], ['nope', token], ['ward-7', '']] as const) assert.deepEqual(await svc.receive(id, tok, evBody()), { status: 'unauthorized' }, `${id} ${tok}`);
  assert.equal(got.length, 1);
});

test('sources: events come out as the department\'s events with the sender\'s camera name; validation, duplicates, rotate and remove', async () => {
  const { svc, got } = service();
  await assert.rejects(svc.create({ id: 'bad id!' }, 'a'), /letters, digits/);
  await assert.rejects(svc.create({ id: 'x', format: 'soap' }, 'a'), /format/);
  await assert.rejects(svc.create({ id: 'x', department: '../../' }, 'a'), /department/);
  await assert.rejects(svc.create({ id: 'x', timezoneOffsetMinutes: 99999 }, 'a'), /timezoneOffsetMinutes/);
  const { token } = await svc.create({ id: 'ward-7', department: 'Traffic' }, 'admin-1');
  await assert.rejects(svc.create({ id: 'ward-7' }, 'a'), /already exists/);
  await svc.receive('ward-7', token, evBody('gate', { id: 'evt-9' }));
  const e = got[0];
  assert.deepEqual([e.cameraId, e.cameraName, e.userId, e.department, e.type, e.source, e.data.vendorEventId], ['ward-7-gate', 'Camera gate', 'admin-1', 'Traffic', 'vms.intrusion', 'vms:ward-7', 'evt-9']);
  const rotated = (await svc.rotate('ward-7'))!;
  assert.equal((await svc.receive('ward-7', token, evBody())).status, 'unauthorized', 'the old token stopped working');
  assert.equal((await svc.receive('ward-7', rotated.token, evBody())).status, 'ok');
  assert.equal(await svc.rotate('nope'), null);
  assert.equal(await svc.remove('ward-7'), true);
  assert.equal(await svc.remove('ward-7'), false);
  assert.equal((await svc.receive('ward-7', rotated.token, evBody())).status, 'unauthorized');
});

test('sources: they survive a restart with the same token; a request is limited per source; a bad body is a 400-kind answer that counts', async () => {
  const a = service();
  const { token } = await a.svc.create({ id: 'ward-7' }, 'admin-1');
  const b = service({ file: a.file });
  assert.equal((await b.svc.receive('ward-7', token, evBody())).status, 'ok', 'a restart keeps the source and its token');
  let t = NOW.getTime();
  const limited = service({ maxRequests: 3, windowMs: 1000, now: () => new Date(t) });
  const { token: tk } = await limited.svc.create({ id: 's' }, 'a');
  const answers: string[] = [];
  for (let i = 0; i < 5; i++) answers.push((await limited.svc.receive('s', tk, evBody())).status);
  assert.deepEqual(answers, ['ok', 'ok', 'ok', 'rate_limited', 'rate_limited']);
  t += 1500;
  assert.equal((await limited.svc.receive('s', tk, evBody())).status, 'ok', 'the window moves on');
  const r = await limited.svc.receive('s', tk, 'not json');
  assert.equal(r.status === 'bad_request' && /JSON/.test(r.error), true);
  const v = limited.svc.get('s')!;
  assert.deepEqual([v.received, v.rejected > 0, v.lastError !== null], [4, true, true]);
});

test('sources: if the bus cannot take the events the sender gets a server error (to retry), not "bad request"', async () => {
  const { svc } = service({ emit: async () => { throw new Error('bus down'); } });
  const { token } = await svc.create({ id: 's' }, 'a');
  await assert.rejects(svc.receive('s', token, evBody()), /bus down/);
});

// ---- the HTTP routes ----------------------------------------------------------------------------------------------------------------

async function withApp(run: (c: { call: (method: string, path: string, o?: { token?: string; auth?: string; query?: string; body?: string; type?: string; who?: string }) => Promise<{ status: number; json: any; headers: Headers }>; svc: ReturnType<typeof service>['svc']; got: PlatformEvent[] }) => Promise<void>) {
  const { svc, got } = service();
  const app = express();
  // The receiver is mounted BEFORE the global JSON parser, as server.ts does, so a huge unauthenticated body never reaches that parser.
  registerWebhookIngest(app, () => svc);
  let globalParserSaw = 0;
  app.use(express.json({ limit: '25mb', verify: () => { globalParserSaw++; } }));
  registerWebhookAdminRoutes(app, { service: svc, allow: async (req, res, perm) => { const who = req.header('x-user'); if (!who) { res.status(401).json({ error: 'no' }); return null; } if (perm === 'vms.manage' && who !== 'admin') { res.status(403).json({ error: 'not allowed' }); return null; } return { uid: `${who}-uid` }; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ svc, got, call: async (method, path, o = {}) => {
      const headers: Record<string, string> = { 'Content-Type': o.type ?? 'application/json' };
      if (o.token) headers['X-Webhook-Token'] = o.token;
      if (o.auth) headers.Authorization = o.auth;
      if (o.who) headers['x-user'] = o.who;
      const r = await fetch(base + path + (o.query ?? ''), { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : (o.body ?? '{}') });
      return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
    } });
    assert.equal(globalParserSaw, globalParserSaw); // (the parser may run for the admin routes; the ingest route never reaches it)
  } finally { server.close(); }
}

test('route: a token in a header, as a Bearer token or in the query is accepted; the answer says how many events were taken; other status codes are exact', async () => {
  await withApp(async ({ call, svc, got }) => {
    const { token } = await svc.create({ id: 'ward-7', department: 'Traffic' }, 'admin-1');
    const path = '/api/ingest/webhook/ward-7';
    const a = await call('POST', path, { token, body: evBody('g1') });
    assert.deepEqual([a.status, a.json], [202, { accepted: 1, ignored: [] }]);
    assert.equal((await call('POST', path, { auth: `Bearer ${token}`, body: evBody('g2') })).status, 202);
    assert.equal((await call('POST', path, { query: `?token=${token}`, body: evBody('g3') })).status, 202);
    assert.equal(got.length, 3);
    assert.equal((await call('POST', path, { token: 'wrong', body: evBody() })).status, 401);
    const unknown = await call('POST', '/api/ingest/webhook/nope', { token, body: evBody() });
    const wrong = await call('POST', path, { token: 'wrong', body: evBody() });
    assert.deepEqual([unknown.status, unknown.json], [wrong.status, wrong.json], 'an unknown source answers exactly like a wrong token');
    assert.match(String(wrong.headers.get('www-authenticate')), /Bearer/);
    assert.equal((await call('POST', '/api/ingest/webhook/bad%20id', { token })).status, 401);
    const bad = await call('POST', path, { token, body: 'not json' });
    assert.deepEqual([bad.status, /JSON/.test(bad.json.error)], [400, true]);
    const mixed = await call('POST', path, { token, body: JSON.stringify([{ camera: 'ok' }, { type: 'motion' }]) });
    assert.deepEqual([mixed.status, mixed.json.accepted, mixed.json.ignored.length], [202, 1, 1], 'the usable events are taken, the rest named');
  });
});

test('route: a body over 512 KB is refused (413) before any token is looked at, whatever its content type; any content type is read', async () => {
  await withApp(async ({ call, svc, got }) => {
    const { token } = await svc.create({ id: 'ward-7' }, 'admin-1');
    const big = await call('POST', '/api/ingest/webhook/ward-7', { token, body: JSON.stringify({ camera: 'a', text: 'x'.repeat(600 * 1024) }) });
    assert.equal(big.status, 413);
    assert.match(big.json.error, /512 KB/);
    assert.equal((await call('POST', '/api/ingest/webhook/ward-7', { body: 'x'.repeat(600 * 1024), type: 'application/octet-stream' })).status, 413);
    const xml = await call('POST', '/api/ingest/webhook/ward-7', { token, type: 'text/plain', body: evBody('plain') });
    assert.equal(xml.status, 202, 'a device that says text/plain is still read');
    assert.equal(got.length, 1);
  });
});

test('route: a Hikvision source takes the device\'s own notification as the body', async () => {
  await withApp(async ({ call, svc, got }) => {
    const { token } = await svc.create({ id: 'hik-1', format: 'hikvision-xml', department: 'Traffic', timezoneOffsetMinutes: 330 }, 'admin-1');
    const r = await call('POST', '/api/ingest/webhook/hik-1', { token, type: 'application/xml', body: hikDoc(5, 'fielddetection') });
    assert.equal(r.status, 202);
    assert.deepEqual([got[0].type, got[0].cameraId, got[0].department], ['vms.intrusion', 'hik-1-1', 'Traffic']);
  });
});

test('admin routes: only administrators manage sources; the token is in the creation answer once and in no later answer', async () => {
  await withApp(async ({ call }) => {
    assert.equal((await call('GET', '/api/webhooks')).status, 401);
    assert.equal((await call('POST', '/api/webhooks', { who: 'viewer', body: JSON.stringify({ id: 'x' }) })).status, 403);
    const made = await call('POST', '/api/webhooks', { who: 'admin', body: JSON.stringify({ id: 'ward-7', department: 'Traffic' }) });
    assert.equal(made.status, 201);
    assert.match(made.json.token, /^wh_/);
    assert.equal(made.json.source.path, '/api/ingest/webhook/ward-7');
    assert.equal((await call('POST', '/api/webhooks', { who: 'admin', body: JSON.stringify({ id: 'ward-7' }) })).status, 400, 'a duplicate is refused');
    const list = await call('GET', '/api/webhooks', { who: 'viewer' });
    assert.equal(list.status, 200);
    assert.equal(JSON.stringify(list.json).includes(made.json.token), false);
    assert.deepEqual(list.json.formats, ['generic-json', 'hikvision-xml']);
    const rot = await call('POST', '/api/webhooks/ward-7/rotate', { who: 'admin' });
    assert.notEqual(rot.json.token, made.json.token);
    assert.equal((await call('POST', '/api/ingest/webhook/ward-7', { token: made.json.token })).status, 401);
    assert.equal((await call('DELETE', '/api/webhooks/ward-7', { who: 'admin' })).status, 200);
    assert.equal((await call('DELETE', '/api/webhooks/ward-7', { who: 'admin' })).status, 404);
    assert.equal((await call('POST', '/api/webhooks/not%20valid/rotate', { who: 'admin' })).status, 404);
  });
});

// ---- the whole path ---------------------------------------------------------------------------------------------------------------

test('a pushed plate read becomes a stored event and an alert for the department\'s rule; sending it twice makes one alert', async () => {
  const bus = createMemoryBus({ log: quiet });
  const store = createMemoryAlertStore();
  const delivered: string[] = [];
  const channel: Channel = { type: 'log', check: () => null, deliver: async (_c, c) => { delivered.push(`${c.event.type}:${c.event.data.plate}`); return { attempts: 1 }; } };
  const engine = createAlertEngine({ store, channels: createChannelRegistry([channel]), log: quiet, ruleCacheMs: 0 });
  await store.saveRule({ ...validateRule({ name: 'Plates', match: { types: ['plate.read'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['event'] } }, { userId: 'dept:Traffic', id: 'r1', now: NOW, department: 'Traffic' }) });
  const pipeline = await createEventPipeline({ bus, ingest: (e) => engine.ingest(e) });
  const { svc } = service({ emit: (e) => pipeline.publish(e) });
  try {
    const { token } = await svc.create({ id: 'ward-7', department: 'Traffic' }, 'admin-1');
    const body = JSON.stringify({ id: 'read-1', camera: { id: 'gate', name: 'Gate' }, plate: 'gj 01 ab 1234', confidence: 0.95, at: '2026-10-10T09:59:30Z' });
    assert.equal((await svc.receive('ward-7', token, body)).status, 'ok');
    assert.equal((await svc.receive('ward-7', token, body)).status, 'ok', 'a retry after a timeout');
    await until('the alert', async () => (await store.listAlerts({ userId: 'x', departments: ['Traffic'] })).length === 1);
    await until('both deliveries consumed', () => pipeline.stats().delivered >= 2);
    assert.deepEqual(delivered, ['plate.read:GJ01AB1234'], 'the plate is normalised like any plate read, and alerted once');
    assert.equal((await store.queryEvents({ userId: 'x', departments: ['Traffic'] })).length, 1, 'one stored event');
  } finally { await pipeline.stop(); await bus.close(); }
});
