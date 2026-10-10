/**
 * A5 remainder: administrators see events on every camera; alert rules, faces, the watchlist and logs can belong to a department.
 * The Firestore rules for the same data are in tests/firestoreRules.test.ts (they need the Firebase emulator).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { can, eventScope, type Principal } from '../server/authz/policy.ts';
import { registerEventRoutes } from '../server/events/routes.ts';
import { createMemoryAlertStore, departmentOwner } from '../server/events/store.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, type Channel } from '../server/events/channels.ts';
import { makeEvent, type PlatformEvent } from '../server/events/schema.ts';
import { validateRule } from '../server/events/rules.ts';
import { loadUserContext, type DocsLike } from '../server/userContext.ts';
import { buildLogDocument } from '../server/logEntry.ts';
import { createAnalysisWorker, type WorkerCamera, type WorkerDeps } from '../server/analysisWorker.ts';
import { createGatewayCentral, createMemoryGatewayDocs, GatewayError } from '../server/gateway/central.ts';
import { subscribeMerged, type Listen } from '../src/lib/mergedQueries.ts';

const T = new Date('2026-10-10T10:00:00Z');
const ev = (owner: string, camera: string, dept: string | undefined, type = 'camera.tamper', at = T) =>
  makeEvent({ type, summary: `${type} on ${camera}`, dedupeKey: camera }, { source: 's', camera: { id: camera, name: camera, userId: owner, department: dept }, ts: at });
const RULE = { name: 'Tamper', match: { types: ['camera.tamper'] }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera', 'type'] } };

// ---- who sees what -------------------------------------------------------------------------------------------------------------

const P = (uid: string, role: Principal['role'], departments: string[], source: Principal['source'] = 'claims'): Principal => ({ uid, role, departments, source });

test('scope: claims decide; an organisation-wide admin sees everything, the rest their departments; the old self-set role stays personal', () => {
  assert.equal(eventScope(P('a', 'admin', ['*'])), '*');
  assert.deepEqual(eventScope(P('a', 'admin', ['Traffic', 'Water'])), ['Traffic', 'Water'], 'an admin with a list covers that list');
  assert.deepEqual(eventScope(P('o', 'operator', ['Traffic'])), ['Traffic']);
  assert.equal(eventScope(P('o', 'operator', [])), null, 'no department: their own');
  assert.equal(eventScope(P('o', 'operator', ['*'])), null, "'*' is for admins only");
  assert.equal(eventScope(P('l', 'admin', ['*'], 'legacy')), null, 'a self-set admin is not trusted with other people\'s events');
  assert.equal(eventScope(P('g', 'viewer', ['Traffic'], 'guest')), null);
  assert.equal(eventScope(undefined), null);
});

// ---- the stores ------------------------------------------------------------------------------------------------------------------

test('store: "all" reads every event and alert, and finds any alert by id; department rules are listed by department', async () => {
  const store = createMemoryAlertStore();
  await store.saveEvents([ev('u1', 'gate', 'Traffic'), ev('u2', 'tap', 'Water'), ev('u3', 'lobby', undefined)]);
  assert.deepEqual((await store.queryEvents({ userId: 'x', all: true })).map((e) => e.cameraId).sort(), ['gate', 'lobby', 'tap']);
  assert.deepEqual((await store.queryEvents({ userId: 'u1' })).map((e) => e.cameraId), ['gate']);
  assert.deepEqual((await store.queryEvents({ userId: 'x', all: true, cameraId: 'tap' })).map((e) => e.cameraId), ['tap'], 'filters still apply');

  const rule = (id: string, owner: string, department?: string) => ({ ...validateRule(RULE, { userId: owner, id, now: T, department }) });
  await store.saveRule(rule('r-own', 'u1'));
  await store.saveRule(rule('r-traffic', departmentOwner('Traffic'), 'Traffic'));
  await store.saveRule(rule('r-water', departmentOwner('Water'), 'Water'));
  assert.deepEqual((await store.listDepartmentRules(['Traffic'])).map((r) => r.id), ['r-traffic']);
  assert.deepEqual((await store.listDepartmentRules(null)).map((r) => r.id).sort(), ['r-traffic', 'r-water']);
  assert.deepEqual(await store.listDepartmentRules([]), []);
  assert.deepEqual((await store.listRules('u1')).map((r) => r.id), ['r-own'], 'a department rule is not anyone\'s personal rule');
});

// ---- the engine ------------------------------------------------------------------------------------------------------------------

function makeEngine() {
  const store = createMemoryAlertStore();
  const delivered: string[] = [];
  const channel: Channel = { type: 'log', check: () => null, deliver: async (_c, ctx) => { delivered.push(`${ctx.rule.name}:${ctx.event.cameraId}`); return { attempts: 1 }; } };
  const engine = createAlertEngine({ store, channels: createChannelRegistry([channel]), now: () => T, log: { warn() {}, info() {} }, ruleCacheMs: 0 });
  return { store, engine, delivered };
}

test('engine: a department rule fires for events on its cameras whoever owns them, and folds them into one alert per camera', async () => {
  const { store, engine, delivered } = makeEngine();
  await store.saveRule(validateRule({ ...RULE, name: 'Traffic tamper' }, { userId: departmentOwner('Traffic'), id: 'rt', now: T, department: 'Traffic', createdBy: 'ann' }));
  const r = await engine.ingest([ev('owner-a', 'gate', 'Traffic'), ev('owner-b', 'yard', 'Traffic'), ev('owner-a', 'tap', 'Water'), ev('owner-a', 'lobby', undefined)]);
  assert.equal(r.stored, 4);
  assert.deepEqual(delivered.sort(), ['Traffic tamper:gate', 'Traffic tamper:yard'], 'only Traffic cameras, from either owner; no owner rule exists');
  const alerts = await store.listAlerts({ userId: 'nobody', departments: ['Traffic'] });
  assert.deepEqual(alerts.map((a) => a.cameraId).sort(), ['gate', 'yard']);
  assert.ok(alerts.every((a) => a.userId === departmentOwner('Traffic') && a.department === 'Traffic'));
  // The same camera again inside the window is folded, even from a different owner id.
  const again = await engine.ingest([ev('owner-b', 'gate', 'Traffic', 'camera.tamper', new Date(T.getTime() + 5_000))]);
  assert.equal(again.alerts[0].opened, false);
  assert.equal((await store.listAlerts({ userId: 'x', departments: ['Traffic'] })).find((a) => a.cameraId === 'gate')!.eventCount, 2);
  // An event seen twice does not alert twice.
  const dup = await engine.ingest([ev('owner-a', 'gate', 'Traffic')]);
  assert.equal(dup.alerts.length, 0);
});

test('engine: the owner\'s own rule and the department\'s rule both apply; a changed department rule is picked up at once', async () => {
  const { store, engine, delivered } = makeEngine();
  await store.saveRule(validateRule({ ...RULE, name: 'Mine' }, { userId: 'owner-a', id: 'ro', now: T }));
  await store.saveRule(validateRule({ ...RULE, name: 'Theirs' }, { userId: departmentOwner('Traffic'), id: 'rt', now: T, department: 'Traffic' }));
  await engine.ingest([ev('owner-a', 'gate', 'Traffic')]);
  assert.deepEqual(delivered.sort(), ['Mine:gate', 'Theirs:gate']);
  await store.saveRule(validateRule({ ...RULE, name: 'Theirs', enabled: false }, { userId: departmentOwner('Traffic'), id: 'rt', now: T, department: 'Traffic' }));
  engine.invalidate(departmentOwner('Traffic'));
  delivered.length = 0;
  await engine.ingest([ev('owner-a', 'gate2', 'Traffic')]);
  assert.deepEqual(delivered, ['Mine:gate2']);
});

// ---- the routes ------------------------------------------------------------------------------------------------------------------

const PEOPLE: Record<string, Principal> = {
  root: P('root-uid', 'admin', ['*']),
  boss: P('boss-uid', 'admin', ['Traffic', 'Water']),
  ann: P('ann-uid', 'operator', ['Traffic']),
  wes: P('wes-uid', 'operator', ['Water']),
  vic: P('vic-uid', 'viewer', ['Traffic']),
  old: P('old-uid', 'admin', ['*'], 'legacy'),
};

async function withApp(run: (h: { call: (who: string, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>; store: ReturnType<typeof createMemoryAlertStore>; engine: ReturnType<typeof createAlertEngine> }) => Promise<void>) {
  const { store, engine } = makeEngine();
  const channels = createChannelRegistry([{ type: 'log', check: () => null, deliver: async () => ({ attempts: 1 }) } as Channel]);
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, {
    store, engine, channels, now: () => T,
    requireUser: async (req, res, permission) => {
      const p = PEOPLE[String(req.header('X-User'))];
      if (!p) { res.status(401).json({ error: 'no' }); return null; }
      if (!can(p, permission)) { res.status(403).json({ error: 'not allowed' }); return null; }
      res.locals.principal = p;
      return p.uid;
    },
    departmentScope: async (req) => eventScope(req.res?.locals.principal as Principal | undefined),
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ store, engine, call: async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-User': who }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    } });
  } finally { server.close(); }
}

test('routes: an organisation-wide administrator sees events and alerts on every camera, handles any alert; an admin with a list sees that list', async () => {
  await withApp(async ({ call, store, engine }) => {
    await store.saveRule(validateRule(RULE, { userId: 'owner-a', id: 'r1', now: T }));
    await engine.ingest([ev('owner-a', 'gate', 'Traffic'), ev('owner-a', 'tap', 'Water'), ev('owner-a', 'lobby', undefined), ev('owner-b', 'yard', 'Traffic')]);
    const seen = async (who: string) => ((await call(who, 'GET', '/api/events')).json.events as PlatformEvent[]).map((e) => e.cameraId).sort();
    assert.deepEqual(await seen('root'), ['gate', 'lobby', 'tap', 'yard'], 'every camera, including one with no department and another owner\'s');
    assert.deepEqual(await seen('boss'), ['gate', 'tap', 'yard'], 'an admin with departments listed: those departments');
    assert.deepEqual(await seen('ann'), ['gate', 'yard']);
    assert.deepEqual(await seen('old'), [], 'a self-set admin sees only what they own (nothing here)');

    const alerts = async (who: string) => (await call(who, 'GET', '/api/alerts')).json.alerts as Array<{ id: string; cameraId: string }>;
    assert.deepEqual((await alerts('root')).map((a) => a.cameraId).sort(), ['gate', 'lobby', 'tap'], 'the alerts the owner\'s rule raised, all of them');
    const lobby = (await alerts('root')).find((a) => a.cameraId === 'lobby')!;
    assert.equal((await call('ann', 'POST', `/api/alerts/${lobby.id}/acknowledge`)).status, 404, 'a department member cannot touch a camera with no department');
    assert.equal((await call('boss', 'POST', `/api/alerts/${lobby.id}/acknowledge`)).status, 404, 'nor can an admin whose list does not cover it');
    assert.equal((await call('root', 'POST', `/api/alerts/${lobby.id}/acknowledge`)).json.alert.state, 'acknowledged');
    assert.equal((await call('root', 'POST', `/api/alerts/${lobby.id}/resolve`)).json.alert.state, 'resolved');
  });
});

test('routes: department rules - made for a department you work for, listed to that department, handled by its operators, invisible to others', async () => {
  await withApp(async ({ call, store }) => {
    const made = await call('ann', 'POST', '/api/alert-rules', { ...RULE, name: 'Traffic tamper', department: 'Traffic' });
    assert.equal(made.status, 201);
    assert.equal(made.json.rule.department, 'Traffic');
    assert.equal(made.json.rule.createdBy, 'ann-uid');
    assert.equal(made.json.rule.userId, departmentOwner('Traffic'));
    const id = made.json.rule.id as string;

    assert.equal((await call('wes', 'POST', '/api/alert-rules', { ...RULE, department: 'Traffic' })).status, 403, 'Water cannot make Traffic rules');
    assert.equal((await call('vic', 'POST', '/api/alert-rules', { ...RULE, department: 'Traffic' })).status, 403, 'a viewer cannot manage rules at all');
    assert.equal((await call('ann', 'POST', '/api/alert-rules', { ...RULE, department: '../../x' })).status, 400);
    assert.equal((await call('old', 'POST', '/api/alert-rules', { ...RULE, department: 'Traffic' })).status, 403, 'a self-set admin has no department scope');

    const names = async (who: string) => ((await call(who, 'GET', '/api/alert-rules')).json.rules as Array<{ name: string }>).map((r) => r.name);
    assert.deepEqual(await names('ann'), ['Traffic tamper']);
    assert.deepEqual(await names('vic'), ['Traffic tamper'], 'a viewer may look');
    assert.deepEqual(await names('wes'), [], 'Water does not see Traffic\'s rules');
    assert.deepEqual(await names('root'), ['Traffic tamper'], 'an organisation-wide admin sees all departments\' rules');

    // another Traffic operator (here: the admin with a list) edits and tests it; Water cannot find it
    assert.equal((await call('wes', 'PUT', `/api/alert-rules/${id}`, { ...RULE, department: 'Traffic' })).status, 404);
    assert.equal((await call('wes', 'DELETE', `/api/alert-rules/${id}`)).status, 404);
    assert.equal((await call('wes', 'POST', `/api/alert-rules/${id}/test`)).status, 404);
    const edited = await call('boss', 'PUT', `/api/alert-rules/${id}`, { ...RULE, name: 'Traffic tamper v2', department: 'Water' });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.rule.department, 'Traffic', 'the department of a rule cannot be changed by editing');
    assert.equal(edited.json.rule.createdBy, 'ann-uid');
    assert.equal(edited.json.rule.userId, departmentOwner('Traffic'));
    assert.equal((await call('ann', 'POST', `/api/alert-rules/${id}/test`)).status, 200);

    assert.equal((await store.listDepartmentRules(['Traffic'])).length, 1, 'still one rule, edited in place');

    assert.equal((await call('ann', 'DELETE', `/api/alert-rules/${id}`)).status, 200);
    assert.equal((await call('ann', 'DELETE', `/api/alert-rules/${id}`)).status, 404);
    assert.deepEqual(await names('root'), []);
  });
});

test('routes: an organisation-wide administrator can make a rule for any department; personal rules are unchanged', async () => {
  await withApp(async ({ call, store }) => {
    assert.equal((await call('root', 'POST', '/api/alert-rules', { ...RULE, department: 'Fire' })).status, 201);
    assert.equal((await store.listDepartmentRules(['Fire'])).length, 1);
    const mine = await call('ann', 'POST', '/api/alert-rules', { ...RULE, name: 'Personal' });
    assert.equal(mine.status, 201);
    assert.equal(mine.json.rule.department, undefined);
    assert.equal(mine.json.rule.userId, 'ann-uid');
    const list = (await call('ann', 'GET', '/api/alert-rules')).json.rules as Array<{ name: string; department?: string }>;
    assert.deepEqual(list.map((r) => r.name), ['Personal'], 'her personal rule, and no Fire rule');
    assert.equal((await call('old', 'POST', '/api/alert-rules', { ...RULE, name: 'Old' })).status, 201, 'accounts without claims keep their personal rules');
  });
});

// ---- the faces and watchlist an analysis uses -------------------------------------------------------------------------------------

function fakeDb(data: Record<string, Array<Record<string, unknown>>>): DocsLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    collection: (name) => ({
      where: (field, _op, value) => {
        asked.push(`${name}.${field}=${String(value)}`);
        const rows = (data[name] ?? []).filter((r) => r[field] === value);
        const q = { limit: (n: number) => ({ ...q, get: async () => ({ docs: rows.slice(0, n).map((r) => ({ data: () => r })) }) }), get: async () => ({ docs: rows.map((r) => ({ data: () => r })) }) };
        return q;
      },
    }),
  };
}

test('context: a department camera uses the owner\'s faces and plates plus the department\'s; any other camera only the owner\'s', async () => {
  const db = fakeDb({
    faces: [
      { userId: 'u1', name: 'Mine', imageData: 'aaa' },
      { userId: 'u2', name: 'Team', imageData: 'bbb', departmentId: 'Traffic' },
      { userId: 'u1', name: 'Dup', imageData: 'ccc' }, { userId: 'u3', name: 'Dup', imageData: 'ccc', departmentId: 'Traffic' },
      { userId: 'u9', name: 'Other', imageData: 'ddd', departmentId: 'Water' },
    ],
    watchlist: [{ userId: 'u1', plate: 'GJ01AA0001' }, { userId: 'u2', plate: 'GJ01BB0002', departmentId: 'Traffic' }, { userId: 'u3', plate: 'GJ01AA0001', departmentId: 'Traffic' }, { userId: 'u9', plate: 'GJ09ZZ9999', departmentId: 'Water' }],
  });
  const withDept = await loadUserContext(db, 'u1', 'Traffic');
  assert.deepEqual(withDept.knownFaces.map((f) => f.name), ['Team', 'Dup', 'Mine'], 'the department\'s first, a repeated face once');
  assert.deepEqual(withDept.watchlist.sort(), ['GJ01AA0001', 'GJ01BB0002'], 'a plate on both lists once; Water\'s never');
  const plain = await loadUserContext(db, 'u1');
  assert.deepEqual(plain.knownFaces.map((f) => f.name), ['Mine', 'Dup']);
  assert.deepEqual(plain.watchlist, ['GJ01AA0001']);
  assert.equal(db.asked.filter((a) => a.includes('departmentId')).length, 2, 'only the first call asked for the department\'s documents');
});

test('context: at most six faces reach the model', async () => {
  const faces = Array.from({ length: 10 }, (_, i) => ({ userId: 'u1', name: `P${i}`, imageData: `img${i}` }));
  assert.equal((await loadUserContext(fakeDb({ faces }), 'u1', 'Traffic')).knownFaces.length, 6);
});

// ---- the worker and the log --------------------------------------------------------------------------------------------------------

const wcam = (id: string, extra: Partial<WorkerCamera> = {}): WorkerCamera => ({ id, userId: 'u1', name: id, remoteStreamUrl: `https://x.test/${id}`, interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '', ...extra });

test('worker: the camera\'s department decides which faces and plates are loaded, and goes onto the log; contexts are cached per department', async () => {
  const asked: Array<[string, string | undefined]> = [];
  const logs: any[] = [];
  const seen: any[] = [];
  let clock = 1_000_000;
  const deps: WorkerDeps = {
    now: () => clock, subscribeCameras: () => () => {},
    loadUserContext: async (u, d) => { asked.push([u, d]); return { knownFaces: [], watchlist: [d ?? 'none'] }; },
    grabFrame: async () => Buffer.from('f'),
    analyze: async (input) => { seen.push(input.watchlist); return { summary: 'ok', counts: { people: 0, vehicles: 0, other: 0 } }; },
    writeLog: async (d) => { logs.push(d); }, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {},
    log: { info() {}, warn() {}, error() {} },
  };
  const w = createAnalysisWorker(deps, { concurrency: 4 });
  w._applyCameras([wcam('a', { departmentId: 'Traffic' }), wcam('b', { departmentId: 'Traffic' }), wcam('c'), wcam('d', { department: 'free text only' })]);
  for (let i = 0; i < 12; i++) { w._tick(); await w._idle(); clock += 1000; } // cameras are spread across one 10 s interval
  assert.deepEqual(asked.sort(), [['u1', 'Traffic'], ['u1', undefined]].sort(), 'one load per owner and department, not per camera, and a free-text department is not a department');
  const byCamera = Object.fromEntries(logs.map((l) => [l.cameraId, l]));
  assert.equal(byCamera.a.departmentId, 'Traffic');
  assert.equal('departmentId' in byCamera.c, false, 'no department, no field');
  assert.equal('departmentId' in byCamera.d, false);
  assert.ok(seen.some((s) => s[0] === 'Traffic') && seen.some((s) => s[0] === 'none'));
});

test('log: carries the camera\'s department only when it has one', () => {
  const cam = { id: 'c', name: 'C', sensitivity: 5, userId: 'u1' };
  assert.equal(buildLogDocument({ ...cam, departmentId: 'Traffic' }, {}, T).departmentId, 'Traffic');
  assert.equal('departmentId' in buildLogDocument(cam, {}, T), false);
});

// ---- a gateway asking for a department's data ------------------------------------------------------------------------------

test('gateway: a department\'s faces and plates go only to a gateway that holds one of that department\'s cameras of that user', async () => {
  const asked: Array<[string, string | undefined]> = [];
  const cams = [{ id: 'cam1', userId: 'u1', name: 'c', remoteStreamUrl: 'rtsp://10.0.0.5/1', interval: 60, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '', departmentId: 'Traffic' }];
  const central = createGatewayCentral({
    docs: createMemoryGatewayDocs(), cameras: async () => cams,
    userContext: async (u, d) => { asked.push([u, d]); return { knownFaces: [], watchlist: [] }; },
    sinks: { writeLog: async () => {}, writeSightings: async () => {}, emitEvents: async () => {}, updateCamera: async () => {} }, assignmentCacheMs: 0, log: { info() {}, warn() {} } as never,
  });
  const { gateway } = await central.provision({ name: 'g', region: 'r', ownerId: 'a' });
  await central.userContext(gateway.id, 'u1', 'Traffic');
  await central.userContext(gateway.id, 'u1');
  assert.deepEqual(asked, [['u1', 'Traffic'], ['u1', undefined]]);
  await assert.rejects(central.userContext(gateway.id, 'u1', 'Water'), (e) => e instanceof GatewayError && e.code === 'forbidden');
  await assert.rejects(central.userContext(gateway.id, 'u2', 'Traffic'), (e) => e instanceof GatewayError && e.code === 'forbidden');
});

// ---- the app's merged listeners ------------------------------------------------------------------------------------------------

function fakeListen<T>() {
  let push: (items: Array<[string, T]>) => void = () => {}, fail: (e: unknown) => void = () => {}, stopped = false;
  const listen: Listen<T> = (onItems, onError) => { push = onItems; fail = onError; return () => { stopped = true; }; };
  return { listen, push: (i: Array<[string, T]>) => push(i), fail: (e: unknown) => fail(e), stopped: () => stopped };
}

test('merged listeners: nothing is shown until every source has answered; own and shared documents merge by id; one failing source does not blank the rest', () => {
  const own = fakeListen<string>(), dept = fakeListen<string>();
  const out: string[][] = [], errs: unknown[] = [];
  const stop = subscribeMerged([own.listen, dept.listen], (items) => out.push(items), (e) => errs.push(e));
  own.push([['1', 'mine'], ['2', 'both']]);
  assert.deepEqual(out, [], 'waits for the department query');
  dept.push([['2', 'both-dept'], ['3', 'team']]);
  assert.deepEqual(out.at(-1), ['mine', 'both', 'team'], 'the first source wins a repeated id');
  own.push([['1', 'mine2']]);
  assert.deepEqual(out.at(-1), ['mine2', 'both-dept', 'team']);
  dept.fail(new Error('permission-denied'));
  assert.equal(errs.length, 1);
  assert.deepEqual(out.at(-1), ['mine2'], 'the failed source counts as empty');
  stop();
  assert.ok(own.stopped() && dept.stopped());

  const none: string[][] = [];
  subscribeMerged<string>([], (i) => none.push(i), () => {});
  assert.deepEqual(none, [[]], 'no sources: an empty list, at once');
});
