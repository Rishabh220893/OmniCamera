import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { emailToUsername, normaliseUsername, passwordProblem, usernameToEmail } from '../src/lib/username.ts';
import { DirectoryError, checkDepartmentName, checkNewUser, createMemoryDirectory, type MemoryDirectory } from '../server/admin/directory.ts';
import { registerAdminRoutes } from '../server/admin/routes.ts';
import { registerEventRoutes } from '../server/events/routes.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, type Channel } from '../server/events/channels.ts';
import { makeEvent, type PlatformEvent } from '../server/events/schema.ts';
import { validateRule } from '../server/events/rules.ts';
import { claimsFor } from '../server/authz/policy.ts';

// ---- usernames -----------------------------------------------------------------------------------------------------------

test('usernames: typed any way, stored one way, mapped to the account e-mail and back', () => {
  assert.equal(normaliseUsername('  Rakesh.M  '), 'rakesh.m');
  assert.equal(usernameToEmail('rakesh.m'), 'rakesh.m@omnisee.local');
  assert.equal(emailToUsername('Rakesh.M@omnisee.local'), 'rakesh.m');
  assert.equal(emailToUsername('someone@gmail.com'), null, 'a Google account is not a username account');
  assert.equal(emailToUsername(null), null);
  for (const bad of ['', 'ab', 'a b', '-lead', '.lead', 'a'.repeat(33), 'name@host', 'name/x', 'नाम', 'a\nb']) assert.equal(normaliseUsername(bad), null, JSON.stringify(bad));
  for (const ok of ['abc', 'a1.b-c_d', 'x'.repeat(32), '9lives']) assert.equal(normaliseUsername(ok), ok);
  assert.equal(passwordProblem('12345678'), null);
  assert.match(passwordProblem('short') ?? '', /at least 8/);
  assert.match(passwordProblem('x'.repeat(129)) ?? '', /at most 128/);
  assert.match(passwordProblem(undefined) ?? '', /required/);
  assert.equal(passwordProblem(' spaces  allowed '), null);
});

// ---- the directory ---------------------------------------------------------------------------------------------------------

const err = async (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e) => e instanceof DirectoryError && e.code === code && (!re || re.test(e.message)), `expected ${code}`);

test('department names are validated; user bodies need a username, a password and (except admins) a department', () => {
  assert.equal(checkDepartmentName('  Traffic   Police '), 'Traffic Police');
  for (const bad of ['', ' ', '.hidden', 'a/b', 'x'.repeat(61), 'name<script>', undefined, 5]) assert.throws(() => checkDepartmentName(bad), DirectoryError, String(bad));
  assert.deepEqual(checkNewUser({ username: 'Ann', password: 'password1', departmentId: 'Traffic' }), { username: 'ann', password: 'password1', role: 'operator', departmentId: 'Traffic' });
  assert.deepEqual(checkNewUser({ username: 'boss', password: 'password1', role: 'admin', departmentId: 'Traffic' }).departmentId, null, 'an admin covers every department');
  for (const bad of [null, {}, { username: 'ann' }, { username: 'ann', password: 'short', departmentId: 'T' }, { username: 'ann', password: 'password1' }, { username: 'ann', password: 'password1', role: 'root', departmentId: 'T' }, { username: 'a b', password: 'password1', departmentId: 'T' }]) {
    assert.throws(() => checkNewUser(bad), DirectoryError, JSON.stringify(bad));
  }
});

test('directory: departments and users; duplicates, missing departments and in-use departments are refused', async () => {
  const d = createMemoryDirectory();
  const traffic = await d.createDepartment('Traffic', 'root');
  await err(d.createDepartment('traffic', 'root'), 'conflict');
  await err(d.createUser({ username: 'ann', password: 'password1', role: 'operator', departmentId: 'Nowhere' }, 'root'), 'invalid', /no department/);
  const ann = await d.createUser({ username: 'ann', password: 'password1', role: 'operator', departmentId: traffic.id }, 'root');
  assert.deepEqual([ann.role, ann.departmentId, ann.disabled], ['operator', 'Traffic', false]);
  assert.ok(!JSON.stringify(ann).includes('password1'));
  await err(d.createUser({ username: 'ann', password: 'password2', role: 'viewer', departmentId: traffic.id }, 'root'), 'conflict', /taken/);
  assert.deepEqual((await d.listDepartments())[0], { ...traffic, users: 1, cameras: 0 });
  await err(d.deleteDepartment('Traffic'), 'conflict', /1 user/);
  await d.deleteUser(ann.uid);
  await d.deleteDepartment('Traffic');
  await err(d.deleteDepartment('Traffic'), 'not_found');
  await err(d.deleteUser('nope'), 'not_found');
});

