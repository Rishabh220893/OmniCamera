import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreLeases, decideClaim, decideRelease, HELD_RETRY_MS, LeaseDoc } from '../server/leaseStore';
import { createAnalysisWorker, WorkerCamera, WorkerDeps } from '../server/analysisWorker';

test('claim: free camera that is due is claimed with a lease', () => {
  const r = decideClaim(undefined, 'A', 1000, 120_000);
  assert.deepEqual(r.result, { claimed: true });
  assert.deepEqual(r.write, { owner: 'A', until: 121_000, nextDueAt: 0 });
});

test('claim: refused while another instance holds an unexpired lease, then allowed once it expires', () => {
  const held: LeaseDoc = { owner: 'B', until: 50_000, nextDueAt: 0 };
  assert.deepEqual(decideClaim(held, 'A', 10_000, 120_000).result, { claimed: false, retryAt: 10_000 + HELD_RETRY_MS });
  assert.equal(decideClaim(held, 'A', 50_001, 120_000).result.claimed, true, 'a crashed holder stops blocking after its lease expires');
});

test('claim: refused until the camera is next due, and says when', () => {
  const released: LeaseDoc = { owner: null, until: 0, nextDueAt: 70_000 };
  assert.deepEqual(decideClaim(released, 'A', 60_000, 120_000).result, { claimed: false, retryAt: 70_000 });
  assert.equal(decideClaim(released, 'A', 70_000, 120_000).result.claimed, true);
});

test('release: only the owner can release, and it records the next due time', () => {
  const mine: LeaseDoc = { owner: 'A', until: 99_999, nextDueAt: 0 };
  assert.deepEqual(decideRelease(mine, 'A', 80_000), { owner: null, until: 0, nextDueAt: 80_000 });
  assert.equal(decideRelease({ ...mine, owner: 'B' }, 'A', 80_000), null, 'a lease another instance took over is left alone');
  assert.equal(decideRelease(undefined, 'A', 80_000), null);
});

// A minimal in-memory stand-in for the Firestore calls the lease store uses.
function fakeFirestore() {
  const docs = new Map<string, unknown>();
  const ref = (id: string) => ({ id });
  // Firestore resolves conflicting transactions by retrying the loser against fresh data,
  // so the outcome is the same as running them one at a time — modelled here with a queue.
  let chain: Promise<unknown> = Promise.resolve();
  const db = {
    collection: (_name: string) => ({ doc: (id: string) => ref(id) }),
    runTransaction: <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      const run = async () => {
        const writes: Array<[string, unknown]> = [];
        const tx = {
          get: async (r: { id: string }) => ({ exists: docs.has(r.id), data: () => docs.get(r.id) }),
          set: (r: { id: string }, data: unknown) => { writes.push([r.id, data]); },
        };
        const out = await fn(tx);
        for (const [id, data] of writes) docs.set(id, data);
        return out;
      };
      const result = chain.then(run, run);
      chain = result.catch(() => undefined);
      return result;
    },
  };
  return { db: db as any, docs };
}

test('firestore leases: claim → refuse the rival → release → rival blocked until due', async () => {
  const { db, docs } = fakeFirestore();
  const a = createFirestoreLeases(db, 'A');
  const b = createFirestoreLeases(db, 'B');
  assert.deepEqual(await a.claim('cam1', 1000, 120_000), { claimed: true });
  assert.deepEqual(await b.claim('cam1', 1500, 120_000), { claimed: false, retryAt: 1500 + HELD_RETRY_MS });
  await a.release('cam1', 31_000);
  assert.deepEqual(docs.get('cam1'), { owner: null, until: 0, nextDueAt: 31_000 });
  assert.deepEqual(await b.claim('cam1', 2000, 120_000), { claimed: false, retryAt: 31_000 });
  assert.deepEqual(await b.claim('cam1', 31_000, 120_000), { claimed: true });
});

// ---- two worker instances sharing one lease store and one clock ----

const cam = (id: string): WorkerCamera => ({
  id, userId: 'u', name: id, remoteStreamUrl: `https://x.test/${id}`, interval: 10, sensitivity: 5,
  peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '',
});

