/**
 * Event search (text, tags, department, source, cursor paging, count) and tag editing: the same expectations run against the memory
 * store and, when TEST_DATABASE_URL is set, a real PostgreSQL (rows under throwaway user ids, removed afterwards), then through the routes.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerEventRoutes } from '../server/events/routes.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, createLogChannel } from '../server/events/channels.ts';
import { createMemoryAlertStore, createPostgresAlertStore, type AlertStore } from '../server/events/store.ts';
import { makeEvent, type PlatformEvent } from '../server/events/schema.ts';

const T0 = new Date('2026-10-10T10:00:00.000Z');
const suffix = randomBytes(4).toString('hex');
const A = `evs-${suffix}-a`, B = `evs-${suffix}-b`;
const DEPT1 = `evs-${suffix}-d1`, DEPT2 = `evs-${suffix}-d2`;

interface Spec { type: string; summary: string; ms: number; user: string; dept?: string; source?: string; tags?: string[]; data?: Record<string, unknown>; cam?: string }
const mk = (s: Spec): PlatformEvent => makeEvent(
  { type: s.type, summary: s.summary, source: s.source, tags: s.tags, data: s.data, dedupeKey: s.summary },
  { source: 'test', camera: { id: s.cam ?? 'cam1', name: s.cam === 'cam2' ? 'Ring Road' : 'Main Gate', userId: s.user, department: s.dept }, ts: new Date(T0.getTime() + s.ms) });

const SPECS: Spec[] = [
  { type: 'plate.read', summary: 'Plate GJ03AB1234 read', ms: 0, user: A, dept: DEPT1, data: { plate: 'GJ03AB1234' } },
  { type: 'plate.watchlist_match', summary: 'Watchlist plate GJ03AB1234 seen', ms: 1000, user: A, dept: DEPT1, tags: ['watchlist'], data: { plate: 'GJ03AB1234' } },
  { type: 'vms.motion', summary: 'Motion at the gate', ms: 2000, user: A, dept: DEPT2, source: 'hikvision-events', cam: 'cam2' },
  { type: 'person.unknown', summary: '100% unknown_person', ms: 3000, user: A },
  { type: 'plate.read', summary: 'Plate MH12XY9999 read', ms: 3000, user: B, dept: DEPT1, data: { plate: 'MH12XY9999' } },
];

function contract(name: string, make: () => Promise<{ store: AlertStore; clean(): Promise<void> }>, skip?: string | false) {
  test(`${name}: search, count, paging and tags`, { skip: skip || undefined }, async () => {
    const { store, clean } = await make();
    try {
      await store.ensureSchema();
      const events = SPECS.map(mk);
      await store.saveEvents(events);
      const ids = (list: PlatformEvent[]) => list.map((e) => e.summary);
      const mine = { userId: A };

      // text: summary, details (the plate lives in data), camera name, type, tags; case-insensitive
      assert.deepEqual(ids(await store.queryEvents({ ...mine, text: 'gj03ab1234' })), ['Watchlist plate GJ03AB1234 seen', 'Plate GJ03AB1234 read']);
      assert.deepEqual(ids(await store.queryEvents({ ...mine, text: 'ring road' })), ['Motion at the gate']);
      assert.deepEqual(ids(await store.queryEvents({ ...mine, text: 'watchlist_match' })), ['Watchlist plate GJ03AB1234 seen']);
      // LIKE wildcards in the user's text are matched literally
      assert.deepEqual(ids(await store.queryEvents({ ...mine, text: '100%' })), ['100% unknown_person']);
      assert.deepEqual(await store.queryEvents({ ...mine, text: '%' }).then(ids), ['100% unknown_person']);
      assert.deepEqual(ids(await store.queryEvents({ ...mine, text: 'unknown_person' })), ['100% unknown_person']);
      assert.deepEqual(await store.queryEvents({ ...mine, text: 'un_nown' }), []);

      // tags (all must be present), source, department
      assert.deepEqual(ids(await store.queryEvents({ ...mine, tags: ['watchlist'] })), ['Watchlist plate GJ03AB1234 seen']);
      assert.deepEqual(await store.queryEvents({ ...mine, tags: ['watchlist', 'other'] }), []);
      assert.deepEqual(ids(await store.queryEvents({ ...mine, source: 'hikvision-events' })), ['Motion at the gate']);
      assert.equal((await store.queryEvents({ ...mine, department: DEPT1 })).length, 2);
      // a department filter cannot widen the scope
      assert.equal((await store.queryEvents({ ...mine, department: DEPT2, departments: [DEPT1] })).length, 0);
      assert.equal((await store.queryEvents({ userId: 'nobody', departments: [DEPT1] })).length, 3, 'department scope sees both owners');

      // count ignores paging
      assert.equal(await store.countEvents({ ...mine, limit: 1 }), 4);
      assert.equal(await store.countEvents({ ...mine, types: ['plate.*'] }), 2);
      assert.equal(await store.countEvents({ userId: 'nobody' }), 0);

      // cursor paging: pages of 2 over 4 events, including two events at the same time (ms 3000 for A has one; use all-scope for the tie)
      const pageIds: string[] = [];
      let after: { ts: string; id: string } | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await store.queryEvents({ userId: 'x', departments: [DEPT1, DEPT2], limit: 2, after });
        if (page.length === 0) break;
        pageIds.push(...page.map((e) => e.id));
        after = { ts: page[page.length - 1].ts, id: page[page.length - 1].id };
      }
      const expect = (await store.queryEvents({ userId: 'x', departments: [DEPT1, DEPT2], limit: 100 })).map((e) => e.id);
      assert.equal(expect.length, 4);
      assert.deepEqual(pageIds, expect, 'pages join up with no gap or repeat');

      // tag edits: only inside the caller's scope
      const target = events[0];
      assert.equal(await store.updateEventTags({ userId: B }, target.id, ['x']), null, 'another owner cannot tag it');
      assert.equal(await store.updateEventTags({ userId: 'nobody', departments: [DEPT2] }, target.id, ['x']), null, 'nor another department');
      assert.equal(await store.updateEventTags({ userId: A }, 'missing-id', ['x']), null);
      const byOwner = await store.updateEventTags({ userId: A }, target.id, ['reviewed', 'case-17']);
      assert.deepEqual(byOwner?.tags, ['reviewed', 'case-17']);
      assert.deepEqual(ids(await store.queryEvents({ ...mine, tags: ['case-17'] })), ['Plate GJ03AB1234 read']);
      const byDept = await store.updateEventTags({ userId: 'nobody', departments: [DEPT1] }, target.id, []);
      assert.deepEqual(byDept?.tags, []);
      assert.equal((await store.updateEventTags({ userId: 'x', all: true }, target.id, ['all']))?.tags[0], 'all');
      assert.deepEqual(ids(await store.queryEvents({ ...mine, tags: ['reviewed'] })), []);
    } finally { await clean(); }
  });
}

contract('memory store', async () => ({ store: createMemoryAlertStore(), clean: async () => {} }));

const URL = process.env.TEST_DATABASE_URL;
let pool: import('pg').Pool | null = null;
contract('postgres store', async () => {
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString: URL, max: 3, ssl: process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  return { store: createPostgresAlertStore(pool as never), clean: async () => { await pool!.query('DELETE FROM platform_events WHERE user_id = ANY($1)', [[A, B]]); } };
}, !URL && 'set TEST_DATABASE_URL to run against PostgreSQL');
after(async () => { await pool?.end(); });

// ---- routes ----

async function withApp(run: (call: (user: string | null, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>, store: AlertStore) => Promise<void>, scopes: Record<string, string[] | '*' | null> = {}) {
  const store = createMemoryAlertStore();
  const channels = createChannelRegistry([createLogChannel({ warn: () => {} }) as never]);
  const engine = createAlertEngine({ store, channels, now: () => T0, log: { warn: () => {}, info: () => {} }, ruleCacheMs: 0 });
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, {
    store, engine, channels, now: () => T0,
    requireUser: async (req, res) => { const u = req.header('x-user'); if (!u) { res.status(401).json({ error: 'Sign-in required.' }); return null; } return u; },
    departmentScope: async (_req, userId) => scopes[userId] ?? null,
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (user, method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json };
    }, store);
  } finally { server.close(); }
}

test('routes: search parameters, cursor paging and total', async () => {
  await withApp(async (call, store) => {
    await store.saveEvents(SPECS.map(mk));
    const q = await call(A, 'GET', '/api/events?q=GJ03AB1234&count=1');
    assert.equal(q.status, 200);
    assert.equal(q.json.events.length, 2);
    assert.equal(q.json.total, 2);
    assert.equal(q.json.nextCursor, undefined, 'a short page has no next page');

    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 4; i++) {
      const p = await call(A, 'GET', `/api/events?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(p.status, 200);
      seen.push(...p.json.events.map((e: PlatformEvent) => e.id));
      if (!p.json.nextCursor) break;
      cursor = p.json.nextCursor;
    }
    assert.equal(new Set(seen).size, 4, 'four distinct events over four pages');

    assert.equal((await call(A, 'GET', '/api/events?cursor=not-a-cursor')).status, 400);
    assert.equal((await call(A, 'GET', '/api/events?tag=BAD!')).status, 400);
    assert.equal((await call(A, 'GET', '/api/events?department=a%27b')).status, 400);
    assert.equal((await call(A, 'GET', '/api/events?tag=watchlist')).json.events.length, 1);
    assert.equal((await call(null, 'GET', '/api/events?q=x')).status, 401);
  });
});

test('routes: tag editing needs sign-in, checks the input and respects department scope', async () => {
  await withApp(async (call, store) => {
    const events = SPECS.map(mk);
    await store.saveEvents(events);
    const id = events[0].id; // owner A, DEPT1
    assert.equal((await call(null, 'PUT', `/api/events/${id}/tags`, { tags: ['x'] })).status, 401);
    assert.equal((await call(A, 'PUT', `/api/events/${id}/tags`, { tags: 'x' })).status, 400);
    assert.equal((await call(A, 'PUT', `/api/events/${id}/tags`, { tags: ['bad tag!'] })).status, 400);
    assert.equal((await call(A, 'PUT', `/api/events/${id}/tags`, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).status, 400);
    assert.equal((await call(A, 'PUT', `/api/events/bad%20id/tags`, { tags: [] })).status, 404);
    assert.equal((await call(B, 'PUT', `/api/events/${id}/tags`, { tags: ['x'] })).status, 404, 'another owner sees no such event');

    const ok = await call(A, 'PUT', `/api/events/${id}/tags`, { tags: [' Case-17 ', 'case-17', 'Reviewed'] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.event.tags, ['case-17', 'reviewed'], 'trimmed, lower-cased, de-duplicated');
    assert.equal((await call(A, 'GET', '/api/events?tag=case-17')).json.events.length, 1);
  }, {});

  // a department member can tag a colleague's event; a member of another department cannot
  await withApp(async (call, store) => {
    const events = SPECS.map(mk);
    await store.saveEvents(events);
    const id = events[0].id;
    assert.equal((await call('member', 'PUT', `/api/events/${id}/tags`, { tags: ['seen'] })).status, 200);
    assert.equal((await call('outsider', 'PUT', `/api/events/${id}/tags`, { tags: ['seen'] })).status, 404);
    assert.equal((await call('boss', 'PUT', `/api/events/${id}/tags`, { tags: ['all'] })).status, 200);
    assert.equal((await call('member', 'GET', '/api/events?department=' + DEPT1)).json.events.length, 3);
    assert.equal((await call('member', 'GET', '/api/events?department=' + DEPT2)).json.events.length, 0, 'asking for another department shows nothing');
  }, { member: [DEPT1], outsider: [DEPT2], boss: '*' });
});