test('directory: changing role and department, password reset, disabling; an admin needs no department, everyone else does', async () => {
  const d = createMemoryDirectory();
  await d.createDepartment('Traffic', 'root'); await d.createDepartment('Water', 'root');
  const u = await d.createUser({ username: 'ann', password: 'password1', role: 'operator', departmentId: 'Traffic' }, 'root');
  assert.deepEqual(d.claimsOf(u.uid), { role: 'operator', departments: ['Traffic'] });
  assert.equal((await d.updateUser(u.uid, { departmentId: 'Water' })).departmentId, 'Water');
  await d.updateUser(u.uid, { password: 'newpassword' });
  assert.equal(d.passwordOf('ann'), 'newpassword');
  assert.equal((await d.updateUser(u.uid, { disabled: true })).disabled, true);
  const admin = await d.updateUser(u.uid, { role: 'admin' });
  assert.deepEqual([admin.role, admin.departmentId], ['admin', null]);
  assert.deepEqual(d.claimsOf(u.uid), { role: 'admin', departments: ['*'] });
  await err(d.updateUser(u.uid, { role: 'operator' }), 'invalid', /department/);
  await err(d.updateUser(u.uid, { role: 'operator', departmentId: 'Ghost' }), 'invalid');
  await err(d.updateUser('nope', { disabled: true }), 'not_found');
  // the same claims the real directory stores
  assert.deepEqual(claimsFor('operator', ['Traffic']), { role: 'operator', departments: ['Traffic'] });
});

test('directory: cameras are given to a department and taken back; unknown ids are reported, not fatal', async () => {
  const d = createMemoryDirectory();
  await d.createDepartment('Traffic', 'root');
  for (const id of ['c1', 'c2', 'c3']) d.addCamera({ id, name: `Cam ${id}`, ownerUserId: 'demo-admin', departmentId: null });
  assert.deepEqual(await d.allotCameras(['c1', 'c2', 'zz', 'c1'], 'Traffic'), { updated: 2, missing: ['zz'] });
  assert.deepEqual((await d.listCameras()).map((c) => [c.id, c.departmentId]), [['c1', 'Traffic'], ['c2', 'Traffic'], ['c3', null]]);
  assert.equal((await d.listDepartments())[0].cameras, 2);
  await err(d.allotCameras(['c3'], 'Ghost'), 'invalid');
  assert.deepEqual(await d.allotCameras(['c1'], null), { updated: 1, missing: [] });
  assert.equal((await d.listCameras()).find((c) => c.id === 'c1')!.departmentId, null);
});

// ---- the HTTP routes ----------------------------------------------------------------------------------------------------------

async function withAdminRoutes(run: (c: { call: (method: string, p: string, body?: unknown, who?: string) => Promise<{ status: number; json: any; text: string }>; dir: MemoryDirectory }) => Promise<void>) {
  const dir = createMemoryDirectory();
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, { directory: dir, requireAdmin: async (req, res) => { const w = String(req.header('X-User')); if (w === 'root') return { uid: 'root' }; res.status(w === 'none' ? 401 : 403).json({ error: 'no' }); return null; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ dir, call: async (method, p, body, who = 'root') => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-User': who }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text };
    } });
  } finally { server.close(); }
}

