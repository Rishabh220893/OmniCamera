/** Which live AI answers are saved as log entries: the first, changes, new unusual flags, and a heartbeat; not six identical entries a minute. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_MS, factsFromAnswer, factsKey, markOf, shouldRecord, type LiveAnswerFacts } from '../src/lib/liveAnalysis.ts';

const F = (over: Partial<LiveAnswerFacts> = {}): LiveAnswerFacts => ({ people: 2, vehicles: 1, plates: [], alerts: [], unusual: false, ...over });

test('the first answer is always saved; a repeat of the same facts is not, until the heartbeat', () => {
  assert.equal(shouldRecord(null, F(), 0), true);
  const m = markOf(F(), 1000);
  assert.equal(shouldRecord(m, F(), 11_000), false, 'ten seconds later, nothing changed');
  assert.equal(shouldRecord(m, F(), 1000 + HEARTBEAT_MS - 1), false);
  assert.equal(shouldRecord(m, F(), 1000 + HEARTBEAT_MS), true, 'a quiet scene still leaves one entry a minute');
});

test('a change in what is reported is saved at once: counts, plates, alerts, a new unusual flag', () => {
  const m = markOf(F(), 0);
  assert.equal(shouldRecord(m, F({ people: 3 }), 10_000), true);
  assert.equal(shouldRecord(m, F({ vehicles: 0 }), 10_000), true);
  assert.equal(shouldRecord(m, F({ plates: ['GJ05AB1234'] }), 10_000), true);
  assert.equal(shouldRecord(m, F({ alerts: ['loitering'] }), 10_000), true);
  assert.equal(shouldRecord(m, F({ unusual: true }), 10_000), true);
  const u = markOf(F({ unusual: true }), 0);
  assert.equal(shouldRecord(u, F({ unusual: true }), 10_000), false, 'still the same unusual scene: not repeated every 10 s');
});

test('wording does not matter, order does not matter; plates and alerts compare as sets', () => {
  assert.equal(factsKey(F({ plates: ['B', 'A'], alerts: ['X', 'y'] })), factsKey(F({ plates: ['A', 'B'], alerts: ['Y', 'x'] })));
  assert.notEqual(factsKey(F()), factsKey(F({ unusual: true })));
});

test('facts are read from a model answer, tolerating missing and odd fields', () => {
  assert.deepEqual(factsFromAnswer({ counts: { people: 2, vehicles: 3 }, detected_plates: ['A'], alerts: ['b'], isUnusual: true }), { people: 2, vehicles: 3, plates: ['A'], alerts: ['b'], unusual: true });
  assert.deepEqual(factsFromAnswer({}), { people: 0, vehicles: 0, plates: [], alerts: [], unusual: false });
  assert.deepEqual(factsFromAnswer({ counts: { people: 'x' }, detected_plates: 'no' }).plates, []);
});
