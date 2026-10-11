/**
 * Recorded snippets: the store (file; PostgreSQL when TEST_DATABASE_URL is set), the recorder with REAL ffmpeg against a camera simulated by a
 * generated video served over HTTP, and the HTTP routes: start, poll, play with ranges, thumbnail, access rules, limits, failures, restart recovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync, existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createFileSnippetStore, createPostgresSnippetStore, type Snippet, type SnippetStore } from '../server/snippets/store.ts';
import { recordClip, streamCandidates, buildRecordArgs } from '../server/snippets/recorder.ts';
import { registerSnippetRoutes } from '../server/snippets/routes.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const T0 = '2026-10-11T10:00:00.000Z';
const mk = (id: string, over: Partial<Snippet> = {}): Snippet => ({
  id, userId: 'u1', cameraId: 'cam1', cameraName: 'Gate', department: 'Traffic', title: id, status: 'ready', requestedSeconds: 10, actualSeconds: 9.8, bytes: 1000, hasThumb: true,
  error: null, sha256: 'ab'.repeat(32), createdAt: T0, finishedAt: T0, ...over,
});

// ---- the store: one set of expectations for both implementations ----------------------------------------------------------------------

async function storeConformance(store: SnippetStore) {
  await store.insert(mk('snp_0000000000000001', { createdAt: '2026-10-11T10:00:01.000Z' }));
  await store.insert(mk('snp_0000000000000002', { userId: 'u2', cameraId: 'cam2', createdAt: '2026-10-11T10:00:02.000Z', bytes: 500 }));
  await store.insert(mk('snp_0000000000000003', { status: 'recording', createdAt: '2026-10-11T10:00:03.000Z', actualSeconds: null, bytes: 0, hasThumb: false, sha256: null, finishedAt: null }));
  assert.deepEqual((await store.list()).map((s) => s.id), ['snp_0000000000000003', 'snp_0000000000000002', 'snp_0000000000000001'], 'newest first');
  assert.deepEqual((await store.list({ userId: 'u2' })).map((s) => s.id), ['snp_0000000000000002']);
  assert.deepEqual((await store.list({ cameraId: 'cam1' })).map((s) => s.id).sort(), ['snp_0000000000000001', 'snp_0000000000000003']);
  const one = (await store.get('snp_0000000000000001'))!;
  assert.deepEqual([one.userId, one.status, one.actualSeconds, one.bytes, one.hasThumb, one.department, one.createdAt], ['u1', 'ready', 9.8, 1000, true, 'Traffic', '2026-10-11T10:00:01.000Z']);
  assert.equal(await store.get('snp_nope'), null);
  assert.equal(await store.totalBytes(), 1500);
  assert.equal(await store.update('snp_0000000000000003', { status: 'ready', bytes: 7, actualSeconds: 4.5, hasThumb: true, finishedAt: T0 }), true);
  assert.equal(await store.update('snp_missing', { bytes: 1 }), false);
  const up = (await store.get('snp_0000000000000003'))!;
  assert.deepEqual([up.status, up.bytes, up.actualSeconds, up.hasThumb], ['ready', 7, 4.5, true]);
  await store.insert(mk('snp_0000000000000004', { status: 'recording', createdAt: '2026-10-11T10:00:04.000Z' }));
  assert.equal(await store.failInterrupted('restarted', new Date('2026-10-11T11:00:00Z')), 1);
  const cut = (await store.get('snp_0000000000000004'))!;
  assert.deepEqual([cut.status, cut.error], ['failed', 'restarted']);
  assert.equal(await store.remove('snp_0000000000000001'), true);
  assert.equal(await store.remove('snp_0000000000000001'), false);
  assert.equal((await store.list()).length, 3);
}

test('file store: list, filter, update, interrupted recordings, remove; survives a restart (same file, new store)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  try {
    const file = join(dir, 'snippets.json');
    await storeConformance(createFileSnippetStore(file));
    assert.equal((await createFileSnippetStore(file).list()).length, 3, 'a new store on the same file sees the same rows');
    assert.equal(createFileSnippetStore(join(dir, 'missing', 'x.json')).kind, 'file');
    assert.deepEqual(await createFileSnippetStore(join(dir, 'absent.json')).list(), [], 'no file yet: empty list');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file store: many quick changes at once are all kept (no write overwrites another)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  try {
    const s = createFileSnippetStore(join(dir, 'snippets.json'));
    await Promise.all(Array.from({ length: 40 }, (_, i) => s.insert(mk(`snp_${String(i).padStart(16, '0')}`, { createdAt: new Date(Date.parse(T0) + i).toISOString() }))));
    assert.equal((await createFileSnippetStore(join(dir, 'snippets.json')).list({ limit: 500 })).length, 40);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const pgUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL store: the same expectations as the file store (needs TEST_DATABASE_URL; runs in a scratch schema that is dropped)', { skip: !pgUrl }, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: pgUrl, max: 1, ssl: process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  const schema = `snippets_test_${Math.random().toString(16).slice(2, 10)}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
    const store = createPostgresSnippetStore(client as never);
    await store.init();
    await storeConformance(store);
  } finally { await client.query('SET search_path TO public').catch(() => {}); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); client.release(); await pool.end(); }
});

// ---- the recorder ---------------------------------------------------------------------------------------------------------------------

test('stream candidates: grid cameras try RTSP then HLS (credentials encoded); other rtsp and http addresses are used as they are; a still picture cannot be recorded', () => {
  const creds = { email: 'a@b.c', password: 'p/w:1' };
  const g = streamCandidates({ url: 'https://cctv.corp8.cloud/cam07/index.m3u8', creds, gridRtspHost: '1.2.3.4:8554', localBaseUrl: 'http://localhost:3000' });
  assert.deepEqual(g.map((c) => c.label), ['RTSP', 'HLS']);
  assert.ok(g[0].url.startsWith('rtsp://a%40b.c:p%2Fw%3A1@1.2.3.4:8554/stream/cam07'));
  assert.deepEqual(streamCandidates({ url: 'rtsp://cam.example/stream1', creds, gridRtspHost: 'x', localBaseUrl: 'y' }).map((c) => [c.label, c.isRtsp]), [['RTSP', true]]);
  assert.deepEqual(streamCandidates({ url: 'https://cam.example/live.m3u8', creds, gridRtspHost: 'x', localBaseUrl: 'y' }).map((c) => c.label), ['HTTP']);
  assert.deepEqual(streamCandidates({ url: 'https://cam.example/snap.jpg', creds, gridRtspHost: 'x', localBaseUrl: 'y' }), []);
  const a = buildRecordArgs({ url: 'rtsp://x/y', isRtsp: true, label: 'RTSP' }, 12, 'o.mp4', false);
  assert.ok(a.includes('-c:v') && a.includes('copy') && a.includes('tcp') && a.includes('-progress'));
  assert.equal(a[a.indexOf('-t') + 1], String(12 * 3 + 30), 'only a distant safety cap, not the length: the recorder stops ffmpeg itself');
  assert.ok(buildRecordArgs({ url: 'http://x/y', isRtsp: false, label: 'HTTP' }, 5, 'o.mp4', true).includes('libx264'));
});

/** A camera: serves a generated MP4 over HTTP (with Range, as real servers do). */
async function startFakeCamera(dir: string, seconds = 8) {
  const file = join(dir, 'source.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=10:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', '-movflags', '+faststart', file]);
  assert.equal(r.status, 0, `could not make the test video: ${r.stderr?.toString()}`);
  const size = statSync(file).size;
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' }); createReadStream(file, { start: a, end: b }).pipe(res); }
    else { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' }); createReadStream(file).pipe(res); }
  });
  await new Promise<void>((r2) => server.listen(0, '127.0.0.1', r2));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/live.mp4`, close: () => new Promise<void>((r2) => { server.closeAllConnections?.(); server.close(() => r2()); }) };
}

test('recorder (real ffmpeg): records a few seconds without re-encoding; a dead address fails with a sentence that does not contain the password', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  const cam = await startFakeCamera(dir);
  try {
    const out = join(dir, 'clip.mp4');
    const ok = await recordClip([{ url: cam.url, isRtsp: false, label: 'HTTP' }], 3, out);
    assert.equal(ok.ok, true, ok.failure);
    assert.ok(ok.bytes > 2000 && existsSync(out));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'default=nw=1', out]).stdout.toString();
    assert.match(probe, /codec_name=h264/);
    const dur = Number(/duration=([\d.]+)/.exec(probe)?.[1]);
    assert.ok(dur > 2 && dur < 5, `about 3 seconds, got ${dur}`);

    const dead = await recordClip([{ url: 'rtsp://user:SuperSecret1@127.0.0.1:9/stream', isRtsp: true, label: 'RTSP' }], 3, join(dir, 'dead.mp4'), { connectTimeoutMs: 4000, secrets: ['SuperSecret1', 'user'] });
    assert.equal(dead.ok, false);
    assert.ok(dead.failure && !dead.failure.includes('SuperSecret1'), `the failure must not echo the password: ${dead.failure}`);
    assert.equal(existsSync(join(dir, 'dead.mp4')), false, 'a failed recording leaves no file');
    assert.equal((await recordClip([], 3, join(dir, 'none.mp4'))).ok, false);
  } finally { await cam.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---- the routes -----------------------------------------------------------------------------------------------------------------------

async function startApp(o: { dir: string; camUrl: string; record?: any; thumb?: any; maxConcurrent?: number; maxTotalBytes?: number }) {
  const store = createFileSnippetStore(join(o.dir, 'snippets.json'));
  const app = express(); app.use(express.json());
  const cameras: Record<string, { id: string; name: string; url: string; department: string | null; owner: string }> = {
    cam1: { id: 'cam1', name: 'Gate 1', url: o.camUrl, department: 'Traffic', owner: 'alice' },
    still: { id: 'still', name: 'Still', url: 'https://cam.example/snap.jpg', department: null, owner: 'alice' },
    internal: { id: 'internal', name: 'Internal', url: 'http://10.0.0.5/live.m3u8', department: null, owner: 'alice' },
    nourl: { id: 'nourl', name: 'No URL', url: '', department: null, owner: 'alice' },
  };
  const routes = registerSnippetRoutes(app, {
    store, dir: join(o.dir, 'files'), gridRtspHost: 'x', localBaseUrl: 'http://localhost:3000', maxConcurrent: o.maxConcurrent, maxTotalBytes: o.maxTotalBytes, record: o.record, thumb: o.thumb,
    creds: () => ({ email: '', password: '' }),
    urlAllowed: (u) => u.startsWith(o.camUrl.slice(0, 16)) || !/^https?:\/\/(10\.|localhost|127\.)/.test(u),
    camera: async (id) => { const c = cameras[id]; return c ? { id: c.id, name: c.name, url: c.url, department: c.department } : null; },
    access: async (req, res) => {
      const who = req.header('x-test-user');
      if (!who) { res.status(401).json({ error: 'Sign in.' }); return null; }
      if (who === 'viewer' && req.method === 'POST') { res.status(403).json({ error: 'Your role cannot do that.' }); return null; }
      return { uid: who, admin: who === 'admin' };
    },
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, who: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(who ? { 'x-test-user': who } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return res;
  };
  const json = async (r: Response) => r.json() as Promise<any>;
  return { call, json, routes, store, close: async () => { await routes.idle(); await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }); } };
}

async function waitFor(fn: () => Promise<boolean>, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error('timed out'); }

test('routes (real ffmpeg): record, poll until ready, thumbnail, play with Range, download, hash, list, delete; the file and picture are really there', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  const cam = await startFakeCamera(dir);
  const app = await startApp({ dir, camUrl: cam.url });
  try {
    const r = await app.call('POST', '/api/snippets', 'alice', { cameraId: 'cam1', seconds: 3, title: 'Gate test' });
    assert.equal(r.status, 202);
    const started = (await app.json(r)).snippet;
    assert.deepEqual([started.status, started.title, started.cameraName, started.department, started.userId, started.fileUrl], ['recording', 'Gate test', 'Gate 1', 'Traffic', 'alice', null]);
    await waitFor(async () => (await app.json(await app.call('GET', `/api/snippets/${started.id}`, 'alice'))).snippet.status !== 'recording');
    const done = (await app.json(await app.call('GET', `/api/snippets/${started.id}`, 'alice'))).snippet;
    assert.equal(done.status, 'ready', done.error);
    assert.ok(done.bytes > 2000 && done.actualSeconds > 2 && done.actualSeconds < 5 && done.hasThumb && /^[a-f0-9]{64}$/.test(done.sha256));
    assert.equal(done.fileUrl, `/api/snippets/${started.id}/file`);

    const file = await app.call('GET', done.fileUrl, 'alice');
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'video/mp4');
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, done.bytes);
    assert.equal(bytes.subarray(4, 8).toString(), 'ftyp', 'an MP4');
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), done.sha256, 'the stored hash is the hash of the file');
    const part = await app.call('GET', done.fileUrl, 'alice', undefined, { Range: 'bytes=0-99' });
    assert.equal(part.status, 206, 'a player can seek: Range is honoured');
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const thumb = await app.call('GET', done.thumbUrl, 'alice');
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    const dl = await app.call('GET', `${done.fileUrl}?download=1`, 'alice');
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="Gate_test\.mp4"/);

    const list = (await app.json(await app.call('GET', '/api/snippets', 'alice'))).snippets;
    assert.deepEqual(list.map((s: any) => s.id), [started.id]);
    assert.deepEqual((await app.json(await app.call('GET', '/api/snippets?cameraId=nothing', 'alice'))).snippets, []);

    assert.equal((await app.call('DELETE', `/api/snippets/${started.id}`, 'alice')).status, 200);
    assert.equal(existsSync(join(dir, 'files', `${started.id}.mp4`)), false);
    assert.equal(existsSync(join(dir, 'files', `${started.id}.jpg`)), false);
    assert.equal((await app.call('GET', `/api/snippets/${started.id}`, 'alice')).status, 404);
  } finally { await app.close(); await cam.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('routes: who may do what; bad input is refused with a sentence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  const fake = async (_c: unknown, seconds: number, out: string) => { const { writeFileSync } = await import('node:fs'); writeFileSync(out, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4000)])); return { ok: true, bytes: 4012 }; };
  const app = await startApp({ dir, camUrl: 'http://127.0.0.1:1/x', record: fake });
  try {
    assert.equal((await app.call('POST', '/api/snippets', null, { cameraId: 'cam1' })).status, 401, 'not signed in');
    assert.equal((await app.call('POST', '/api/snippets', 'viewer', { cameraId: 'cam1' })).status, 403, 'a viewer cannot record');
    for (const [body, re] of [[{}, /cameraId/], [{ cameraId: 'cam1', seconds: 1 }, /3 to 120/], [{ cameraId: 'cam1', seconds: 500 }, /3 to 120/], [{ cameraId: 'cam1', seconds: 'ten' }, /3 to 120/]] as const) {
      const r = await app.call('POST', '/api/snippets', 'alice', body);
      assert.equal(r.status, 400); assert.match((await app.json(r)).error, re);
    }
    assert.equal((await app.call('POST', '/api/snippets', 'alice', { cameraId: 'ghost' })).status, 404);
    assert.equal((await app.call('POST', '/api/snippets', 'alice', { cameraId: 'nourl' })).status, 409);
    assert.equal((await app.call('POST', '/api/snippets', 'alice', { cameraId: 'internal' })).status, 400, 'an internal address is not recorded from the server');
    assert.match((await app.json(await app.call('POST', '/api/snippets', 'alice', { cameraId: 'still' }))).error, /still pictures/);

    const s = (await app.json(await app.call('POST', '/api/snippets', 'alice', { cameraId: 'cam1', seconds: 5 }))).snippet;
    await app.routes.idle();
    assert.equal((await app.json(await app.call('GET', `/api/snippets/${s.id}`, 'alice'))).snippet.status, 'ready');
    assert.equal((await app.call('GET', `/api/snippets/${s.id}`, 'bob')).status, 404, "another user cannot see someone else's snippet");
    assert.equal((await app.call('GET', `/api/snippets/${s.id}/file`, 'bob')).status, 404);
    assert.equal((await app.call('DELETE', `/api/snippets/${s.id}`, 'bob')).status, 404);
    assert.deepEqual((await app.json(await app.call('GET', '/api/snippets', 'bob'))).snippets, []);
    assert.equal((await app.json(await app.call('GET', '/api/snippets', 'admin'))).snippets.length, 1, 'an administrator sees everyone\'s');
    assert.equal((await app.call('GET', '/api/snippets/not-an-id', 'alice')).status, 404);
    assert.equal((await app.call('GET', '/api/snippets/..%2F..%2Fetc%2Fpasswd/file', 'alice')).status, 404, 'an id is never a path');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('routes: a failed recording is kept with its reason; limits (at once, per user, disk) answer 429/507; a restart marks cut-off recordings failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let mode: 'fail' | 'hold' = 'fail';
  const rec = async (_c: unknown, _s: number, out: string) => { if (mode === 'hold') { await gate; const { writeFileSync } = await import('node:fs'); writeFileSync(out, Buffer.alloc(3000)); return { ok: true, bytes: 3000 }; } return { ok: false, bytes: 0, failure: 'RTSP: connection refused' }; };
  const app = await startApp({ dir, camUrl: 'http://127.0.0.1:1/x', record: rec, maxConcurrent: 1 });
  try {
    const f = (await app.json(await app.call('POST', '/api/snippets', 'alice', { cameraId: 'cam1', seconds: 5 }))).snippet;
    await app.routes.idle();
    const failed = (await app.json(await app.call('GET', `/api/snippets/${f.id}`, 'alice'))).snippet;
    assert.deepEqual([failed.status, failed.error, failed.fileUrl], ['failed', 'RTSP: connection refused', null]);
    assert.equal((await app.call('GET', `/api/snippets/${f.id}/file`, 'alice')).status, 409, 'no file for a failed recording');

    mode = 'hold';
    const a = await app.call('POST', '/api/snippets', 'alice', { cameraId: 'cam1', seconds: 5 });
    assert.equal(a.status, 202);
    const b = await app.call('POST', '/api/snippets', 'alice', { cameraId: 'cam1', seconds: 5 });
    assert.equal(b.status, 429, 'only one at once in this test');
    assert.match((await app.json(b)).error, /at once/);
    const id = (await app.json(a)).snippet.id;
    assert.equal((await app.call('DELETE', `/api/snippets/${id}`, 'alice')).status, 409, 'cannot delete while it records');
    release(); await app.routes.idle();

    // a snippet left "recording" by a crash is marked failed when the store is opened by the next server start
    await app.store.insert(mk('snp_00000000000000ff', { status: 'recording', userId: 'alice' }));
    assert.equal(await app.store.failInterrupted('The server restarted while this was recording.', new Date()), 1);
    assert.equal((await app.json(await app.call('GET', '/api/snippets/snp_00000000000000ff', 'alice'))).snippet.status, 'failed');
  } finally { release?.(); await app.close(); rmSync(dir, { recursive: true, force: true }); }

  const dir2 = mkdtempSync(join(tmpdir(), 'snp-'));
  const small = await startApp({ dir: dir2, camUrl: 'http://127.0.0.1:1/x', record: rec, maxTotalBytes: 500_000 });
  try {
    const r = await small.call('POST', '/api/snippets', 'alice', { cameraId: 'cam1', seconds: 30 });
    assert.equal(r.status, 507, 'a 30 s clip would not fit in a 0.5 MB store');
  } finally { await small.close(); rmSync(dir2, { recursive: true, force: true }); }
});

test('routes: a snippet folder inside a dot-folder (the default .data/snippets) still serves its video and picture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  const dotted = join(dir, '.data');           // the real default is <project>/.data/snippets: Express refuses to send from any path with a dot-folder unless given a root
  const fake = async (_c: unknown, _s: number, out: string) => { const { writeFileSync } = await import('node:fs'); writeFileSync(out, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4000)])); return { ok: true, bytes: 4012 }; };
  const app = await startApp({ dir: dotted, camUrl: 'http://127.0.0.1:1/x', record: fake, thumb: async (_f: string, out: string) => { const { writeFileSync } = await import('node:fs'); writeFileSync(out, Buffer.alloc(500, 1)); return true; } });
  try {
    const s = (await app.json(await app.call('POST', '/api/snippets', 'alice', { cameraId: 'cam1', seconds: 5 }))).snippet;
    await app.routes.idle();
    const done = (await app.json(await app.call('GET', `/api/snippets/${s.id}`, 'alice'))).snippet;
    assert.equal(done.status, 'ready');
    const file = await app.call('GET', done.fileUrl, 'alice');
    assert.equal(file.status, 200, 'the video is served');
    assert.equal((await file.arrayBuffer()).byteLength, 4012);
    const part = await app.call('GET', done.fileUrl, 'alice', undefined, { Range: 'bytes=0-9' });
    assert.equal(part.status, 206);
    assert.equal(done.hasThumb, true);
    assert.equal((await app.call('GET', done.thumbUrl, 'alice')).status, 200, 'and the picture');
    assert.equal((await app.call('GET', `${done.fileUrl}?download=1`, 'alice')).status, 200);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});


// ---- length: counted from the first frame, whatever the connection does ----------------------------------------------------------------

/** A live-like camera: real-time MPEG-TS over HTTP. Each connection waits delayMs[n] before the first frame and ends after lengthsS[n] seconds (stall: stays open and silent). */
async function startLiveCamera(plan: Array<{ delayMs: number; seconds: number; stall?: boolean }>) {
  let n = 0;
  const server = http.createServer((req, res) => {
    const p = plan[Math.min(n++, plan.length - 1)];
    const timer = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      const ff = spawn('ffmpeg', ['-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', String(p.seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      ff.stdout.pipe(res, { end: !p.stall });
      res.on('close', () => ff.kill('SIGKILL'));
    }, p.delayMs);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/live.ts`, connections: () => n, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const durationOf = (file: string) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).stdout.toString().trim());

