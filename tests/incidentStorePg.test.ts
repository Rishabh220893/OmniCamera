/**
 * The incident store (server/incidents/store.ts) against a REAL PostgreSQL, with the same expectations the in-memory store is tested with.
 * Skipped unless a database is given:
 *
 *   TEST_DATABASE_URL=postgres://... node --import tsx --test tests/incidentStorePg.test.ts
 *
 * Creates the `platform_incidents` table and two indexes if missing (as the server does on start) and writes only rows whose key starts
 * with a throwaway prefix, removed afterwards. Neon and similar hosts need TLS: sslmode=require in the URL or TEST_DATABASE_SSL=true.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createMemoryIncidentStore, createPostgresIncidentStore, type Incident, type IncidentStore } from '../server/incidents/store.ts';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'set TEST_DATABASE_URL to run against PostgreSQL';
const PREFIX = `pgtest-${randomBytes(4).toString('hex')}`;
let pool: import('pg').Pool | null = null;

async function db() {
  if (pool) return pool;
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString: URL, max: 3, ssl: process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  return pool;
}
after(async () => { if (!pool) return; await pool.query('DELETE FROM platform_incidents WHERE key LIKE $1', [`${PREFIX}%`]).catch(() => {}); await pool.end(); });

const inc = (id: string, over: Partial<Incident> = {}): Incident => ({
  id: `${PREFIX}-${id}`, kind: 'plate_trail', key: `${PREFIX}:trail:X`, title: 'Vehicle X seen on 2 cameras', severity: 'notice', state: 'open', eventIds: ['e1', 'e2'], eventCount: 2,
  cameraIds: ['a', 'b'], cameraNames: ['A', 'B'], departments: ['Traffic'], userIds: ['u1'], crossDepartment: false,
  firstAt: '2026-10-11T10:00:00.000Z', lastAt: '2026-10-11T10:10:00.000Z', createdAt: '2026-10-11T10:10:00.000Z', notes: [], ...over,
});

/** One contract, run against both stores. */
async function contract(store: IncidentStore, who: { all: { all: true }; dept: { departments: string[] }; user: { userId: string } }) {
  await store.ensureSchema();
  await store.save(inc('1'));
  await store.save(inc('2', { key: `${PREFIX}:trail:Y`, departments: ['Forest'], userIds: ['u2'], lastAt: '2026-10-11T11:00:00.000Z' }));
  assert.equal((await store.get(`${PREFIX}-1`))?.title, 'Vehicle X seen on 2 cameras');
  assert.equal(await store.get(`${PREFIX}-nope`), null);

  const mine = (await store.list(who.all)).filter((i) => i.key.startsWith(PREFIX));
  assert.deepEqual(mine.map((i) => i.id), [`${PREFIX}-2`, `${PREFIX}-1`], 'newest activity first');
  assert.deepEqual((await store.list(who.dept)).filter((i) => i.key.startsWith(PREFIX)).map((i) => i.id), [`${PREFIX}-1`], 'by department');
  assert.deepEqual((await store.list(who.user)).filter((i) => i.key.startsWith(PREFIX)).map((i) => i.id), [`${PREFIX}-1`], 'by owner of a camera involved');

  assert.equal((await store.findOpen('plate_trail', `${PREFIX}:trail:X`, new Date('2026-10-11T10:05:00Z').getTime()))?.id, `${PREFIX}-1`);
  assert.equal(await store.findOpen('plate_trail', `${PREFIX}:trail:X`, new Date('2026-10-11T10:30:00Z').getTime()), null, 'too old to fold into');
  assert.equal(await store.findOpen('watchlist', `${PREFIX}:trail:X`, 0), null, 'another kind');

  const one = (await store.get(`${PREFIX}-1`))!;
  one.state = 'closed'; one.notes = [{ text: 'handled', by: 'u1', at: '2026-10-11T10:20:00.000Z' }];
  await store.save(one);
  assert.equal(await store.findOpen('plate_trail', `${PREFIX}:trail:X`, 0), null, 'a closed incident is not found');
  assert.deepEqual((await store.list({ ...who.all, state: 'closed' })).filter((i) => i.key.startsWith(PREFIX)).map((i) => i.notes[0]?.text), ['handled']);
  assert.equal((await store.list({ ...who.all, before: new Date('2026-10-11T10:30:00Z') })).filter((i) => i.key.startsWith(PREFIX)).length, 1, 'paging by time');
}

test('memory incident store: the contract', async () => {
  await contract(createMemoryIncidentStore(), { all: { all: true }, dept: { departments: ['Traffic'] }, user: { userId: 'u1' } });
});

test('postgres incident store: the same contract', { skip }, async () => {
  await contract(createPostgresIncidentStore(await db()), { all: { all: true }, dept: { departments: ['Traffic'] }, user: { userId: 'u1' } });
});
