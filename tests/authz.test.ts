import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ALL, PERMISSIONS, can, claimsFor, coversDepartment, decide, principalFromClaims, visibleTo, type Principal } from '../server/authz/policy.ts';
import { bearerToken, createAuthz, createBatchedLog, createRingLog, type AccessLogEntry, type AuthzDeps } from '../server/authz/authz.ts';
import { registerEventRoutes } from '../server/events/routes.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, createLogChannel } from '../server/events/channels.ts';

const P = (role: Principal['role'], departments: string[] = [ALL]): Principal => ({ uid: 'u', role, departments, source: 'claims' });

// ---- policy ----------------------------------------------------------------------------------------------------------

test('roles: viewer only looks, operator also works, admin may do everything', () => {
  const viewer = new Set(PERMISSIONS.filter((p) => can(P('viewer'), p)));
  assert.deepEqual([...viewer].sort(), ['alert.view', 'camera.view', 'event.view', 'rule.view']);
  for (const p of ['alert.handle', 'rule.manage', 'tracking.run', 'camera.edit'] as const) assert.ok(can(P('operator'), p), p);
  for (const p of ['camera.delete', 'camera.assign-gateway', 'gateway.manage', 'profile.change', 'adapter.use', 'audit.read', 'user.manage'] as const) {
    assert.ok(!can(P('operator'), p), `operator must not ${p}`);
    assert.ok(can(P('admin'), p), p);
  }
  assert.ok(PERMISSIONS.every((p) => can(P('admin'), p)));
});

test('departments: a resource is reachable only inside the principal\'s departments; one with none is admin-wide only', () => {
  const traffic = P('operator', ['traffic']);
  assert.ok(can(traffic, 'camera.edit', { department: 'traffic' }));
  assert.deepEqual(decide(traffic, 'camera.edit', { department: 'water' }), { allowed: false, reason: 'department' });
  assert.deepEqual(decide(traffic, 'camera.edit', { department: undefined }), { allowed: false, reason: 'department' });
  assert.ok(can(traffic, 'camera.edit'), 'no resource named: only the role is checked');
  assert.ok(can(P('operator'), 'camera.edit', { department: 'anything' }));
  assert.ok(can(P('operator'), 'camera.edit', { department: undefined }));
  assert.ok(!coversDepartment(P('operator', []), 'traffic'));
  // The role is checked first, so the reason is the role, not the department.
  assert.deepEqual(decide(P('viewer', ['traffic']), 'camera.delete', { department: 'water' }), { allowed: false, reason: 'role' });
});

test('a department-limited admin still runs the platform (gateways, adapters) but cannot touch another department\'s cameras', () => {
  const a = P('admin', ['traffic']);
  assert.ok(can(a, 'gateway.manage'));
  assert.ok(can(a, 'adapter.use'));
  assert.ok(can(a, 'camera.delete', { department: 'traffic' }));
  assert.ok(!can(a, 'camera.delete', { department: 'water' }));
});

test('visibleTo keeps only the principal\'s departments', () => {
  const items = [{ id: 1, department: 'traffic' }, { id: 2, department: 'water' }, { id: 3 }, { id: 4, department: null }];
  assert.deepEqual(visibleTo(P('operator', ['traffic']), items).map((i) => i.id), [1]);
  assert.deepEqual(visibleTo(P('operator', ['traffic', 'water']), items).map((i) => i.id), [1, 2]);
  assert.equal(visibleTo(P('admin'), items).length, 4);
  assert.deepEqual(visibleTo(P('viewer', []), items), []);
});

test('claims: only a valid role counts; bad departments are dropped; an admin with none covers all', () => {
  assert.equal(principalFromClaims('u', undefined), null);
  assert.equal(principalFromClaims('u', { role: 'root' }), null);
  assert.equal(principalFromClaims('u', { role: 'ADMIN' }), null);
  assert.equal(principalFromClaims('u', { role: ['admin'] }), null);
  assert.deepEqual(principalFromClaims('u', { role: 'admin' }), { uid: 'u', role: 'admin', departments: [ALL], source: 'claims' });
  assert.deepEqual(principalFromClaims('u', { role: 'operator', departments: ['traffic', 7, '', null, 'water'] })?.departments, ['traffic', 'water']);
  assert.deepEqual(principalFromClaims('u', { role: 'operator', departments: 'traffic' })?.departments, [], 'a string is not a list');
  assert.deepEqual(principalFromClaims('u', { role: 'viewer' })?.departments, []);
  assert.equal(principalFromClaims('u', { role: 'operator', departments: Array.from({ length: 500 }, (_, i) => `d${i}`) })?.departments.length, 50);
});

