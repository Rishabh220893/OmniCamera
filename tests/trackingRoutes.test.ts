import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createGeminiChecks, parseJsonAnswer, parseStartRequest, registerTrackingRoutes, trackingOptionsFromEnv, type TrackingContext } from '../server/trackingRoutes.ts';

const cam = (n: number) => ({ id: `cam${String(n).padStart(2, '0')}`, name: `CAM${n} Road`, url: `https://cctv.example.org/cam${String(n).padStart(2, '0')}/index.m3u8` });
const PNG = 'data:image/png;base64,' + Buffer.alloc(900, 7).toString('base64');

test('start request: a plate is normalised, and a bad one is refused in words', () => {
  const r = parseStartRequest({ mode: 'plate', plate: ' gj 05-ab 1234 ', cameras: [cam(1), cam(2)] });
  assert.deepEqual(r.spec, { mode: 'plate', plate: 'GJ05AB1234' });
  assert.equal(r.cameras.length, 2);
  assert.throws(() => parseStartRequest({ mode: 'plate', plate: 'AB1', cameras: [cam(1)] }), /4 to 12 letters and digits/);
  assert.throws(() => parseStartRequest({ mode: 'plate', plate: 'GJ05AB1234', cameras: [] }), /No cameras/);
  assert.throws(() => parseStartRequest({ mode: 'nonsense', cameras: [cam(1)] }), /plate, face or rules/);
});

test('start request: a face needs a real photo of a sensible size; a rule needs words', () => {
  const f = parseStartRequest({ mode: 'face', faceImage: PNG, faceLabel: '  Test Person A  ', cameras: [cam(1)] });
  assert.equal(f.spec.mode === 'face' && f.spec.label, 'Test Person A');
  assert.equal(f.spec.mode === 'face' && f.spec.mimeType, 'image/png');
  assert.equal(f.spec.mode === 'face' && f.spec.image.length, 900);
  assert.throws(() => parseStartRequest({ mode: 'face', faceImage: 'not an image', cameras: [cam(1)] }), /Upload a photo/);
  assert.throws(() => parseStartRequest({ mode: 'face', faceImage: 'data:image/gif;base64,AAAA', cameras: [cam(1)] }), /Upload a photo/);
  assert.throws(() => parseStartRequest({ mode: 'face', faceImage: 'data:image/png;base64,AAAA', cameras: [cam(1)] }), /too small/);
  assert.throws(() => parseStartRequest({ mode: 'face', faceImage: 'data:image/jpeg;base64,' + Buffer.alloc(5 * 1024 * 1024).toString('base64'), cameras: [cam(1)] }), /larger than 4 MB/);
  assert.equal(parseStartRequest({ mode: 'face', faceImage: PNG, cameras: [cam(1)] }).spec.mode === 'face' && 'Tracked person', 'Tracked person');
  assert.throws(() => parseStartRequest({ mode: 'rules', rules: 'x', cameras: [cam(1)] }), /Describe what should raise an alert/);
  assert.equal((parseStartRequest({ mode: 'rules', rules: '  a person climbing the fence ', cameras: [cam(1)] }).spec as { rules: string }).rules, 'a person climbing the fence');
});

test('start request: private addresses, bad ids and duplicates are dropped, and the rest still run', () => {
  const r = parseStartRequest({ mode: 'rules', rules: 'anything odd here', cameras: [
    cam(1), cam(1), { id: 'cam02', name: 'inside', url: 'http://192.168.1.5/x.m3u8' }, { id: '../etc', name: 'x', url: 'https://a.example/x' }, { id: 'cam03', name: '', url: 'rtsp://cams.example.org/x' },
  ] });
  assert.deepEqual(r.cameras.map((c) => c.id), ['cam01', 'cam03']);
  assert.equal(r.cameras[1].name, 'cam03');
  assert.equal(r.rejected.length, 2);
  assert.throws(() => parseStartRequest({ mode: 'rules', rules: 'anything odd here', cameras: [{ id: 'a', name: 'a', url: 'http://127.0.0.1/x' }] }), /None of the cameras/);
  assert.equal(parseStartRequest({ mode: 'rules', rules: 'anything odd here', cameras: [{ id: 'a', name: 'a', url: 'http://127.0.0.1/x' }] }, { allowAnyUrl: true }).cameras.length, 1);
  const many = Array.from({ length: 300 }, (_, i) => cam(i + 1)).map((c, i) => ({ ...c, id: `c${i}` }));
  assert.equal(parseStartRequest({ mode: 'rules', rules: 'anything odd here', cameras: many }).cameras.length, 200);
});

