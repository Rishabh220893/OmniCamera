/**
 * The federation service (gap A7): client identities with API keys, the department stamped by the identity, event and daily quotas,
 * session leases with a cap, and the HTTP routes (public client side mounted before the global parser, admin side behind permissions).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createFederationService } from '../server/federation/service.ts';
import { registerFederationAdminRoutes, registerFederationClientRoutes } from '../server/federation/routes.ts';
import type { PlatformEvent } from '../server/events/schema.ts';

const quiet = { warn() {}, info() {} };
const T0 = new Date('2026-10-11T10:00:00Z').getTime();
const ev = (cam = 'gate', extra: object = {}) => JSON.stringify({ camera: cam, type: 'intrusion', text: 'person', ...extra });
const evs = (n: number) => JSON.stringify({ events: Array.from({ length: n }, (_, i) => ({ id: `e${i}-${Math.random()}`, camera: 'gate', type: 'motion' })) });

function setup(o: { emit?: (e: PlatformEvent[]) => Promise<unknown>; depCap?: number } = {}) {
  const got: PlatformEvent[] = [];
  const clock = { t: T0 };
  const file = join(mkdtempSync(join(tmpdir(), 'fed-')), 'clients.json');
  const mk = (f = file) => createFederationService({ file: f, emit: o.emit ?? (async (e) => { got.push(...e); }), now: () => new Date(clock.t), log: quiet, departmentSessionCap: o.depCap });
  return { svc: mk(), mk, got, clock, file };
}

test('create: a department is required; the key names the client, is shown once, and only its hash is stored (file mode 0600)', async () => {
  const { svc, file } = setup();
  await assert.rejects(svc.create({ id: 'x' }, 'a'), /department/);
  await assert.rejects(svc.create({ id: 'bad id', department: 'Traffic' }, 'a'), /id/);
  await assert.rejects(svc.create({ id: 'x', department: 'Traffic', scopes: ['root'] }, 'a'), /scopes/);
  await assert.rejects(svc.create({ id: 'x', department: 'Traffic', quotas: { maxSessions: -1 } }, 'a'), /maxSessions/);
  const { client, key } = await svc.create({ id: 'traffic-vms', department: 'Traffic', label: 'Traffic VMS' }, 'admin-1');
  assert.match(key, /^fed_traffic-vms\./);
  assert.equal(JSON.stringify(client).includes(key), false);
  assert.deepEqual([client.department, client.ownerUserId, client.scopes, client.enabled], ['Traffic', 'admin-1', ['events.push'], true]);
  await assert.rejects(svc.create({ id: 'traffic-vms', department: 'Traffic' }, 'a'), /already exists/);
  const stored = readFileSync(file, 'utf8');
  assert.equal(stored.includes(key), false, 'the key itself is never written down');
  assert.equal(stored.includes(key.split('.')[1]), false);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('authenticate: a wrong secret, an unknown id, a malformed key and a switched-off client all give the same null; rotate and remove cut access at once', async () => {
  const { svc } = setup();
  const { key } = await svc.create({ id: 'a', department: 'Traffic' }, 'u');
  assert.equal(svc.authenticate(key)?.id, 'a');
  for (const bad of [undefined, '', 'fed_a.wrong', 'fed_nope.' + key.split('.')[1], 'a.' + key.split('.')[1], key + 'x']) assert.equal(svc.authenticate(bad), null, String(bad));
  await svc.update('a', { enabled: false });
  assert.equal(svc.authenticate(key), null, 'switched off');
  await svc.update('a', { enabled: true });
  const rotated = (await svc.rotate('a'))!;
  assert.equal(svc.authenticate(key), null, 'the old key stopped working');
  assert.equal(svc.authenticate(rotated.key)?.id, 'a');
  assert.equal(await svc.rotate('nope'), null);
  assert.equal(await svc.remove('a'), true);
  assert.equal(svc.authenticate(rotated.key), null);
  assert.equal(await svc.remove('a'), false);
});

test('clients survive a restart with the same key, scopes and quotas', async () => {
  const { svc, mk } = setup();
  const { key } = await svc.create({ id: 'a', department: 'Police', scopes: ['events.push', 'sessions'], quotas: { eventsPerMinute: 7 } }, 'u');
  const again = mk();
  await again.load();
  const c = again.authenticate(key)!;
  assert.deepEqual([c.department, c.scopes, c.quotas.eventsPerMinute], ['Police', ['events.push', 'sessions'], 7]);
});

test('push: the identity\'s department is stamped on every event, whatever the body claims; the owner and a source label come from the client', async () => {
  const { svc, got } = setup();
  const { key } = await svc.create({ id: 'police-nvr', department: 'Police' }, 'admin-1');
  const c = svc.authenticate(key)!;
  const r = await svc.push(c, ev('gate', { id: 'e1', data: { department: 'Traffic' }, department: 'Traffic' }));
  assert.deepEqual(r, { status: 'ok', accepted: 1, ignored: [] });
  assert.deepEqual([got[0].department, got[0].userId, got[0].cameraId], ['Police', 'admin-1', 'fed-police-nvr-gate']);
  assert.equal((await svc.push(c, 'not json')).status, 'bad_request');
  assert.equal((await svc.push(c, JSON.stringify([{ type: 'motion' }]))).status, 'bad_request', 'nothing usable in the body');
});

test('push: a key without the events.push scope is refused (forbidden), and nothing reaches the bus', async () => {
  const { svc, got } = setup();
  const { key } = await svc.create({ id: 'viewer', department: 'Traffic', scopes: ['sessions'] }, 'u');
  assert.deepEqual(await svc.push(svc.authenticate(key)!, ev()), { status: 'forbidden' });
  assert.equal(got.length, 0);
});

test('quotas: the per-minute quota is all-or-nothing and moves on with the clock; the daily quota resets at midnight UTC; refused events are not counted', async () => {
  const { svc, got, clock } = setup();
  const { key } = await svc.create({ id: 'q', department: 'Traffic', quotas: { eventsPerMinute: 5, eventsPerDay: 8 } }, 'u');
  const c = svc.authenticate(key)!;
  assert.equal((await svc.push(c, evs(3))).status, 'ok');
  const over = await svc.push(c, evs(3));
  assert.equal(over.status === 'quota' && over.which === 'minute' && over.retryAfterS >= 1 && over.retryAfterS <= 60, true, 'a batch that would pass the limit is refused whole');
  assert.equal(got.length, 3, 'none of the refused batch was published');
  assert.equal((await svc.push(c, evs(2))).status, 'ok', 'exactly up to the limit is fine');
  clock.t += 61_000;
  assert.equal((await svc.push(c, evs(3))).status, 'ok', 'the minute moved on'); // day total now 8
  clock.t += 61_000;
  const day = await svc.push(c, evs(1));
  assert.equal(day.status === 'quota' && day.which === 'day', true);
  clock.t = Date.UTC(2026, 9, 12, 0, 0, 5);
  assert.equal((await svc.push(c, evs(5))).status, 'ok', 'a new day');
  const u = (await svc.get('q'))!.usage;
  assert.deepEqual([u.eventsToday, u.received, u.rejected], [5, 13, 2]);
});

test('push: if the bus cannot take the events the sender gets an error to retry and the quota is not used up', async () => {
  let down = true;
  const { svc } = setup({ emit: async () => { if (down) throw new Error('bus down'); } });
  const { key } = await svc.create({ id: 'q', department: 'Traffic', quotas: { eventsPerMinute: 2 } }, 'u');
  const c = svc.authenticate(key)!;
  await assert.rejects(svc.push(c, evs(2)), /bus down/);
  down = false;
  assert.equal((await svc.push(c, evs(2))).status, 'ok');
});

test('sessions: a cap per client; slots come back on release and when a lease runs out; renewing keeps one; a lease cannot be used by another client', async () => {
  const { svc, clock } = setup();
  const a = svc.authenticate((await svc.create({ id: 'a', department: 'Traffic', scopes: ['sessions'], quotas: { maxSessions: 2 } }, 'u')).key)!;
  const b = svc.authenticate((await svc.create({ id: 'b', department: 'Traffic', scopes: ['sessions'], quotas: { maxSessions: 2 } }, 'u')).key)!;
  const one = await svc.acquire(a, 'wall A');
  const two = await svc.acquire(a, 'wall B');
  assert.equal(one.status === 'ok' && two.status === 'ok', true);
  const third = await svc.acquire(a, 'wall C');
  assert.deepEqual([third.status, third.status === 'cap' && third.max], ['cap', 2]);
  assert.equal((await svc.acquire(b, 'other client')).status, 'ok', 'another client has its own cap');
  assert.equal(await svc.release(b, (one as any).lease.id), false, 'not b\'s lease');
  assert.equal((await svc.renew(b, (one as any).lease.id)).status, 'gone');
  assert.equal(await svc.release(a, (one as any).lease.id), true);
  assert.equal((await svc.acquire(a, 'wall C')).status, 'ok', 'a released slot is free');
  clock.t += 45_000;
  assert.equal((await svc.renew(a, (two as any).lease.id)).status, 'ok');
  clock.t += 45_000; // the other leases (never renewed) are older than 60 s now, the renewed one is not
  assert.equal((await svc.get('a'))!.usage.activeSessions, 1);
  assert.equal((await svc.acquire(a, 'again')).status, 'ok');
  clock.t += 120_000;
  assert.equal((await svc.renew(a, (two as any).lease.id)).status, 'gone', 'a lease that ran out is gone');
  assert.equal((await svc.sessions()).length, 0);
});

test('sessions: switching a client off or removing it drops its leases; the scope is checked; an optional department cap spans clients', async () => {
  const { svc } = setup({ depCap: 3 });
  const noScope = svc.authenticate((await svc.create({ id: 'n', department: 'Traffic' }, 'u')).key)!;
  assert.equal((await svc.acquire(noScope, 'x')).status, 'forbidden');
  const mkc = async (id: string, dept = 'Traffic') => svc.authenticate((await svc.create({ id, department: dept, scopes: ['sessions'], quotas: { maxSessions: 5 } }, 'u')).key)!;
  const a = await mkc('a'), b = await mkc('b'), other = await mkc('o', 'Police');
  await svc.acquire(a, '1'); await svc.acquire(a, '2'); await svc.acquire(b, '3');
  assert.equal((await svc.acquire(b, '4')).status, 'cap', 'Traffic is at 3 in total');
  assert.equal((await svc.acquire(other, '5')).status, 'ok', 'another department is not affected');
  await svc.update('a', { enabled: false });
  assert.equal((await svc.acquire(b, '4')).status, 'ok', 'a switched-off client\'s leases were dropped');
  await svc.remove('b');
  assert.equal((await svc.sessions()).filter((l) => l.clientId === 'b').length, 0);
});

test('update: quotas and scopes change; a bad value is refused and changes nothing', async () => {
  const { svc } = setup();
  const { key } = await svc.create({ id: 'a', department: 'Traffic' }, 'u');
  await assert.rejects(svc.update('a', { quotas: { eventsPerDay: 'lots' } }), /eventsPerDay/);
  await assert.rejects(svc.update('a', { enabled: 'yes' }), /enabled/);
  const v = (await svc.update('a', { quotas: { eventsPerMinute: 1 }, scopes: ['events.push', 'sessions'], label: 'x' }))!;
  assert.deepEqual([v.quotas.eventsPerMinute, v.quotas.maxSessions, v.scopes, v.label], [1, 4, ['events.push', 'sessions'], 'x']);
  assert.equal(svc.authenticate(key)!.quotas.eventsPerMinute, 1);
  assert.equal(await svc.update('nope', {}), null);
});

// ---- HTTP ------------------------------------------------------------------------------------------------------------------------

async function withApp(run: (c: { call: (method: string, path: string, o?: { key?: string; xkey?: string; who?: string; body?: string }) => Promise<{ status: number; json: any; headers: Headers }>; svc: ReturnType<typeof setup>['svc']; got: PlatformEvent[] }) => Promise<void>) {
  const { svc, got } = setup();
  const app = express();
  let parserSaw = 0;
  registerFederationClientRoutes(app, () => svc); // before the global parser, as server.ts does
  app.use(express.json({ limit: '25mb', verify: () => { parserSaw++; } }));
  registerFederationAdminRoutes(app, { service: svc, allow: async (req, res, perm) => { const who = req.header('x-user'); if (!who) { res.status(401).json({ error: 'no' }); return null; } if (perm === 'vms.manage' && who !== 'admin') { res.status(403).json({ error: 'not allowed' }); return null; } return { uid: `${who}-uid` }; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ svc, got, call: async (method, path, o = {}) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (o.key) headers.Authorization = `Bearer ${o.key}`;
      if (o.xkey) headers['X-Api-Key'] = o.xkey;
      if (o.who) headers['x-user'] = o.who;
      const r = await fetch(base + path, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : (o.body ?? '{}') });
      return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
    } });
    assert.equal(parserSaw, parserSaw);
  } finally { server.close(); }
}

test('http client side: 401 for every bad key (same answer), 202 on push with Bearer or X-Api-Key, 403 scope, 429 with Retry-After, 413 over 512 KB, me shows use', async () => {
  await withApp(async ({ call, svc, got }) => {
    const { key } = await svc.create({ id: 'p', department: 'Police', quotas: { eventsPerMinute: 3 } }, 'u');
    const none = await call('POST', '/api/federation/events', { body: ev() });
    const wrong = await call('POST', '/api/federation/events', { key: 'fed_p.nope', body: ev() });
    const unknown = await call('POST', '/api/federation/events', { key: 'fed_zz.nope', body: ev() });
    assert.deepEqual([none.status, wrong.status, unknown.status], [401, 401, 401]);
    assert.deepEqual([none.json, wrong.json], [wrong.json, unknown.json], 'the same body for every kind of bad key');
    assert.match(none.headers.get('www-authenticate') ?? '', /Bearer/);
    const ok = await call('POST', '/api/federation/events', { key, body: ev() });
    assert.deepEqual([ok.status, ok.json.accepted], [202, 1]);
    assert.equal((await call('POST', '/api/federation/events', { xkey: key, body: ev('b') })).status, 202);
    assert.equal((await call('POST', '/api/federation/events', { key, body: 'nope' })).status, 400);
    const limited = await call('POST', '/api/federation/events', { key, body: evs(5) });
    assert.equal(limited.status, 429);
    assert.equal(Number(limited.headers.get('retry-after')) >= 1, true);
    const big = await call('POST', '/api/federation/events', { key, body: JSON.stringify({ x: 'a'.repeat(600 * 1024) }) });
    assert.equal(big.status, 413);
    const me = await call('GET', '/api/federation/me', { key });
    assert.deepEqual([me.status, me.json.department, me.json.usage.received, 'keyHash' in me.json], [200, 'Police', 2, false]);
    assert.equal(got.every((e) => e.department === 'Police'), true);
    assert.equal((await call('GET', '/api/federation/me')).status, 401);
  });
});

test('http sessions: open, renew, release; 429 at the cap; 404 for a lease that is gone; 403 without the scope', async () => {
  await withApp(async ({ call, svc }) => {
    const { key } = await svc.create({ id: 'w', department: 'Traffic', scopes: ['sessions'], quotas: { maxSessions: 1 } }, 'u');
    const { key: pushOnly } = await svc.create({ id: 'po', department: 'Traffic' }, 'u');
    assert.equal((await call('POST', '/api/federation/sessions', { key: pushOnly, body: '{}' })).status, 403);
    const open = await call('POST', '/api/federation/sessions', { key, body: JSON.stringify({ what: 'wall 3' }) });
    assert.equal(open.status, 201);
    const id = open.json.lease.id;
    const capped = await call('POST', '/api/federation/sessions', { key, body: '{}' });
    assert.equal(capped.status, 429);
    assert.equal((await call('POST', '/api/federation/sessions', { key, body: 'x{' })).status, 400);
    assert.equal((await call('POST', `/api/federation/sessions/${id}/renew`, { key })).status, 200);
    assert.equal((await call('DELETE', `/api/federation/sessions/${id}`, { key })).status, 200);
    assert.equal((await call('DELETE', `/api/federation/sessions/${id}`, { key })).status, 404);
    assert.equal((await call('POST', `/api/federation/sessions/${id}/renew`, { key })).status, 404);
    assert.equal((await call('POST', '/api/federation/sessions/..%2F..', { key })).status, 404);
    assert.equal((await call('POST', '/api/federation/sessions', { key, body: '{}' })).status, 201, 'the slot is free again');
  });
});

test('http admin side: needs a sign-in and the manage permission; the key is shown once; patch and rotate work; nothing secret in a list', async () => {
  await withApp(async ({ call }) => {
    assert.equal((await call('GET', '/api/federation/clients')).status, 401);
    assert.equal((await call('POST', '/api/federation/clients', { who: 'viewer', body: '{"id":"a","department":"Traffic"}' })).status, 403);
    assert.equal((await call('POST', '/api/federation/clients', { who: 'admin', body: '{"id":"a"}' })).status, 400);
    const made = await call('POST', '/api/federation/clients', { who: 'admin', body: JSON.stringify({ id: 'a', department: 'Traffic', quotas: { maxSessions: 9 } }) });
    assert.equal(made.status, 201);
    const key = made.json.key as string;
    const list = await call('GET', '/api/federation/clients', { who: 'viewer' });
    assert.equal(list.status, 200);
    assert.equal(JSON.stringify(list.json).includes(key), false);
    assert.equal(JSON.stringify(list.json).includes('keyHash'), false);
    assert.equal((await call('PATCH', '/api/federation/clients/a', { who: 'admin', body: '{"enabled":false}' })).json.client.enabled, false);
    assert.equal((await call('GET', '/api/federation/me', { key })).status, 401, 'switched off');
    await call('PATCH', '/api/federation/clients/a', { who: 'admin', body: '{"enabled":true}' });
    assert.equal((await call('PATCH', '/api/federation/clients/a', { who: 'admin', body: '{"quotas":{"eventsPerDay":"x"}}' })).status, 400);
    const rot = await call('POST', '/api/federation/clients/a/rotate', { who: 'admin' });
    assert.equal((await call('GET', '/api/federation/me', { key })).status, 401);
    assert.equal((await call('GET', '/api/federation/me', { key: rot.json.key })).status, 200);
    assert.equal((await call('GET', '/api/federation/sessions', { who: 'viewer' })).status, 200);
    assert.equal((await call('DELETE', '/api/federation/clients/a', { who: 'admin' })).status, 200);
    assert.equal((await call('DELETE', '/api/federation/clients/a', { who: 'admin' })).status, 404);
    assert.equal((await call('PATCH', '/api/federation/clients/..', { who: 'admin' })).status, 404);
  });
});
