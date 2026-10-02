import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisQueue } from '../server/analysisQueue';
import { backoffDelayMs, createAnalysisWorker, WorkerCamera, WorkerDeps } from '../server/analysisWorker';
import { buildLogDocument } from '../server/logEntry';
import { isSafeCameraUrl } from '../server/frameSource';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('queue never exceeds its concurrency and dedupes by key', async () => {
  const q = createAnalysisQueue({ concurrency: 2 });
  let running = 0, peak = 0;
  const job = async () => { running++; peak = Math.max(peak, running); await sleep(20); running--; };
  for (let i = 0; i < 6; i++) assert.equal(q.enqueue(`cam${i}`, job), true);
  assert.equal(q.enqueue('cam0', job), false, 'a camera already queued/running is not queued twice');
  await q.idle();
  assert.equal(peak, 2);
  assert.equal(q.stats().active, 0);
  assert.equal(q.enqueue('cam0', job), true, 'key is free again once the job finishes');
  await q.idle();
});

test('queue survives a throwing job', async () => {
  const q = createAnalysisQueue({ concurrency: 1 });
  let ran = false;
  q.enqueue('a', async () => { throw new Error('boom'); });
  q.enqueue('b', async () => { ran = true; });
  await q.idle();
  assert.equal(ran, true);
});

test('backoff grows per failure and is capped', () => {
  assert.equal(backoffDelayMs(10_000, 0, 300_000), 10_000);
  assert.equal(backoffDelayMs(10_000, 1, 300_000), 20_000);
  assert.equal(backoffDelayMs(10_000, 3, 300_000), 80_000);
  assert.equal(backoffDelayMs(10_000, 20, 300_000), 300_000);
  assert.equal(backoffDelayMs(600_000, 2, 300_000), 600_000, 'never shorter than the camera interval');
});

test('log document matches the browser-produced shape and rules', () => {
  const cam = { id: 'c1', name: 'Gate', sensitivity: 5, userId: 'u1' };
  const now = new Date('2026-01-01T00:00:00Z');
  const doc = buildLogDocument(cam, {
    summary: 'A van', counts: { people: 1, vehicles: 1, other: 0 }, brands: ['Acme'],
    people_identified: ['Unknown Person'], detected_plates: ['GJ01AB1234'], watchlistMatches: ['GJ01AB1234'], sentiment: 'weird',
  }, now);
  assert.equal(doc.isWatchlistMatch, true);
  assert.equal(doc.isUnusual, true);
  assert.equal(doc.sentiment, 'neutral', 'unknown sentiment falls back to neutral');
  assert.equal(doc.alerts[0], 'Watchlist match: GJ01AB1234');
  assert.match(doc.summary, /Detected brands: Acme\. People: Unknown Person/);
  assert.equal(doc.userId, 'u1');
  const quiet = buildLogDocument({ ...cam, sensitivity: 2 }, { people_identified: ['Unknown Person'] }, now);
  assert.equal(quiet.isUnusual, false, 'unknown person only matters above sensitivity 3');
});

test('unsafe camera URLs are rejected', () => {
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://10.0.0.5/a', 'http://192.168.1.2/a', 'http://172.20.0.1/a', 'file:///etc/passwd', 'ftp://x.com/a', 'not a url', 'http://[::1]/a', 'http://db.internal/a']) {
    assert.equal(isSafeCameraUrl(bad), false, bad);
  }
  for (const good of ['https://cctv.corp8.cloud/cam01/index.m3u8', 'rtsp://103.250.160.189:8554/stream/cam01', 'http://172.32.0.1/a']) {
    assert.equal(isSafeCameraUrl(good), true, good);
  }
});

