/**
 * The source store (server/sources/store.ts) and `removeProfile` of the profile store against a REAL PostgreSQL, with the same expectations the
 * in-memory stores are tested with. Skipped unless a database is given:
 *
 *   TEST_DATABASE_URL=postgres://... node --import tsx --test tests/sourceStorePg.test.ts
 *
 * Creates the `camera_sources` table if it is missing (as the server does on start) and otherwise writes only under a throwaway site name,
 * removed afterwards. Neon and similar hosts need TLS: sslmode=require in the URL or TEST_DATABASE_SSL=true.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPostgresSourceStore, type SourceRecord } from '../server/sources/store.ts';
import { createProfileStore, deriveFlags, PROBE_VERSION, type ProbeReport } from '../server/cameraProfile.ts';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'set TEST_DATABASE_URL to run against PostgreSQL';
const SITE = `pgtest-${randomBytes(4).toString('hex')}`;
let pool: import('pg').Pool | null = null;

async function db() {
  if (pool) return pool;
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString: URL, max: 3, ssl: process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  return pool;
}

after(async () => {
  if (!pool) return;
  for (const t of ['camera_sources', 'camera_profiles', 'probe_runs', 'recipe_changes']) await pool.query(`DELETE FROM ${t} WHERE site = $1`, [SITE]).catch(() => {});
  await pool.end();
});

const rec = (id: string, over: Partial<SourceRecord> = {}): SourceRecord => ({
  site: SITE, cameraId: id, adapter: 'hikvision', name: `Cam ${id}`, ref: { host: '10.1.1.5', port: 80, options: { channel: 1 } }, sealed: 'v1.a.b.c',
  registryId: null, ownerUid: 'u1', departmentId: 'Traffic', createdAt: new Date('2026-10-10T10:00:00Z').toISOString(), updatedAt: new Date('2026-10-10T10:00:00Z').toISOString(), ...over,
});

test('postgres source store: put, update in place, get, list in order, remove', { skip }, async () => {
  const store = createPostgresSourceStore(await db());
  await store.ensureSchema();
  await store.put(rec('fed-aaaaaa'));
  await store.put(rec('fed-bbbbbb', { createdAt: new Date('2026-10-10T11:00:00Z').toISOString() }));
  assert.deepEqual((await store.list(SITE)).map((r) => r.cameraId), ['fed-aaaaaa', 'fed-bbbbbb']);
  assert.equal((await store.get(SITE, 'fed-aaaaaa'))!.ref.options!.channel, 1);
  await store.put({ ...rec('fed-aaaaaa'), registryId: 'reg-1', name: 'Renamed' });
  const got = (await store.get(SITE, 'fed-aaaaaa'))!;
  assert.deepEqual([got.registryId, got.name, got.sealed], ['reg-1', 'Renamed', 'v1.a.b.c']);
  assert.equal((await store.list(SITE)).length, 2, 'an update does not add a row');
  assert.equal(await store.get(SITE, 'fed-nope'), null);
  assert.equal(await store.get('some-other-site', 'fed-aaaaaa'), null, 'sites are separate');
  assert.equal(await store.remove(SITE, 'fed-aaaaaa'), true);
  assert.equal(await store.remove(SITE, 'fed-aaaaaa'), false);
  assert.deepEqual((await store.list(SITE)).map((r) => r.cameraId), ['fed-bbbbbb']);
});

test('postgres profile store: removeProfile forgets the profile, the probe history and the recipe changes of one camera only', { skip }, async () => {
  const profiles = createProfileStore(await db());
  await profiles.ensureSchema();
  const report = (id: string): ProbeReport => ({
    cameraId: id, site: SITE, transport: 'tcp', probedAt: new Date().toISOString(), probeVersion: PROBE_VERSION, reachable: true, failure: null, failureDetail: null,
    describe: { codec: 'h264', profile: null, width: 1920, height: 1080, fps: 25, pixFmt: null, hasBFrames: false, bitrate: null } as never, sample: null, whep: null, flags: deriveFlags(null, null),
  });
  await profiles.saveProbe(report('fed-aaaaaa'));
  await profiles.saveProbe(report('fed-bbbbbb'));
  await profiles.recordChange({ site: SITE, cameraId: 'fed-aaaaaa', at: new Date().toISOString(), from: 'A', to: 'C', source: 'auto', trigger: 'test', evidence: {} } as never);
  assert.equal((await profiles.listProfiles(SITE)).length, 2);
  await profiles.removeProfile!(SITE, 'fed-aaaaaa');
  assert.deepEqual((await profiles.listProfiles(SITE)).map((p) => p.report.cameraId), ['fed-bbbbbb']);
  assert.equal((await profiles.history(SITE, 'fed-aaaaaa')).length, 0);
  assert.equal((await profiles.history(SITE, 'fed-bbbbbb')).length, 1);
  assert.equal((await profiles.changes(SITE, 'fed-aaaaaa')).length, 0);
});
