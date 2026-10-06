import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createMotionGate, diffFingerprints, ffmpegFingerprint, Fingerprint } from '../server/frameGate';
import { createAnalysisWorker, WorkerCamera, WorkerDeps } from '../server/analysisWorker';
import type { AnalysisJob, JobBackend, JobOutcome, OutcomeListener } from '../server/jobBackend';
import { redisConnectionFromUrl } from '../server/bullBackend';
import { checkFfmpeg } from '../server/frameSource';
import { createFirestoreEventStore, createPostgresEventStore, createTeeEventStore, EventStore, isNotable, LogDocument, PgLike } from '../server/eventStore';
import { buildLogDocument } from '../server/logEntry';
import type { PlateSighting } from '../src/lib/plateTracking';

const flat = (v: number): Fingerprint => new Uint8Array(64 * 36).fill(v);
/** A frame whose first `fraction` of pixels are bright, on an otherwise dark scene. */
const withBlob = (fraction: number): Fingerprint => { const f = flat(20); f.fill(200, 0, Math.round(64 * 36 * fraction)); return f; };

// A "frame" in these tests is just a tag; the injected fingerprint function maps it to pixels.
const frames: Record<string, Fingerprint> = { empty: flat(20), empty2: flat(22), person: withBlob(0.05), bigger: withBlob(0.2), junk: new Uint8Array(0) };
const gateFor = (extra = {}) => createMotionGate({ fingerprint: async (b) => (b.toString() === 'broken' ? null : frames[b.toString()]), ...extra });

test('gate: first frame is analysed, an unchanged scene is skipped, a real change is analysed', async () => {
  const gate = gateFor();
  const a = await gate.check('c1', Buffer.from('empty'), 0);
  assert.deepEqual([a.analyze, a.reason], [true, 'first-frame']);
  a.commit();
  const b = await gate.check('c1', Buffer.from('empty2'), 60_000);
  assert.deepEqual([b.analyze, b.reason], [false, 'unchanged'], 'sensor noise / tiny brightness drift is not motion');
  const c = await gate.check('c1', Buffer.from('person'), 120_000);
  assert.deepEqual([c.analyze, c.reason], [true, 'changed']);
  assert.deepEqual(gate.stats(), { skipped: 1, analysed: 1 });
});

test('gate: the baseline is the last ANALYSED frame, so a failed analysis does not hide a change and slow drift still triggers', async () => {
  const gate = gateFor();
  (await gate.check('c1', Buffer.from('empty'), 0)).commit();
  const changed = await gate.check('c1', Buffer.from('person'), 1000);
  assert.equal(changed.analyze, true);
  // analysis failed → commit() never called → the same change must be reported again, not swallowed
  const again = await gate.check('c1', Buffer.from('person'), 2000);
  assert.equal(again.analyze, true, 'still counts as changed because the old baseline was kept');
  again.commit();
  assert.equal((await gate.check('c1', Buffer.from('person'), 3000)).analyze, false, 'now it is the baseline');
});

test('gate: heartbeat forces an analysis of a quiet scene, and each camera has its own baseline', async () => {
  const gate = gateFor({ maxSkipMs: 600_000 });
  (await gate.check('c1', Buffer.from('empty'), 0)).commit();
  (await gate.check('c2', Buffer.from('person'), 0)).commit();
  assert.equal((await gate.check('c1', Buffer.from('empty'), 599_000)).analyze, false);
  const hb = await gate.check('c1', Buffer.from('empty'), 600_000);
  assert.deepEqual([hb.analyze, hb.reason], [true, 'heartbeat']);
  assert.equal((await gate.check('c2', Buffer.from('person'), 1000)).analyze, false, 'c2 compared with c2, not c1');
});

test('gate: fails open — a frame that cannot be fingerprinted is analysed', async () => {
  const gate = gateFor();
  const d = await gate.check('c1', Buffer.from('broken'), 0);
  assert.deepEqual([d.analyze, d.reason], [true, 'unreadable']);
});

test('diffFingerprints: identical → 0, different sizes → treated as fully changed', () => {
  assert.deepEqual(diffFingerprints(flat(5), flat(5)), { changedFraction: 0, meanDelta: 0 });
  assert.equal(diffFingerprints(flat(5), new Uint8Array(10)).changedFraction, 1);
});

