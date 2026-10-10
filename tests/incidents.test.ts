import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createCorrelator, normalisePlate } from '../server/incidents/correlator.ts';
import { registerIncidentRoutes } from '../server/incidents/routes.ts';
import { createMemoryIncidentStore, incidentVisible } from '../server/incidents/store.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { makeEvent, type EventDraft, type PlatformEvent } from '../server/events/schema.ts';

const T0 = new Date('2026-10-11T10:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000);
const cam = (id: string, over: { userId?: string; department?: string } = {}) => ({ id, name: `Camera ${id}`, userId: over.userId ?? 'u1', department: over.department });

function ev(draft: EventDraft, camera: ReturnType<typeof cam>, ts: Date): PlatformEvent {
  return makeEvent(draft, { source: draft.source ?? 'anpr', camera, ts });
}
const plate = (p: string, camera: ReturnType<typeof cam>, ts: Date, over: Partial<EventDraft> = {}) => ev({ type: 'plate.read', summary: `Plate ${p} read`, data: { plate: p }, dedupeKey: p, ...over }, camera, ts);

/** The alert engine stores events before the correlator looks at them; this does the same. */
function lab() {
  const events = createMemoryAlertStore();
  const store = createMemoryIncidentStore();
  let n = 0;
  const correlator = createCorrelator({ events, store, newId: () => `inc${++n}`, now: () => new Date(T0 + 24 * 3_600_000), log: { warn() {} } });
  const feed = async (list: PlatformEvent[]) => { await events.saveEvents(list); return correlator.observe(list); };
  return { events, store, feed };
}
const all = (s: ReturnType<typeof createMemoryIncidentStore>) => s.list({ all: true });

test('plates: the same plate is compared however it was typed', () => {
  assert.equal(normalisePlate('gj 05-AB 1234'), 'GJ05AB1234');
  assert.equal(normalisePlate(undefined), '');
});

test('plate trail: one camera is not an incident; the same plate on a second camera is, and a third folds into it', async () => {
  const { store, feed } = lab();
  assert.deepEqual(await feed([plate('GJ05AB1234', cam('a'), at(0))]), []);
  assert.deepEqual(await feed([plate('GJ05AB1234', cam('a'), at(5))]), [], 'the same camera again is still one place');
  const made = await feed([plate('gj 05 ab 1234', cam('b'), at(10))]);
  assert.equal(made.length, 1);
  assert.equal(made[0].kind, 'plate_trail');
  assert.equal(made[0].key, 'trail:GJ05AB1234');
  assert.deepEqual(made[0].cameraIds.sort(), ['a', 'b']);
  assert.equal(made[0].eventCount, 3, 'every sighting in the window joins it');
  assert.match(made[0].title, /2 cameras/);
  await feed([plate('GJ05AB1234', cam('c'), at(20))]);
  const list = await all(store);
  assert.equal(list.length, 1, 'folded, not duplicated');
  assert.deepEqual(list[0].cameraIds.sort(), ['a', 'b', 'c']);
  assert.match(list[0].title, /3 cameras/);
  assert.equal(list[0].lastAt, at(20).toISOString());
});

test('plate trail: sightings further apart than the window are not one trail; other plates do not mix', async () => {
  const { store, feed } = lab();
  await feed([plate('AA11AA1111', cam('a'), at(0))]);
  assert.deepEqual(await feed([plate('AA11AA1111', cam('b'), at(0 + 61))]), [], 'more than an hour apart');
  await feed([plate('BB22BB2222', cam('a'), at(100))]);
  await feed([plate('CC33CC3333', cam('b'), at(101))]);
  assert.equal((await all(store)).length, 0);
});

test('plate trail across departments is marked, raised to a warning, and visible to both departments but not to a third', async () => {
  const { store, feed } = lab();
  await feed([plate('GJ01XY9999', cam('a', { userId: 'u1', department: 'Traffic' }), at(0))]);
  const [i] = await feed([plate('GJ01XY9999', cam('b', { userId: 'u2', department: 'Forest' }), at(3))]);
  assert.equal(i.crossDepartment, true);
  assert.equal(i.severity, 'warning');
  assert.deepEqual(i.departments.sort(), ['Forest', 'Traffic']);
  assert.match(i.title, /2 departments/);
  assert.equal(incidentVisible(i, { departments: ['Traffic'] }), true);
  assert.equal(incidentVisible(i, { departments: ['Forest'] }), true);
  assert.equal(incidentVisible(i, { departments: ['Excise'] }), false);
  assert.equal(incidentVisible(i, { all: true }), true);
  assert.equal(incidentVisible(i, { userId: 'u2' }), true);
  assert.equal(incidentVisible(i, { userId: 'u3' }), false);
  assert.equal((await store.list({ departments: ['Excise'] })).length, 0);
});

test('watchlist: one sighting is enough, it is critical, and further sightings fold into the same incident', async () => {
  const { store, feed } = lab();
  const [i] = await feed([plate('GJ09ZZ0001', cam('a'), at(0), { type: 'plate.watchlist_match', summary: 'Watchlist plate seen' })]);
  assert.equal(i.kind, 'watchlist');
  assert.equal(i.severity, 'critical');
  await feed([plate('GJ09ZZ0001', cam('a'), at(7), { type: 'plate.watchlist_match', summary: 'Watchlist plate seen again' })]);
  const list = await all(store);
  assert.equal(list.length, 1);
  assert.equal(list[0].eventCount, 2);
});

test('multi-source: two different systems on one camera within minutes make an incident; one system alone does not', async () => {
  const { store, feed } = lab();
  const c = cam('gate', { department: 'Traffic' });
  assert.deepEqual(await feed([ev({ type: 'vms.intrusion', summary: 'Intrusion', source: 'hikvision-events' }, c, at(0))]), []);
  assert.deepEqual(await feed([ev({ type: 'vms.motion', summary: 'Motion', source: 'hikvision-events' }, c, at(1))]), [], 'the same system twice is still one witness');
  const [i] = await feed([ev({ type: 'person.unknown', summary: 'Unknown person', source: 'gemini-scene' }, c, at(2))]);
  assert.equal(i.kind, 'multi_source');
  assert.equal(i.key, 'cam:gate');
  assert.ok(['warning', 'critical'].includes(i.severity));
  assert.equal(i.eventCount, 3);
  assert.equal((await all(store)).length, 1);
});

test('multi-source: reports too far apart, other cameras, and bookkeeping events do not count', async () => {
  const { store, feed } = lab();
  await feed([ev({ type: 'vms.motion', summary: 'Motion', source: 'hik' }, cam('a'), at(0))]);
  await feed([ev({ type: 'person.unknown', summary: 'Unknown', source: 'gemini-scene' }, cam('a'), at(10))]);
  await feed([ev({ type: 'person.unknown', summary: 'Unknown', source: 'gemini-scene' }, cam('b'), at(10))]);
  await feed([ev({ type: 'vehicle.seen', summary: '2 vehicles seen', source: 'gemini-scene' }, cam('c'), at(30)), ev({ type: 'vms.motion', summary: 'Motion', source: 'hik' }, cam('c'), at(30))]);
  assert.equal((await all(store)).length, 0);
});

test('observing the same events again changes nothing, and a closed incident is not reopened by later events', async () => {
  const { store, feed } = lab();
  const first = plate('GJ05AB1234', cam('a'), at(0));
  const second = plate('GJ05AB1234', cam('b'), at(2));
  await feed([first, second]);
  assert.deepEqual(await feed([second]), [], 'a repeat adds nothing');
  const [i] = await all(store);
  i.state = 'closed';
  await store.save(i);
  await feed([plate('GJ05AB1234', cam('c'), at(4))]);
  const list = await all(store);
  assert.equal(list.length, 2, 'new activity after closing starts a new incident');
  assert.equal(list.filter((x) => x.state === 'open').length, 1);
});

test('a failure while correlating never throws out of observe', async () => {
  const bad = createCorrelator({ events: { queryEvents: async () => { throw new Error('store down'); } }, store: createMemoryIncidentStore(), log: { warn() {} } });
  assert.deepEqual(await bad.observe([plate('GJ05AB1234', cam('a'), at(0))]), []);
});

// ---- routes ------------------------------------------------------------------------------------------------------------

async function withRoutes(run: (c: { call: (method: string, p: string, who: string, body?: unknown) => Promise<{ status: number; json: any }>; feed: ReturnType<typeof lab>['feed'] }) => Promise<void>) {
  const l = lab();
  const app = express();
  app.use(express.json());
  // Test callers: X-User picks who they are; ann is in Traffic, raj is in Forest, boss is organisation-wide, viewer1 may not handle.
  const DEPT: Record<string, string[] | '*' | null> = { ann: ['Traffic'], raj: ['Forest'], boss: '*', u1: null, stranger: null, viewer1: ['Traffic'] };
  registerIncidentRoutes(app, {
    store: l.store, events: l.events, now: () => new Date(T0),
    requireUser: async (req, res, permission) => {
      const who = String(req.header('X-User'));
      if (who === 'none') { res.status(401).json({ error: 'no' }); return null; }
      if (permission === 'alert.handle' && who === 'viewer1') { res.status(403).json({ error: 'no' }); return null; }
      return who;
    },
    departmentScope: async (_req, userId) => DEPT[userId] ?? null,
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ feed: l.feed, call: async (method, p, who, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-User': who }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json: any = null; try { json = await r.json(); } catch { /* none */ }
      return { status: r.status, json };
    } });
  } finally { server.close(); }
}

