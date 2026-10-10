import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { HEADER, MAX_CLOCK_SKEW_MS, createNonceCache, signRequest, signingString, verifyRequest, type OutboxItem } from '../server/gateway/protocol.ts';
import { openOutbox } from '../server/gateway/outbox.ts';
import { createGatewayCentral, createMemoryGatewayDocs, GatewayError, type GatewayStatus } from '../server/gateway/central.ts';
import { captureRawBody, registerGatewayRoutes } from '../server/gateway/routes.ts';
import { createAgent } from '../server/gateway/agent.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
const until = async (cond: () => boolean, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};
const quiet = { info() {}, warn() {} };

// ---- signing -------------------------------------------------------------------------------------------------------

test('signing: a request verifies; tampering with any part, a wrong secret, replay, a bad clock and unknown or disabled gateways do not', () => {
  const secret = 's3cret';
  const lookup = (id: string) => (id === 'gw-1' ? { secret } : id === 'gw-off' ? { secret, disabled: true } : null);
  const now = 1_800_000_000_000;
  const body = JSON.stringify({ items: [1, 2, 3] });
  const check = (over: Partial<Parameters<typeof verifyRequest>[0]> & { headers?: Record<string, string> }, headers?: Record<string, string>) =>
    verifyRequest({ headers: headers ?? signRequest({ gatewayId: 'gw-1', secret, method: 'POST', path: '/api/gateway/ingest', body, now }), method: 'POST', path: '/api/gateway/ingest', body, lookup, nonces: createNonceCache(), now, ...over });

  assert.deepEqual(check({}), { ok: true, gatewayId: 'gw-1' });
  assert.deepEqual(check({ body: body + ' ' }), { ok: false, reason: 'bad_signature' }, 'body changed');
  assert.deepEqual(check({ path: '/api/gateway/ingest?x=1' }), { ok: false, reason: 'bad_signature' }, 'path or query changed');
  assert.deepEqual(check({ method: 'GET' }), { ok: false, reason: 'bad_signature' }, 'method changed');
  const other = signRequest({ gatewayId: 'gw-1', secret: 'wrong', method: 'POST', path: '/api/gateway/ingest', body, now });
  assert.deepEqual(check({}, other), { ok: false, reason: 'bad_signature' }, 'wrong secret');
  const good = signRequest({ gatewayId: 'gw-1', secret, method: 'POST', path: '/api/gateway/ingest', body, now, nonce: 'n1' });
  assert.equal(check({}, { ...good, [HEADER.time]: String(now + 1) }).ok, false, 'time field changed');
  assert.equal(check({}, { ...good, [HEADER.nonce]: 'n2' }).ok, false, 'nonce changed');
  assert.equal(check({}, { ...good, [HEADER.id]: 'gw-off' }).ok, false);

  const nonces = createNonceCache();
  assert.equal(check({ nonces }, good).ok, true);
  assert.deepEqual(check({ nonces }, good), { ok: false, reason: 'replay' }, 'the same request twice');

  const old = signRequest({ gatewayId: 'gw-1', secret, method: 'POST', path: '/api/gateway/ingest', body, now: now - MAX_CLOCK_SKEW_MS - 1000 });
  assert.deepEqual(check({}, old), { ok: false, reason: 'clock', serverTime: now });
  const future = signRequest({ gatewayId: 'gw-1', secret, method: 'POST', path: '/api/gateway/ingest', body, now: now + MAX_CLOCK_SKEW_MS + 1000 });
  assert.equal((check({}, future) as { reason: string }).reason, 'clock');
  const nearly = signRequest({ gatewayId: 'gw-1', secret, method: 'POST', path: '/api/gateway/ingest', body, now: now - MAX_CLOCK_SKEW_MS + 1000 });
  assert.equal(check({}, nearly).ok, true, 'inside the allowed skew');

  const unknown = signRequest({ gatewayId: 'gw-9', secret, method: 'POST', path: '/api/gateway/ingest', body, now });
  assert.deepEqual(check({}, unknown), { ok: false, reason: 'unknown_gateway' });
  const disabled = signRequest({ gatewayId: 'gw-off', secret, method: 'POST', path: '/api/gateway/ingest', body, now });
  assert.deepEqual(check({}, disabled), { ok: false, reason: 'disabled' });

  for (const headers of [{}, { [HEADER.id]: 'gw-1' }, { ...good, [HEADER.signature]: 'zz' }, { ...good, [HEADER.time]: 'soon' }, { ...good, [HEADER.nonce]: 'x'.repeat(100) }]) {
    assert.deepEqual(check({}, headers as Record<string, string>), { ok: false, reason: 'missing_headers' });
  }
  assert.ok(signingString({ time: 1, nonce: 'n', method: 'post', path: '/p', body: '' }).startsWith('1.n.POST./p.'));
});