test('admin routes: the whole flow - department, user, cameras - and no password ever comes back', async () => {
  await withAdminRoutes(async ({ call, dir }) => {
    for (const id of ['c1', 'c2']) dir.addCamera({ id, name: id, ownerUserId: 'demo-admin', departmentId: null });
    assert.equal((await call('POST', '/api/admin/departments', { name: 'Traffic Police' })).status, 201);
    assert.equal((await call('POST', '/api/admin/departments', { name: 'traffic police' })).status, 409);
    assert.equal((await call('POST', '/api/admin/departments', { name: '' })).status, 400);
    const made = await call('POST', '/api/admin/users', { username: 'Ann', password: 'S3cret-pass!', role: 'operator', departmentId: 'Traffic Police' });
    assert.equal(made.status, 201);
    assert.deepEqual([made.json.user.username, made.json.user.departmentId], ['ann', 'Traffic Police']);
    assert.equal((await call('POST', '/api/admin/users', { username: 'ann', password: 'S3cret-pass!', departmentId: 'Traffic Police' })).status, 409);
    assert.equal((await call('POST', '/api/admin/users', { username: 'bob', password: 'x', departmentId: 'Traffic Police' })).status, 400);
    assert.equal((await call('POST', '/api/admin/users', { username: 'bob', password: 'S3cret-pass!', departmentId: 'Nowhere' })).status, 400);

    const allot = await call('POST', '/api/admin/cameras/allot', { cameraIds: ['c1', 'ghost'], departmentId: 'Traffic Police' });
    assert.deepEqual(allot.json, { updated: 1, missing: ['ghost'] });
    for (const bad of [{}, { cameraIds: [] }, { cameraIds: 'c1' }, { cameraIds: [5] }, { cameraIds: ['a/b'] }, { cameraIds: ['c1'], departmentId: '<x>' }]) assert.equal((await call('POST', '/api/admin/cameras/allot', bad)).status, 400, JSON.stringify(bad));
    const deps = await call('GET', '/api/admin/departments');
    assert.deepEqual([deps.json.departments[0].users, deps.json.departments[0].cameras], [1, 1]);
    assert.equal((await call('DELETE', '/api/admin/departments/Traffic%20Police')).status, 409, 'still in use');

    const upd = await call('PATCH', `/api/admin/users/${made.json.user.uid}`, { password: 'Another-pass-1', disabled: true });
    assert.equal(upd.json.user.disabled, true);
    assert.equal(dir.passwordOf('ann'), 'Another-pass-1');
    assert.equal((await call('PATCH', `/api/admin/users/${made.json.user.uid}`, {})).status, 400);
    assert.equal((await call('PATCH', '/api/admin/users/nope', { disabled: true })).status, 404);
    assert.equal((await call('GET', '/api/admin/cameras')).json.cameras.length, 2);
    for (const r of [made, upd, deps, await call('GET', '/api/admin/users'), await call('GET', '/api/admin/cameras')]) {
      assert.ok(!r.text.includes('S3cret-pass!') && !r.text.includes('Another-pass-1') && !/password/i.test(r.text), 'no password in any answer');
    }
    assert.equal((await call('DELETE', `/api/admin/users/${made.json.user.uid}`)).status, 200);
    assert.equal((await call('GET', '/api/admin/users')).json.users.length, 0);
  });
});

test('admin routes: only admins; an admin cannot lock themselves out', async () => {
  await withAdminRoutes(async ({ call, dir }) => {
    await dir.createDepartment('Traffic', 'root');
    for (const [m, p] of [['GET', '/api/admin/users'], ['GET', '/api/admin/departments'], ['GET', '/api/admin/cameras'], ['POST', '/api/admin/departments'], ['POST', '/api/admin/users'], ['POST', '/api/admin/cameras/allot'], ['PATCH', '/api/admin/users/x'], ['DELETE', '/api/admin/users/x'], ['DELETE', '/api/admin/departments/Traffic']] as const) {
      assert.equal((await call(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, 'operator')).status, 403, `${m} ${p}`);
      assert.equal((await call(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}, 'none')).status, 401, `${m} ${p} signed out`);
    }
    const me = await dir.createUser({ username: 'root-admin', password: 'password1', role: 'admin', departmentId: null }, 'x');
    // the "root" caller's uid is 'root'; make an account with that uid to test self-protection
    const self = await dir.createUser({ username: 'self', password: 'password1', role: 'operator', departmentId: 'Traffic' }, 'x');
    void me; void self;
    assert.equal((await call('PATCH', '/api/admin/users/root', { disabled: true })).status, 403);
    assert.equal((await call('PATCH', '/api/admin/users/root', { role: 'viewer' })).status, 403);
    assert.equal((await call('DELETE', '/api/admin/users/root')).status, 403);
  });
});

// ---- events and alerts follow the department ------------------------------------------------------------------------------------

const T = new Date('2026-10-10T10:00:00Z');
const ev = (owner: string, camera: string, dept: string | undefined, type = 'camera.tamper', at = T) =>
  makeEvent({ type, summary: `${type} on ${camera}`, dedupeKey: camera }, { source: 's', camera: { id: camera, name: camera, userId: owner, department: dept }, ts: at });

