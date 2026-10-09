import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileStore, PROFILE_SCHEMA } from '../server/cameraProfile.ts';

// The SQL of the self-heal floor and the change log, checked without a database: every placeholder has a parameter, nothing user-supplied
// is in the statement text, and rows map back to the right shapes. (tests/profileStorePg.test.ts runs the same against a real PostgreSQL.)
function fake(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const store = createProfileStore({ query: async (text, params) => { calls.push({ text, params: params ?? [] }); return { rows }; } });
  return { store, calls };
}
const placeholders = (sql: string) => new Set(sql.match(/\$\d+/g)).size;

test('change log and floor: placeholders match parameters and the text carries no input', async () => {
  const { store, calls } = fake();
  const evil = "x'; DROP TABLE camera_profiles; --";
  await store.setHealFloor('grid', evil, { recipe: 'B', reason: evil, at: '2026-10-09T11:30:00.000Z' });
  await store.setHealFloor('grid', 'cam01', null);
  await store.recordChange({ site: 'grid', cameraId: evil, at: '2026-10-09T11:30:00.000Z', from: 'A', to: 'B', source: 'auto', trigger: evil, evidence: { a: evil } });
  await store.changes('grid', evil, 9999);
  await store.changes('grid', null, 0);
  await store.getProfile('grid', evil);
  for (const c of calls) {
    assert.equal(placeholders(c.text), c.params.length, c.text);
    assert.ok(!c.text.includes('DROP TABLE'), c.text);
  }
  assert.deepEqual(calls[1].params, ['grid', 'cam01', null, null, null], 'clearing sets every floor column to NULL');
  assert.equal(calls[3].params[2], 500, 'a page is capped');
  assert.equal(calls[4].params[1], 1, 'and has at least one row');
  assert.match(PROFILE_SCHEMA, /CREATE TABLE IF NOT EXISTS recipe_changes/);
  assert.match(PROFILE_SCHEMA, /ADD COLUMN IF NOT EXISTS heal_floor/, 'an existing database is migrated, not recreated');
});

test('rows map to profiles with a floor, and to changes with ISO times', async () => {
  const profile = { site: 'grid', camera_id: 'cam01' };
  const a = fake([{ profile, recipe_override: null, override_reason: null, failure: null, consecutive_failures: 0, latest_failure: null, heal_floor: 'F', heal_reason: 'why', heal_at: new Date('2026-10-09T11:30:00Z') }]);
  const row = await a.store.getProfile('grid', 'cam01');
  assert.deepEqual(row?.healFloor, { recipe: 'F', reason: 'why', at: '2026-10-09T11:30:00.000Z' });
  const none = fake([{ profile, recipe_override: 'A', override_reason: 'r', failure: null, consecutive_failures: 0, latest_failure: null, heal_floor: null }]);
  assert.equal((await none.store.getProfile('grid', 'cam01'))?.healFloor, null);
  assert.equal((await fake([]).store.getProfile('grid', 'cam01')), null);
  const ch = fake([{ site: 'grid', camera_id: 'cam01', at: new Date('2026-10-09T12:00:00Z'), from_recipe: 'A', to_recipe: 'B', source: 'dry', trigger: 't', evidence: { k: 1 } }]);
  assert.deepEqual(await ch.store.changes('grid', null), [{ site: 'grid', cameraId: 'cam01', at: '2026-10-09T12:00:00.000Z', from: 'A', to: 'B', source: 'dry', trigger: 't', evidence: { k: 1 } }]);
});