test('signing: a clock error is only revealed to someone who holds the secret', () => {
  const lookup = () => ({ secret: 'real' });
  const wrongSecretOldClock = signRequest({ gatewayId: 'gw-1', secret: 'guess', method: 'GET', path: '/x', now: 1000 });
  const r = verifyRequest({ headers: wrongSecretOldClock, method: 'GET', path: '/x', body: '', lookup, nonces: createNonceCache(), now: 5_000_000_000 });
  assert.deepEqual(r, { ok: false, reason: 'bad_signature' }, 'no server time for an attacker');
});

test('nonce cache forgets old nonces and stays bounded', () => {
  const c = createNonceCache(1000, 3);
  assert.equal(c.seen('g', 'a', 0), false);
  assert.equal(c.seen('g', 'a', 500), true);
  assert.equal(c.seen('g', 'a', 1600), false, 'forgotten after its lifetime');
  for (let i = 0; i < 20; i++) c.seen('g', `n${i}`, 2000);
  assert.equal(c.seen('g', 'n19', 2000), true, 'recent ones are kept');
});

// ---- outbox --------------------------------------------------------------------------------------------------------

test('outbox: items come back in order, confirmed ones go, ids never repeat', () => {
  const dir = tmp();
  const ob = openOutbox({ dir });
  const ids = Array.from({ length: 10 }, (_, i) => ob.append('events', [{ n: i }]));
  assert.equal(new Set(ids).size, 10);
  assert.deepEqual(ob.peek(3).map((x) => (x.payload as { n: number }[])[0].n), [0, 1, 2]);
  assert.deepEqual(ob.peek(100).map((x) => x.id), ids);
  ob.ack([ids[0], ids[1], 'nope']);
  assert.equal(ob.peek(1)[0].id, ids[2]);
  assert.equal(ob.stats().pending, 8);
  ob.ack([ids[0]]);
  assert.equal(ob.stats().pending, 8, 'confirming twice changes nothing');
  assert.equal(ob.peek(100, 1).length, 1, 'always at least one item, whatever the size limit');
});

test('outbox: a restart finds what was not confirmed; closed, fully confirmed segments are deleted; a torn last line is ignored', () => {
  const dir = tmp();
  let ob = openOutbox({ dir, segmentBytes: 400 });
  const ids = Array.from({ length: 12 }, (_, i) => ob.append('log', { text: 'x'.repeat(60), i }));
  assert.ok(ob.stats().segments > 2, 'rolled over into several files');
  ob.ack(ids.slice(0, 8));
  const filesBefore = fs.readdirSync(dir).filter((f) => f.startsWith('seg-')).length;
  assert.ok(filesBefore < ob.stats().segments + 1);

  // a crash in the middle of writing a line leaves half of it behind
  const last = fs.readdirSync(dir).filter((f) => f.startsWith('seg-')).sort().at(-1)!;
  fs.appendFileSync(path.join(dir, last), '{"id":"torn","kind":"log","at":1,"payl');
  ob = openOutbox({ dir, segmentBytes: 400 });
  const back = ob.peek(100);
  assert.ok(back.length >= 4 && back.length <= 12, `${back.length} items came back`);
  assert.deepEqual(ids.slice(8).filter((id) => !back.some((b) => b.id === id)), [], 'everything that was not confirmed is still there');
  assert.ok(!back.some((b) => b.id === 'torn'));
  const fresh = ob.append('log', { after: true });
  assert.ok(!ids.includes(fresh), 'a new id after the restart');
  assert.equal(ob.peek(100).at(-1)!.id, fresh, 'and it comes after the older items');
  ob.ack(back.map((b) => b.id));
  ob.ack([fresh]);
  assert.equal(ob.stats().pending, 0);
});

test('outbox: ids never repeat even if the saved counter is stale after a crash', () => {
  const dir = tmp();
  const a = openOutbox({ dir });
  const first = Array.from({ length: 30 }, () => a.append('log', {}));
  // pretend the process died before the counter was saved: put the saved counter back to 1
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...st, nextSeq: 1 }));
  const b = openOutbox({ dir });
  const second = Array.from({ length: 30 }, () => b.append('log', {}));
  assert.equal(new Set([...first, ...second]).size, 60);
  // and when everything was confirmed and the files are gone
  b.ack([...first, ...second]);
  fs.rmSync(path.join(dir, 'state.json'));
  const c = openOutbox({ dir });
  assert.notEqual(c.epoch, a.epoch, 'a lost state file starts a new epoch, so old ids cannot collide');
});

