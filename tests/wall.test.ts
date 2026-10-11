/**
 * Video walls (gap A10): layout geometry and validation, tours, saved layouts and who may see them, wall sessions (viewer cap, one controller,
 * expiry, forced takeover, audit), and the HTTP routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { LayoutError as LibLayoutError, camerasOf, cellCount, gridOf, validateSpec, visibleCells, WALL_PRESETS } from '../src/lib/wallLayout.ts';
import { createWallService, SESSION_MS } from '../server/wall/service.ts';
import { registerWallRoutes } from '../server/wall/routes.ts';
import type { Principal } from '../server/authz/policy.ts';

const T0 = Date.UTC(2026, 9, 11, 10, 0, 0);
const quiet = { warn() {}, info() {} };
const who = (uid: string, role: Principal['role'] = 'operator', departments: string[] = ['Traffic']): Principal => ({ uid, role, departments, source: 'claims' });
const admin = who('root', 'admin', ['*']);

// ---- layout library ------------------------------------------------------------------------------------------------------------------

test('presets: the cell counts are what the names say, every cell sits inside the grid, and no two cells overlap', () => {
  const counts: Record<string, number> = { '1x1': 1, '2x2': 4, '3x3': 9, '4x4': 16, '1+5': 6, '1+7': 8, '2+8': 10 };
  for (const p of WALL_PRESETS.filter((x) => x !== 'custom')) {
    const g = gridOf(p);
    assert.equal(g.cells.length, counts[p], p);
    const taken = new Set<string>();
    for (const c of g.cells) {
      assert.equal(c.col >= 1 && c.row >= 1 && c.col + c.colSpan - 1 <= g.cols && c.row + c.rowSpan - 1 <= g.rows, true, `${p} cell inside`);
      for (let r = c.row; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) { assert.equal(taken.has(`${k},${r}`), false, `${p} overlap at ${k},${r}`); taken.add(`${k},${r}`); }
    }
  }
  assert.deepEqual(gridOf('1+5').cells[0], { col: 1, row: 1, colSpan: 2, rowSpan: 2 });
  assert.equal(gridOf('1+5').cells.length, 6);
  assert.deepEqual([cellCount('custom', { cols: 3, rows: 2 }), cellCount('custom', { cols: 99, rows: 99 })], [6, 48], 'a custom grid is capped at 8 × 6');
});

test('validateSpec: the cell list must match the preset; a camera appears once; a tour needs a sensible interval and cameras; bad input gives a sentence', () => {
  const ok = validateSpec({ preset: '2x2', cells: ['a', null, 'b', 'c'] });
  assert.deepEqual(ok.cells, ['a', null, 'b', 'c']);
  assert.deepEqual(validateSpec({ preset: 'custom', cols: 3, rows: 1, cells: ['a', 'b', 'c'] }).cols, 3);
  for (const [bad, re] of [
    [{ preset: 'weird', cells: [] }, /preset/], [{ preset: '2x2', cells: ['a'] }, /exactly 4/], [{ preset: '1x1', cells: [5] }, /camera id/],
    [{ preset: '2x2', cells: ['a', 'a', null, null] }, /two cells/], [{ preset: 'custom', cols: 99, rows: 1, cells: [] }, /cols/], [{ preset: 'custom', cols: 2, rows: 0, cells: [] }, /rows/],
    [{ preset: '1x1', cells: ['bad id!'] }, /camera id/], [{ preset: '1x1', cells: [null], tour: { intervalS: 1, cameraIds: ['a'] } }, /intervalS/],
    [{ preset: '1x1', cells: [null], tour: { intervalS: 10, cameraIds: [] } }, /camera ids/],
  ] as Array<[unknown, RegExp]>) assert.throws(() => validateSpec(bad), (e) => e instanceof LibLayoutError && re.test((e as Error).message), JSON.stringify(bad));
  assert.deepEqual(camerasOf(validateSpec({ preset: '1x1', cells: ['a'], tour: { intervalS: 10, cameraIds: ['a', 'b', 'a'] } })).sort(), ['a', 'b']);
});

test('tour: groups of the wall\'s size change every interval, the same on every screen; the last short group is topped up; fewer cameras than cells leaves empty cells', () => {
  const spec = validateSpec({ preset: '2x2', cells: [null, null, null, null], tour: { intervalS: 10, cameraIds: ['1', '2', '3', '4', '5', '6'] } });
  const at = (s: number) => visibleCells(spec, T0 + s * 1000, T0);
  assert.deepEqual(at(0), ['1', '2', '3', '4']);
  assert.deepEqual(at(9), ['1', '2', '3', '4']);
  assert.deepEqual(at(10), ['5', '6', '1', '2'], 'the short last group is filled from the start');
  assert.deepEqual(at(20), ['1', '2', '3', '4'], 'and it goes round');
  assert.deepEqual(at(-50), ['1', '2', '3', '4'], 'a clock slightly behind the start does not break it');
  const few = validateSpec({ preset: '2x2', cells: [null, null, null, null], tour: { intervalS: 10, cameraIds: ['x', 'y'] } });
  assert.deepEqual(visibleCells(few, T0 + 99_000, T0), ['x', 'y', null, null]);
  const still = validateSpec({ preset: '1x1', cells: ['a'] });
  assert.deepEqual(visibleCells(still, T0 + 1e6, T0), ['a']);
});

// ---- service -------------------------------------------------------------------------------------------------------------------------

function setup() {
  const clock = { t: T0 };
  const file = join(mkdtempSync(join(tmpdir(), 'wall-')), 'walls.json');
  const mk = (f = file) => createWallService({ file: f, now: () => new Date(clock.t), log: quiet });
  return { svc: mk(), mk, clock, file };
}
const spec = (a: string | null = 'cam1') => ({ preset: '2x2', cells: [a, null, null, null] });

test('layouts: private to the owner until shared with a department; only owners (or department admins) change them; deleting one empties the walls that showed it', async () => {
  const { svc } = setup();
  const alice = who('alice'), bob = who('bob'), carol = who('carol', 'operator', ['Police']);
  const mine = await svc.createLayout({ name: 'Gates', spec: spec(), department: 'Traffic' }, alice);
  assert.deepEqual((await svc.listLayouts(bob)).map((l) => l.name), [], 'not shared: bob does not see it');
  await svc.updateLayout(mine.id, { shared: true }, alice);
  assert.deepEqual((await svc.listLayouts(bob)).map((l) => l.name), ['Gates']);
  assert.deepEqual((await svc.listLayouts(carol)).map((l) => l.name), [], 'another department does not');
  assert.deepEqual((await svc.listLayouts(admin)).map((l) => l.name), ['Gates'], 'an organisation-wide admin sees all');
  assert.equal(await svc.updateLayout(mine.id, { name: 'x' }, bob), 'forbidden');
  assert.equal(await svc.removeLayout(mine.id, bob), 'forbidden');
  assert.equal(await svc.updateLayout(mine.id, { name: 'x' }, carol), null, 'carol cannot even tell it exists');
  await assert.rejects(svc.createLayout({ name: 'S', spec: spec(), shared: true }, alice), /department/);
  await assert.rejects(svc.createLayout({ name: 'S', spec: spec(), department: 'Police' }, alice), /own departments/);
  await assert.rejects(svc.createLayout({ name: '', spec: spec() }, alice), /name/);
  await assert.rejects(svc.createLayout({ name: 'Bad', spec: { preset: '2x2', cells: [] } }, alice), LibLayoutError);
  await svc.createWall({ id: 'w1', department: 'Traffic' }, admin);
  const att = await svc.attach('w1', alice, 'controller');
  assert.equal(att.status, 'ok');
  await svc.setLayout('w1', alice, (att as any).sessionId, { layoutId: mine.id });
  assert.equal((await svc.getWall('w1', alice))!.spec?.cells[0], 'cam1');
  assert.equal(await svc.removeLayout(mine.id, alice), 'ok');
  const after = (await svc.getWall('w1', alice))!;
  assert.deepEqual([after.spec, after.wall.layoutId], [null, null]);
});

test('walls: administrators make them; only people of the wall\'s department see them; a wall without a department is for everyone', async () => {
  const { svc } = setup();
  await svc.createWall({ id: 'traffic-room', name: 'Traffic room', department: 'Traffic', maxViewers: 2, maxLiveTiles: 6 }, admin);
  await svc.createWall({ id: 'lobby' }, admin);
  await assert.rejects(svc.createWall({ id: 'lobby' }, admin), /already exists/);
  await assert.rejects(svc.createWall({ id: 'bad id' }, admin), /id/);
  await assert.rejects(svc.createWall({ id: 'x', maxViewers: -1 }, admin), /maxViewers/);
  assert.deepEqual((await svc.listWalls(who('t'))).map((w) => w.wall.id).sort(), ['lobby', 'traffic-room']);
  assert.deepEqual((await svc.listWalls(who('p', 'viewer', ['Police']))).map((w) => w.wall.id), ['lobby']);
  assert.equal(await svc.getWall('traffic-room', who('p', 'viewer', ['Police'])), null);
  const u = await svc.updateWall('traffic-room', { maxLiveTiles: 4 }, admin);
  assert.deepEqual([u!.wall.maxLiveTiles, u!.wall.version], [4, 2]);
  assert.equal(await svc.removeWall('lobby', admin), true);
  assert.equal(await svc.removeWall('lobby', admin), false);
});

test('sessions: viewers up to the cap; one controller; a second operator is told who has it; control runs out without heartbeats and can then be taken', async () => {
  const { svc, clock } = setup();
  await svc.createWall({ id: 'w', maxViewers: 2 }, admin);
  const a = who('alice'), b = who('bob'), c = who('carol');
  const v1 = await svc.attach('w', a, 'viewer'), v2 = await svc.attach('w', b, 'viewer'), v3 = await svc.attach('w', c, 'viewer');
  assert.deepEqual([v1.status, v2.status, v3.status === 'full' && v3.max], ['ok', 'ok', 2]);
  assert.equal((await svc.getWall('w', a))!.viewers, 2);
  const ctl = await svc.attach('w', a, 'controller');
  assert.equal(ctl.status, 'ok');
  const busy = await svc.attach('w', b, 'controller');
  assert.deepEqual([busy.status, busy.status === 'busy' && busy.holder], ['busy', 'alice']);
  assert.equal(await svc.attach('w', b, 'controller', true).then((r) => r.status), 'busy', 'force works only for an administrator');
  assert.equal((await svc.getWall('w', b))!.controller?.uid, 'alice');
  clock.t += SESSION_MS - 1000;
  assert.notEqual(await svc.heartbeat('w', a, (ctl as any).sessionId, 'controller'), null, 'alice keeps control with a heartbeat');
  clock.t += SESSION_MS - 1000;
  assert.equal((await svc.getWall('w', b))!.controller?.uid, 'alice', 'still held: her heartbeat renewed it');
  clock.t += SESSION_MS + 1000;
  assert.equal((await svc.getWall('w', b))!.controller, null, 'no heartbeat: control ran out');
  assert.equal((await svc.attach('w', b, 'controller')).status, 'ok');
  assert.equal(await svc.heartbeat('w', a, (ctl as any).sessionId, 'controller'), null, 'alice\'s old session is gone');
  assert.equal(await svc.heartbeat('w', b, (v1 as any).sessionId, 'viewer'), null, 'a session id is only good for the person it was given to');
  assert.equal((await svc.getWall('w', a))!.viewers, 0, 'viewers who stopped sending heartbeats ran out too');
  const fresh = (await svc.attach('w', a, 'viewer')) as any;
  assert.equal(await svc.detach('w', a, fresh.sessionId, 'viewer'), true);
  assert.equal((await svc.attach('w', c, 'viewer')).status, 'ok', 'a slot came free');
});

test('control: only the controller changes the wall; an administrator can force control; your own earlier session is replaced; everything is in the audit', async () => {
  const { svc } = setup();
  await svc.createWall({ id: 'w' }, admin);
  const a = who('alice'), b = who('bob');
  const lay = await svc.createLayout({ name: 'Four', spec: spec('cam7'), department: 'Traffic', shared: true }, a);
  const viewer = (await svc.attach('w', b, 'viewer')) as any;
  assert.equal((await svc.setLayout('w', b, viewer.sessionId, { layoutId: lay.id })).status, 'not_controller');
  const ctl = (await svc.attach('w', a, 'controller')) as any;
  const r = await svc.setLayout('w', a, ctl.sessionId, { layoutId: lay.id });
  assert.equal(r.status === 'ok' && r.state.spec?.cells[0], 'cam7');
  assert.equal(r.status === 'ok' && r.state.wall.version, 2);
  const adHoc = await svc.setLayout('w', a, ctl.sessionId, { spec: { preset: '1x1', cells: ['cam9'] } });
  assert.equal(adHoc.status === 'ok' && adHoc.state.spec?.preset, '1x1');
  await assert.rejects(svc.setLayout('w', a, ctl.sessionId, {}), /layoutId/);
  await assert.rejects(svc.setLayout('w', a, ctl.sessionId, { layoutId: 'nope' }), /No such layout/);
  await assert.rejects(svc.setLayout('w', a, ctl.sessionId, { spec: { preset: '2x2', cells: [] } }), LibLayoutError);
  const again = (await svc.attach('w', a, 'controller')) as any;
  assert.equal(again.status, 'ok', 'her second tab replaces her first session');
  assert.equal((await svc.setLayout('w', a, ctl.sessionId, { layoutId: lay.id })).status, 'not_controller');
  const forced = await svc.attach('w', admin, 'controller', true);
  assert.equal(forced.status, 'ok');
  assert.equal((await svc.setLayout('w', a, again.sessionId, { layoutId: lay.id })).status, 'not_controller', 'alice lost control');
  const actions = svc.audit('w').map((e) => `${e.uid}:${e.action}`);
  assert.deepEqual(actions.filter((x) => /control|layout/.test(x)).reverse(), ['alice:take-control', 'alice:layout', 'alice:layout', 'alice:take-control', 'root:force-control']);
  assert.equal(svc.audit('w').find((e) => e.action === 'force-control')!.detail, 'from alice');
});

test('walls and layouts survive a restart; sessions do not need to', async () => {
  const { svc, mk, file } = setup();
  await svc.createWall({ id: 'w', department: 'Traffic', maxViewers: 3 }, admin);
  const l = await svc.createLayout({ name: 'Keep', spec: spec(), department: 'Traffic' }, who('alice'));
  const again = mk(file);
  assert.deepEqual((await again.listWalls(who('x'))).map((w) => [w.wall.id, w.wall.maxViewers]), [['w', 3]]);
  assert.deepEqual((await again.listLayouts(who('alice'))).map((x) => x.id), [l.id]);
});

// ---- HTTP ----------------------------------------------------------------------------------------------------------------------------

async function withApp(run: (call: (method: string, path: string, user: string, body?: unknown) => Promise<{ status: number; json: any; headers: Headers }>) => Promise<void>) {
  const { svc } = setup();
  const people: Record<string, Principal> = { alice: who('alice'), bob: who('bob'), vera: who('vera', 'viewer'), root: admin };
  const perms: Record<string, string[]> = { viewer: ['camera.view'], operator: ['camera.view', 'camera.edit'], admin: ['camera.view', 'camera.edit', 'user.manage'] };
  const app = express();
  app.use(express.json());
  registerWallRoutes(app, { service: svc, allow: async (req, res, perm) => {
    const p = people[req.header('x-user') ?? ''];
    if (!p) { res.status(401).json({ error: 'no' }); return null; }
    if (!perms[p.role].includes(perm)) { res.status(403).json({ error: 'not allowed' }); return null; }
    return p;
  } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (method, path, user, body) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
    });
  } finally { server.close(); }
}

test('http: the whole story — admin makes a wall, an operator takes control and sets a layout, a viewer watches, a second operator is told no, status codes are exact', async () => {
  await withApp(async (call) => {
    assert.equal((await call('GET', '/api/walls', '')).status, 401);
    assert.equal((await call('POST', '/api/walls', 'alice', { id: 'w' })).status, 403, 'operators cannot make walls');
    assert.equal((await call('POST', '/api/walls', 'root', { id: 'w', maxViewers: 1 })).status, 201);
    assert.equal((await call('POST', '/api/walls', 'root', { id: 'w' })).status, 400);
    const lay = await call('POST', '/api/wall-layouts', 'alice', { name: 'Four', spec: { preset: '2x2', cells: ['c1', 'c2', null, null] } });
    assert.equal(lay.status, 201);
    assert.equal((await call('POST', '/api/wall-layouts', 'vera', { name: 'x', spec: {} })).status, 403, 'a viewer cannot save layouts');
    assert.equal((await call('POST', '/api/wall-layouts', 'alice', { name: 'x', spec: { preset: '2x2', cells: [] } })).status, 400);
    assert.equal((await call('GET', '/api/wall-layouts', 'bob')).json.layouts.length, 0, 'private');
    const ctl = await call('POST', '/api/walls/w/sessions', 'alice', { mode: 'controller' });
    assert.equal(ctl.status, 201);
    assert.equal((await call('POST', '/api/walls/w/sessions', 'bob', { mode: 'controller' })).status, 409);
    assert.equal((await call('POST', '/api/walls/w/sessions', 'bob', { mode: 'controller', force: true })).status, 403);
    assert.equal((await call('POST', '/api/walls/w/sessions', 'vera', { mode: 'controller' })).status, 403, 'a viewer cannot control');
    assert.equal((await call('POST', '/api/walls/w/sessions', 'vera', { mode: 'sideways' })).status, 400);
    const view = await call('POST', '/api/walls/w/sessions', 'vera', { mode: 'viewer' });
    assert.equal(view.status, 201);
    const full = await call('POST', '/api/walls/w/sessions', 'bob', { mode: 'viewer' });
    assert.deepEqual([full.status, full.headers.get('retry-after')], [429, '45']);
    const set = await call('PUT', '/api/walls/w/layout', 'alice', { sessionId: ctl.json.sessionId, layoutId: lay.json.layout.id });
    assert.deepEqual([set.status, set.json.state.spec.cells[0]], [200, 'c1']);
    assert.equal((await call('PUT', '/api/walls/w/layout', 'alice', { layoutId: lay.json.layout.id })).status, 403, 'no session');
    assert.equal((await call('PUT', '/api/walls/w/layout', 'bob', { sessionId: ctl.json.sessionId, layoutId: lay.json.layout.id })).status, 403, 'someone else\'s session');
    assert.equal((await call('PUT', '/api/walls/w/layout', 'alice', { sessionId: ctl.json.sessionId })).status, 400);
    const hb = await call('POST', `/api/walls/w/sessions/${view.json.sessionId}/heartbeat`, 'vera', { mode: 'viewer' });
    assert.deepEqual([hb.status, hb.json.state.viewers, hb.json.state.controller.uid], [200, 1, 'alice']);
    assert.equal((await call('POST', '/api/walls/w/sessions/nonesuch/heartbeat', 'vera', { mode: 'viewer' })).status, 404);
    assert.equal((await call('DELETE', `/api/walls/w/sessions/${view.json.sessionId}?mode=viewer`, 'vera')).status, 200);
    assert.equal((await call('DELETE', `/api/walls/w/sessions/${view.json.sessionId}?mode=viewer`, 'vera')).status, 404);
    const forced = await call('POST', '/api/walls/w/sessions', 'root', { mode: 'controller', force: true });
    assert.equal(forced.status, 201);
    assert.equal((await call('PUT', '/api/walls/w/layout', 'alice', { sessionId: ctl.json.sessionId, layoutId: lay.json.layout.id })).status, 403, 'alice lost control');
    assert.equal((await call('GET', '/api/walls/w/audit', 'alice')).status, 403);
    const audit = await call('GET', '/api/walls/w/audit', 'root');
    assert.equal(audit.json.audit.some((a: any) => a.action === 'force-control'), true);
    assert.equal((await call('GET', '/api/walls/nope', 'alice')).status, 404);
    assert.equal((await call('GET', '/api/walls/..%2Fx', 'alice')).status, 404);
    assert.equal((await call('DELETE', '/api/wall-layouts/' + lay.json.layout.id, 'bob')).status, 404, 'bob cannot see it, so it is not there for him');
    assert.equal((await call('DELETE', '/api/wall-layouts/' + lay.json.layout.id, 'alice')).status, 200);
    assert.equal((await call('DELETE', '/api/walls/w', 'root')).status, 200);
  });
});