test('ffmpeg fingerprint: a real JPEG gives a 64x36 grid, and moving content shows up as change', async (t) => {
  if (!(await checkFfmpeg()).available) return t.skip('ffmpeg not installed');
  const jpeg = (filter: string) => {
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { maxBuffer: 10_000_000 });
    assert.equal(r.status, 0, String(r.stderr));
    return r.stdout as Buffer;
  };
  const dark = await ffmpegFingerprint(jpeg('color=c=black:s=640x360'));
  const darkAgain = await ffmpegFingerprint(jpeg('color=c=0x050505:s=640x360'));
  const bright = await ffmpegFingerprint(jpeg('color=c=white:s=640x360'));
  assert.equal(dark?.length, 64 * 36);
  assert.equal(diffFingerprints(dark!, darkAgain!).changedFraction, 0);
  assert.equal(diffFingerprints(dark!, bright!).changedFraction, 1);
  assert.equal(await ffmpegFingerprint(Buffer.from('not an image')), null);
});

// ---------------------------------------------------------------------------
// Worker + gate
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cam = (id: string): WorkerCamera => ({ id, userId: 'u1', name: id, remoteStreamUrl: `https://x.test/${id}`, interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '' });

function deps(over: Partial<WorkerDeps> & { clock: { t: number } }): WorkerDeps & { logs: any[]; updates: any[]; analyses: number } {
  const state = { logs: [] as any[], updates: [] as any[], analyses: 0 };
  const d: any = {
    now: () => over.clock.t,
    subscribeCameras: () => () => {},
    loadUserContext: async () => ({ knownFaces: [], watchlist: [] }),
    grabFrame: async () => Buffer.from('empty'),
    analyze: async () => { state.analyses++; return { summary: 'ok' }; },
    writeLog: async (doc: any) => { state.logs.push(doc); },
    writeSightings: async () => {},
    updateCamera: async (id: string, patch: any) => { state.updates.push([id, patch]); },
    sendWebhook: async () => {},
    log: { info() {}, warn() {}, error() {} },
    ...over,
  };
  Object.defineProperty(d, 'logs', { get: () => state.logs });
  Object.defineProperty(d, 'updates', { get: () => state.updates });
  Object.defineProperty(d, 'analyses', { get: () => state.analyses });
  return d;
}

test('worker with a gate: unchanged scenes make no model call, no log, no camera write; a change goes through', async () => {
  const clock = { t: 1_000_000 };
  let frame = 'empty';
  const d = deps({ clock, gate: gateFor(), grabFrame: async () => Buffer.from(frame) });
  const w = createAnalysisWorker(d, { concurrency: 1 });
  w._applyCameras([cam('a')]);
  const runOnce = async () => { w._tick(); await w._idle(); clock.t += 10_000; };
  await runOnce();                       // first frame → analysed
  await runOnce(); await runOnce();      // unchanged ×2 → skipped
  assert.equal(d.analyses, 1);
  assert.equal(d.logs.length, 1);
  assert.equal(d.updates.length, 1, 'only the analysed run touched the camera record');
  frame = 'person';
  await runOnce();
  assert.equal(d.analyses, 2);
  assert.equal(w.status().skippedUnchanged, 2);
  assert.equal(w.status().cameras[0].failures, 0, 'a skip is a healthy run');
});

test('worker with a gate: a failing analysis does not become the baseline, so the next run retries it', async () => {
  const clock = { t: 1_000_000 };
  let fail = true;
  const d = deps({ clock, gate: gateFor(), analyze: async () => { if (fail) throw new Error('gemini 503'); return { summary: 'ok' }; } });
  const w = createAnalysisWorker(d, { concurrency: 1 });
  w._applyCameras([cam('a')]);
  w._tick(); await w._idle();
  assert.equal(w.status().cameras[0].failures, 1);
  fail = false; clock.t += 600_000;
  w._tick(); await w._idle();
  assert.equal(d.logs.length, 1, 'the scene was analysed on the retry instead of being skipped as "unchanged"');
  assert.equal(w.status().cameras[0].failures, 0);
});

// ---------------------------------------------------------------------------
// Scheduler and executor as separate processes
// ---------------------------------------------------------------------------

/** Two views of one shared queue — what Redis gives two processes. */
function sharedQueue() {
  const waiting = new Map<string, AnalysisJob>();
  let handler: ((j: AnalysisJob) => Promise<JobOutcome>) | null = null;
  const listeners: OutcomeListener[] = [];
  let active = 0;
  const pump = () => {
    if (!handler) return;
    for (const [id, job] of [...waiting]) {
      waiting.delete(id); active++;
      handler(job).then((o) => listeners.forEach((l) => l(id, o)), (e) => listeners.forEach((l) => l(id, { crashed: String(e.message) }))).finally(() => { active--; });
    }
  };
  const view = (kind: 'bull'): JobBackend => ({
    kind,
    async enqueue(job) { if (waiting.has(job.camera.id)) return false; waiting.set(job.camera.id, job); setTimeout(pump, 0); return true; },
    startConsuming(h) { handler = h; setTimeout(pump, 0); },
    onOutcome(l) { listeners.push(l); },
    stats: async () => ({ queued: waiting.size, active, concurrency: 1 }),
    idle: async () => { while (waiting.size || active) await sleep(2); },
    close: async () => {},
  });
  return { scheduler: view('bull'), worker: view('bull'), jobsWaiting: () => waiting.size };
}

