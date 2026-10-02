import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisWorker, WorkerCamera } from '../server/analysisWorker';

/**
 * Drives the real worker with a fake clock to see how it behaves at ~50 cameras.
 * Each analysis "takes" `jobSeconds` of simulated time. These are assumptions
 * (capture + model call), not measurements — the point is the relationship
 * between camera count, interval, job time and concurrency.
 */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

async function simulate(opts: { cameras: number; intervalS: number; concurrency: number; jobSeconds: number; totalSeconds: number }) {
  let t = 1_000_000;
  const pending: Array<{ finishAt: number; resolve: () => void }> = [];
  const runs = new Map<string, number[]>();
  const quiet = { info() {}, warn() {}, error() {} };
  const worker = createAnalysisWorker({
    now: () => t, subscribeCameras: () => () => {},
    loadUserContext: async () => ({ knownFaces: [], watchlist: [] }),
    grabFrame: (c) => new Promise<Buffer>((resolve) => {
      runs.set(c.id, [...(runs.get(c.id) ?? []), t]);
      pending.push({ finishAt: t + opts.jobSeconds * 1000, resolve: () => resolve(Buffer.from('f')) });
    }),
    analyze: async () => ({}), writeLog: async () => {}, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {}, log: quiet,
  }, { concurrency: opts.concurrency });

  const cams: WorkerCamera[] = Array.from({ length: opts.cameras }, (_, i) => ({
    id: `cam${i}`, userId: 'u', name: `cam${i}`, remoteStreamUrl: `https://x.test/cam${i}`, interval: opts.intervalS,
    sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '',
  }));
  worker._applyCameras(cams);

  let peakOverdue = 0;
  for (let s = 0; s < opts.totalSeconds; s++) {
    t += 1000;
    for (const p of pending.filter((p) => p.finishAt <= t)) { pending.splice(pending.indexOf(p), 1); p.resolve(); }
    await settle();
    worker._tick();
    await settle();
    peakOverdue = Math.max(peakOverdue, worker.status().overdue);
  }
  // Average gap between consecutive runs of the same camera, ignoring each camera's first run.
  const gaps = [...runs.values()].flatMap((ts) => ts.slice(1).map((x, i) => (x - ts[i]) / 1000));
  const meanPeriod = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  return { meanPeriod, peakOverdue, totalRuns: [...runs.values()].reduce((a, ts) => a + ts.length, 0), status: worker.status() };
}

test('50 cameras @60 s with too little concurrency: cameras run far less often than asked, and the backlog shows it', async () => {
  const r = await simulate({ cameras: 50, intervalS: 60, concurrency: 4, jobSeconds: 15, totalSeconds: 600 });
  assert.ok(r.meanPeriod > 120, `expected cameras to run well under their 60 s schedule, mean period ${r.meanPeriod.toFixed(0)} s`);
  assert.ok(r.peakOverdue >= 20, `expected a visible backlog, peak ${r.peakOverdue}`);
  assert.ok(r.status.maxLagSeconds > 0);
});

test('50 cameras @60 s with enough concurrency (cameras × jobSeconds ÷ interval, rounded up, plus headroom) keeps the schedule', async () => {
  const needed = Math.ceil((50 * 15) / 60); // 13
  const r = await simulate({ cameras: 50, intervalS: 60, concurrency: needed + 3, jobSeconds: 15, totalSeconds: 600 });
  assert.ok(r.meanPeriod >= 60 && r.meanPeriod <= 66, `mean period ${r.meanPeriod.toFixed(0)} s should match the 60 s interval, neither faster nor drifting`);
  assert.ok(r.peakOverdue <= 2, `no real backlog, peak ${r.peakOverdue}`);
});

test('the sizing rule holds at a 30 s interval too: ~25 concurrent jobs needed, 32 is enough, 16 is not', async () => {
  const short = await simulate({ cameras: 50, intervalS: 30, concurrency: 16, jobSeconds: 15, totalSeconds: 600 });
  const enough = await simulate({ cameras: 50, intervalS: 30, concurrency: 32, jobSeconds: 15, totalSeconds: 600 });
  assert.ok(short.meanPeriod > 40, `16 slots cannot sustain 30 s (mean ${short.meanPeriod.toFixed(0)} s)`);
  assert.ok(enough.meanPeriod <= 33, `32 slots can (mean ${enough.meanPeriod.toFixed(0)} s)`);
});

test('every one of 60 cameras gets analysed (no camera is starved)', async () => {
  const r = await simulate({ cameras: 60, intervalS: 30, concurrency: 8, jobSeconds: 10, totalSeconds: 400 });
  assert.equal(r.status.cameras.length, 60);
  assert.ok(r.status.cameras.every((c) => c.lastRunAt !== null), 'each camera ran at least once');
});
