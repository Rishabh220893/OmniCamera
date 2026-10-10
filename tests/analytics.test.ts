import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalyzerPipeline, createDefaultPipeline, createAnprAnalyzer, createGeminiSceneAnalyzer, createSceneFinalizer, createTamperAnalyzer, judgeFingerprint, mergeFields, safeDrafts, type Analyzer, type AnalyzerInput } from '../server/analytics/index.ts';
import { mergePlates } from '../server/plateMerge.ts';
import { ffmpegFingerprint } from '../server/frameGate.ts';
import { createAnalysisWorker, type WorkerCamera, type WorkerDeps } from '../server/analysisWorker.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, createWebhookChannel } from '../server/events/channels.ts';
import { validateRule } from '../server/events/rules.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { EventError, makeEvent } from '../server/events/schema.ts';

const quiet = { warn() {}, log() {} };
const FRAME = Buffer.from('jpeg-bytes');
const input = (over: Partial<Omit<AnalyzerInput, 'signal'>> = {}): Omit<AnalyzerInput, 'signal'> => ({
  camera: { id: 'cam01', name: 'Gate', userId: 'u1' }, frame: { jpeg: FRAME, base64: FRAME.toString('base64') }, user: { knownFaces: [], watchlist: [] }, now: new Date('2026-10-10T10:00:00Z'), ...over,
});
const analyzer = (id: string, f: (i: AnalyzerInput) => ReturnType<Analyzer['analyze']>, extra: Partial<Analyzer> = {}): Analyzer => ({ id, label: id, description: id, analyze: f, ...extra });

// ---- merging ------------------------------------------------------------------------------------------------------

test('merge: lists join without repeats, counts take the larger number, unusual wins, the most severe mood wins, the first summary stays', () => {
  const m = mergeFields([
    { summary: 'A van at the gate', counts: { people: 1, vehicles: 2, other: 0 }, alerts: ['a', 'b'], detected_plates: ['X1'], isUnusual: false, sentiment: 'calm', brands: ['Acme'] },
    { summary: 'ignored', counts: { people: 3, vehicles: 1, other: 4 }, alerts: ['b', 'c'], detected_plates: ['X1', 'Y2'], isUnusual: true, isUnusualReason: 'fence', sentiment: 'tense' },
    undefined,
    { summary: '', isUnusual: true, isUnusualReason: 'crowd; fence', sentiment: 'nonsense', plate_source: 'x' },
  ]);
  assert.equal(m.summary, 'A van at the gate');
  assert.deepEqual(m.counts, { people: 3, vehicles: 2, other: 4 });
  assert.deepEqual(m.alerts, ['a', 'b', 'c']);
  assert.deepEqual(m.detected_plates, ['X1', 'Y2']);
  assert.equal(m.isUnusual, true);
  assert.equal(m.isUnusualReason, 'fence; crowd; fence');
  assert.equal(m.sentiment, 'tense');
  assert.deepEqual(m.brands, ['Acme']);
  assert.equal(m.plate_source, 'x', 'other fields: first non-empty value');
  assert.deepEqual(mergeFields([]), {});
  assert.deepEqual(mergeFields([{ isUnusual: false }]).isUnusual, false);
  assert.deepEqual(mergeFields([{ summary: '' }, { summary: 'later' }]).summary, 'later', 'an empty value does not block a later one');
  assert.equal('alerts' in mergeFields([{ summary: 's' }]), false, 'a list nobody gave stays absent');
});

// ---- pipeline -----------------------------------------------------------------------------------------------------