test('scheduler-only and worker-only processes cooperate over a shared queue; failures and backoff flow back', async () => {
  const clock = { t: 1_000_000 };
  const q = sharedQueue();
  let failB = true;
  const schedulerDeps = deps({ clock });
  schedulerDeps.grabFrame = async () => { throw new Error('the scheduler must never capture frames'); };
  const workerDeps = deps({ clock, grabFrame: async (c) => { if (c.id === 'b' && failB) throw new Error('camera offline'); return Buffer.from('empty'); } });
  const scheduler = createAnalysisWorker({ ...schedulerDeps, backend: q.scheduler }, { role: 'scheduler' });
  const worker = createAnalysisWorker({ ...workerDeps, backend: q.worker }, { role: 'worker' });
  worker.start();
  scheduler._applyCameras([cam('a'), cam('b')]);
  clock.t += 10_000;
  scheduler._tick();
  await sleep(30); await q.scheduler.idle();
  await sleep(5);
  assert.equal(workerDeps.logs.length, 1, 'camera a was analysed by the worker process');
  const st = scheduler.status();
  assert.equal(st.role, 'scheduler');
  assert.equal(st.cameras.find((c) => c.id === 'a')!.lastSuccessAt !== null, true, 'the scheduler learned a succeeded');
  const b = st.cameras.find((c) => c.id === 'b')!;
  assert.equal(b.failures, 1, 'the scheduler learned b failed');
  assert.equal(b.lastError, 'camera offline');
  assert.ok(Date.parse(b.nextDueAt) >= clock.t + 20_000, 'and backed it off');
  // recovery: failure history travels in the job, so the worker (which keeps none) still clears the error
  failB = false; clock.t += 60_000;
  scheduler._tick(); await sleep(30); await q.scheduler.idle(); await sleep(5);
  assert.equal(scheduler.status().cameras.find((c) => c.id === 'b')!.failures, 0);
  assert.ok(workerDeps.updates.some(([id, p]) => id === 'b' && p.lastAnalysisError === null), 'error cleared on recovery');
  worker.stop(); scheduler.stop();
});

test('a job that dies without reporting is treated as a failure and does not park the camera forever', async () => {
  const clock = { t: 1_000_000 };
  const lost: JobBackend = {
    kind: 'bull',
    enqueue: async (job) => { setTimeout(() => listener?.(job.camera.id, { crashed: 'worker lost' }), 0); return true; },
    startConsuming() {}, onOutcome(l) { listener = l; },
    stats: async () => ({ queued: 0, active: 0, concurrency: 1 }), idle: async () => { await sleep(10); }, close: async () => {},
  };
  let listener: OutcomeListener | undefined;
  const w = createAnalysisWorker({ ...deps({ clock }), backend: lost }, { role: 'scheduler' });
  w._applyCameras([cam('a')]);
  w._tick(); await sleep(15);
  const s = w.status().cameras[0];
  assert.equal(s.failures, 1);
  assert.equal(s.lastError, 'worker lost');
  assert.ok(Date.parse(s.nextDueAt) > clock.t);
});

test('redis URL parsing: auth, db, tls', () => {
  assert.deepEqual(redisConnectionFromUrl('redis://localhost'), { host: 'localhost', port: 6379, username: undefined, password: undefined, db: 0 });
  const r = redisConnectionFromUrl('rediss://user:p%40ss@cache.example.com:6380/2');
  assert.deepEqual(r, { host: 'cache.example.com', port: 6380, username: 'user', password: 'p@ss', db: 2, tls: {} });
});

// ---------------------------------------------------------------------------
// Event stores
// ---------------------------------------------------------------------------

const logDoc = (over: Partial<Parameters<typeof buildLogDocument>[1]> = {}, sensitivity = 5): LogDocument =>
  buildLogDocument({ id: 'c1', name: 'Gate', sensitivity, userId: 'u1' }, { summary: 'quiet', counts: { people: 1, vehicles: 2, other: 0 }, ...over }, new Date('2026-01-01T00:00:00Z'));
const sighting = (id: string, plate = 'GJ01AB1234'): PlateSighting => ({ id, plate, cameraId: 'c1', cameraName: 'Gate', timestamp: new Date('2026-01-01T00:00:00Z'), confidence: 0.9, source: 'anpr' });

function fakePg() {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pg: PgLike = { query: async (text, params = []) => { calls.push({ text, params }); return { rows: [{ doc: { x: 1 } }] }; } };
  return { pg, calls };
}