async function withEventApp(run: (c: { call: (method: string, p: string, who: string, body?: unknown) => Promise<{ status: number; json: any }>; store: ReturnType<typeof createMemoryAlertStore>; engine: ReturnType<typeof createAlertEngine> }) => Promise<void>) {
  const store = createMemoryAlertStore();
  const channel: Channel = { type: 'log', check: () => null, deliver: async () => ({ attempts: 1 }) };
  const channels = createChannelRegistry([channel]);
  const engine = createAlertEngine({ store, channels, now: () => T });
  // 'demo-admin' owns every camera (the demo admin); Traffic and Water members own nothing.
  await store.saveRule(validateRule({ name: 'Tamper', match: { types: ['camera.tamper'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] } }, { userId: 'demo-admin', id: 'r1', now: T }));
  await engine.ingest([ev('demo-admin', 'gate', 'Traffic'), ev('demo-admin', 'tap', 'Water'), ev('demo-admin', 'lobby', undefined), ev('other-owner', 'yard', 'Traffic')]);
  const people: Record<string, { uid: string; role: string; source: string; departments: string[] }> = {
    admin: { uid: 'demo-admin', role: 'admin', source: 'legacy', departments: ['*'] },
    ann: { uid: 'ann-uid', role: 'operator', source: 'claims', departments: ['Traffic'] },
    wes: { uid: 'wes-uid', role: 'operator', source: 'claims', departments: ['Water'] },
    old: { uid: 'old-uid', role: 'operator', source: 'legacy', departments: ['Traffic'] },
  };
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, {
    store, engine, channels,
    requireUser: async (req, res) => { const p = people[String(req.header('X-User'))]; if (!p) { res.status(401).json({ error: 'no' }); return null; } res.locals.principal = p; return p.uid; },
    departmentScope: async (req) => { const p = req.res?.locals.principal; return p && p.source === 'claims' && p.role !== 'admin' && p.departments.length > 0 && !p.departments.includes('*') ? p.departments : null; },
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ store, engine, call: async (method, p, who, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-User': who }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    } });
  } finally { server.close(); }
}

test('events: people in a department see its events whoever owns the cameras, and nothing else; the owner and legacy accounts are unchanged', async () => {
  await withEventApp(async ({ call }) => {
    const seen = async (who: string) => ((await call('GET', '/api/events', who)).json.events as PlatformEvent[]).map((e) => e.cameraId).sort();
    assert.deepEqual(await seen('ann'), ['gate', 'yard'], 'Traffic: its own camera and another owner\'s camera in Traffic');
    assert.deepEqual(await seen('wes'), ['tap']);
    assert.deepEqual(await seen('admin'), ['gate', 'lobby', 'tap'], 'the owner sees what they own, as before (not other owners\' events)');
    assert.deepEqual(await seen('old'), [], 'an account on the old self-set role is not scoped by department: it sees its own data, as before');
    assert.equal((await call('GET', '/api/events', 'nobody')).status, 401);
  });
});

test('alerts: department members see, acknowledge and resolve their department\'s alerts only', async () => {
  await withEventApp(async ({ call, store }) => {
    const alerts = async (who: string) => ((await call('GET', '/api/alerts', who)).json.alerts as Array<{ id: string; cameraId: string; department?: string }>);
    const ann = await alerts('ann');
    assert.deepEqual(ann.map((a) => a.cameraId).sort(), ['gate'], 'the alert rule belongs to the owner; Traffic sees the alert raised on its camera');
    assert.equal(ann[0].department, 'Traffic');
    assert.deepEqual((await alerts('wes')).map((a) => a.cameraId), ['tap']);
    const waterAlert = (await alerts('wes'))[0];
    assert.equal((await call('POST', `/api/alerts/${waterAlert.id}/acknowledge`, 'ann')).status, 404, 'Traffic cannot touch a Water alert');
    assert.equal((await call('POST', `/api/alerts/${waterAlert.id}/acknowledge`, 'wes')).json.alert.state, 'acknowledged');
    assert.equal((await call('POST', `/api/alerts/${waterAlert.id}/resolve`, 'wes')).json.alert.state, 'resolved');
    assert.equal((await alerts('wes')).length, 1);
    assert.equal((await call('GET', '/api/alerts?state=resolved', 'wes')).json.alerts.length, 1);
    assert.equal((await call('GET', '/api/alerts?state=open', 'wes')).json.alerts.length, 0);
    const gate = ann[0];
    assert.equal((await call('POST', `/api/alerts/${gate.id}/acknowledge`, 'admin')).json.alert.state, 'acknowledged', 'the owner still handles their alerts');
    assert.equal((await store.getAlertForDepartments(['Traffic'], gate.id))!.ackBy, 'demo-admin');
    assert.equal(await store.getAlertForDepartments(['Water'], gate.id), null);
  });
});
