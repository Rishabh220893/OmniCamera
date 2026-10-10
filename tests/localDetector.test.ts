import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultPipeline } from '../server/analytics/index.ts';
import { configOf, createLocalDetectorAnalyzer, detectLocal } from '../server/analytics/localDetector.ts';
import { FINGERPRINT_H, FINGERPRINT_W } from '../server/frameGate.ts';
import { createAnalysisWorker, OFFLINE_AFTER_FAILURES, type WorkerCamera, type WorkerDeps } from '../server/analysisWorker.ts';
import type { PlatformEvent } from '../server/events/schema.ts';

const N = FINGERPRINT_W * FINGERPRINT_H;
const flat = (v = 100) => new Uint8Array(N).fill(v);
/** A picture where the pixels in the box (fingerprint pixels) are bright. */
const withBox = (x0: number, y0: number, x1: number, y1: number, v = 220) => {
  const f = flat();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) f[y * FINGERPRINT_W + x] = v;
  return f;
};
const cfg = (over: object = {}) => configOf({ id: 'c', name: 'c', analyzers: { 'local-detector': over } });
const types = (e: { type: string }[]) => e.map((x) => x.type).sort();

test('local detector: a still picture raises nothing, a moving object raises motion', () => {
  assert.deepEqual(detectLocal(flat(), flat(), cfg()), []);
  assert.deepEqual(types(detectLocal(flat(), withBox(5, 5, 15, 15), cfg())), ['vms.motion']);
});

test('local detector: a light switching on (most of the picture changes) is not motion', () => {
  assert.deepEqual(detectLocal(flat(60), flat(200), cfg()), []);
});

test('local detector: a tiny change stays under the motion threshold, and the threshold is configurable', () => {
  const small = withBox(0, 0, 2, 2); // 4 of 2304 pixels
  assert.deepEqual(detectLocal(flat(), small, cfg()), []);
  assert.deepEqual(types(detectLocal(flat(), small, cfg({ motionPercent: 0.1 }))), ['vms.motion']);
});

test('local detector: movement inside the zone is an intrusion, movement outside it is not', () => {
  const zone = { zone: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 } };
  assert.deepEqual(types(detectLocal(flat(), withBox(36, 20, 44, 28), cfg(zone))), ['vms.intrusion', 'vms.motion']);
  assert.deepEqual(types(detectLocal(flat(), withBox(2, 2, 12, 10), cfg(zone))), ['vms.motion']);
});

test('local detector: movement on both sides of the line is a crossing, movement on one side is not', () => {
  const line = { line: { x1: 0.5, y1: 0, x2: 0.5, y2: 1 } }; // vertical line down the middle
  assert.ok(types(detectLocal(flat(), withBox(28, 10, 36, 20), cfg(line))).includes('vms.line_crossing'));
  assert.ok(!types(detectLocal(flat(), withBox(2, 10, 14, 20), cfg(line))).includes('vms.line_crossing'));
});

test('local detector: bad settings are ignored, not fatal', () => {
  const c = cfg({ zone: { x: 2, y: 'a' }, line: { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, motionPercent: -3 });
  assert.equal(c.zone, undefined);
  assert.equal(c.line, undefined);
  assert.equal(c.motionPercent, 1.5);
  assert.deepEqual(detectLocal(new Uint8Array(5), new Uint8Array(5), cfg()), [], 'wrong-sized fingerprints');
});

test('analyzer: only runs when AI analysis is off, the first frame only sets the baseline, then movement is reported', async () => {
  const frames = [flat(), withBox(5, 5, 15, 15)];
  let i = 0;
  const a = createLocalDetectorAnalyzer({ fingerprint: async () => frames[i++] ?? null });
  assert.equal(a.appliesTo!({ id: 'c', name: 'c' }), false);
  assert.equal(a.appliesTo!({ id: 'c', name: 'c', aiAnalysis: true }), false);
  assert.equal(a.appliesTo!({ id: 'c', name: 'c', aiAnalysis: false }), true);
  const input = { camera: { id: 'c', name: 'c', aiAnalysis: false }, frame: { jpeg: Buffer.from('x'), base64: 'eA==' }, user: { knownFaces: [], watchlist: [] }, now: new Date(), signal: new AbortController().signal };
  const first = await a.analyze(input);
  assert.equal(first.events, undefined);
  const second = await a.analyze(input);
  assert.deepEqual(types(second.events ?? []), ['vms.motion']);
});

test('pipeline: with AI analysis off the model is never called and the local detector reports; with it on, the opposite', async () => {
  let modelCalls = 0;
  const frames = [flat(), withBox(5, 5, 15, 15)];
  let i = 0;
  const generate = async () => { modelCalls++; return { text: JSON.stringify({ summary: 'A street', counts: { people: 1, vehicles: 0, other: 0 } }) }; };
  const local = createLocalDetectorAnalyzer({ fingerprint: async () => frames[i++ % 2] });
  const pipeline = createDefaultPipeline({ generate, anpr: null, off: ['local-detector', 'camera-tamper'], extra: [local], log: { warn() {}, log() {} } });
  const input = (aiAnalysis: boolean) => ({ camera: { id: 'c', name: 'c', userId: 'u', aiAnalysis }, frame: { jpeg: Buffer.from('x'), base64: 'eA==' }, user: { knownFaces: [], watchlist: [] }, now: new Date() });
  await pipeline.analyze(input(false));
  const off = await pipeline.analyze(input(false));
  assert.equal(modelCalls, 0, 'no model call with AI analysis off');
  assert.deepEqual(types(off.events), ['vms.motion']);
  assert.match(off.result.summary ?? '', /AI analysis is off/);
  const on = await pipeline.analyze(input(true));
  assert.equal(modelCalls, 1);
  assert.equal(on.result.summary, 'A street');
  assert.deepEqual(on.events, [], 'the local detector stays out of AI cameras');
});

// ---- offline / online from the run history ----------------------------------------------------------------------

test('worker: a camera that keeps failing is reported offline once, and online once when it comes back', async () => {
  let t = 1_000_000;
  let down = true;
  const emitted: PlatformEvent[] = [];
  const deps: WorkerDeps = {
    now: () => t, subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: [] }),
    grabFrame: async () => { if (down) throw new Error('Could not capture a frame'); return Buffer.from('f'); },
    analyze: async () => ({ summary: 'ok' }), writeLog: async () => {}, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {},
    emitEvents: async (e) => { emitted.push(...e); }, log: { info() {}, warn() {}, error() {} },
  };
  const worker = createAnalysisWorker(deps, { concurrency: 1 });
  const camera: WorkerCamera = { id: 'a', userId: 'u1', name: 'Gate', remoteStreamUrl: 'https://x.test/a', interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '' };
  worker._applyCameras([camera]);
  for (let k = 0; k < OFFLINE_AFTER_FAILURES + 3; k++) { t += 10 * 60_000; worker._tick(); await worker._idle(); }
  assert.deepEqual(emitted.map((e) => e.type), ['camera.offline'], 'reported once, not on every failed run');
  assert.equal(emitted[0].cameraId, 'a');
  down = false;
  t += 10 * 60_000; worker._tick(); await worker._idle();
  assert.deepEqual(emitted.map((e) => e.type), ['camera.offline', 'camera.online']);
  t += 10 * 60_000; worker._tick(); await worker._idle();
  assert.equal(emitted.length, 2, 'no repeat once it is back');
});
