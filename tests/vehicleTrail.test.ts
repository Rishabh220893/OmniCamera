/**
 * The statewide vehicle trail (gap A18): a trail across departments built from the shared events, legs and flags, look-alike suggestions and
 * confirmations, visibility (a department you do not cover is a count only), paging, and the routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildTrail, summarisePlates, trailFor, collectReads } from '../server/trail/trail.ts';
import { registerTrailRoutes } from '../server/trail/routes.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { makeEvent, type PlatformEvent } from '../server/events/schema.ts';
import type { Principal } from '../server/authz/policy.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const min = (m: number) => new Date(NOW.getTime() - m * 60_000); // minutes ago
const cam = (id: string, department: string | undefined, lat: number, lng: number, userId = 'owner') => ({ id, name: `Camera ${id}`, userId, department, location: { lat, lng } });
// Ahmedabad, Gandhinagar (~25 km), Surat (~230 km), Rajkot (~215 km from Ahmedabad)
const AMD = (id = 'amd') => cam(id, 'Traffic', 23.0225, 72.5714);
const GNR = (id = 'gnr') => cam(id, 'Police', 23.2156, 72.6369);
const SRT = (id = 'srt') => cam(id, 'Municipal', 21.1702, 72.8311);

let n = 0;
const read = (c: ReturnType<typeof AMD>, plate: string, minutesAgo: number, extra: { confidence?: number } = {}): PlatformEvent =>
  makeEvent({ type: 'plate.read', summary: `Plate ${plate} read`, data: { plate, confidence: extra.confidence ?? 0.9 }, dedupeKey: `${plate}-${++n}` }, { source: 'anpr', camera: c, ts: min(minutesAgo) });

async function world() {
  const store = createMemoryAlertStore();
  await store.saveEvents([
    read(AMD(), 'GJ05AB1234', 300), read(AMD(), 'GJ05AB1234', 296), // two reads at one camera: one visit
    read(GNR(), 'GJ05AB1234', 240),                                  // 25 km in about 56 min: plausible
    read(SRT(), 'GJ05AB1234', 235),                                  // 200+ km in 5 min: implausible speed
    read(AMD('amd2'), 'GJ05AB1Z34', 100),                            // a look-alike misread (letter Z for digit 2 at one position)
    read(AMD(), 'MH12DE1433', 50), read(GNR(), 'MH12DE1433', 40),
    read(AMD(), 'GJ05AB1234', 60 * 24 * 20),                         // 20 days ago: outside a 7 day window
    makeEvent({ type: 'plate.watchlist_match', summary: 'Watchlist plate GJ05AB1234 seen', data: { plate: 'GJ05AB1234' }, dedupeKey: 'wl' }, { source: 'anpr', camera: AMD(), ts: min(300) }),
  ]);
  const departments = async () => [{ name: 'Traffic' }, { name: 'Police' }, { name: 'Municipal' }];
  return { store, deps: { events: store, departments } };
}
const w7 = { from: new Date(NOW.getTime() - 7 * 86_400_000), to: NOW };

test('trail: reads of one plate across departments in order; a double read at one camera is one visit; the legs carry distance, time and speed', async () => {
  const { deps } = await world();
  const t = await trailFor(deps, { userId: 'admin', all: true }, 'gj 05 ab 1234', w7);
  assert.equal(t.plate, 'GJ05AB1234');
  assert.equal(t.reads, 4, 'the watchlist event and the 20-day-old read are not part of a 7-day trail');
  assert.deepEqual(t.route.segments.map((s) => s.cameraId), ['amd', 'gnr', 'srt']);
  assert.equal(t.route.segments[0].sightings.length, 2);
  assert.deepEqual(t.departments, ['Municipal', 'Police', 'Traffic']);
  const [l1, l2] = t.route.legs;
  assert.equal(l1.distanceKm! > 20 && l1.distanceKm! < 30, true, `Ahmedabad to Gandhinagar is about 25 km (${l1.distanceKm})`);
  assert.deepEqual(l1.flags, [], 'about 25 km in under an hour is possible');
  assert.deepEqual(l2.flags, ['implausible_speed'], 'about 200 km in five minutes is flagged');
  assert.equal(t.route.totalDistanceKm > 200, true);
  assert.equal(t.notes.some((x) => /misread or two vehicles/.test(x)), true);
});

test('look-alikes: a plate one OCR edit away is suggested, not merged; confirming it adds its reads to the trail as a confirmed look-alike', async () => {
  const { deps } = await world();
  const t = await trailFor(deps, { userId: 'a', all: true }, 'GJ05AB1234', w7);
  assert.deepEqual(t.possible.map((p) => p.plate), ['GJ05AB1Z34']);
  assert.equal(t.possible[0].distance <= 1, true);
  assert.equal(t.route.segments.some((s) => s.cameraId === 'amd2'), false, 'not merged until a person confirms it');
  const c = await trailFor(deps, { userId: 'a', all: true }, 'GJ05AB1234', { ...w7, also: ['gj05ab1z34', 'GJ05AB1234', 'ZZ'] });
  assert.deepEqual(c.confirmed, ['GJ05AB1Z34', 'ZZ'], 'the searched plate itself is dropped from the list; the rest are normalised');
  assert.equal(c.route.segments.some((s) => s.cameraId === 'amd2' && s.sightings[0].matchedAs === 'confirmed'), true);
  assert.equal(c.possible.length, 0, 'a confirmed plate is no longer a suggestion');
});

test('visibility: a department user builds the trail from their own reads and sees the others only as a count', async () => {
  const { deps } = await world();
  const t = await trailFor(deps, { userId: 'tom', departments: ['Traffic'] }, 'GJ05AB1234', w7);
  assert.deepEqual(t.route.segments.map((s) => s.cameraId), ['amd']);
  assert.deepEqual(t.elsewhere, [{ department: 'Police', reads: 1 }, { department: 'Municipal', reads: 1 }]);
  const json = JSON.stringify(t);
  assert.equal(json.includes('Camera gnr') || json.includes('Camera srt'), false, 'no other department camera is named');
  assert.equal(t.notes.some((x) => /count, not where or when|how many reads, not where or when/.test(x)), true);
  const both = await trailFor(deps, { userId: 'x', departments: ['Traffic', 'Police'] }, 'GJ05AB1234', w7);
  assert.deepEqual(both.route.segments.map((s) => s.cameraId), ['amd', 'gnr']);
  assert.deepEqual(both.elsewhere, [{ department: 'Municipal', reads: 1 }]);
});

test('plates list: distinct plates with reads, cameras and departments, busiest first; paging reads past 500; the cap says it cut short', async () => {
  const { store, deps } = await world();
  const { events } = await collectReads(deps, { userId: 'a', all: true }, w7.from, w7.to);
  const list = summarisePlates(events);
  assert.deepEqual(list.map((p) => [p.plate, p.reads]), [['GJ05AB1234', 4], ['MH12DE1433', 2], ['GJ05AB1Z34', 1]]);
  assert.deepEqual(list[0].departments, ['Municipal', 'Police', 'Traffic']);
  await store.saveEvents(Array.from({ length: 650 }, (_, i) => read(AMD(), `BULK${String(i).padStart(4, '0')}`, 10 + i / 1000)));
  const all = await collectReads(deps, { userId: 'a', all: true }, w7.from, w7.to);
  assert.equal(all.truncated, false);
  assert.equal(all.events.length >= 657, true);
  const cut = await collectReads(deps, { userId: 'a', all: true }, w7.from, w7.to, 600);
  assert.deepEqual([cut.events.length, cut.truncated], [600, true]);
});

test('buildTrail with no reads is an empty route, not an error', () => {
  const t = buildTrail([], 'GJ05AB1234', w7);
  assert.deepEqual([t.reads, t.route.segments.length, t.route.legs.length, t.possible.length], [0, 0, 0, 0]);
});

// ---- HTTP ----------------------------------------------------------------------------------------------------------------------------

async function withApp(run: (call: (path: string, user?: string) => Promise<{ status: number; json: any; text: string; headers: Headers }>) => Promise<void>) {
  const { deps } = await world();
  const people: Record<string, Principal> = {
    root: { uid: 'root', role: 'admin', departments: ['*'], source: 'claims' }, tom: { uid: 'tom', role: 'operator', departments: ['Traffic'], source: 'claims' },
  };
  const app = express();
  registerTrailRoutes(app, { ...deps, now: () => NOW, allow: async (req, res) => { const p = people[req.header('x-user') ?? '']; if (!p) { res.status(401).json({ error: 'no' }); return null; } return p; } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (path, user) => { const r = await fetch(base + path, { headers: user ? { 'x-user': user } : {} }); const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ } return { status: r.status, json, text, headers: r.headers }; });
  } finally { server.close(); }
}

test('http: sign-in needed; the plate list and a trail; csv evidence; bad input is 400; scope applies', async () => {
  await withApp(async (call) => {
    assert.equal((await call('/api/trail/plates')).status, 401);
    assert.equal((await call('/api/trail/GJ05AB1234')).status, 401);
    const list = await call('/api/trail/plates?q=mh12', 'root');
    assert.deepEqual(list.json.plates.map((p: any) => p.plate), ['MH12DE1433']);
    const trail = await call('/api/trail/gj05%20ab1234', 'root');
    assert.equal(trail.status, 200);
    assert.deepEqual([trail.json.reads, trail.json.route.segments.length, trail.json.route.legs[1].flags], [4, 3, ['implausible_speed']]);
    assert.equal(trail.headers.get('cache-control'), 'no-store');
    const tom = await call('/api/trail/GJ05AB1234', 'tom');
    assert.deepEqual([tom.json.route.segments.length, tom.json.elsewhere.length], [1, 2]);
    const csv = await call('/api/trail/GJ05AB1234?format=csv', 'root');
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.text.split('\n')[0], /^Segment,Timestamp,Camera,Department/);
    assert.equal(csv.text.trim().split('\n').length, 1 + 4);
    for (const bad of ['/api/trail/AB', '/api/trail/GJ05AB1234?days=0', '/api/trail/GJ05AB1234?days=91', '/api/trail/GJ05AB1234?format=pdf', '/api/trail/GJ05AB1234?also=a,b,c,d,e,f', '/api/trail/GJ05AB1234?also=ZZ', '/api/trail/plates?days=abc']) {
      assert.equal((await call(bad, 'root')).status, 400, bad);
    }
    const withAlso = await call('/api/trail/GJ05AB1234?also=GJ05AB1Z34', 'root');
    assert.equal(withAlso.json.reads, 5);
  });
});

test('plate filter: the store finds a plate however it was typed, by its letters and digits (the indexed lookup incidents and the other-department counts use)', async () => {
  const store = createMemoryAlertStore();
  await store.saveEvents([read(AMD(), 'GJ05AB1234', 5), read(GNR(), 'gj 05-ab 1234', 4), read(AMD(), 'GJ05AB1235', 3), makeEvent({ type: 'person.seen', summary: 'x', data: { count: 2 }, dedupeKey: 'p' }, { source: 's', camera: AMD(), ts: min(2) })]);
  const found = await store.queryEvents({ userId: '', all: true, plate: ' GJ05 ab1234 ', limit: 50 });
  assert.equal(found.length, 2);
  assert.equal(await store.countEvents({ userId: '', all: true, plate: 'GJ05AB1235' }), 1);
  assert.equal(await store.countEvents({ userId: '', all: true, plate: 'ZZ99ZZ9999' }), 0);
  assert.equal((await store.queryEvents({ userId: '', all: true, plate: '', limit: 50 })).length, 4, 'an empty plate is no filter');
});

test('visibility: reads already in the trail (a user with no department sees their own cameras) are not counted again as elsewhere', async () => {
  const { store, deps } = await world();
  await store.saveEvents([read(cam('own-police', 'Police', 23.1, 72.6, 'tom'), 'GJ05AB1234', 30), read(cam('own-traffic', 'Traffic', 23.0, 72.5, 'tom'), 'GJ05AB1234', 20)]);
  const t = await trailFor(deps, { userId: 'tom' }, 'GJ05AB1234', w7);
  assert.deepEqual(t.route.segments.map((s) => s.cameraId).sort(), ['own-police', 'own-traffic']);
  // Others' reads in the window: Traffic 2 (amd), Police 1 (gnr), Municipal 1 (srt) and one 20 days old (outside); their own two are not counted twice.
  assert.deepEqual(t.elsewhere, [{ department: 'Traffic', reads: 2 }, { department: 'Police', reads: 1 }, { department: 'Municipal', reads: 1 }]);
});