test('gemini prompts: the answers are parsed, clamped and never trusted blindly', async () => {
  assert.deepEqual(parseJsonAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJsonAnswer('I cannot help with that'), /expected format/);
  const seen: unknown[] = [];
  const answer = (o: unknown) => async (p: unknown) => { seen.push(p); return { text: JSON.stringify(o) }; };
  const face = await createGeminiChecks(answer({ match: true, confidence: 7, reason: '  same   glasses ' })).matchFace(Buffer.from('f'), { image: Buffer.from('r'), mimeType: 'image/png', label: 'A' });
  assert.deepEqual(face, { match: true, confidence: 1, reason: 'same glasses' });
  const parts = (seen[0] as { contents: { parts: Array<{ inlineData?: { mimeType: string } }> } }).contents.parts;
  assert.deepEqual(parts.filter((p) => p.inlineData).map((p) => p.inlineData!.mimeType), ['image/png', 'image/jpeg'], 'the reference and the frame both go to Gemini');
  assert.equal((await createGeminiChecks(answer({ match: 'yes', confidence: 'high' })).matchFace(Buffer.from('f'), { image: Buffer.from('r'), mimeType: 'image/png', label: 'Ann' })).match, false, 'only a real boolean true counts');
  const rule = await createGeminiChecks(answer({ violated: true, confidence: 0.8, reason: 'a man is on the wall' })).checkRules(Buffer.from('f'), 'climbing', 'CAM1');
  assert.deepEqual(rule, { violated: true, confidence: 0.8, reason: 'a man is on the wall' });
  assert.match(JSON.stringify(seen[2]), /climbing/);
  const plates = await createGeminiChecks(answer({ plates: [{ text: 'gj 05 ab 1234', confidence: 0.9 }, { text: 'X', confidence: 1 }, { text: 'MH12DE1433' }] })).readPlates(Buffer.from('f'));
  assert.deepEqual(plates, [{ text: 'GJ05AB1234', confidence: 0.9 }, { text: 'MH12DE1433', confidence: 0 }]);
});

test('settings: the interval cannot go below 5 s; nonsense falls back', () => {
  assert.deepEqual(trackingOptionsFromEnv({}), {});
  assert.equal(trackingOptionsFromEnv({ TRACK_INTERVAL_S: '1' }).intervalMs, 5000);
  assert.equal(trackingOptionsFromEnv({ TRACK_INTERVAL_S: '20' }).intervalMs, 20000);
  assert.equal(trackingOptionsFromEnv({ TRACK_MIN_CONFIDENCE: '5' }).minConfidence, undefined);
  assert.equal(trackingOptionsFromEnv({ TRACK_CONCURRENCY: 'x' }).concurrency, undefined);
});

async function serve(over: Partial<TrackingContext> = {}) {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  const answers: unknown[] = [];
  const ctx: TrackingContext = {
    generate: async (p) => { answers.push(p); return { text: JSON.stringify({ plates: [{ text: 'GJ05AB1234', confidence: 0.9 }] }) }; },
    anpr: { detect: async () => [{ text: 'GJ05AB1234', confidence: 0.95 }] },
    grab: async (c) => Buffer.from(`frame:${c.id}`),
    credentials: (req) => ({ email: String(req.header('X-Stream-Email') || ''), password: String(req.header('X-Stream-Password') || '') }),
    requireUser: async (req, res) => { if (req.header('Authorization') === 'Bearer ok') return true; res.status(401).json({ error: 'Sign-in required.' }); return false; },
    env: { GEMINI_API_KEY: 'k' }, log: { info() {}, warn() {} },
    ...over,
  };
  const { tracker } = registerTrackingRoutes(app, ctx);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, init: RequestInit & { json?: unknown; auth?: boolean; creds?: boolean } = {}) => fetch(base + path, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.auth === false ? {} : { Authorization: 'Bearer ok' }), ...(init.creds === false ? {} : { 'X-Stream-Email': 'a@b.c', 'X-Stream-Password': 'pw' }) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return { call, tracker, answers, close: () => { tracker.shutdown(); server.close(); } };
}