test('claimsFor validates what is about to be stored', () => {
  assert.deepEqual(claimsFor('admin', []), { role: 'admin', departments: [ALL] });
  assert.deepEqual(claimsFor('operator', ['traffic', ' traffic ', 'water']), { role: 'operator', departments: ['traffic', 'water'] });
  assert.throws(() => claimsFor('boss', []), /viewer, operator or admin/);
  assert.throws(() => claimsFor('operator', ['*']), /Only an admin/);
  assert.throws(() => claimsFor('operator', ['a/b<script>']), /not allowed/);
  assert.deepEqual(claimsFor('viewer', []), { role: 'viewer', departments: [] });
});

// ---- identity from a request -------------------------------------------------------------------------------------------

test('bearerToken: exactly "Bearer <token>"; anything else is no token', () => {
  const h = (v?: string) => ({ header: () => v });
  assert.equal(bearerToken(h('Bearer abc.def')), 'abc.def');
  assert.equal(bearerToken(h('bearer   abc ')), 'abc');
  for (const v of [undefined, '', 'Bearer', 'Bearer ', 'abc', 'Basic abc', 'Bearer a b']) assert.equal(bearerToken(h(v)), '', String(v));
});

type Accounts = Record<string, { claims?: Record<string, unknown>; doc?: { role?: unknown; department?: unknown } }>;
function harness(accounts: Accounts, over: Partial<AuthzDeps> = {}) {
  const ring = createRingLog(100);
  const warnings: string[] = [];
  const authz = createAuthz({
    verify: async (t) => { const a = accounts[t]; if (!a) throw new Error('bad token'); return { uid: t, claims: a.claims ?? {} }; },
    legacyProfile: async (uid) => accounts[uid]?.doc,
    log: ring, warn: (m) => warnings.push(m), now: () => new Date('2026-10-10T00:00:00Z'),
    ...over,
  });
  return { authz, ring, warnings };
}
async function serve(authz: ReturnType<typeof createAuthz>, run: (call: (token: string | null, path: string, method?: string) => Promise<{ status: number; json: any }>) => Promise<void>) {
  const app = express();
  app.get('/x/:perm', async (req, res) => {
    const p = await authz.require(req, res, req.params.perm as never, req.query.dept ? { department: String(req.query.dept) } : undefined);
    if (p) res.json({ uid: p.uid, role: p.role, source: p.source, departments: p.departments });
  });
  app.post('/x/:perm', async (req, res) => { const p = await authz.require(req, res, req.params.perm as never); if (p) res.json({ ok: true }); });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (token, path, method = 'GET') => {
      const r = await fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
      return { status: r.status, json: await r.json() };
    });
  } finally { server.close(); }
}