test('pipeline: analyzers run side by side, skipped ones are reported, ids are checked', async () => {
  const order: string[] = [];
  const slow = analyzer('slow', async () => { order.push('slow-start'); await new Promise((r) => setTimeout(r, 60)); order.push('slow-end'); return { fields: { summary: 'slow' } }; });
  const fast = analyzer('fast', async () => { order.push('fast'); return { fields: { counts: { people: 2, vehicles: 0, other: 0 } } }; });
  const off = analyzer('off', async () => { throw new Error('must not run'); }, { appliesTo: (c) => c.id === 'other' });
  const throwing = analyzer('throwing-applies', async () => ({ fields: { summary: 'x' } }), { appliesTo: () => { throw new Error('bad config'); } });
  const p = createAnalyzerPipeline({ analyzers: [slow, fast, off, throwing], log: quiet });
  const t0 = Date.now();
  const r = await p.analyze(input());
  assert.ok(Date.now() - t0 < 200);
  assert.deepEqual(order, ['slow-start', 'fast', 'slow-end'], 'the fast one finished while the slow one was still running');
  assert.equal(r.result.summary, 'slow');
  assert.deepEqual(r.outcomes.map((o) => [o.id, o.ok, !!o.skipped]), [['slow', true, false], ['fast', true, false], ['off', true, true], ['throwing-applies', true, true]]);
  assert.deepEqual(p.applicable({ id: 'other', name: 'o' }).map((a) => a.id), ['slow', 'fast', 'off']);
  assert.throws(() => createAnalyzerPipeline({ analyzers: [slow, slow] }), /registered twice/);
  for (const id of ['Bad', 'has space', '1x', '', 'a_b']) assert.throws(() => createAnalyzerPipeline({ analyzers: [analyzer(id, async () => ({}))] }), /lower case/, id);
});

test('pipeline: a required analyzer failing fails the analysis with its own error; others fail softly', async () => {
  const must = analyzer('must', async () => { throw new Error('quota exceeded'); }, { required: true });
  const nice = analyzer('nice', async () => { throw new Error('detector offline'); });
  const good = analyzer('good', async () => ({ fields: { summary: 'fine' } }));
  await assert.rejects(createAnalyzerPipeline({ analyzers: [good, must, nice], log: quiet }).analyze(input()), /quota exceeded/);
  const r = await createAnalyzerPipeline({ analyzers: [good, nice], log: quiet }).analyze(input());
  assert.equal(r.result.summary, 'fine', 'the working analyzers still produce the log');
  assert.deepEqual(r.outcomes.map((o) => [o.id, o.ok, o.error]), [['good', true, undefined], ['nice', false, 'detector offline']]);
  assert.deepEqual(r.events.map((e) => [e.type, e.source, e.data]), [['analyzer.failed', 'nice', { analyzer: 'nice', error: 'detector offline' }]]);
});

test('pipeline: failure events are limited to one per analyzer per cooldown; timeouts cut a stuck analyzer off', async () => {
  let now = 0;
  const nice = analyzer('nice', async () => { throw new Error('down'); });
  const p = createAnalyzerPipeline({ analyzers: [nice], log: quiet, failureEventCooldownMs: 1000, now: () => now });
  assert.equal((await p.analyze(input())).events.length, 1);
  now = 500;
  assert.equal((await p.analyze(input())).events.length, 0, 'inside the cooldown');
  now = 1500;
  assert.equal((await p.analyze(input())).events.length, 1, 'after the cooldown');

  let aborted = false;
  const stuck = analyzer('stuck', (i) => new Promise((_, rej) => { i.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); }), { timeoutMs: 40 });
  const r = await createAnalyzerPipeline({ analyzers: [stuck, analyzer('ok', async () => ({ fields: { summary: 's' } }))], log: quiet }).analyze(input());
  assert.equal(r.outcomes[0].error, 'stuck took longer than 40 ms');
  assert.equal(aborted, true, 'the analyzer was told to stop');
  assert.equal(r.result.summary, 's');
});