test('postgres store: log row carries the queryable columns plus the full document', async () => {
  const { pg, calls } = fakePg();
  await createPostgresEventStore(pg).writeLog(logDoc({ detected_plates: ['GJ01AB1234'] }));
  const { text, params } = calls[0];
  assert.match(text, /INSERT INTO analysis_logs/);
  assert.equal((text.match(/\$\d+/g) ?? []).length, params.length, 'one placeholder per parameter');
  assert.equal(params[0], 'u1');
  assert.deepEqual(params.slice(9, 12), [1, 2, 0], 'people / vehicles / other');
  assert.deepEqual(params[12], ['GJ01AB1234']);
  assert.equal(JSON.parse(params[14] as string).cameraId, 'c1');
});

test('postgres store: sightings go in one statement, idempotent on id, with matching placeholders', async () => {
  const { pg, calls } = fakePg();
  const store = createPostgresEventStore(pg);
  await store.writeSightings('u1', []);
  assert.equal(calls.length, 0, 'nothing to write → no query');
  await store.writeSightings('u1', [sighting('s1'), sighting('s2', 'MH12XY9999')]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /ON CONFLICT \(id\) DO NOTHING/);
  assert.equal(calls[0].params.length, 12);
  assert.match(calls[0].text, /\(\$1,\$2,\$3,\$4,\$5,\$6\),\(\$7,\$8,\$9,\$10,\$11,\$12\)/);
});

test('postgres store: queries are scoped to the user, parameterised, and the page size is capped', async () => {
  const { pg, calls } = fakePg();
  const store = createPostgresEventStore(pg);
  const rows = await store.queryLogs({ userId: 'u1', cameraId: "c1' OR 1=1 --", onlyNotable: true, from: new Date('2026-01-01'), limit: 999_999 });
  assert.deepEqual(rows, [{ x: 1 }]);
  const { text, params } = calls[0];
  assert.match(text, /user_id = \$1/);
  assert.ok(!text.includes('OR 1=1'), 'user input never reaches the SQL text');
  assert.equal(params[1], "c1' OR 1=1 --");
  assert.equal(params[params.length - 1], 500, 'limit capped');
  assert.match(text, /\(is_unusual OR is_watchlist_match\)/);
  await store.querySightings('u1', 'GJ01AB1234', -5);
  assert.equal(calls[1].params[2], 1, 'limit floored');
});

test('postgres schema creates the indexes the queries rely on', async () => {
  const { pg, calls } = fakePg();
  await createPostgresEventStore(pg).ensureSchema();
  for (const idx of ['analysis_logs_user_ts', 'analysis_logs_user_camera_ts', 'plate_sightings_user_plate_ts']) assert.match(calls[0].text, new RegExp(idx));
});

function fakeFirestore() {
  const added: any[] = [];
  const db: any = { collection: (name: string) => ({ add: async (d: any) => { added.push([name, d]); } }), batch: () => ({ set() {}, commit: async () => {} }) };
  return { db, added };
}

test('firestore live feed modes: all / notable / none', async () => {
  const quiet = logDoc();
  const loud = logDoc({ isUnusual: true, isUnusualReason: 'x' });
  assert.equal(isNotable(quiet), false);
  assert.equal(isNotable(loud), true);
  for (const [mode, expected] of [['all', 2], ['notable', 1], ['none', 0]] as const) {
    const { db, added } = fakeFirestore();
    const store = createFirestoreEventStore(db, mode);
    await store.writeLog(quiet); await store.writeLog(loud);
    assert.equal(added.length, expected, mode);
  }
});

test('tee: the first store is the record (its failure fails the write); mirrors are best-effort', async () => {
  const calls: string[] = [];
  const mk = (name: string, fail = false): EventStore => ({
    kind: name,
    writeLog: async () => { calls.push(name); if (fail) throw new Error(`${name} down`); },
    writeSightings: async () => { calls.push(name); if (fail) throw new Error(`${name} down`); },
  });
  const errors: string[] = [];
  const ok = createTeeEventStore(mk('pg'), [mk('fs', true)], (what) => errors.push(what));
  await ok.writeLog(logDoc());
  assert.deepEqual(calls, ['pg', 'fs']);
  assert.equal(errors.length, 1, 'mirror failure is reported, not thrown');
  calls.length = 0;
  const bad = createTeeEventStore(mk('pg', true), [mk('fs')]);
  await assert.rejects(() => bad.writeLog(logDoc()), /pg down/);
  assert.deepEqual(calls, ['pg'], 'mirror is not written when the record failed, so the retry cannot double up');
  assert.equal(ok.kind, 'pg + fs');
});