test('incident routes: list and detail by scope; a department sees the incident but only its own events inside it', async () => {
  await withRoutes(async ({ call, feed }) => {
    await feed([plate('GJ01XY9999', cam('a', { userId: 'u1', department: 'Traffic' }), at(0))]);
    const [inc] = await feed([plate('GJ01XY9999', cam('b', { userId: 'u2', department: 'Forest' }), at(3))]);
    assert.equal((await call('GET', '/api/incidents', 'ann')).json.incidents.length, 1);
    assert.equal((await call('GET', '/api/incidents', 'raj')).json.incidents.length, 1);
    assert.equal((await call('GET', '/api/incidents', 'boss')).json.incidents.length, 1);
    assert.equal((await call('GET', '/api/incidents', 'stranger')).json.incidents.length, 0);
    assert.equal((await call('GET', '/api/incidents', 'none')).status, 401);

    const ann = (await call('GET', `/api/incidents/${inc.id}`, 'ann')).json;
    assert.equal(ann.incident.crossDepartment, true);
    assert.deepEqual(ann.events.map((e: PlatformEvent) => e.department), ['Traffic'], 'only her department\'s event');
    assert.equal(ann.hiddenEvents, 1);
    const boss = (await call('GET', `/api/incidents/${inc.id}`, 'boss')).json;
    assert.equal(boss.events.length, 2);
    assert.equal(boss.hiddenEvents, 0);
    assert.equal((await call('GET', `/api/incidents/${inc.id}`, 'stranger')).status, 404, 'a hidden incident looks missing');
    assert.equal((await call('GET', '/api/incidents/..%2Fx', 'boss')).status, 404);
  });
});