test('pipeline: events carry their analyzer; a draft that breaks the contract is dropped, not fatal', async () => {
  const a = analyzer('zone-intrusion', async () => ({ events: [{ type: 'zone.intrusion', summary: 'Someone entered zone A', severity: 'critical', data: { zone: 'A' } }, { type: 'Bad Type', summary: 'x' }, { type: 'zone.exit', summary: 'left', source: 'custom-source' }] }));
  const r = await createAnalyzerPipeline({ analyzers: [a], log: quiet }).analyze(input());
  assert.deepEqual(r.events.map((e) => [e.type, e.source]), [['zone.intrusion', 'zone-intrusion'], ['Bad Type', 'zone-intrusion'], ['zone.exit', 'custom-source']]);
  const bad: string[] = [];
  const events = safeDrafts(r.events, (d) => makeEvent(d, { source: 'x', camera: { id: 'c', name: 'c', userId: 'u' }, ts: new Date() }), (d, e) => { assert.ok(e instanceof EventError); bad.push(d.type); });
  assert.deepEqual(events.map((e) => e.type), ['zone.intrusion', 'zone.exit']);
  assert.deepEqual(bad, ['Bad Type']);
  assert.throws(() => safeDrafts([{ type: 'a.b', summary: 's' }], () => { throw new TypeError('real bug'); }, () => {}), /real bug/, 'only contract errors are swallowed');
});

// ---- parity with the code this replaced ---------------------------------------------------------------------------

/** What analyzeFrame did with a Gemini answer and the ANPR outcome before the refactor (server.ts at b2bfc01). */
function referenceFinish(data: { detected_plates?: string[]; [k: string]: unknown }, anpr: { reads: any[] } | { error: unknown } | null, watchlist: string[]) {
  const merged = mergePlates((data.detected_plates || []).map(String), anpr);
  const set = new Set(watchlist.map((p) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '')));
  return { ...data, detected_plates: merged.plates, watchlistMatches: merged.plates.filter((p) => set.has(p)), plate_reads: merged.reads, plate_source: merged.source };
}

const GEMINI = { summary: 'A van', counts: { people: 1, vehicles: 1, other: 0 }, brands: ['Acme'], people_identified: ['Unknown Person'], alerts: [], isUnusual: false, isUnusualReason: '', detected_plates: ['gj 05 ab 1234', 'MH12XY9999'], sentiment: 'calm' };
const READ = (text: string, confidence = 0.9) => ({ text, confidence, rawText: text, formatValid: true, corrected: false });

test('parity: the default pipeline returns what analyzeFrame returned, for every ANPR situation', async () => {
  const situations: Array<[string, { detect: (b: Buffer) => Promise<any[]> } | null, any]> = [
    ['no ANPR configured', null, null],
    ['ANPR reads plates', { detect: async () => [READ('GJ05AB1234'), READ('KA01ZZ0001', 0.5)] }, { reads: [READ('GJ05AB1234'), READ('KA01ZZ0001', 0.5)] }],
    ['ANPR answers with no plates (authoritative)', { detect: async () => [] }, { reads: [] }],
    ['ANPR is down', { detect: async () => { throw new Error('ECONNREFUSED'); } }, { error: 'x' }],
  ];
  for (const watchlist of [[], ['GJ05AB1234'], ['gj-05-ab-1234', 'MH12XY9999']]) {
    for (const [name, anpr, expectedAnpr] of situations) {
      const p = createDefaultPipeline({ generate: async () => ({ text: JSON.stringify(GEMINI) }), anpr: anpr as never, off: ['camera-tamper'], log: quiet });
      const got = (await p.analyze(input({ user: { knownFaces: [], watchlist } }))).result;
      const want = referenceFinish(GEMINI, expectedAnpr, watchlist);
      assert.deepEqual(got, want, `${name}, watchlist ${JSON.stringify(watchlist)}`);
    }
  }
});

test('parity: a failing or odd Gemini answer behaves as before', async () => {
  const run = (generate: () => Promise<{ text?: string }>) => createDefaultPipeline({ generate, anpr: null, off: ['camera-tamper'], log: quiet }).analyze(input());
  await assert.rejects(run(async () => { throw new Error('429 quota'); }), /429 quota/);
  await assert.rejects(run(async () => ({ text: 'not json' })), SyntaxError);
  const empty = (await run(async () => ({ text: '' }))).result;
  assert.deepEqual(empty, { detected_plates: [], watchlistMatches: [], plate_reads: [], plate_source: 'gemini' }, 'an empty answer is {} like before');
  const t = (await run(async () => ({}))).result;
  assert.equal(t.plate_source, 'gemini');
});

