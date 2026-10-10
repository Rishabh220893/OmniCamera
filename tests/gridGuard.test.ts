import test from 'node:test';
import assert from 'node:assert/strict';
import { createGridGuard, createMemoryGridStore, createRedisGridStore, PauseError } from '../server/gridGuard.ts';
import { agoText, friendlyAnalysisError, summariseAnalysis } from '../src/lib/analysisStatus.ts';
import { createAnalysisWorker, type WorkerCamera, type WorkerDeps } from '../server/analysisWorker.ts';
import type { PlatformEvent } from '../server/events/schema.ts';

/** A clock the test moves by hand; sleeping advances it. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}
const quiet = { warn() {} };

test('grab limit: up to the limit per minute go straight through, the next waits for the oldest to age out', async () => {
  const c = clock();
  const g = createGridGuard({ perMinute: 3, maxWaitMs: 120_000, now: c.now, sleep: c.sleep, log: quiet });
  const t0 = c.now();
  for (let i = 0; i < 3; i++) { await g.take(); c.advance(1_000); }
  assert.equal((await g.status()).grabsLastMinute, 3);
  await g.take();                                   // the fourth has to wait until the first is a minute old
  assert.ok(c.now() - t0 >= 60_000, 'waited for a free slot, did not fail');
  assert.equal((await g.status()).grabsLastMinute, 3, 'never more than the limit inside any minute');
});

test('grab limit: a wait that would be too long is a pause (the camera tries again later), not a failure', async () => {
  const c = clock();
  const g = createGridGuard({ perMinute: 1, maxWaitMs: 5_000, now: c.now, sleep: c.sleep, log: quiet });
  await g.take();
  await assert.rejects(g.take(), (e: unknown) => e instanceof PauseError && e.retryAfterMs > 5_000 && /Waiting its turn/.test(e.reason));
});

test('a refusal pauses every grab, doubles on repeats up to six times the base, and ends by itself', async () => {
  const c = clock();
  const g = createGridGuard({ cooldownMs: 60_000, now: c.now, sleep: c.sleep, log: quiet });
  assert.equal(await g.trip('watch time limit reached'), 60);
  await assert.rejects(g.take(), (e: unknown) => e instanceof PauseError && /refusing this account/.test(e.message) && !/\d+s/.test(e.reason), 'the saved reason has no countdown');
  const st = await g.status();
  assert.deepEqual([st.blocked, st.retryAfterSec, st.message, st.refusals], [true, 60, 'watch time limit reached', 1]);
  c.advance(61_000);
  await g.take();                                   // the pause is over
  assert.equal((await g.status()).blocked, false);
  c.advance(1_000);
  assert.equal(await g.trip('again'), 120, 'a refusal right after the pause doubles it');
  c.advance(121_000);
  assert.equal(await g.trip('again'), 240);
  c.advance(241_000);
  assert.equal(await g.trip('again'), 360, 'capped at six times the base');
  c.advance(361_000);
  await g.ok();
  c.advance(10 * 60_000);
  assert.equal(await g.trip('much later'), 60, 'a good grab and a long quiet spell reset it');
});

test('state is shared through the store, so another process sees the pause and the grab counts', async () => {
  const c = clock();
  const kv = new Map<string, string>();
  const redis = { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => { kv.set(k, v); return 'OK'; } };
  const worker = createGridGuard({ now: c.now, sleep: c.sleep, store: createRedisGridStore(redis), log: quiet });
  const web = createGridGuard({ now: c.now, sleep: c.sleep, store: createRedisGridStore(redis), log: quiet });
  await worker.take(); await worker.take();
  assert.equal((await web.status()).grabsLastMinute, 2, 'the web process sees the worker\'s grabs');
  await worker.trip('watch time limit');
  const seen = await web.status();
  assert.deepEqual([seen.blocked, seen.store], [true, 'redis']);
  await assert.rejects(web.take(), PauseError);
});

test('a store that fails never breaks the guard', async () => {
  const bad = { get: async () => { throw new Error('redis down'); }, set: async () => { throw new Error('redis down'); } };
  const g = createGridGuard({ store: createRedisGridStore(bad as never), log: quiet });
  await g.take();                                   // no throw
  assert.equal((await g.status()).blocked, false);
});

// ---- the worker -------------------------------------------------------------------------------------------------------------

test('worker: a paused grab is not a failure: no failure count, no offline event, no back-off, and the next try is when the pause ends', async () => {
  let t = 1_000_000;
  const emitted: PlatformEvent[] = [];
  const updates: Array<[string, Record<string, unknown>]> = [];
  const deps: WorkerDeps = {
    now: () => t, subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: [] }),
    grabFrame: async () => { throw new PauseError('refusing; 240s left', 240_000, 'Paused: the camera grid is refusing this account (limit). Analysis resumes by itself.'); },
    analyze: async () => ({ summary: 'ok' }), writeLog: async () => {}, writeSightings: async () => {},
    updateCamera: async (id, patch) => { updates.push([id, patch as Record<string, unknown>]); }, sendWebhook: async () => {},
    emitEvents: async (e) => { emitted.push(...e); }, log: { info() {}, warn() {}, error() {} },
  };
  const worker = createAnalysisWorker(deps, { concurrency: 1 });
  const camera: WorkerCamera = { id: 'a', userId: 'u1', name: 'Gate', remoteStreamUrl: 'https://x.test/a', interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '' };
  worker._applyCameras([camera]);
  for (let k = 0; k < 6; k++) { t += 5 * 60_000; worker._tick(); await worker._idle(); }
  const st = worker.status().cameras.find((x) => x.id === 'a')!;
  assert.equal(st.failures, 0, 'a pause is not a failed attempt');
  assert.equal(emitted.length, 0, 'so the camera is never reported offline');
  assert.equal(updates.filter(([, p]) => /^Paused:/.test(String(p.lastAnalysisError))).length, 1, 'the reason is saved on the camera once, not on every retry');
});

// ---- what people are told -----------------------------------------------------------------------------------------------------

test('analysis status: waiting, working, paused and failing say different things; unknown errors are shown as they are', () => {
  const now = new Date('2026-10-11T12:00:00Z').getTime();
  const at = (min: number) => new Date(now - min * 60_000);
  assert.equal(summariseAnalysis({ selected: false }, now).state, 'off');
  assert.equal(summariseAnalysis({ selected: true }, now).state, 'waiting');
  const ok = summariseAnalysis({ selected: true, lastAnalysisTime: at(3) }, now);
  assert.deepEqual([ok.state, ok.text], ['ok', 'Analysed 3 min ago']);
  const failing = summariseAnalysis({ selected: true, lastAnalysisTime: at(30), lastAnalysisError: 'Could not capture a frame from the camera stream' }, now);
  assert.equal(failing.state, 'failing');
  assert.match(failing.detail!, /No picture from this camera.*Last analysed 30 min ago/);
  const paused = summariseAnalysis({ selected: true, lastAnalysisError: 'Paused: the camera grid is refusing this account (limit). Analysis resumes by itself.' }, now);
  assert.deepEqual([paused.state, paused.text], ['paused', 'Paused, resumes by itself']);
  assert.equal(friendlyAnalysisError('Something odd happened'), 'Something odd happened');
  assert.equal(friendlyAnalysisError('x'.repeat(300)).length, 160);
  assert.equal(agoText(new Date(now - 10_000), now), 'just now');
  assert.equal(agoText(new Date(now - 3 * 3_600_000), now), '3 h ago');
});