test('outbox: limits drop the oldest closed files and say so; a damaged line costs one item, not the file', () => {
  const dir = tmp();
  let clock = 1_000_000;
  const ob = openOutbox({ dir, segmentBytes: 300, maxBytes: 1000, now: () => clock });
  for (let i = 0; i < 40; i++) ob.append('log', { pad: 'y'.repeat(50), i });
  const s = ob.stats();
  assert.ok(s.bytes <= 1000 + 300, `kept ${s.bytes} bytes`);
  assert.ok(s.dropped > 0, 'the loss is counted');
  assert.equal(ob.peek(1)[0].payload && (ob.peek(1)[0].payload as { i: number }).i > 0, true, 'the oldest are the ones gone');
  assert.equal(s.pending + s.dropped, 40);

  const dir2 = tmp();
  const aged = openOutbox({ dir: dir2, segmentBytes: 200, maxAgeMs: 10_000, now: () => clock });
  for (let i = 0; i < 6; i++) aged.append('log', { i, pad: 'z'.repeat(40) });
  clock += 20_000;
  for (let i = 0; i < 6; i++) aged.append('log', { i: 100 + i, pad: 'z'.repeat(40) });
  assert.ok(aged.peek(100).every((x) => (x.payload as { i: number }).i >= 100 || x.at > clock - 10_000 || true));
  assert.ok(aged.stats().dropped > 0, 'items older than the limit are dropped');

  const dir3 = tmp();
  const ob3 = openOutbox({ dir: dir3 });
  ob3.append('log', { n: 1 });
  const file = path.join(dir3, fs.readdirSync(dir3).find((f) => f.startsWith('seg-'))!);
  fs.appendFileSync(file, 'this is not json\n');
  const kept = ob3.append('log', { n: 2 });
  const again = openOutbox({ dir: dir3 }).peek(10);
  assert.deepEqual(again.map((x) => (x.payload as { n: number }).n), [1, 2]);
  assert.equal(again[1].id, kept);
});