test('routes: start, watch, read the alert and its frame, stop', async () => {
  const s = await serve();
  try {
    const bad = await s.call('/api/tracking/start', { json: { mode: 'plate', plate: 'x', cameras: [cam(1)] } });
    assert.equal(bad.status, 400);
    const r = await s.call('/api/tracking/start', { json: { mode: 'plate', plate: 'GJ 05 AB 1234', cameras: [cam(1), cam(2)] } });
    assert.equal(r.status, 202);
    const started = await r.json();
    assert.deepEqual([started.started, started.cameras, started.plateReader], [true, 2, 'anpr']);
    assert.ok(!JSON.stringify(started).includes('pw'), 'the login is never echoed');
    await s.tracker.tick();
    const st = await (await s.call('/api/tracking/status')).json();
    assert.deepEqual([st.active, st.mode, st.target, st.intervalSec, st.plateReader], [true, 'plate', 'GJ05AB1234', 10, 'anpr']);
    assert.equal(st.alerts.length, 1, 'the first camera is due at once; the second is spread to half an interval later');
    assert.equal((await (await s.call(`/api/tracking/status?after=${st.alerts[0].id}`)).json()).alerts.length, 0, 'nothing newer than the one already seen');
    const frame = await s.call(`/api/tracking/alerts/${st.alerts[0].id}/frame.jpg`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await frame.arrayBuffer()).toString().slice(0, 6), 'frame:');
    assert.equal((await s.call('/api/tracking/alerts/999/frame.jpg')).status, 404);
    assert.equal((await (await s.call('/api/tracking/stop', { json: {} })).json()).stopped, true);
    assert.equal((await (await s.call('/api/tracking/status')).json()).active, false);
  } finally { s.close(); }
});

test('routes: signed-out callers are refused, a missing camera login is explained, a missing key is explained', async () => {
  const s = await serve();
  try {
    for (const [path, init] of [['/api/tracking/status', {}], ['/api/tracking/start', { json: { mode: 'plate', plate: 'GJ05AB1234', cameras: [cam(1)] } }], ['/api/tracking/stop', { json: {} }]] as const) {
      assert.equal((await s.call(path, { ...init, auth: false })).status, 401, path);
    }
    const noCreds = await s.call('/api/tracking/start', { json: { mode: 'plate', plate: 'GJ05AB1234', cameras: [cam(1)] }, creds: false });
    assert.equal(noCreds.status, 401);
    assert.match((await noCreds.json()).error, /Stream access email and password/);
  } finally { s.close(); }
  const noKey = await serve({ env: {}, anpr: null });
  try {
    const face = await noKey.call('/api/tracking/start', { json: { mode: 'face', faceImage: PNG, cameras: [cam(1)] } });
    assert.equal(face.status, 503);
    assert.match((await face.json()).error, /GEMINI_API_KEY/);
    assert.equal((await noKey.call('/api/tracking/start', { json: { mode: 'plate', plate: 'GJ05AB1234', cameras: [cam(1)] } })).status, 503);
  } finally { noKey.close(); }
});

test('plates fall back to Gemini, and say so, when the plate reader is absent or failing', async () => {
  for (const anpr of [null, { detect: async () => { throw new Error('connection refused'); } }]) {
    const s = await serve({ anpr });
    try {
      const r = await s.call('/api/tracking/start', { json: { mode: 'plate', plate: 'GJ05AB1234', cameras: [cam(1)] } });
      assert.equal((await r.json()).plateReader, anpr ? 'anpr' : 'gemini');
      await s.tracker.tick();
      const st = await (await s.call('/api/tracking/status')).json();
      assert.equal(st.alerts[0].source, 'gemini-fallback');
      assert.match(st.alerts[0].detail, /unverified read/);
      assert.equal(s.answers.length, 1);
    } finally { s.close(); }
  }
});
