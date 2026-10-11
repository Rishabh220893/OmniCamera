/**
 * The registry's PostGIS mirror: rows from Firestore documents, parameterised SQL, and above all that it fails soft (a broken database or a
 * bad document never reaches the app; callers are told "not available" and use Firestore). Uses a fake database and a fake Firestore listener:
 * the real SQL has to be checked on a PostGIS database (npm run registry-postgis-check).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistryMirror, fromRow, selectSql, startRegistrySync, toRow, upsertSql, type SnapshotLike, type SqlClient } from '../server/registry/postgis.ts';

class FakeDb implements SqlClient {
  calls: Array<{ text: string; params?: unknown[] }> = [];
  failAlways = false; rows: any[] = [];
  async query(text: string, params?: unknown[]) {
    this.calls.push({ text, params });
    if (this.failAlways) throw new Error('connection refused');
    return { rows: this.rows, rowCount: this.rows.length };
  }
}
const quiet = () => {};

test('toRow: good documents map, bad values become null instead of failing the batch', () => {
  const r = toRow('c1', { userId: 'u', name: 'MG Road', department: 'Traffic', location: { lat: 12.97, lng: 77.59 }, installDate: '2023-06-15', connectivityStatus: 'online' });
  assert.deepEqual([r.lat, r.lng, r.installDate, r.connectivityStatus], [12.97, 77.59, '2023-06-15', 'online']);
  const bad = toRow('c2', { name: 5, location: { lat: 95, lng: 10 }, installDate: 'soon', connectivityStatus: '', department: { x: 1 } });
  assert.deepEqual([bad.lat, bad.lng, bad.installDate, bad.name, bad.department, bad.connectivityStatus, bad.userId], [null, null, null, '', null, 'unknown', '']);
  assert.equal(toRow('c3', { location: { lat: 12, lng: 'x' } }).lat, null, 'half a location is no location');
  assert.equal(toRow('x'.repeat(500), {}).id.length, 200);
});

test('SQL: values are always bound parameters, never spliced into the text', () => {
  const evil = "'; DROP TABLE registry_cameras; --";
  const u = upsertSql([toRow('c1', { name: evil, userId: evil, location: { lat: 1, lng: 2 } })]);
  assert.equal(u.text.includes('DROP TABLE'), false);
  assert.ok(u.params.includes(evil));
  assert.ok(u.params.includes('POINT(2 1)'), 'longitude first');
  const q = selectSql(evil, { q: evil + '%_', department: evil, status: evil, type: evil, installedBefore: '2020-01-01', bbox: [77, 12, 78, 13] });
  assert.equal(q.text.includes('DROP TABLE'), false);
  const placeholders: string[] = q.text.match(/\$\d+/g) ?? [];
  assert.equal(placeholders.every((p) => Number(p.slice(1)) <= q.params.length), true, 'every placeholder has a value');
  assert.equal(q.params[0], evil);
  assert.ok(q.params.some((p) => typeof p === 'string' && p.startsWith('%') && p.includes('\\%') && p.includes('\\_')), 'LIKE wildcards in the search text are escaped');
  assert.deepEqual(q.params.slice(-4), [77, 12, 78, 13]);
});

test('fromRow gives the API the same field names Firestore documents use', () => {
  const c = fromRow({ id: 'c1', user_id: 'u', name: 'A', department: 'T', camera_type: 'ptz', connectivity_status: 'online', maintenance_status: 'operational', install_date: '2020-01-02', lat: 1.5, lng: 2.5 });
  assert.deepEqual(c, { id: 'c1', userId: 'u', name: 'A', department: 'T', cameraType: 'ptz', connectivityStatus: 'online', maintenanceStatus: 'operational', installDate: '2020-01-02', location: { lat: 1.5, lng: 2.5 } });
});

test('mirror: not ready until initialised and the first copy is marked; then reads come from the database', async () => {
  const db = new FakeDb(); const m = createRegistryMirror(db, quiet);
  assert.equal(await m.list('u', {}), null, 'before init: callers use Firestore');
  assert.equal(await m.init(), true);
  assert.equal(await m.list('u', {}), null, 'initialised but the first copy is not complete: still Firestore');
  m.markReady();
  db.rows = [{ id: 'c1', user_id: 'u', name: 'A', connectivity_status: 'online', maintenance_status: 'operational' }];
  assert.deepEqual((await m.list('u', {}))!.map((c) => c.id), ['c1']);
  assert.equal(m.status().ready, true);
});

test('mirror fails soft: a failing database makes it "not ready" (callers fall back), never an exception; it recovers on a good write', async () => {
  const db = new FakeDb(); const m = createRegistryMirror(db, quiet);
  await m.init(); m.markReady();
  db.failAlways = true;
  for (let i = 0; i < 3; i++) assert.equal(await m.list('u', {}), null);
  assert.equal(m.status().ready, false);
  assert.match(m.status().lastError ?? '', /connection refused/);
  await m.apply([{ id: 'c1', data: { name: 'A' } }], []); // a write while the database is down: swallowed
  db.failAlways = false;
  await m.apply([{ id: 'c1', data: { name: 'A' } }], []);
  assert.equal(m.status().ready, true, 'a successful write restores trust');

  const dead = new FakeDb(); dead.failAlways = true; const m2 = createRegistryMirror(dead, quiet); // PostGIS not available
  assert.equal(await m2.init(), false);
  const before = dead.calls.length;
  await m2.apply([{ id: 'x', data: {} }], ['y']);
  assert.equal(dead.calls.length, before, 'a mirror that could not initialise does not keep hitting the database');
  assert.equal(await m2.list('u', {}), null);
  assert.equal(await m2.gaps('u', { radiusMeters: 300 }), null);
});

test('sync: the first snapshot is the backfill and marks the mirror ready; later changes upsert and delete in order; a listener error re-subscribes', async () => {
  const db = new FakeDb(); const m = createRegistryMirror(db, quiet); await m.init();
  let next!: (s: SnapshotLike) => void, onErr!: (e: Error) => void; let subscribed = 0, unsub = 0;
  const source = { collection: () => ({ onSnapshot: (n: any, e: any) => { subscribed++; next = n; onErr = e; return () => { unsub++; }; } }) };
  const doc = (id: string, data: Record<string, unknown> = {}) => ({ id, data: () => data });
  const stop = startRegistrySync(source, m, { log: quiet, retryMs: 5 });
  assert.equal(await m.list('u', {}), null, 'not ready before the first snapshot is applied');
  next({ docChanges: () => [{ type: 'added', doc: doc('a', { name: 'A', userId: 'u' }) }, { type: 'added', doc: doc('b', { name: 'B', userId: 'u' }) }] });
  next({ docChanges: () => [{ type: 'modified', doc: doc('a', { name: 'A2', userId: 'u' }) }, { type: 'removed', doc: doc('b') }] });
  await new Promise((r) => setTimeout(r, 30));
  const ins = db.calls.filter((c) => c.text.startsWith('INSERT'));
  assert.equal(ins.length, 2);
  assert.equal(ins[0].params![3], 'A'); assert.equal(ins[1].params![3], 'A2', 'in order');
  assert.ok(db.calls.some((c) => c.text.startsWith('DELETE') && (c.params![0] as string[]).includes('b')));
  assert.notEqual(await m.list('u', {}), null, 'ready after the backfill');
  onErr(new Error('permission denied'));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(subscribed, 2, 're-subscribed after the error');
  assert.ok(unsub >= 1);
  stop();
});

test('a batch bigger than one INSERT is split, and each statement stays under the parameter limit', async () => {
  const db = new FakeDb(); const m = createRegistryMirror(db, quiet); await m.init();
  await m.apply(Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, data: { name: `n${i}` } })), []);
  const ins = db.calls.filter((c) => c.text.startsWith('INSERT'));
  assert.equal(ins.length, 3);
  assert.ok(ins.every((c) => (c.params?.length ?? 0) <= 65_535));
});

test('gaps: fewer than 3 located cameras answers without a grid query; a database error is null, not a throw', async () => {
  const db = new FakeDb(); const m = createRegistryMirror(db, quiet); await m.init(); m.markReady();
  db.rows = [{ cameras: 2, located: 2, min_lng: 1, min_lat: 1, max_lng: 2, max_lat: 2 }];
  const g = await m.gaps('u', { radiusMeters: 300 });
  assert.deepEqual([g!.located, g!.cellsChecked, g!.zones.length], [2, 0, 0]);
  db.failAlways = true;
  assert.equal(await m.gaps('u', { radiusMeters: 300 }), null);
});