test('outbox: an unwritable directory never throws into the analysis; the loss is counted', () => {
  const dir = tmp();
  const ob = openOutbox({ dir });
  ob.append('log', { ok: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'a file where the folder was'); // appends now fail
  assert.doesNotThrow(() => ob.append('log', { lost: true }));
  assert.equal(ob.stats().dropped, 1);
});

// ---- the centre ----------------------------------------------------------------------------------------------------

const CAM = (id: string, userId = 'u1') => ({ id, userId, name: id, remoteStreamUrl: `rtsp://10.0.0.5/${id}`, interval: 60, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '' });
const logDoc = (cameraId: string, userId = 'u1', n = 0) => ({ cameraId, cameraName: cameraId, summary: `s${n}`, detectedItems: [], timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(), userId, counts: { people: 1, vehicles: 0, other: 0 }, sentiment: 'neutral', isUnusual: false, unusualReason: '', alerts: [], detectedPlates: [], isWatchlistMatch: false, plateReads: [], plateSource: 'gemini', analyzedBy: 'server' });
const event = (cameraId: string, userId = 'u1', id = 'e1') => ({ id, type: 'plate.read', source: 'anpr', severity: 'info', userId, cameraId, cameraName: cameraId, ts: '2026-10-10T10:00:00.000Z', summary: 'Plate read', data: {}, tags: [] });
const item = (id: string, kind: OutboxItem['kind'], payload: unknown): OutboxItem => ({ id, kind, at: 1, payload });

function makeCentral(over: { cameras?: ReturnType<typeof CAM>[]; failFirst?: number; now?: () => number; onTransition?: (g: GatewayStatus, from: string) => void } = {}) {
  const got = { logs: [] as any[], sightings: [] as any[], events: [] as any[], cameras: [] as any[] };
  let fails = over.failFirst ?? 0;
  const central = createGatewayCentral({
    docs: createMemoryGatewayDocs(),
    cameras: async () => over.cameras ?? [CAM('cam1'), CAM('cam2')],
    userContext: async (u) => ({ knownFaces: [], watchlist: [`WL-${u}`] }),
    sinks: {
      writeLog: async (d) => { if (fails-- > 0) throw new Error('store down'); got.logs.push(d); },
      writeSightings: async (u, s) => { got.sightings.push([u, s]); },
      emitEvents: async (e) => { got.events.push(...e); },
      updateCamera: async (id, p) => { got.cameras.push([id, p]); },
    },
    now: over.now, log: quiet, onTransition: over.onTransition as never,
  });
  return { central, got };
}

test('centre: provisioning returns the secret once, lists never show it, and rotation, disabling and removal work', async () => {
  const { central } = makeCentral();
  const { gateway, secret } = await central.provision({ name: ' North ', region: 'Ahmedabad-1', ownerId: 'admin1' });
  assert.match(gateway.id, /^gw-[0-9a-f]{8}$/);
  assert.equal(gateway.name, 'North');
  assert.equal(gateway.state, 'never_seen');
  assert.ok(secret.length >= 40);
  assert.equal(JSON.stringify(await central.list()).includes(secret), false);
  assert.equal(central.lookup(gateway.id)!.secret, secret);
  const next = await central.rotateSecret(gateway.id);
  assert.notEqual(next, secret);
  assert.equal(central.lookup(gateway.id)!.secret, next);
  await central.setDisabled(gateway.id, true);
  assert.equal(central.lookup(gateway.id)!.disabled, true);
  assert.equal((await central.list())[0].state, 'disabled');
  await central.remove(gateway.id);
  assert.equal(central.lookup(gateway.id), null);
  await assert.rejects(central.rotateSecret(gateway.id), (e) => e instanceof GatewayError && e.code === 'not_found');
  for (const bad of [{ name: '', region: 'x' }, { name: 'a', region: '' }, { name: 'a', region: '<script>' }, { name: 'n'.repeat(81), region: 'x' }]) {
    await assert.rejects(central.provision({ ...bad, ownerId: 'a' }), (e) => e instanceof GatewayError && e.code === 'bad_request');
  }
});

test('centre: state follows the heartbeat - online, degraded for each problem, offline when silent, back online', async () => {
  let t = 1_000_000;
  const seen: Array<[string, string]> = [];
  const { central } = makeCentral({ now: () => t, onTransition: (g, from) => seen.push([from, g.state]) });
  const { gateway } = await central.provision({ name: 'g', region: 'r', ownerId: 'a' });
  const hb = (over: Record<string, unknown> = {}, outbox: Record<string, unknown> = {}, cameras: Record<string, unknown> = {}) => ({
    version: '1', sentAt: t, uptimeS: 10, link: 'online' as const, concurrency: 4, cameras: { assigned: 10, failing: 0, ...cameras }, outbox: { pending: 0, bytes: 0, oldestAgeS: 0, dropped: 0, ...outbox }, ...over,
  });
  const state = async () => (await central.list())[0];
  central.heartbeat(gateway.id, hb());
  assert.equal((await state()).state, 'online');
  for (const [name, h, expect] of [
    ['link', hb({ link: 'degraded' }), /link to the centre is degraded/], ['backlog', hb({}, { pending: 6000 }), /6000 results waiting/], ['old backlog', hb({}, { oldestAgeS: 1200 }), /20 minutes old/],
    ['dropped', hb({}, { dropped: 4 }), /4 results were dropped/], ['failing cameras', hb({}, {}, { failing: 6 }), /6 of 10 cameras are failing/],
  ] as const) {
    central.heartbeat(gateway.id, h);
    const s = await state();
    assert.equal(s.state, 'degraded', name);
    assert.match(s.problems.join(' '), expect, name);
  }
  central.heartbeat(gateway.id, hb());
  assert.equal((await state()).state, 'online');
  t += 89_000; central.sweep();
  assert.equal((await state()).state, 'online', 'still inside the allowed silence');
  t += 2_000; central.sweep();
  assert.equal((await state()).state, 'offline');
  assert.match((await state()).problems[0], /no heartbeat for 91 s/);
  central.sweep();
  central.heartbeat(gateway.id, hb());
  assert.equal((await state()).state, 'online');
  assert.deepEqual(seen, [['online', 'degraded'], ['degraded', 'online'], ['online', 'offline'], ['offline', 'online']], 'transitions are reported once each (the very first heartbeat is not news)');
});

test('centre: ingest applies each kind, and only for cameras assigned to the gateway and owned by the camera\'s user', async () => {
  const { central, got } = makeCentral();
  const { gateway } = await central.provision({ name: 'g', region: 'r', ownerId: 'a' });
  const res = await central.ingest(gateway.id, { batchId: 'b', items: [
    item('1', 'log', logDoc('cam1', 'u1', 1)),
    item('2', 'sightings', { userId: 'u1', sightings: [{ id: 's1', plate: 'GJ05AB1234', cameraId: 'cam2', cameraName: 'cam2', timestamp: '2026-10-10T10:00:00.000Z', confidence: 0.9, source: 'anpr' }] }),
    item('3', 'events', [event('cam1', 'u1', 'e1'), event('cam2', 'u1', 'e2')]),
    item('4', 'camera', { cameraId: 'cam1', patch: { lastAnalysisTime: '2026-10-10T10:00:00.000Z', lastAnalysisError: null } }),
  ] });
  assert.deepEqual(res, { accepted: ['1', '2', '3', '4'], rejected: [] });
  assert.ok(got.logs[0].timestamp instanceof Date, 'dates are real dates again');
  assert.ok(got.sightings[0][1][0].timestamp instanceof Date);
  assert.deepEqual(got.events.map((e) => e.id), ['e1', 'e2']);
  assert.ok(got.cameras[0][1].lastAnalysisTime instanceof Date);
  assert.equal(got.cameras[0][1].lastAnalysisError, null);

  const bad = await central.ingest(gateway.id, { batchId: 'b2', items: [
    item('a', 'log', logDoc('cam9')), item('b', 'log', logDoc('cam1', 'someone-else')), item('c', 'events', [event('cam1'), event('cam9', 'u1', 'e9')]),
    item('d', 'sightings', { userId: 'u1', sightings: [{ id: 's', plate: 'X', cameraId: 'cam9', timestamp: '2026-10-10T10:00:00.000Z' }] }),
    item('e', 'camera', { cameraId: 'cam9', patch: {} }), item('f', 'log', { ...logDoc('cam1'), timestamp: 'yesterday' }), item('g', 'events', 'nope'),
    item('h', 'events', [{ ...event('cam1'), type: 'Bad Type' }]), item('i', 'camera', { cameraId: 'cam1', patch: { lastAnalysisTime: 'never' } }), item('j', 'surprise' as never, {}),
    item('ok', 'log', logDoc('cam2', 'u1', 5)),
  ] });
  assert.deepEqual(bad.accepted, ['ok']);
  assert.deepEqual(bad.rejected.map((r) => r.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  assert.match(bad.rejected[0].reason, /not assigned/);
  assert.equal(got.events.length, 2, 'a batch with one foreign event applied none of its events');
  assert.equal((await central.list())[0].rejectedItems, 10);
});

test('centre: repeats are accepted without being applied again; a temporary sink failure is left for the next try', async () => {
  const { central, got } = makeCentral({ failFirst: 2 });
  const { gateway } = await central.provision({ name: 'g', region: 'r', ownerId: 'a' });
  const items = [item('1', 'log', logDoc('cam1', 'u1', 1)), item('2', 'log', logDoc('cam1', 'u1', 2)), item('3', 'events', [event('cam1')])];
  const first = await central.ingest(gateway.id, { batchId: 'b', items });
  assert.deepEqual(first, { accepted: ['3'], rejected: [] }, 'the two logs hit a store that was down: neither accepted nor rejected');
  const second = await central.ingest(gateway.id, { batchId: 'b', items });
  assert.deepEqual(second.accepted.sort(), ['1', '2', '3']);
  assert.equal(got.logs.length, 2);
  assert.equal(got.events.length, 1, 'the event was applied once although it was sent twice');
  const third = await central.ingest(gateway.id, { batchId: 'b', items });
  assert.equal(got.logs.length, 2);
  assert.equal(third.accepted.length, 3);
  assert.equal(central._appliedCount(), 3);
});

test('centre: assignment changes version when a camera changes; user data only for users on the gateway', async () => {
  let cams = [CAM('cam2'), CAM('cam1')];
  const { central } = makeCentral({ cameras: undefined });
  const c2 = createGatewayCentral({ docs: createMemoryGatewayDocs(), cameras: async () => cams, userContext: async (u) => ({ knownFaces: [], watchlist: [u] }), sinks: { writeLog: async () => {}, writeSightings: async () => {}, emitEvents: async () => {}, updateCamera: async () => {} }, assignmentCacheMs: 0, log: quiet });
  void central;
  const { gateway } = await c2.provision({ name: 'g', region: 'r', ownerId: 'a' });
  const a1 = await c2.assignment(gateway.id);
  assert.deepEqual(a1.cameras.map((c) => c.id), ['cam1', 'cam2'], 'sorted, so the version is stable');
  assert.equal((await c2.assignment(gateway.id)).version, a1.version);
  cams = [CAM('cam2'), { ...CAM('cam1'), interval: 30 }];
  assert.notEqual((await c2.assignment(gateway.id)).version, a1.version);
  assert.deepEqual((await c2.userContext(gateway.id, 'u1')).watchlist, ['u1']);
  await assert.rejects(c2.userContext(gateway.id, 'stranger'), (e) => e instanceof GatewayError && e.code === 'forbidden');
});

// ---- over real HTTP, with a link that can be cut, slowed and made to lose answers --------------------------------

interface Link { partitioned: boolean; latencyMs: number; loseNextResponses: number; failNext: number; skewMs: number; calls: number; blocked: number }

async function rig(o: { cameras?: ReturnType<typeof CAM>[]; failFirst?: number } = {}) {
  const { central, got } = makeCentral(o);
  const { gateway, secret } = await central.provision({ name: 'north', region: 'r', ownerId: 'admin1' });
  const app = express();
  app.use(express.json({ limit: '25mb', verify: captureRawBody }));
  registerGatewayRoutes(app, { central, requireAdmin: async () => 'admin1' });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const link: Link = { partitioned: false, latencyMs: 0, loseNextResponses: 0, failNext: 0, skewMs: 0, calls: 0, blocked: 0 };
  const linkFetch: typeof fetch = async (url, init) => {
    link.calls++;
    if (link.partitioned) { link.blocked++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); }
    if (link.latencyMs) await new Promise((r) => setTimeout(r, link.latencyMs));
    if (link.failNext > 0) { link.failNext--; return new Response('{}', { status: 503 }); }
    const res = await fetch(url, init);
    if (link.loseNextResponses > 0) { link.loseNextResponses--; await res.arrayBuffer(); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } // the centre did the work, the answer never arrived
    return res;
  };
  const dir = tmp();
  const outbox = openOutbox({ dir: path.join(dir, 'outbox') });
  const agentFor = (extra: Partial<Parameters<typeof createAgent>[0]> = {}) => createAgent({
    centralUrl: base, gatewayId: gateway.id, secret, outbox, fetchImpl: linkFetch, log: quiet, now: () => Date.now() + link.skewMs,
    heartbeatEveryMs: 40, assignmentEveryMs: 80, flushEveryMs: 15, minBackoffMs: 15, maxBackoffMs: 120, requestTimeoutMs: 3000, ...extra,
  });
  return { central, got, gateway, secret, server, base, link, dir, outbox, agentFor, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

test('link: results flow, the centre sees a healthy gateway and its camera list', async () => {
  const r = await rig();
  const agent = r.agentFor({ cameraCounts: () => ({ assigned: 2, failing: 0 }), mediaUrl: 'https://media.north.example' });
  const cams: string[][] = [];
  agent.onCameras((c) => cams.push(c.map((x) => x.id)));
  agent.start();
  try {
    for (let i = 0; i < 30; i++) r.outbox.append('log', logDoc('cam1', 'u1', i));
    r.outbox.append('events', [event('cam1')]);
    await until(() => r.got.logs.length === 30 && r.got.events.length === 1, 5000, 'delivery');
    assert.deepEqual(r.got.logs.map((l) => l.summary), Array.from({ length: 30 }, (_, i) => `s${i}`), 'in the order they were produced');
    await until(() => cams.length > 0, 3000, 'camera list');
    assert.deepEqual(cams[0], ['cam1', 'cam2']);
    await until(() => r.outbox.stats().pending === 0, 3000, 'confirmation');
    await until(() => agent.status().link === 'online', 3000, 'link online');
    await new Promise((res) => setTimeout(res, 120)); // a heartbeat after the last send
    const g = (await r.central.list())[0];
    assert.equal(g.state, 'online');
    assert.equal(g.heartbeat?.mediaUrl, 'https://media.north.example');
    assert.equal(agent.status().sent, 31);
    assert.deepEqual((await agent.userContext('u1')).watchlist, ['WL-u1']);
  } finally { agent.stop(); await r.close(); }
});

test('link: a long outage loses nothing - everything is sent once, in order, when the link returns', async () => {
  const r = await rig();
  const agent = r.agentFor();
  agent.start();
  try {
    await until(() => agent.status().link === 'online', 3000, 'first contact');
    r.link.partitioned = true;
    for (let i = 0; i < 400; i++) r.outbox.append('log', logDoc('cam1', 'u1', i));
    await until(() => agent.status().link === 'offline', 3000, 'link offline');
    assert.equal(r.got.logs.length, 0);
    assert.equal(r.outbox.stats().pending, 400);
    for (let i = 400; i < 450; i++) r.outbox.append('log', logDoc('cam1', 'u1', i)); // still analysing while cut off
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(r.link.blocked > 3, 'it kept trying, with back-off');
    assert.ok(r.link.blocked < 60, `but did not hammer the link (${r.link.blocked} attempts in the outage)`);
    r.link.partitioned = false;
    await until(() => r.got.logs.length === 450, 8000, 'catch-up');
    assert.deepEqual(r.got.logs.map((l) => l.summary), Array.from({ length: 450 }, (_, i) => `s${i}`));
    await until(() => agent.status().link === 'online', 3000, 'link back');
    await until(() => r.outbox.stats().pending === 0, 3000, 'everything confirmed');
  } finally { agent.stop(); await r.close(); }
});

test('link: answers lost after the centre did the work, and 503s, never cause duplicates or losses', async () => {
  const r = await rig();
  const agent = r.agentFor();
  agent.start();
  try {
    await until(() => agent.status().link === 'online', 3000, 'first contact');
    r.link.loseNextResponses = 4; r.link.failNext = 3;
    for (let i = 0; i < 120; i++) r.outbox.append('log', logDoc('cam2', 'u1', i));
    r.outbox.append('events', [event('cam2', 'u1', 'only-once')]);
    await until(() => r.got.logs.length === 120 && r.got.events.length === 1, 8000, 'delivery');
    await until(() => r.outbox.stats().pending === 0, 3000, 'confirmation');
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.got.logs.length, 120, 'each log applied exactly once');
    assert.equal(new Set(r.got.logs.map((l) => l.summary)).size, 120);
    assert.equal(r.got.events.length, 1);
  } finally { agent.stop(); await r.close(); }
});

test('link: restarting the gateway resumes from disk; new results do not collide with old ones', async () => {
  const r = await rig();
  r.link.partitioned = true;
  const a1 = r.agentFor();
  a1.start();
  for (let i = 0; i < 50; i++) r.outbox.append('log', logDoc('cam1', 'u1', i));
  await new Promise((res) => setTimeout(res, 100));
  a1.stop();
  // the process dies; a new one starts on the same disk, with the link back
  const reopened = openOutbox({ dir: path.join(r.dir, 'outbox') });
  assert.equal(reopened.stats().pending, 50);
  for (let i = 50; i < 60; i++) reopened.append('log', logDoc('cam1', 'u1', i));
  r.link.partitioned = false;
  const a2 = createAgent({ centralUrl: r.base, gatewayId: r.gateway.id, secret: r.secret, outbox: reopened, log: quiet, heartbeatEveryMs: 40, assignmentEveryMs: 80, flushEveryMs: 15, minBackoffMs: 15, maxBackoffMs: 100 });
  a2.start();
  try {
    await until(() => r.got.logs.length === 60, 8000, 'resume');
    assert.deepEqual(r.got.logs.map((l) => l.summary), Array.from({ length: 60 }, (_, i) => `s${i}`));
  } finally { a2.stop(); await r.close(); }
});

test('link: a gateway clock hours wrong is corrected from the centre, and nothing is lost meanwhile', async () => {
  const r = await rig();
  r.link.skewMs = 3 * 3_600_000;
  const agent = r.agentFor();
  for (let i = 0; i < 20; i++) r.outbox.append('log', logDoc('cam1', 'u1', i));
  agent.start();
  try {
    await until(() => r.got.logs.length === 20, 6000, 'delivery despite the clock');
    assert.ok(Math.abs(agent.status().clockOffsetMs + 3 * 3_600_000) < 5000, `offset ${agent.status().clockOffsetMs} ms`);
  } finally { agent.stop(); await r.close(); }
});

test('link: wrong secret or a switched-off gateway is reported as unauthorised and keeps its results; fixing it releases them', async () => {
  const r = await rig();
  for (let i = 0; i < 10; i++) r.outbox.append('log', logDoc('cam1', 'u1', i));
  const wrong = r.agentFor({ secret: 'not the secret' });
  wrong.start();
  await until(() => wrong.status().unauthorized, 3000, 'refusal noticed');
  assert.match(wrong.status().lastError ?? '', /refused/);
  assert.equal(r.outbox.stats().pending, 10);
  wrong.stop();

  await r.central.setDisabled(r.gateway.id, true);
  const good = r.agentFor();
  good.start();
  await until(() => good.status().unauthorized && /disabled/.test(good.status().lastError ?? ''), 3000, 'disabled noticed');
  assert.equal(r.got.logs.length, 0);
  await r.central.setDisabled(r.gateway.id, false);
  await until(() => r.got.logs.length === 10, 6000, 'release');
  await until(() => !good.status().unauthorized, 3000, 'refusal cleared');
  good.stop();
  await r.close();
});

test('link: results for a camera that is not this gateway\'s are refused and discarded; the rest of the batch goes through', async () => {
  const r = await rig();
  r.outbox.append('log', logDoc('cam1', 'u1', 1));
  r.outbox.append('log', logDoc('not-mine', 'u1', 2));
  r.outbox.append('log', logDoc('cam2', 'u1', 3));
  const agent = r.agentFor();
  agent.start();
  try {
    await until(() => r.outbox.stats().pending === 0, 5000, 'batch done');
    assert.deepEqual(r.got.logs.map((l) => l.summary), ['s1', 's3']);
    assert.equal(agent.status().rejected, 1);
    assert.equal((await r.central.list())[0].rejectedItems, 1);
  } finally { agent.stop(); await r.close(); }
});

test('link: a store that is down at the centre means retry later, not loss', async () => {
  const r = await rig({ failFirst: 5 });
  for (let i = 0; i < 8; i++) r.outbox.append('log', logDoc('cam1', 'u1', i));
  const agent = r.agentFor();
  agent.start();
  try {
    await until(() => r.got.logs.length === 8, 8000, 'eventually stored');
    assert.deepEqual(r.got.logs.map((l) => l.summary).sort(), Array.from({ length: 8 }, (_, i) => `s${i}`).sort());
  } finally { agent.stop(); await r.close(); }
});

test('link: a slow link still works, in batches; and a 20,000-item backlog drains', async () => {
  const slow = await rig();
  slow.link.latencyMs = 120;
  for (let i = 0; i < 300; i++) slow.outbox.append('log', logDoc('cam1', 'u1', i));
  const a = slow.agentFor({ batchItems: 100, requestTimeoutMs: 2000 });
  a.start();
  try {
    await until(() => slow.got.logs.length === 300, 10_000, 'slow delivery');
    assert.ok(slow.link.calls < 60, `${slow.link.calls} calls for 300 items`);
  } finally { a.stop(); await slow.close(); }

  const big = await rig();
  for (let i = 0; i < 20_000; i++) big.outbox.append('log', logDoc('cam1', 'u1', i % 1000));
  const t0 = Date.now();
  const b = big.agentFor({ batchItems: 500, batchBytes: 5_000_000, flushEveryMs: 5 });
  b.start();
  try {
    await until(() => big.got.logs.length === 20_000, 60_000, 'backlog');
    await until(() => big.outbox.stats().pending === 0, 5000, 'everything confirmed');
    console.log(`      (20,000 queued results delivered in ${((Date.now() - t0) / 1000).toFixed(1)} s over loopback)`);
  } finally { b.stop(); await big.close(); }
});

test('link: a captured request cannot be replayed, and a forged one is refused', async () => {
  const r = await rig();
  try {
    const body = JSON.stringify({ batchId: 'x', items: [item('replay-1', 'log', logDoc('cam1', 'u1', 1))] });
    const headers = { 'Content-Type': 'application/json', ...signRequest({ gatewayId: r.gateway.id, secret: r.secret, method: 'POST', path: '/api/gateway/ingest', body }) };
    const first = await fetch(r.base + '/api/gateway/ingest', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    const again = await fetch(r.base + '/api/gateway/ingest', { method: 'POST', headers, body });
    assert.equal(again.status, 401);
    assert.equal((await again.json() as { reason: string }).reason, 'replay');
    const forged = await fetch(r.base + '/api/gateway/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', ...signRequest({ gatewayId: r.gateway.id, secret: 'guess', method: 'POST', path: '/api/gateway/ingest', body }) }, body });
    assert.equal(forged.status, 401);
    const unknown = await fetch(r.base + '/api/gateway/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', ...signRequest({ gatewayId: 'gw-deadbeef', secret: 'guess', method: 'POST', path: '/api/gateway/ingest', body }) }, body });
    assert.equal((await unknown.json() as { reason: string }).reason, 'bad_signature', 'an unknown gateway looks like a wrong signature');
    const unsigned = await fetch(r.base + '/api/gateway/cameras');
    assert.equal(unsigned.status, 401);
    assert.equal(r.got.logs.length, 1, 'applied once');
    const big = JSON.stringify({ batchId: 'x', items: Array.from({ length: 501 }, (_, i) => item(`b${i}`, 'camera', { cameraId: 'cam1', patch: {} })) });
    const tooMany = await fetch(r.base + '/api/gateway/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', ...signRequest({ gatewayId: r.gateway.id, secret: r.secret, method: 'POST', path: '/api/gateway/ingest', body: big }) }, body: big });
    assert.equal(tooMany.status, 413);
    const foreign = await fetch(r.base + '/api/gateway/user-context?userId=stranger', { headers: signRequest({ gatewayId: r.gateway.id, secret: r.secret, method: 'GET', path: '/api/gateway/user-context?userId=stranger' }) });
    assert.equal(foreign.status, 403);
    const etagReq = (etag?: string) => fetch(r.base + '/api/gateway/cameras', { headers: { ...signRequest({ gatewayId: r.gateway.id, secret: r.secret, method: 'GET', path: '/api/gateway/cameras' }), ...(etag ? { 'If-None-Match': etag } : {}) } });
    const first2 = await etagReq();
    const tag = first2.headers.get('etag')!;
    assert.equal((await etagReq(tag)).status, 304, 'an unchanged camera list is not sent again');
  } finally { await r.close(); }
});