function makeFleet(instances: string[], opts: { seed?: (docs: Map<string, unknown>) => void; leases?: boolean } = {}) {
  const { db, docs } = fakeFirestore();
  opts.seed?.(docs);
  let t = 1_000_000;
  const analysed: Array<{ camera: string; by: string; at: number }> = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const workers = instances.map((id) => {
    const leases = createFirestoreLeases(db, id);
    const deps: WorkerDeps = {
      now: () => t, instanceId: id,
      claim: opts.leases === false ? undefined : leases.claim, release: opts.leases === false ? undefined : leases.release,
      subscribeCameras: () => () => {},
      loadUserContext: async () => ({ knownFaces: [], watchlist: [] }),
      grabFrame: async () => Buffer.from('f'),
      analyze: async ({ camera }) => { analysed.push({ camera: camera.id, by: id, at: t }); return { summary: 's' }; },
      writeLog: async () => {}, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {},
      log: quiet,
    };
    return createAnalysisWorker(deps, { concurrency: 4 });
  });
  return {
    workers, analysed, docs,
    set time(v: number) { t = v; },
    get time() { return t; },
    // Advance one second at a time, letting every instance tick and finish.
    async run(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        t += 1000;
        workers.forEach((w) => w._tick());
        await Promise.all(workers.map((w) => w._idle()));
      }
    },
  };
}

test('two instances never analyse the same camera twice within an interval', async () => {
  const fleet = makeFleet(['A', 'B']);
  const cams = Array.from({ length: 12 }, (_, i) => cam(`c${i}`));
  fleet.workers.forEach((w) => w._applyCameras(cams));
  await fleet.run(60);

  const byCamera = new Map<string, number[]>();
  for (const r of fleet.analysed) byCamera.set(r.camera, [...(byCamera.get(r.camera) ?? []), r.at]);
  assert.equal(byCamera.size, 12, 'every camera gets analysed');
  for (const [id, times] of byCamera) {
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 10_000, `${id} re-analysed after only ${(times[i] - times[i - 1]) / 1000}s`);
    assert.ok(times.length >= 4 && times.length <= 6, `${id} analysed ${times.length} times in 60 s at a 10 s interval`);
  }
  const owners = new Set(fleet.analysed.map((r) => r.by));
  assert.equal(owners.size, 2, 'the work is actually shared between instances');
  assert.ok(fleet.workers.some((w) => w.status().skippedClaims > 0), 'the instance that lost a race skipped instead of duplicating');
  assert.equal(fleet.workers[0].status().distributed, true);
});

test('control: the same two instances WITHOUT leases do duplicate work', async () => {
  const fleet = makeFleet(['A', 'B'], { leases: false });
  fleet.workers.forEach((w) => w._applyCameras(Array.from({ length: 12 }, (_, i) => cam(`c${i}`))));
  await fleet.run(60);
  const perCamera = fleet.analysed.length / 12;
  assert.ok(perCamera >= 9, `expected ~2x the work without leases, got ${perCamera.toFixed(1)} runs per camera`);
  assert.equal(fleet.workers[0].status().distributed, false);
});

test('a crashed instance\'s cameras are taken over once its lease expires', async () => {
  const fleet = makeFleet(['B'], {
    seed: (docs) => docs.set('c0', { owner: 'dead-instance', until: 1_000_000 + 30_000, nextDueAt: 0 }),
  });
  fleet.workers[0]._applyCameras([cam('c0')]);
  await fleet.run(25);
  assert.equal(fleet.analysed.length, 0, 'blocked while the dead instance\'s lease is still valid');
  await fleet.run(20); // past the 30 s lease expiry
  assert.ok(fleet.analysed.length >= 1, 'taken over after expiry');
  assert.equal(fleet.analysed[0].by, 'B');
});

test('if the lease store is unreachable the worker does not analyse (no silent duplicates) and retries soon', async () => {
  let t = 1_000_000;
  let calls = 0;
  const analysed: string[] = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const w = createAnalysisWorker({
    now: () => t, claim: async () => { calls++; throw new Error('firestore down'); },
    subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: [] }),
    grabFrame: async () => Buffer.from('f'), analyze: async ({ camera }) => { analysed.push(camera.id); return {}; },
    writeLog: async () => {}, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {}, log: quiet,
  });
  w._applyCameras([cam('c0')]);
  t += 10_000; w._tick(); await w._idle();
  assert.equal(analysed.length, 0);
  assert.equal(calls, 1);
  t += 6_000; w._tick(); await w._idle();
  assert.equal(calls, 2, 'retried after ~5 s');
});

test('status reports backlog and lag when capacity is too low', async () => {
  let t = 1_000_000;
  const quiet = { info() {}, warn() {}, error() {} };
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const w = createAnalysisWorker({
    now: () => t, subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: [] }),
    grabFrame: async () => { await gate; return Buffer.from('f'); }, analyze: async () => ({}),
    writeLog: async () => {}, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {}, log: quiet,
  }, { concurrency: 1 });
  w._applyCameras([cam('a'), cam('b'), cam('c')]);
  t += 10_000; w._tick();
  t += 25_000; // jobs stuck for 25 s
  const s = w.status();
  assert.equal(s.queue.active, 1);
  assert.equal(s.queue.queued, 2);
  assert.equal(s.overdue, 2, 'the two cameras waiting behind the running one');
  assert.ok(s.maxLagSeconds >= 25);
  release(); await w._idle();
});