test('parity: the Gemini prompt is exactly the one analyzeFrame sent (fixture taken from git b2bfc01)', async () => {
  const fx = JSON.parse(readFileSync('tests/fixtures/geminiScenePrompt.json', 'utf8')) as { prompt: string; knownFacesContext: string };
  const expected = (c: { name: string; sensitivity: number; people: number; vehicles: number; rules: string }, faces: string[]) => {
    const ctx = faces.length ? fx.knownFacesContext.replace('${faceDataParts.length}', String(faces.length)).replace("${faces.map((f) => f.name).join(', ')}", faces.join(', ')) : '';
    return fx.prompt
      .replace("${camera?.name ?? 'Unknown'}", c.name).replace('${camera?.sensitivity ?? 5}', String(c.sensitivity))
      .replace('${camera?.peopleThreshold ?? 5}', String(c.people)).replace('${camera?.vehicleThreshold ?? 2}', String(c.vehicles))
      .replace("${camera?.suspiciousRules ? `- CUSTOM SUSPICIOUS RULES: ${camera.suspiciousRules}` : ''}", c.rules ? `- CUSTOM SUSPICIOUS RULES: ${c.rules}` : '')
      .replace('${knownFacesContext}', ctx);
  };
  const capture = async (camera: any, faces: Array<{ name: string; imageData: string }>) => {
    let seen: any;
    await createGeminiSceneAnalyzer({ generate: async (p) => { seen = p; return { text: '{}' }; }, log: quiet }).analyze({ ...input({ camera, user: { knownFaces: faces, watchlist: [] } }), signal: new AbortController().signal });
    return seen;
  };
  const faces = [{ name: 'Jane', imageData: 'data:image/jpeg;base64,AAAA' }, { name: 'John', imageData: 'BBBB' }];
  for (const [camera, f] of [
    [{ id: 'c', name: 'Gate', sensitivity: 7, peopleThreshold: 4, vehicleThreshold: 3, suspiciousRules: 'anyone climbing' }, faces],
    [{ id: 'c', name: 'Yard' }, []],
    [{ id: 'c', name: 'Dock', suspiciousRules: '' }, faces.slice(0, 1)],
  ] as const) {
    const seen = await capture(camera, [...f]);
    const parts = seen.contents.parts as any[];
    const promptText = parts.at(-1).text as string;
    const norm = (s: string) => s.replace(/\r/g, '');
    assert.equal(norm(promptText), norm(expected({ name: camera.name, sensitivity: (camera as any).sensitivity ?? 5, people: (camera as any).peopleThreshold ?? 5, vehicles: (camera as any).vehicleThreshold ?? 2, rules: (camera as any).suspiciousRules ?? '' }, f.map((x) => x.name))), JSON.stringify(camera));
    assert.deepEqual(parts.slice(0, 1 + f.length + 1).map((p) => p.text ?? (p.inlineData ? 'img' : '?')), ['KNOWN INDIVIDUALS REFERENCE IMAGES (If provided):', ...f.map(() => 'img'), 'MAIN CAMERA FEED FRAME TO ANALYZE:']);
    assert.equal(parts[1 + f.length + 1].inlineData.data, FRAME.toString('base64'));
    if (f.length) assert.deepEqual(parts.slice(1, 1 + f.length).map((x) => x.inlineData.data), f.map((x) => (x.imageData.includes(',') ? x.imageData.split(',')[1] : x.imageData)), 'a data: URL prefix is stripped from face images');
    assert.deepEqual(seen.config, { responseMimeType: 'application/json' });
  }
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, imageData: 'AA' }));
  const sevenFaces = (await capture({ id: 'c', name: 'x' }, many)).contents.parts as any[];
  assert.equal(sevenFaces.filter((p) => p.inlineData).length, 7, 'nine faces offered: the first six are sent, plus the frame');
});