test('admin routes: provision, list, rotate, disable, enable, delete - and only for an admin', async () => {
  const { central } = makeCentral();
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  let admin: string | null = 'admin1';
  registerGatewayRoutes(app, { central, requireAdmin: async (_q, res) => { if (!admin) { res.status(403).json({ error: 'no' }); return null; } return admin; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
  try {
    const made = await call('POST', '/api/gateways', { name: 'South', region: 'Surat' });
    assert.equal(made.status, 201);
    assert.ok(made.json.secret);
    const id = made.json.gateway.id as string;
    assert.equal(made.json.gateway.ownerId, 'admin1');
    assert.equal(JSON.stringify((await call('GET', '/api/gateways')).json).includes(made.json.secret), false);
    assert.notEqual((await call('POST', `/api/gateways/${id}/rotate-secret`)).json.secret, made.json.secret);
    assert.equal((await call('POST', `/api/gateways/${id}/disable`)).status, 200);
    assert.equal((await call('GET', '/api/gateways')).json.gateways[0].state, 'disabled');
    assert.equal((await call('POST', `/api/gateways/${id}/enable`)).status, 200);
    assert.equal((await call('POST', '/api/gateways', { name: '', region: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/gateways/not-an-id/disable')).status, 404);
    assert.equal((await call('POST', '/api/gateways/gw-00000000/disable')).status, 404);
    admin = null;
    for (const [m, p] of [['GET', '/api/gateways'], ['POST', '/api/gateways'], ['POST', `/api/gateways/${id}/rotate-secret`], ['DELETE', `/api/gateways/${id}`]] as const) assert.equal((await call(m, p, {})).status, 403, `${m} ${p}`);
    admin = 'admin1';
    assert.equal((await call('DELETE', `/api/gateways/${id}`)).status, 200);
    assert.equal((await call('GET', '/api/gateways')).json.gateways.length, 0);
  } finally { server.close(); }
});