test('incident routes: close, reopen and notes need permission and visibility', async () => {
  await withRoutes(async ({ call, feed }) => {
    await feed([plate('GJ01XY9999', cam('a', { department: 'Traffic' }), at(0))]);
    const [inc] = await feed([plate('GJ01XY9999', cam('b', { department: 'Traffic' }), at(3))]);
    assert.equal((await call('POST', `/api/incidents/${inc.id}/close`, 'viewer1')).status, 403);
    assert.equal((await call('POST', `/api/incidents/${inc.id}/close`, 'raj')).status, 404, 'not visible to Forest');
    const closed = await call('POST', `/api/incidents/${inc.id}/close`, 'ann');
    assert.equal(closed.json.incident.state, 'closed');
    assert.equal(closed.json.incident.closedBy, 'ann');
    assert.equal((await call('GET', '/api/incidents?state=open', 'ann')).json.incidents.length, 0);
    assert.equal((await call('GET', '/api/incidents?state=closed', 'ann')).json.incidents.length, 1);
    assert.equal((await call('POST', `/api/incidents/${inc.id}/reopen`, 'ann')).json.incident.state, 'open');
    assert.equal((await call('POST', `/api/incidents/${inc.id}/notes`, 'ann', { text: '  Called the unit.  ' })).json.incident.notes[0].text, 'Called the unit.');
    assert.equal((await call('POST', `/api/incidents/${inc.id}/notes`, 'ann', { text: '' })).status, 400);
    assert.equal((await call('POST', `/api/incidents/${inc.id}/notes`, 'ann', { text: 'x'.repeat(1001) })).status, 400);
    assert.equal((await call('GET', `/api/incidents/${inc.id}`, 'ann')).json.incident.notes.length, 1);
  });
});
