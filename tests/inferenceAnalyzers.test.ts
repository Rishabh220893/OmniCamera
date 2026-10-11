/**
 * Counting, anomaly detection and face matching (gap A17): the hour-of-week baseline, the anomaly events, the face index, and the analyzer that talks
 * to an inference service (a mock one, over real HTTP). No GPU and no model are involved: these test the platform's side of the contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBaseline, hourOfWeek } from '../server/analytics/baseline.ts';
import { createAnomalyDetector } from '../server/analytics/anomaly.ts';
import { cosine, createFaceIndex } from '../server/analytics/faceIndex.ts';
import { createInferenceClient, createRemoteDetectorAnalyzer } from '../server/analytics/remoteInference.ts';
import { createAnalyzerPipeline } from '../server/analytics/pipeline.ts';
import { makeEvent, type PlatformEvent } from '../server/events/schema.ts';

// ---- baseline ------------------------------------------------------------------------------------------------------------------------

test('hour of the week: Monday 00:00 is 0 and Sunday 23:00 is 167, in the camera\'s time zone', () => {
  assert.equal(hourOfWeek(new Date('2026-10-12T00:00:00Z'), 0), 0, '2026-10-12 is a Monday');
  assert.equal(hourOfWeek(new Date('2026-10-18T23:30:00Z'), 0), 167);
  assert.equal(hourOfWeek(new Date('2026-10-11T18:30:00Z'), 330), 0, 'Sunday 18:30 UTC is Monday 00:00 in India');
  assert.equal(hourOfWeek(new Date('2026-10-12T00:00:00Z'), -60), 6 * 24 + 23);
});

const at = (week: number, hour: number) => new Date(Date.UTC(2026, 9, 5 + week * 7, hour - 5, 30)); // Monday of a week + hour in IST (UTC+5:30 → hour:00 local)

test('baseline: it learns the usual per hour of the week, says nothing before it has enough history, and judges a value before learning it', () => {
  const b = createBaseline({ minSamples: 5, floor: 0.5 });
  const obs = (w: number, h: number, v: number) => b.observe({ key: 'cam', metric: 'people', at: at(w, h), value: v });
  for (let w = 0; w < 4; w++) assert.equal(obs(w, 18, 20).z, null, 'too little history to judge');
  const fifth = obs(4, 18, 20);
  assert.deepEqual([fifth.samples, fifth.z], [4, null], 'the fifth is judged against four');
  const sixth = obs(5, 18, 20);
  assert.equal(sixth.samples, 5);
  assert.equal(Math.abs(sixth.z!) < 1e-9, true, 'the usual is not unusual');
  const big = b.score({ key: 'cam', metric: 'people', at: at(6, 18), value: 60 });
  assert.equal(big.z! > 10, true, 'forty more than usual is far outside');
  assert.equal(b.score({ key: 'cam', metric: 'people', at: at(6, 3), value: 60 }).samples, 0, '3 a.m. has its own (empty) history');
  assert.equal(b.score({ key: 'other', metric: 'people', at: at(6, 18), value: 60 }).samples, 0, 'another camera has its own');
  assert.equal(b.score({ key: 'cam', metric: 'vehicles', at: at(6, 18), value: 60 }).samples, 0, 'and another metric');
  assert.equal(b.score({ key: 'cam', metric: 'people', at: at(6, 18), value: 20.2 }).stdev, 0.5, 'the floor keeps a steady camera from raising alarms at a tiny change');
});

test('baseline: the mean follows slow changes, variance reflects spread, and state survives export and import', () => {
  const b = createBaseline({ alpha: 0.2, minSamples: 3 });
  for (let i = 0; i < 60; i++) b.observe({ key: 'c', metric: 'vehicles', at: at(i, 9), value: i % 2 === 0 ? 8 : 12 });
  const s = b.score({ key: 'c', metric: 'vehicles', at: at(60, 9), value: 10 });
  assert.equal(Math.abs(s.expected - 10) < 1.5, true, `mean near 10, got ${s.expected}`);
  assert.equal(s.stdev > 1 && s.stdev < 3, true, `spread near 2, got ${s.stdev}`);
  const copy = createBaseline({ alpha: 0.2, minSamples: 3 });
  copy.import(JSON.parse(JSON.stringify(b.export())));
  assert.deepEqual(copy.score({ key: 'c', metric: 'vehicles', at: at(60, 9), value: 10 }), s);
  copy.import({ bad: { n: -1, mean: NaN, m2: 0 } as never, worse: null as never });
  assert.equal(copy.size(), b.size(), 'malformed saved state is ignored');
});

// ---- anomaly events -------------------------------------------------------------------------------------------------------------------

const seen = (type: 'person.seen' | 'vehicle.seen', cam: string, ts: Date, count: number): PlatformEvent =>
  makeEvent({ type, summary: `${count} seen`, data: { count }, dedupeKey: `${type}-${ts.getTime()}` }, { source: 'gemini-scene', camera: { id: cam, name: `Camera ${cam}`, userId: 'u1', department: 'Traffic' }, ts });

function learn(det: ReturnType<typeof createAnomalyDetector>, cam: string, hour: number, weeks: number, value: number) {
  for (let w = 0; w < weeks; w++) det.handle([seen('person.seen', cam, at(w, hour), value + (w % 2))]);
}

test('anomaly: a crowd far above the usual raises one event with the numbers, and not again within the cooldown; a normal count raises nothing', () => {
  const det = createAnomalyDetector({ baseline: createBaseline({ minSamples: 8 }) });
  learn(det, 'gate', 18, 12, 10);
  assert.deepEqual(det.handle([seen('person.seen', 'gate', at(12, 18), 11)]), [], 'a usual count is not news');
  const out = det.handle([seen('person.seen', 'gate', at(13, 18), 45)]);
  assert.equal(out.length, 1);
  const e = out[0];
  assert.deepEqual([e.type, e.severity, e.source, e.cameraId, e.department, e.data.metric, e.data.direction, e.data.count], ['count.anomaly', 'warning', 'anomaly-baseline', 'gate', 'Traffic', 'people', 'high', 45]);
  assert.equal(e.data.expected! >= 9 && e.data.expected! <= 12, true);
  assert.match(e.summary, /Unusually many people at Camera gate: 45 \(usually about 1\d at this hour\)/);
  assert.deepEqual(det.handle([seen('person.seen', 'gate', new Date(at(13, 18).getTime() + 5 * 60_000), 50)]), [], 'cooldown');
  assert.equal(det.handle([seen('person.seen', 'gate', new Date(at(13, 18).getTime() + 20 * 60_000), 50)]).length, 1, 'after the cooldown it can raise again');
});

test('anomaly: a few more than usual on a quiet street is not an anomaly (minimum difference); a camera that is usually busy and suddenly empty is, as a notice; other event types and bad counts are ignored', () => {
  const det = createAnomalyDetector({ baseline: createBaseline({ minSamples: 8 }) });
  learn(det, 'lane', 3, 12, 0);
  assert.deepEqual(det.handle([seen('person.seen', 'lane', at(13, 3), 3)]), [], 'three people at 3 a.m. against none: below the minimum difference');
  assert.equal(det.handle([seen('person.seen', 'lane', at(14, 3), 9)]).length, 1, 'nine is');
  learn(det, 'market', 11, 12, 30);
  const low = det.handle([seen('person.seen', 'market', at(13, 11), 2)]);
  assert.deepEqual([low.length, low[0].severity, low[0].data.direction], [1, 'notice', 'low']);
  assert.match(low[0].summary, /Unusually few people/);
  const other = makeEvent({ type: 'plate.read', summary: 'x', data: { count: 99 }, dedupeKey: 'p' }, { source: 's', camera: { id: 'gate', name: 'g', userId: 'u1' }, ts: at(13, 18) });
  const bad = seen('person.seen', 'gate', at(13, 19), -4);
  assert.deepEqual(det.handle([other, bad, { ...bad, data: { count: 'many' } }]), []);
});

test('anomaly: people and vehicles are separate; learned state is saved to a file and read back by a new detector', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'anom-')), 'baseline.json');
  const a = createAnomalyDetector({ stateFile: file, baseline: createBaseline({ minSamples: 8 }) });
  learn(a, 'gate', 18, 12, 10);
  for (let w = 0; w < 12; w++) a.handle([seen('vehicle.seen', 'gate', at(w, 18), 40)]);
  await a.save();
  assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length, 2, 'one bucket per metric');
  const b = createAnomalyDetector({ stateFile: file, baseline: createBaseline({ minSamples: 8 }) });
  await b.load();
  assert.equal(b.handle([seen('person.seen', 'gate', at(13, 18), 45)]).length, 1, 'it still knows what is usual');
  assert.deepEqual(b.handle([seen('vehicle.seen', 'gate', at(13, 18), 41)]), [], 'vehicles have their own usual');
  const none = createAnomalyDetector({ stateFile: join(tmpdir(), 'does-not-exist-xyz', 'b.json') });
  await none.load();
  assert.equal(none.baseline.size(), 0, 'no file is not an error');
});

// ---- faces -------------------------------------------------------------------------------------------------------------------------

test('face index: cosine similarity, the best match above the threshold, nothing below it, size and ordering of the nearest', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(Math.round(cosine([1, 1], [-1, -1])), -1);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0, 'different sizes never match');
  const index = createFaceIndex([{ id: 'a', name: 'Anil', embedding: [1, 0, 0, 0] }, { id: 'b', name: 'Bina', embedding: [0, 1, 0, 0] }, { id: 'c', name: 'Broken', embedding: [] }, { id: 'd', name: 'Nan', embedding: [NaN, 1] }], { threshold: 0.8 });
  assert.equal(index.size(), 2, 'unusable vectors are left out');
  assert.deepEqual(index.match([0.9, 0.1, 0, 0]), { id: 'a', name: 'Anil', score: index.nearest([0.9, 0.1, 0, 0], 1)[0].score });
  assert.equal(index.match([0.9, 0.1, 0, 0])!.score > 0.99, true);
  assert.equal(index.match([0.7, 0.7, 0, 0]), null, 'between two people: no match');
  assert.deepEqual(index.nearest([0.7, 0.7, 0, 0], 5).map((m) => m.name), ['Anil', 'Bina']);
  assert.deepEqual(index.nearest([], 3), []);
  assert.equal(index.match([5, 0, 0, 0], 0.99)!.name, 'Anil', 'length does not matter, only direction');
  assert.equal(createFaceIndex([]).match([1, 0]), null);
});

// ---- the inference service (mock, over HTTP) ---------------------------------------------------------------------------------------

interface MockOpts { status?: number; body?: unknown; delayMs?: number; key?: string }
async function mockService(o: MockOpts = {}) {
  const seen: Array<{ auth?: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', model: 'mock', device: 'cpu' })); return; }
      seen.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (o.key && req.headers.authorization !== `Bearer ${o.key}`) { res.writeHead(401).end('{}'); return; }
      setTimeout(() => res.writeHead(o.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(o.body ?? {
        model: 'mock-yolo', ms: 12,
        detections: [
          { label: 'person', score: 0.93, box: [0.1, 0.1, 0.1, 0.3] }, { label: 'person', score: 0.88, box: [0.5, 0.2, 0.1, 0.3] }, { label: 'person', score: 0.3, box: [0.7, 0.2, 0.1, 0.3] },
          { label: 'car', score: 0.9, box: [0.2, 0.6, 0.2, 0.2] }, { label: 'truck', score: 0.8, box: [0.6, 0.6, 0.3, 0.3] }, { label: 'person', score: 0.95, box: [0.9, 0.9, 0.001, 0.001] }, { label: 'dog', score: 0.99, box: [0.3, 0.3, 0.1, 0.1] },
          { label: 'person', score: 'x', box: [0, 0, 1, 1] },
        ],
        faces: [{ box: [0.1, 0.1, 0.05, 0.08], score: 0.97, embedding: Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : 0.01)) }, { box: [0.5, 0.2, 0.05, 0.08], score: 0.9, embedding: Array.from({ length: 16 }, (_, i) => (i === 5 ? 1 : 0)) }, { box: [0.7, 0.2, 0.05, 0.08], score: 0.9 }],
      })), o.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}
const camera = { id: 'cam1', name: 'Gate', userId: 'u1' };
const input = (signal = new AbortController().signal) => ({ camera, frame: { jpeg: Buffer.from('jpeg-bytes'), base64: Buffer.from('jpeg-bytes').toString('base64') }, user: { knownFaces: [], watchlist: [] }, now: new Date('2026-10-11T10:00:00Z'), signal });

test('remote detector: people and vehicles are counted from confident, sensibly sized detections; the events match the model-based ones; the key and the frame are sent', async () => {
  const svc = await mockService({ key: 'K' });
  try {
    const client = createInferenceClient({ url: svc.url, apiKey: 'K' });
    const a = createRemoteDetectorAnalyzer({ client });
    const out = await a.analyze(input());
    assert.deepEqual(out.fields!.counts, { people: 2, vehicles: 2, other: 0 }, 'a 0.3 score, a tiny box, a dog and a malformed row are not counted');
    assert.deepEqual(out.events!.map((e) => [e.type, e.data!.count]), [['vehicle.seen', 2], ['person.seen', 2]]);
    assert.deepEqual(out.events![0].data!.byLabel, { car: 1, truck: 1 });
    assert.equal(out.events![1].data!.detector, 'mock-yolo');
    assert.equal(svc.seen[0].auth, 'Bearer K');
    assert.deepEqual([svc.seen[0].body.image, svc.seen[0].body.tasks], [Buffer.from('jpeg-bytes').toString('base64'), ['person', 'vehicle']]);
    assert.equal((await client.health()).status, 'ok');
    assert.equal(a.id, 'remote-detector');
  } finally { svc.close(); }
});

test('remote detector: face embeddings are matched to enrolled faces (known, unknown) only when an index exists for the user; the faces task is asked for only then', async () => {
  const svc = await mockService();
  try {
    const known = Array.from({ length: 16 }, (_, i) => (i === 0 ? 1 : 0));
    const index = createFaceIndex([{ id: 'a', name: 'Anil', embedding: known }], { threshold: 0.9 });
    const a = createRemoteDetectorAnalyzer({ client: createInferenceClient({ url: svc.url }), faces: (uid) => (uid === 'u1' ? index : null) });
    const out = await a.analyze(input());
    assert.deepEqual(svc.seen[0].body.tasks, ['person', 'vehicle', 'face']);
    assert.deepEqual(out.fields!.people_identified, ['Anil']);
    const types = out.events!.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t.startsWith('person.') && t !== 'person.seen').sort(), ['person.known', 'person.unknown']);
    const unknown = out.events!.find((e) => e.type === 'person.unknown')!;
    assert.equal((unknown.data!.names as string[]).length, 1, 'one face had an embedding that matched nobody; the one with no embedding is not counted');
    const k = out.events!.find((e) => e.type === 'person.known')!;
    assert.equal(k.confidence! > 0.99, true);
    // Another user has no faces enrolled: no face task, no face events.
    const other = await a.analyze({ ...input(), camera: { ...camera, userId: 'u2' } });
    assert.deepEqual(svc.seen[1].body.tasks, ['person', 'vehicle']);
    assert.equal(other.events!.some((e) => e.type === 'person.known' || e.type === 'person.unknown'), false);
  } finally { svc.close(); }
});

test('remote detector: a failing or slow service fails only this analyzer; after repeated failures it is skipped for a while and then tried again', async () => {
  const svc = await mockService({ status: 503 });
  try {
    let t = 1000;
    const client = createInferenceClient({ url: svc.url, failureThreshold: 2, cooldownMs: 60_000, now: () => t });
    await assert.rejects(client.infer(Buffer.from('x'), ['person']), /answered 503/);
    await assert.rejects(client.infer(Buffer.from('x'), ['person']), /answered 503/);
    const calls = svc.seen.length;
    await assert.rejects(client.infer(Buffer.from('x'), ['person']), /paused/);
    assert.equal(svc.seen.length, calls, 'a paused service is not called');
    t += 61_000;
    await assert.rejects(client.infer(Buffer.from('x'), ['person']), /answered 503/);
    assert.equal(svc.seen.length, calls + 1, 'tried again after the pause');
  } finally { svc.close(); }
  const shape = await mockService({ body: { nonsense: true } });
  try { await assert.rejects(createInferenceClient({ url: shape.url }).infer(Buffer.from('x'), ['person']), /unexpected shape/); } finally { shape.close(); }
  const slow = await mockService({ delayMs: 400 });
  try { await assert.rejects(createInferenceClient({ url: slow.url, timeoutMs: 50 }).infer(Buffer.from('x'), ['person']), /timeout|aborted/i); } finally { slow.close(); }
});

test('remote detector: inside the pipeline its failure is an analyzer.failed notice and the rest of the frame\'s result is kept', async () => {
  const svc = await mockService({ status: 500 });
  try {
    const pipeline = createAnalyzerPipeline({
      analyzers: [
        { id: 'base', label: 'b', description: 'b', required: true, async analyze() { return { fields: { summary: 'calm street', counts: { people: 1, vehicles: 0, other: 0 } } }; } },
        createRemoteDetectorAnalyzer({ client: createInferenceClient({ url: svc.url }) }),
      ],
      log: { warn() {} } as never,
    });
    const r = await pipeline.analyze({ camera, frame: input().frame, user: { knownFaces: [], watchlist: [] }, now: new Date() });
    assert.equal(r.result.summary, 'calm street');
    assert.deepEqual(r.outcomes.map((o) => [o.id, o.ok]), [['base', true], ['remote-detector', false]]);
    assert.equal(r.events.some((e) => e.type === 'analyzer.failed'), true);
  } finally { svc.close(); }
});

test('anomaly: a crowd is not learned as normal while it lasts, but a camera that stays at a new level for long enough gets it as its new usual', () => {
  const det = createAnomalyDetector({ baseline: createBaseline({ minSamples: 8 }), acceptAfter: 5, cooldownMs: 1 });
  learn(det, 'gate', 18, 12, 10);
  // Twenty frames of a crowd of 50 within the same hour of the week: each is unusual until it has lasted past `acceptAfter`, then it is learned.
  let raised = 0;
  for (let i = 0; i < 40; i++) raised += det.handle([seen('person.seen', 'gate', new Date(at(13, 18).getTime() + i * 60_000), 50)]).length;
  assert.equal(raised >= 5, true, `a lasting crowd keeps being reported while it is unusual (got ${raised})`);
  assert.equal(raised < 40, true, 'but once it has become the usual it stops');
  const afterwards = det.handle([seen('person.seen', 'gate', new Date(at(14, 18).getTime()), 50)]);
  assert.deepEqual(afterwards, [], 'fifty is the usual now');
});