// ---- the camera-tamper analyzer ----------------------------------------------------------------------------------

test('tamper: pixel statistics tell blocked, dark and overexposed pictures from normal ones', () => {
  const flat = (v: number) => new Uint8Array(64 * 36).fill(v);
  const noisy = Uint8Array.from({ length: 64 * 36 }, (_, i) => (i * 37) % 256);
  assert.equal(judgeFingerprint(noisy).state, 'ok');
  assert.equal(judgeFingerprint(flat(120)).state, 'blocked');
  assert.equal(judgeFingerprint(flat(0)).state, 'dark');
  assert.equal(judgeFingerprint(flat(255)).state, 'overexposed');
  assert.equal(judgeFingerprint(flat(12)).state, 'dark', 'at the dark limit');
  assert.equal(judgeFingerprint(flat(13)).state, 'blocked');
  assert.equal(judgeFingerprint(flat(243)).state, 'overexposed');
  assert.equal(judgeFingerprint(new Uint8Array(0)).state, 'ok');
  const night = Uint8Array.from({ length: 64 * 36 }, (_, i) => (i % 7 === 0 ? 40 : 6));
  assert.equal(judgeFingerprint(night).state, 'ok', 'a night scene with lights in it is still a picture (dark on average, but not flat)');
  const sensorNoise = Uint8Array.from({ length: 64 * 36 }, (_, i) => 2 + (i % 3));
  assert.equal(judgeFingerprint(sensorNoise).state, 'dark', 'a covered lens shows only sensor noise');
  const glare = Uint8Array.from({ length: 64 * 36 }, (_, i) => 250 + (i % 4));
  assert.equal(judgeFingerprint(glare).state, 'overexposed');
  const slightlyNoisyGrey = Uint8Array.from({ length: 64 * 36 }, (_, i) => 120 + (i % 3));
  assert.equal(judgeFingerprint(slightlyNoisyGrey).state, 'blocked');
  const v = judgeFingerprint(flat(0)) as { mean: number; stdDev: number };
  assert.deepEqual([v.mean, v.stdDev], [0, 0]);
});