test('requests: no token and a bad token are 401; claims decide the role; a refusal is 403 with the reason and is logged', async () => {
  const { authz, ring } = harness({
    boss: { claims: { role: 'admin' } },
    ops: { claims: { role: 'operator', departments: ['traffic'] } },
    eye: { claims: { role: 'viewer' } },
  }, { legacyProfile: undefined });
  await serve(authz, async (call) => {
    assert.equal((await call(null, '/x/camera.view')).status, 401);
    assert.equal((await call('forged', '/x/camera.view')).status, 401);
    assert.equal((await call('boss', '/x/gateway.manage')).status, 200);
    assert.equal((await call('ops', '/x/gateway.manage')).status, 403);
    assert.match((await call('ops', '/x/gateway.manage')).json.error, /Only an admin/);
    assert.equal((await call('eye', '/x/alert.handle', 'POST')).status, 403);
    assert.equal((await call('ops', '/x/camera.edit?dept=traffic')).status, 200);
    const other = await call('ops', '/x/camera.edit?dept=water');
    assert.equal(other.status, 403);
    assert.match(other.json.error, /department you do not work for/);
  });
  const entries = ring.recent(100);
  assert.ok(entries.some((e) => e.uid === 'ops' && e.permission === 'gateway.manage' && !e.allowed && e.reason === 'role'));
  assert.ok(entries.some((e) => e.uid === 'ops' && e.permission === 'camera.edit' && !e.allowed && e.reason === 'department' && e.department === 'water'));
  assert.ok(entries.some((e) => e.permission === 'sign-in' && e.reason === 'no token'));
  assert.ok(entries.some((e) => e.permission === 'sign-in' && e.reason === 'token not verified'));
  assert.ok(entries.some((e) => e.uid === 'boss' && e.permission === 'gateway.manage' && e.allowed), 'a sensitive use is logged even when allowed');
  assert.ok(!entries.some((e) => e.permission === 'camera.view'), 'ordinary allowed reads are not logged');
});

test('a viewer-claimed account cannot be raised by its own user document (the self-set role is ignored once claims exist)', async () => {
  const { authz } = harness({ eve: { claims: { role: 'viewer' }, doc: { role: 'admin' } } });
  await serve(authz, async (call) => {
    assert.equal((await call('eve', '/x/gateway.manage')).status, 403);
    assert.equal((await call('eve', '/x/event.view')).json.source, 'claims');
  });
});

test('legacy fallback: no claim -> the old self-set role, with a warning once per account; it is switched off by leaving legacyProfile out', async () => {
  const accounts: Accounts = { old: { doc: { role: 'admin' } }, plain: { doc: {} }, dept: { doc: { role: 'operator', department: 'traffic' } }, none: {}, odd: { doc: { role: 'superuser' } } };
  const { authz, warnings } = harness(accounts);
  await serve(authz, async (call) => {
    assert.equal((await call('old', '/x/gateway.manage')).status, 200);
    assert.equal((await call('old', '/x/gateway.manage')).json.source, 'legacy');
    const plain = await call('plain', '/x/rule.manage');
    assert.deepEqual([plain.status, plain.json.role, plain.json.departments], [200, 'operator', [ALL]]);
    assert.equal((await call('plain', '/x/gateway.manage')).status, 403);
    assert.deepEqual((await call('dept', '/x/camera.view')).json.departments, ['traffic']);
    assert.equal((await call('none', '/x/tracking.run')).status, 200, 'no document at all behaves as it did before: a signed-in operator');
    assert.equal((await call('odd', '/x/gateway.manage')).status, 403, 'an unknown role value is never an admin');
  });
  assert.equal(warnings.filter((w) => w.includes('old')).length, 1);

  const strict = harness(accounts, { legacyProfile: undefined });
  await serve(strict.authz, async (call) => {
    const r = await call('old', '/x/event.view');
    assert.deepEqual([r.status, r.json.role, r.json.source], [200, 'viewer', 'default']);
    assert.equal((await call('old', '/x/gateway.manage')).status, 403);
    assert.equal((await call('old', '/x/tracking.run')).status, 403, 'without a role, an account can only look');
  });
});

test('a failing profile lookup does not lock an account in as admin: it falls back to the least it can be', async () => {
  const { authz } = harness({ x: {} }, { legacyProfile: async () => { throw new Error('firestore down'); } });
  await serve(authz, async (call) => {
    assert.equal((await call('x', '/x/gateway.manage')).status, 403);
  });
});

test('guest mode (local demo) is an admin named demo; not configured is 401 even with a token', async () => {
  await serve(harness({}, { allowGuests: true }).authz, async (call) => {
    const r = await call(null, '/x/gateway.manage');
    assert.deepEqual([r.status, r.json.uid, r.json.source], [200, 'demo', 'guest']);
  });
  await serve(harness({ a: { claims: { role: 'admin' } } }, { ready: () => false }).authz, async (call) => {
    assert.equal((await call('a', '/x/gateway.manage')).status, 401);
  });
});

