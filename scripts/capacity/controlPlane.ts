/**
 * What the platform's own code costs per analysed frame and per camera held in the scheduler, at fleet sizes up to a state's worth.
 * The REAL worker, analyzer pipeline, log builder, event derivation and alert engine run; only the things outside this repo are faked
 * (the camera frame is a few bytes, the Gemini call returns a canned answer). So this measures our code, not capture, not the model,
 * not Firestore/Redis/Postgres.
 *
 *   node --import tsx scripts/capacity/controlPlane.ts [cameras...]      default: 500 5000 20000 80000
 *
 * Writes scripts/capacity/results/controlPlane.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnalysisWorker, type WorkerCamera } from '../../server/analysisWorker';
import { createDefaultPipeline } from '../../server/analytics';
import { createAlertEngine } from '../../server/events/alertEngine';
import { createChannelRegistry, createLogChannel } from '../../server/events/channels';
import { validateRule } from '../../server/events/rules';
import { createMemoryAlertStore } from '../../server/events/store';

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const INTERVAL_S = 60;
const SIM_SECONDS = 150; // 2.5 intervals: every camera runs at least twice

const GEMINI_ANSWER = JSON.stringify({
  summary: 'A white van stops at the gate while two people talk.', counts: { people: 2, vehicles: 1, other: 0 }, brands: ['Acme'],
  people_identified: ['Unknown Person'], alerts: [], isUnusual: false, isUnusualReason: '', detected_plates: ['GJ05AB1234'], sentiment: 'neutral',
});

async function once(cameras: number) {
  let t = 1_000_000;
  const heap0 = (global.gc?.(), process.memoryUsage());

  const lastRun = new Map<string, number>();
  let maxGapMs = 0;
  let logs = 0, logBytes = 0, sightings = 0, eventsOut = 0, eventBytes = 0, updates = 0;
  const pipeline = createDefaultPipeline({ generate: async () => ({ text: GEMINI_ANSWER }), anpr: null, off: ['camera-tamper'], log: quiet });
  const store = createMemoryAlertStore({ maxEvents: 20_000, maxAlerts: 5_000 });
  const engine = createAlertEngine({ store, channels: createChannelRegistry([createLogChannel(quiet) as never]), now: () => new Date(t), log: quiet, ruleCacheMs: 60_000 });
  await store.saveRule(validateRule({ name: 'unknown people', match: { types: ['person.unknown'] }, throttle: { windowMs: 600_000, by: ['camera', 'type'] }, channels: [{ type: 'log' }] }, { userId: 'u1', id: 'r1', now: new Date(t) }));

  const worker = createAnalysisWorker({
    now: () => t, subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: ['ZZ99ZZ9999'] }),
    grabFrame: async (c) => { const prev = lastRun.get(c.id); if (prev !== undefined) maxGapMs = Math.max(maxGapMs, t - prev); lastRun.set(c.id, t); return Buffer.alloc(64); },
    analyze: async ({ imageBase64, camera, knownFaces, watchlist }) => {
      const r = await pipeline.analyze({ camera: { id: camera.id, name: camera.name, userId: camera.userId }, frame: { jpeg: Buffer.from(imageBase64, 'base64'), base64: imageBase64 }, user: { knownFaces, watchlist }, now: new Date(t) });
      return { ...r.result, events: r.events, analyzers: r.outcomes };
    },
    writeLog: async (d) => { logs++; logBytes += JSON.stringify(d).length; },
    writeSightings: async (_u, s) => { sightings += s.length; },
    emitEvents: async (events) => { eventsOut += events.length; for (const e of events) eventBytes += JSON.stringify(e).length; await engine.ingest(events); },
    updateCamera: async () => { updates++; }, sendWebhook: async () => {}, log: quiet,
  }, { concurrency: 8, tickMs: 1000 });

  const cams: WorkerCamera[] = Array.from({ length: cameras }, (_, i) => ({
    id: `cam${String(i).padStart(6, '0')}`, userId: 'u1', name: `Camera ${i}`, remoteStreamUrl: `https://cams.example/cam${i}/index.m3u8`, interval: INTERVAL_S,
    sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '', department: `Dept ${i % 40}`, location: { lat: 20 + (i % 1000) / 100, lng: 70 + (i % 700) / 100 },
  }));

  const tApply = performance.now();
  worker._applyCameras(cams);
  const applyMs = performance.now() - tApply;
  const heapAfterApply = (global.gc?.(), process.memoryUsage());

  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  let worstTickMs = 0, tickTotalMs = 0, ticks = 0;
  for (let s = 0; s < SIM_SECONDS; s++) {
    const a = performance.now();
    worker._tick();
    const tickMs = performance.now() - a;
    worstTickMs = Math.max(worstTickMs, tickMs);
    tickTotalMs += tickMs;
    ticks++;
    await worker._idle();
    t += 1000;
  }
  await engine.idle();
  const wallMs = performance.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  const cpuS = (cpu.user + cpu.system) / 1e6;
  const heapEnd = (global.gc?.(), process.memoryUsage());

  const analyses = logs;
  const result = {
    cameras,
    simulatedSeconds: SIM_SECONDS,
    analyses,
    cpuSecondsTotal: round(cpuS, 3),
    /** CPU milliseconds of platform code per analysed frame (the number the capacity model uses). */
    platformCpuMsPerAnalysis: round((cpuS * 1000) / Math.max(1, analyses), 3),
    /** How many analyses per second one core of this machine can sustain in our code alone. */
    maxAnalysesPerSecondPerCore: Math.round(analyses / cpuS),
    wallSeconds: round(wallMs / 1000, 2),
    applyCamerasMs: round(applyMs, 1),
    schedulerTickMsAvg: round(tickTotalMs / ticks, 3),
    schedulerTickMsWorst: round(worstTickMs, 1),
    /** The longest any camera waited between two runs, minus its interval: how late the scheduler was. 0 = on time (the fake clock moves 1 s per tick). */
    worstLateSeconds: Math.max(0, round(maxGapMs / 1000 - INTERVAL_S, 1)),
    heapMBPerThousandCameras: round(((heapAfterApply.heapUsed - heap0.heapUsed) / 1e6) / (cameras / 1000), 2),
    rssMBAtEnd: Math.round(heapEnd.rss / 1e6),
    heapMBAtEnd: Math.round(heapEnd.heapUsed / 1e6),
    logBytesAvg: Math.round(logBytes / Math.max(1, logs)),
    eventBytesAvg: eventsOut ? Math.round(eventBytes / eventsOut) : 0,
    eventsPerAnalysis: round(eventsOut / Math.max(1, analyses), 2),
    sightingsPerAnalysis: round(sightings / Math.max(1, analyses), 2),
    cameraUpdates: updates,
  };
  worker.stop();
  return result;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

async function main() {
  const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const list = sizes.length ? sizes : [500, 5_000, 20_000, 80_000];
  const cpu = os.cpus()[0];
  const out = { when: new Date().toISOString(), machine: { cores: os.cpus().length, cpu: cpu.model.trim(), mhz: cpu.speed, ramGB: round(os.totalmem() / 1e9, 1), node: process.version }, intervalS: INTERVAL_S, runs: [] as Awaited<ReturnType<typeof once>>[] };
  for (const n of list) {
    const r = await once(n);
    out.runs.push(r);
    console.log(`${String(n).padStart(6)} cameras: ${r.analyses} analyses in ${r.wallSeconds}s wall, ${r.platformCpuMsPerAnalysis} ms CPU each, tick avg ${r.schedulerTickMsAvg} ms / worst ${r.schedulerTickMsWorst} ms, ${r.heapMBPerThousandCameras} MB per 1,000 cameras, worst lateness ${r.worstLateSeconds}s, RSS ${r.rssMBAtEnd} MB`);
  }
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'controlPlane.json'), JSON.stringify(out, null, 2));
  console.log('written scripts/capacity/results/controlPlane.json');
}

void main();
