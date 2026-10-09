import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createProfileStore, FAILURES_BEFORE_REPLACING_PROFILE, type ProbeReport } from '../server/cameraProfile.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

// Runs against a real PostgreSQL: the rule that a failed probe does not replace a good profile is SQL, which a fake cannot check.
//   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres node --import tsx --test tests/profileStorePg.test.ts
const URL = process.env.TEST_DATABASE_URL;

test('store on PostgreSQL: a failed probe keeps the good profile until it has failed three times in a row', { skip: !URL && 'set TEST_DATABASE_URL to run against PostgreSQL' }, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: URL, max: 2 });
  const site = `test-${randomBytes(4).toString('hex')}`;
  const store = createProfileStore(pool);
  const at = (n: number) => `2026-10-09T10:0${n}:00.000Z`;
  const good = (n: number): ProbeReport => ({ ...GRID_REPORTS[0], site, cameraId: 'camX', probedAt: at(n) });
  const bad = (n: number, detail = 'no frame within 60s'): ProbeReport => ({ ...GRID_REPORTS[0], site, cameraId: 'camX', probedAt: at(n), failure: 'no_frame', failureDetail: detail, describe: null, sample: null, flags: [] });
  const stored = async () => (await store.listProfiles(site))[0];
  try {
    await store.ensureSchema();
    await store.ensureSchema();
    assert.equal(FAILURES_BEFORE_REPLACING_PROFILE, 3);

    assert.deepEqual(await store.saveProbe(good(0)), { kept: false, consecutiveFailures: 0 });
    await store.saveDecision(site, 'camX', { recipe: 'A', reason: 'clean' });

    // First and second failure: the good profile stays, and the failure is shown.
    assert.deepEqual(await store.saveProbe(bad(1)), { kept: true, consecutiveFailures: 1 });
    let row = await stored();
    assert.equal(row.report.failure, null);
    assert.equal(row.report.probedAt, at(0));
    assert.deepEqual(row.lastFailure, { probedAt: at(1), failure: 'no_frame', detail: 'no frame within 60s', inARow: 1 });
    assert.deepEqual(await store.saveProbe(bad(2, 'ffprobe timed out')), { kept: true, consecutiveFailures: 2 });
    row = await stored();
    assert.deepEqual([row.report.failure, row.lastFailure?.inARow, row.lastFailure?.detail], [null, 2, 'ffprobe timed out']);

    // Every run, good or not, is in the history.
    assert.deepEqual((await store.history(site, 'camX')).map((r) => r.failure), ['no_frame', 'no_frame', null]);

    // The third failure in a row replaces the profile: this camera really has no video now.
    assert.deepEqual(await store.saveProbe(bad(3)), { kept: false, consecutiveFailures: 3 });
    row = await stored();
    assert.equal(row.report.failure, 'no_frame');
    assert.equal(row.lastFailure, null, 'the stored profile now is the failure, so there is nothing "earlier" to report');

    // A good probe brings it back and resets the count.
    assert.deepEqual(await store.saveProbe(good(4)), { kept: false, consecutiveFailures: 0 });
    row = await stored();
    assert.deepEqual([row.report.failure, row.report.probedAt, row.lastFailure], [null, at(4), null]);
    assert.deepEqual(await store.saveProbe(bad(5)), { kept: true, consecutiveFailures: 1 }, 'the count starts again after a good probe');

    // A camera whose very first probe failed has nothing good to keep.
    await store.saveProbe({ ...bad(6), cameraId: 'camY' });
    const y = (await store.listProfiles(site)).find((r) => r.report.cameraId === 'camY')!;
    assert.equal(y.report.failure, 'no_frame');
    assert.equal(y.lastFailure, null);

    // The recipe columns and the override survive a kept failure.
    await store.setOverride(site, 'camX', 'B', 'forced');
    await store.saveProbe(bad(7));
    row = (await store.listProfiles(site)).find((r) => r.report.cameraId === 'camX')!;
    assert.deepEqual([row.override, row.overrideReason, row.report.failure], ['B', 'forced', null]);
    const { rows: [d] } = await pool.query(`SELECT recipe FROM camera_profiles WHERE site = $1 AND camera_id = 'camX'`, [site]);
    assert.equal(d.recipe, 'A');
  } finally {
    await pool.query(`DELETE FROM camera_profiles WHERE site = $1`, [site]);
    await pool.query(`DELETE FROM probe_runs WHERE site = $1`, [site]);
    await pool.end();
  }
});

test('store on PostgreSQL: the self-heal floor and the change log round-trip, and a later probe keeps the floor', { skip: !URL && 'set TEST_DATABASE_URL to run against PostgreSQL' }, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: URL, max: 2 });
  const site = `test-${randomBytes(4).toString('hex')}`;
  const store = createProfileStore(pool);
  const probe = (n: number): ProbeReport => ({ ...GRID_REPORTS[0], site, cameraId: 'camH', probedAt: `2026-10-09T11:0${n}:00.000Z` });
  try {
    await store.ensureSchema();
    assert.equal(await store.getProfile(site, 'camH'), null);
    await store.saveProbe(probe(0));
    assert.equal((await store.getProfile(site, 'camH'))?.healFloor, null);

    await store.setHealFloor(site, 'camH', { recipe: 'B', reason: '3 muxer crashes in 2 min', at: '2026-10-09T11:30:00.000Z' });
    let row = await store.getProfile(site, 'camH');
    assert.deepEqual(row?.healFloor, { recipe: 'B', reason: '3 muxer crashes in 2 min', at: '2026-10-09T11:30:00.000Z' });
    assert.deepEqual((await store.listProfiles(site))[0].healFloor, row?.healFloor);

    await store.saveProbe(probe(1)); // a new probe replaces the measurements, not the floor
    assert.equal((await store.getProfile(site, 'camH'))?.healFloor?.recipe, 'B');

    await store.recordChange({ site, cameraId: 'camH', at: '2026-10-09T11:30:00.000Z', from: 'A', to: 'B', source: 'auto', trigger: '3 muxer crashes in 2 min', evidence: { events: [{ kind: 'dts_error' }], rtpPacketsLost: 1000 } });
    await store.recordChange({ site, cameraId: 'camH', at: '2026-10-09T12:00:00.000Z', from: 'B', to: 'F', source: 'dry', trigger: 'again', evidence: {} });
    await store.recordChange({ site, cameraId: 'camOther', at: '2026-10-09T12:05:00.000Z', from: 'A', to: 'B', source: 'manual', trigger: 'x', evidence: {} });
    const mine = await store.changes(site, 'camH');
    assert.deepEqual(mine.map((c) => `${c.from}>${c.to}:${c.source}`), ['B>F:dry', 'A>B:auto'], 'newest first, this camera only');
    assert.deepEqual(mine[1].evidence, { events: [{ kind: 'dts_error' }], rtpPacketsLost: 1000 });
    assert.equal((await store.changes(site, null)).length, 3);
    assert.equal((await store.changes(site, null, 1)).length, 1);

    await store.setHealFloor(site, 'camH', null);
    row = await store.getProfile(site, 'camH');
    assert.equal(row?.healFloor, null);
  } finally {
    await pool.query(`DELETE FROM camera_profiles WHERE site = $1`, [site]);
    await pool.query(`DELETE FROM probe_runs WHERE site = $1`, [site]);
    await pool.query(`DELETE FROM recipe_changes WHERE site = $1`, [site]);
    await pool.end();
  }
});