function makeWorker(over: Partial<WorkerDeps> = {}, opts = {}) {
  let t = 1_000_000;
  const logs: any[] = [];
  const updates: Array<[string, any]> = [];
  const webhooks: any[] = [];
  const sightings: any[] = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const deps: WorkerDeps = {
    now: () => t,
    subscribeCameras: () => () => {},
    loadUserContext: async () => ({ knownFaces: [], watchlist: ['X1'] }),
    grabFrame: async () => Buffer.from('frame'),
    analyze: async () => ({ summary: 'ok', counts: { people: 0, vehicles: 0, other: 0 } }),
    writeLog: async (d) => { logs.push(d); },
    writeSightings: async (userId, s) => { sightings.push([userId, s]); },
    updateCamera: async (id, patch) => { updates.push([id, patch]); },
    sendWebhook: async (u, p) => { webhooks.push([u, p]); },
    log: quiet,
    ...over,
  };
  const worker = createAnalysisWorker(deps, { concurrency: 2, ...opts });
  return { worker, logs, updates, webhooks, sightings, advance: (ms: number) => { t += ms; } };
}
const cam = (id: string, extra: Partial<WorkerCamera> = {}): WorkerCamera => ({
  id, userId: 'u1', name: id, remoteStreamUrl: `https://x.test/${id}`, interval: 10, sensitivity: 5,
  peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '', ...extra,
});

test('worker analyses a camera at once, writes a log, updates the camera, then waits an interval', async () => {
  const { worker, logs, updates, advance } = makeWorker();
  worker._applyCameras([cam('a')]);
  worker._tick();
  await worker._idle();
  assert.equal(logs.length, 1, 'the first (or only) camera starts immediately');
  assert.equal(logs[0].analyzedBy, 'server');
  assert.equal(updates[0][0], 'a');
  worker._tick();
  await worker._idle();
  assert.equal(logs.length, 1, 'not due again until an interval has passed');
  advance(10_000);
  worker._tick();
  await worker._idle();
  assert.equal(logs.length, 2);
});

test('cameras added together are spread evenly across the interval, not fired at once', async () => {
  const { worker, logs, advance } = makeWorker();
  worker._applyCameras(['c', 'a', 'd', 'b'].map((id) => cam(id)));
  const starts: number[] = [];
  for (let s = 0; s < 10; s++) {
    const before = logs.length;
    worker._tick(); await worker._idle();
    starts.push(logs.length - before);
    advance(1000);
  }
  // 4 cameras over a 10 s interval are due at 0, 2.5, 5 and 7.5 s → they start on the ticks at 0, 3, 5 and 8 s.
  assert.deepEqual(starts, [1, 0, 0, 1, 0, 1, 0, 0, 1, 0]);
  assert.equal(logs.length, 4);
});

test('worker passes the user watchlist/faces to analysis and fires the webhook', async () => {
  let seen: any;
  const { worker, webhooks, advance } = makeWorker({ analyze: async (i) => { seen = i; return { summary: 's' }; } });
  worker._applyCameras([cam('a', { webhookUrl: 'https://hook.test/x' })]);
  advance(10_000);
  worker._tick();
  await worker._idle();
  assert.deepEqual(seen.watchlist, ['X1']);
  assert.equal(seen.imageBase64, Buffer.from('frame').toString('base64'));
  await sleep(5);
  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0][0], 'https://hook.test/x');
});

test('a failing camera backs off, records its error once, and does not block healthy cameras', async () => {
  const { worker, logs, updates, advance } = makeWorker({
    grabFrame: async (c) => { if (c.id === 'bad') throw new Error('stream down'); return Buffer.from('f'); },
  });
  worker._applyCameras([cam('bad'), cam('good')]);
  advance(10_000);
  worker._tick();
  await worker._idle();
  assert.equal(logs.length, 1, 'good camera still analysed');
  assert.equal(worker.status().cameras.find((c) => c.id === 'bad')!.failures, 1);

  advance(10_000); // base interval — but bad is now backing off to 20s
  worker._tick();
  await worker._idle();
  assert.equal(worker.status().cameras.find((c) => c.id === 'bad')!.failures, 1, 'still backing off');

  advance(10_000);
  worker._tick();
  await worker._idle();
  const bad = worker.status().cameras.find((c) => c.id === 'bad')!;
  assert.equal(bad.failures, 2);
  assert.equal(updates.filter(([id, p]) => id === 'bad' && p.lastAnalysisError).length, 1, 'same error persisted only once');
});