test('tamper: the analyzer reports an event only for a bad picture, and never fails the frame when the picture cannot be read', async () => {
  const run = (fp: Uint8Array | null | 'throw') => createTamperAnalyzer({ fingerprint: async () => { if (fp === 'throw') throw new Error('x'); return fp; } }).analyze({ ...input(), signal: new AbortController().signal });
  assert.deepEqual(await run(Uint8Array.from({ length: 100 }, (_, i) => i * 2)), {});
  assert.deepEqual(await run(null), {});
  const out = await run(new Uint8Array(2304).fill(2));
  assert.equal(out.events![0].type, 'camera.dark');
  assert.equal(out.events![0].severity, 'warning');
  assert.deepEqual(out.events![0].tags, ['tamper']);
  const p = createAnalyzerPipeline({ analyzers: [createTamperAnalyzer({ fingerprint: async () => { throw new Error('ffmpeg missing'); } })], log: quiet });
  const r = await p.analyze(input());
  assert.equal(r.outcomes[0].ok, false);
  assert.equal(r.events[0].type, 'analyzer.failed');
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('tamper with real images: black, white, flat grey and a real picture, through ffmpeg', { skip: !hasFfmpeg && 'ffmpeg not available' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tamper-'));
  try {
    const make = (name: string, src: string) => { const f = path.join(dir, name); execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-frames:v', '1', '-y', f]); return readFileSync(f); };
    const images: Array<[string, Buffer, string | null]> = [
      ['black.jpg', make('black.jpg', 'color=c=black:s=640x360'), 'camera.dark'],
      ['white.jpg', make('white.jpg', 'color=c=white:s=640x360'), 'camera.overexposed'],
      ['grey.jpg', make('grey.jpg', 'color=c=0x808080:s=640x360'), 'camera.blocked'],
      ['scene.jpg', make('scene.jpg', 'testsrc2=s=640x360'), null],
    ];
    const a = createTamperAnalyzer();
    for (const [name, jpeg, want] of images) {
      const out = await a.analyze({ ...input({ frame: { jpeg, base64: jpeg.toString('base64') } }), signal: new AbortController().signal });
      assert.equal(out.events?.[0]?.type ?? null, want, name);
    }
    assert.equal(await ffmpegFingerprint(Buffer.from('not an image')), null, 'an unreadable image gives no verdict');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the whole path: a new analyzer reaches an alert with no change to the worker --------------------------------

test('a new detector added to the pipeline reaches a webhook alert through the unchanged worker', async () => {
  // The "detector": counts people in a zone. Nothing in the worker, the log or the alert code knows it exists.
  const zone = analyzer('zone-intrusion', async ({ camera }) => ({
    events: [{ type: 'zone.intrusion', summary: `Person in restricted zone at ${camera.name}`, severity: 'critical', data: { zone: 'loading-bay', people: 2 }, confidence: 0.82 }],
  }));
  const pipeline = createDefaultPipeline({ generate: async () => ({ text: JSON.stringify({ ...GEMINI, detected_plates: [], people_identified: [] }) }), anpr: null, off: ['camera-tamper'], extra: [zone], log: quiet });

  const store = createMemoryAlertStore();
  const hooks: Array<{ url: string; body: any; headers: any }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => { hooks.push({ url, body: JSON.parse(String(init.body)), headers: init.headers }); return new Response('', { status: 200 }); }) as never;
  const engine = createAlertEngine({ store, channels: createChannelRegistry([createWebhookChannel({ fetchImpl: fakeFetch }) as never]), log: { warn() {}, info() {} } });
  await store.saveRule(validateRule({ name: 'Zone breach', match: { types: ['zone.*'], minSeverity: 'warning', where: [{ field: 'data.people', op: 'gte', value: 1 }] }, channels: [{ type: 'webhook', url: 'https://hooks.example.org/z', secret: 's' }] }, { userId: 'u1', id: 'r1', now: new Date() }));

  const logs: any[] = [];
  const deps: WorkerDeps = {
    now: () => Date.now(), subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: [] }), grabFrame: async () => FRAME,
    analyze: async ({ imageBase64, camera, knownFaces, watchlist }) => {
      const r = await pipeline.analyze({ camera: { id: camera.id, name: camera.name, userId: camera.userId }, frame: { jpeg: Buffer.from(imageBase64, 'base64'), base64: imageBase64 }, user: { knownFaces, watchlist }, now: new Date() });
      return { ...r.result, events: r.events, analyzers: r.outcomes };
    },
    writeLog: async (d) => { logs.push(d); }, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {},
    emitEvents: async (events) => { await engine.ingest(events); }, log: { info() {}, warn() {}, error() {} },
  };
  const worker = createAnalysisWorker(deps, { concurrency: 1 });
  const camera: WorkerCamera = { id: 'cam07', userId: 'u1', name: 'Loading bay', remoteStreamUrl: 'https://x.test/c', interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '', department: 'Logistics' };
  worker._applyCameras([camera]);
  worker._tick();
  await worker._idle();
  await engine.idle();
  await new Promise((r) => setTimeout(r, 20));
  await engine.idle();

  assert.equal(logs.length, 1, 'the log is written as before');
  assert.equal(logs[0].detectedPlates.length, 0);
  const events = await store.queryEvents({ userId: 'u1' });
  assert.deepEqual(events.map((e) => e.type).sort(), ['zone.intrusion']);
  assert.equal(events[0].source, 'zone-intrusion');
  assert.equal(events[0].department, 'Logistics');
  assert.equal(events[0].cameraId, 'cam07');
  assert.equal(hooks.length, 1, 'exactly one webhook');
  assert.equal(hooks[0].url, 'https://hooks.example.org/z');
  assert.equal(hooks[0].body.event.type, 'zone.intrusion');
  assert.equal(hooks[0].body.event.data.zone, 'loading-bay');
  assert.equal(hooks[0].body.rule.name, 'Zone breach');
  assert.match(String((hooks[0].headers as Record<string, string>)['X-OmniSee-Signature']), /^sha256=[0-9a-f]{64}$/);
  const alerts = await store.listAlerts({ userId: 'u1' });
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].deliveries.map((d) => d.ok), [true]);
});

test('worker: events come from the existing Gemini/ANPR result with no analyzer changes (plates, watchlist, unusual scene)', async () => {
  const got: any[] = [];
  const logs: any[] = [];
  const deps: WorkerDeps = {
    now: () => Date.now(), subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: ['GJ05AB1234'] }), grabFrame: async () => FRAME,
    analyze: async () => ({ summary: 's', counts: { people: 1, vehicles: 1, other: 0 }, detected_plates: ['GJ05AB1234', 'MH12XY9999'], watchlistMatches: ['GJ05AB1234'], plate_reads: [{ plate: 'GJ05AB1234', confidence: 0.93, formatValid: true, corrected: false }], plate_source: 'anpr', people_identified: ['Unknown Person'], isUnusual: true, isUnusualReason: 'Fence climbing', sentiment: 'tense', alerts: ['Person near gate'], events: [{ type: 'Bad Type', summary: 'bad' }, { type: 'zone.entered', summary: 'in', source: 'z' }] }),
    writeLog: async (d) => { logs.push(d); }, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {},
    emitEvents: async (e) => { got.push(...e); }, log: { info() {}, warn() {}, error() {} },
  };
  const worker = createAnalysisWorker(deps, { concurrency: 1 });
  worker._applyCameras([{ id: 'c1', userId: 'u1', name: 'Gate', remoteStreamUrl: 'https://x.test/c', interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '' }]);
  worker._tick();
  await worker._idle();
  assert.deepEqual(got.map((e) => `${e.type}:${e.source}`), ['plate.read:anpr', 'plate.watchlist_match:anpr', 'plate.read:anpr', 'person.unknown:gemini-scene', 'scene.unusual:gemini-scene', 'scene.alert:gemini-scene', 'zone.entered:z']);
  assert.equal(got.find((e) => e.type === 'plate.watchlist_match').severity, 'critical');
  assert.equal(got.every((e) => e.ts === logs[0].timestamp.toISOString()), true, 'events carry the time of the frame');
  assert.equal(new Set(got.map((e) => e.id)).size, got.length);
});