test('a log that throws never breaks the request', async () => {
  const { authz } = harness({ a: { claims: { role: 'viewer' } } }, { log: { record: () => { throw new Error('disk full'); } } });
  await serve(authz, async (call) => { assert.equal((await call('a', '/x/gateway.manage')).status, 403); });
});

// ---- the event routes honour it -------------------------------------------------------------------------------------------

test('event routes: a viewer reads but cannot change rules or handle alerts; an operator can; nobody signed-out gets in', async () => {
  const { authz } = harness({ eye: { claims: { role: 'viewer' } }, ops: { claims: { role: 'operator' } } });
  const store = createMemoryAlertStore();
  const channels = createChannelRegistry([createLogChannel()]);
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, { store, engine: createAlertEngine({ store, channels }), channels, requireUser: async (req, res, perm) => (await authz.require(req, res, perm))?.uid ?? null });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.status;
  };
  try {
    assert.equal(await call('eye', 'GET', '/api/events'), 200);
    assert.equal(await call('eye', 'GET', '/api/alerts'), 200);
    assert.equal(await call('eye', 'GET', '/api/alert-rules'), 200);
    assert.equal(await call('eye', 'POST', '/api/alert-rules', { name: 'x' }), 403);
    assert.equal(await call('eye', 'DELETE', '/api/alert-rules/abc'), 403);
    assert.equal(await call('eye', 'POST', '/api/alerts/abc/acknowledge'), 403);
    assert.equal(await call('eye', 'POST', '/api/alerts/abc/resolve'), 403);
    assert.equal(await call('ops', 'POST', '/api/alerts/abc/acknowledge'), 404, 'allowed, then simply not found');
    assert.equal(await call('ops', 'POST', '/api/alert-rules', { name: '' }), 400, 'allowed, then rejected as invalid');
    assert.equal(await call(null, 'GET', '/api/events'), 401);
    assert.equal(await call('forged', 'GET', '/api/alerts'), 401);
  } finally { server.close(); }
});

// ---- the access log ---------------------------------------------------------------------------------------------------------

const entry = (n: number, over: Partial<AccessLogEntry> = {}): AccessLogEntry => ({ at: String(n), uid: 'u', role: 'viewer', source: 'claims', permission: 'camera.view', allowed: true, method: 'GET', path: '/', ...over });

test('ring log keeps the newest, newest first, filtered; counts what fell off', () => {
  const log = createRingLog(3);
  for (let i = 1; i <= 5; i++) log.record(entry(i, { uid: i % 2 ? 'a' : 'b', allowed: i !== 4 }));
  assert.deepEqual(log.recent().map((e) => e.at), ['5', '4', '3']);
  assert.equal(log.dropped, 2);
  assert.deepEqual(log.recent(10, { uid: 'a' }).map((e) => e.at), ['5', '3']);
  assert.deepEqual(log.recent(10, { allowed: false }).map((e) => e.at), ['4']);
});

test('batched log: writes in batches, retries after a failure without losing or doubling, and bounds its queue', async () => {
  const written: string[][] = [];
  let failNext = 0;
  const log = createBatchedLog(async (batch) => { if (failNext > 0) { failNext--; throw new Error('db down'); } written.push(batch.map((e) => e.at)); }, { flushMs: 60_000, maxBatch: 2, maxQueue: 5 });
  try {
    for (let i = 1; i <= 5; i++) log.record(entry(i));
    await log.flush();
    assert.deepEqual(written, [['1', '2'], ['3', '4'], ['5']]);

    failNext = 1;
    log.record(entry(6)); log.record(entry(7));
    await log.flush();
    assert.equal(log.failures, 1);
    assert.equal(written.length, 3, 'nothing written while down');
    await log.flush();
    assert.deepEqual(written.slice(3), [['6', '7']], 'sent once after recovery');

    failNext = 99;
    for (let i = 10; i < 20; i++) log.record(entry(i));
    assert.equal(log.dropped, 5, 'the oldest five were dropped, and counted');
    failNext = 0;
    await log.flush();
    assert.deepEqual(written.slice(4).flat(), ['15', '16', '17', '18', '19']);
  } finally { await log.stop(); }
});