test('length (real ffmpeg): a camera that takes 6 seconds to send its first frame still gives the full length, because counting starts at the first frame', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  const cam = await startLiveCamera([{ delayMs: 6000, seconds: 60 }]);
  try {
    const out = join(dir, 'clip.mp4'); const t0 = Date.now();
    const r = await recordClip([{ url: cam.url, isRtsp: false, label: 'HTTP' }], 6, out);
    assert.equal(r.ok, true, r.failure);
    const d = durationOf(out);
    assert.ok(d >= 5.8 && d < 9, `asked for 6 s, the file holds ${d} s`);
    assert.ok(Date.now() - t0 >= 11_000, 'it really waited for the first frame, then recorded the full length');
    assert.equal(r.parts, 1);
  } finally { await cam.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('length (real ffmpeg): a source that drops after 3 seconds is reconnected and the parts are joined, so the clip still has the full length', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  const cam = await startLiveCamera([{ delayMs: 0, seconds: 3 }, { delayMs: 500, seconds: 60 }]);
  try {
    const out = join(dir, 'clip.mp4');
    const r = await recordClip([{ url: cam.url, isRtsp: false, label: 'HTTP' }], 8, out);
    assert.equal(r.ok, true, r.failure);
    assert.ok((r.parts ?? 0) >= 2 && cam.connections() >= 2, 'it reconnected');
    const d = durationOf(out);
    assert.ok(d >= 7.4 && d < 12, `asked for 8 s across a drop, the file holds ${d} s`);
    assert.equal(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', out]).stdout.toString().trim(), 'h264');
    assert.equal(existsSync(out + '.part1.mp4') || existsSync(out + '.list.txt'), false, 'no temporary parts are left behind');
  } finally { await cam.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('length (real ffmpeg): a source that goes silent mid-clip is given up on after the stall limit and what was captured is kept; a source that gives under 3 seconds fails with a sentence', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snp-'));
  const stalling = await startLiveCamera([{ delayMs: 0, seconds: 12, stall: true }]);
  try {
    const out = join(dir, 'clip.mp4');
    const r = await recordClip([{ url: stalling.url, isRtsp: false, label: 'HTTP' }], 20, out, { stallAfterMs: 7000, connectTimeoutMs: 20_000 });
    assert.equal(r.ok, true, r.failure);
    const d = durationOf(out);
    assert.ok(d >= 3 && d < 14, `kept the captured part (${d} s of the 20 asked for)`);
  } finally { await stalling.close(); }
  const brief = await startLiveCamera([{ delayMs: 0, seconds: 1.5, stall: true }]);
  try {
    const r = await recordClip([{ url: brief.url, isRtsp: false, label: 'HTTP' }], 20, join(dir, 'brief.mp4'), { stallAfterMs: 4000, connectTimeoutMs: 6000 });
    assert.equal(r.ok, false);
    assert.match(r.failure ?? '', /only|no video|HTTP/);
    assert.equal(existsSync(join(dir, 'brief.mp4')), false);
  } finally { await brief.close(); rmSync(dir, { recursive: true, force: true }); }
});