test('a camera that recovers clears its error', async () => {
  let fail = true;
  const { worker, updates, advance } = makeWorker({ grabFrame: async () => { if (fail) throw new Error('down'); return Buffer.from('f'); } });
  worker._applyCameras([cam('a')]);
  advance(10_000); worker._tick(); await worker._idle();
  fail = false;
  advance(20_000); worker._tick(); await worker._idle();
  assert.equal(worker.status().cameras[0].lastError, null);
  assert.ok(updates.some(([, p]) => p.lastAnalysisError === null));
});

test('cameras removed from the subscription stop being scheduled; edits keep schedule state', async () => {
  const { worker, logs, advance } = makeWorker();
  worker._applyCameras([cam('a'), cam('b')]);
  worker._applyCameras([cam('a', { name: 'Renamed' })]);
  assert.deepEqual(worker.status().cameras.map((c) => c.id), ['a']);
  assert.equal(worker.status().cameras[0].name, 'Renamed');
  advance(10_000); worker._tick(); await worker._idle();
  assert.equal(logs.length, 1);
});

test('a slow camera is never queued twice while its run is in flight', async () => {
  let calls = 0;
  const { worker, advance } = makeWorker({ grabFrame: async () => { calls++; await sleep(50); return Buffer.from('f'); } });
  worker._applyCameras([cam('a')]);
  advance(10_000);
  worker._tick(); worker._tick(); worker._tick();
  await worker._idle();
  assert.equal(calls, 1);
});

test('worker records a plate sighting per plate with camera location, and survives a sighting write failure', async () => {
  const analyze = async () => ({
    summary: 's', detected_plates: ['GJ01AB1234'], plate_source: 'anpr',
    plate_reads: [{ plate: 'GJ01AB1234', confidence: 0.92, formatValid: true, corrected: false }],
  });
  const ok = makeWorker({ analyze });
  ok.worker._applyCameras([cam('a', { location: { lat: 23, lng: 72 }, department: 'Police' })]);
  ok.advance(10_000); ok.worker._tick(); await ok.worker._idle();
  assert.equal(ok.sightings.length, 1);
  const [userId, list] = ok.sightings[0];
  assert.equal(userId, 'u1');
  assert.deepEqual([list[0].plate, list[0].confidence, list[0].source, list[0].cameraId, list[0].department], ['GJ01AB1234', 0.92, 'anpr', 'a', 'Police']);
  assert.deepEqual(list[0].location, { lat: 23, lng: 72 });

  const failing = makeWorker({ analyze, writeSightings: async () => { throw new Error('firestore down'); } });
  failing.worker._applyCameras([cam('a')]);
  failing.advance(10_000); failing.worker._tick(); await failing.worker._idle();
  assert.equal(failing.logs.length, 1, 'the log is still written');
  assert.equal(failing.worker.status().cameras[0].lastError, null, 'and the camera is not marked failed');
});

test('cadence is measured from when a run started, with a short floor if a run outlasts its interval', async () => {
  let advanceFn: (ms: number) => void = () => {};
  const { worker, advance } = makeWorker({ grabFrame: async () => { advanceFn(25_000); return Buffer.from('f'); } });
  advanceFn = advance;
  worker._applyCameras([cam('slow')]); // interval 10 s, but a run "takes" 25 s
  const start = Date.parse(worker.status().cameras[0].nextDueAt);
  worker._tick(); await worker._idle();
  const next = Date.parse(worker.status().cameras[0].nextDueAt);
  assert.equal(next - start, 25_000 + 2_000, 'run overran its interval → next run 2 s after it finished, not instantly');

  const fast = makeWorker();
  fast.worker._applyCameras([cam('quick')]);
  const t0 = Date.parse(fast.worker.status().cameras[0].nextDueAt);
  fast.worker._tick(); await fast.worker._idle();
  assert.equal(Date.parse(fast.worker.status().cameras[0].nextDueAt) - t0, 10_000, 'a quick run keeps the exact 10 s cadence');
});