test('worker: an event receiver that fails or hangs never delays or fails the analysis', async () => {
  let hung = false;
  const deps = (emit: WorkerDeps['emitEvents']): WorkerDeps => ({
    now: () => Date.now(), subscribeCameras: () => () => {}, loadUserContext: async () => ({ knownFaces: [], watchlist: [] }), grabFrame: async () => FRAME,
    analyze: async () => ({ summary: 's', detected_plates: ['AB12CD3456'] }), writeLog: async () => {}, writeSightings: async () => {}, updateCamera: async () => {}, sendWebhook: async () => {},
    emitEvents: emit, log: { info() {}, warn() {}, error() {} },
  });
  const cam: WorkerCamera = { id: 'c1', userId: 'u1', name: 'Gate', remoteStreamUrl: 'https://x.test/c', interval: 10, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '' };
  for (const emit of [async () => { throw new Error('db down'); }, () => { hung = true; return new Promise<void>(() => {}); }]) {
    const w = createAnalysisWorker(deps(emit as never), { concurrency: 1 });
    w._applyCameras([cam]);
    w._tick();
    await w._idle();
    assert.equal(w.status().cameras[0].failures, 0, 'the camera is healthy');
    assert.equal(w.status().cameras[0].lastError, null);
  }
  assert.equal(hung, true);
});
