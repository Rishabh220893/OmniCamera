/**
 * The whole ONVIF path with nothing mocked except the camera's ONVIF service: a real MediaMTX serves a live H.264 stream over RTSP
 * (with a login), the fake ONVIF device points at it, and the adapter reads the profiles, builds the RTSP address, and probes it
 * with the real ffprobe/ffmpeg. Skipped when MediaMTX or ffmpeg is not available.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOnvifAdapter } from '../server/adapters/onvif.ts';
import { startFakeOnvif } from './lab/fakeOnvif.ts';

const MEDIAMTX = path.resolve('media-server/bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const have = existsSync(MEDIAMTX) && spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = have ? false : 'MediaMTX or ffmpeg is not available';

const CAM = { user: 'cam', pass: 'P@ss#w&rd$1' }; // reads the stream; also the ONVIF login. MediaMTX allows only some characters; @ # & need URL-encoding
const PUB = { user: 'pub', pass: 'pubpass' };

let dir = '', port = 0, mtx: ChildProcess | null = null, pub: ChildProcess | null = null;

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

before(async () => {
  if (!have) return;
  dir = mkdtempSync(path.join(tmpdir(), 'onvif-e2e-'));
  port = await freePort();
  const yml = `logLevel: error
api: false
metrics: false
pprof: false
playback: false
rtmp: false
hls: false
webrtc: false
srt: false
moq: false
rtsp: true
rtspTransports: [tcp]
rtspAddress: 127.0.0.1:${port}
authInternalUsers:
  - user: ${PUB.user}
    pass: ${PUB.pass}
    ips: []
    permissions: [{ action: publish }]
  - user: ${CAM.user}
    pass: "${CAM.pass}"
    ips: []
    permissions: [{ action: read }]
paths:
  gate: {}
  yard: {}
`;
  writeFileSync(path.join(dir, 'mediamtx.yml'), yml);
  mtx = spawn(MEDIAMTX, [path.join(dir, 'mediamtx.yml')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  if (mtx.exitCode !== null) throw new Error('MediaMTX did not start (check the generated config)');
  pub = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '50', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://${PUB.user}:${PUB.pass}@127.0.0.1:${port}/gate`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
});

after(() => {
  for (const p of [pub, mtx]) { try { p?.kill('SIGKILL'); } catch { /* gone */ } }
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

const rtsp = (host: string, p: string) => `rtsp://${host}:${port}/${p}`;

test('probe through ONVIF: login, profiles, 0.0.0.0 fixed, real RTSP pulled with an awkward password, real measurements', { skip, timeout: 90_000 }, async () => {
  const dev = await startFakeOnvif({ auth: 'wsse', user: CAM.user, pass: CAM.pass, profiles: [{ token: 'main', name: 'MainStream', codec: 'H264', width: 640, height: 360, uri: `rtsp://0.0.0.0:${port}/gate` }] });
  try {
    const r = await createOnvifAdapter({ requestTimeoutMs: 5000 }).probe({ id: 'gate', url: dev.url, credentials: CAM, site: 'lab' }, { sampleSec: 6 });
    assert.equal(r.failure, null, JSON.stringify(r.failureDetail));
    assert.equal(r.reachable, true);
    assert.equal(r.site, 'lab');
    assert.equal(r.describe?.codec, 'h264');
    assert.equal(r.describe?.width, 640);
    assert.ok((r.sample?.frames ?? 0) >= 100, `frames: ${r.sample?.frames}`);
    assert.ok(r.sample!.keyframeIntervalSec!.median >= 1.5 && r.sample!.keyframeIntervalSec!.median <= 2.5, 'keyframe every 2 s as published');
    assert.ok(!r.flags.includes('bframes') && !r.flags.includes('h265'));
    assert.ok(r.notes?.some((n) => n.includes('MainStream')));
    assert.ok(!JSON.stringify(r).includes(CAM.pass), 'the password is not in the report');
  } finally { await dev.close(); }
});

test('probe through ONVIF: a stream address on a host only the camera can use falls back to the address it was reached on', { skip, timeout: 90_000 }, async () => {
  // MediaMTX listens on 127.0.0.1 only, so 127.0.0.2 is refused, like a camera that announces its internal address.
  const dev = await startFakeOnvif({ auth: 'none', profiles: [{ token: 'main', name: 'Main', codec: 'H264', uri: rtsp('127.0.0.2', 'gate') }] });
  try {
    const r = await createOnvifAdapter({ requestTimeoutMs: 5000 }).probe({ id: 'gate', url: dev.url, credentials: CAM }, { sampleSec: 5 });
    assert.equal(r.failure, null, JSON.stringify(r.failureDetail));
    assert.ok((r.sample?.frames ?? 0) >= 80);
    assert.ok(r.notes?.some((n) => n.includes('127.0.0.2') && n.includes('was used')), JSON.stringify(r.notes));
  } finally { await dev.close(); }
});

test('probe through ONVIF: ONVIF login fine but RTSP login wrong is reported as bad credentials, not as a dead stream', { skip, timeout: 90_000 }, async () => {
  const dev = await startFakeOnvif({ auth: 'wsse', user: 'onvifuser', pass: 'onvifpass', profiles: [{ token: 'main', name: 'Main', codec: 'H264', uri: rtsp('127.0.0.1', 'gate') }] });
  try {
    const r = await createOnvifAdapter({ requestTimeoutMs: 5000 }).probe({ id: 'gate', url: dev.url, credentials: { user: 'onvifuser', pass: 'onvifpass' } }, { sampleSec: 5 });
    assert.equal(r.failure, 'bad_credentials', JSON.stringify(r.failureDetail));
    assert.ok(!JSON.stringify(r).includes('onvifpass'));
  } finally { await dev.close(); }
});

test('probe through ONVIF: a stream path that does not exist is reported as a failure with a reason', { skip, timeout: 90_000 }, async () => {
  const dev = await startFakeOnvif({ auth: 'none', profiles: [{ token: 'main', name: 'Main', codec: 'H264', uri: rtsp('127.0.0.1', 'nothing-here') }] });
  try {
    const r = await createOnvifAdapter({ requestTimeoutMs: 5000 }).probe({ id: 'x', url: dev.url, credentials: CAM }, { sampleSec: 5 });
    assert.ok(r.failure, 'a missing stream must not look healthy');
    assert.equal(r.sample?.frames ?? 0, 0);
  } finally { await dev.close(); }
});

test('probe through ONVIF: the adapter works the same behind the HTTP route layer and is saved as a profile', { skip, timeout: 90_000 }, async () => {
  const express = (await import('express')).default;
  const { registerAdapterRoutes } = await import('../server/adapterRoutes.ts');
  const { createAdapterRegistry } = await import('../server/adapters/index.ts');
  const dev = await startFakeOnvif({ auth: 'http-digest', user: CAM.user, pass: CAM.pass, profiles: [{ token: 'main', name: 'Main', codec: 'H264', width: 640, height: 360, uri: rtsp('0.0.0.0', 'gate') }] });
  const saved: unknown[] = [];
  const app = express();
  app.use(express.json());
  registerAdapterRoutes(app, { adapters: createAdapterRegistry([createOnvifAdapter({ requestTimeoutMs: 5000 })]), requireAdmin: async () => true, allowPrivate: true, save: async (r) => { saved.push(r); } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (p: string, body: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
    const e = await post('/api/adapters/endpoints', { camera: { id: 'gate', url: dev.url, credentials: CAM } });
    assert.equal(e.status, 200);
    assert.ok(!JSON.stringify(e.json).includes(CAM.pass) && !JSON.stringify(e.json).includes(encodeURIComponent(CAM.pass)), 'no password in the response');
    assert.equal(e.json.endpoints[0].url, `rtsp://***@127.0.0.1:${port}/gate`);
    const p = await post('/api/adapters/probe', { camera: { id: 'gate', url: dev.url, credentials: CAM }, sampleSec: 5 });
    assert.equal(p.status, 200);
    assert.equal(p.json.report.failure, null, JSON.stringify(p.json.report.failureDetail));
    assert.equal(p.json.saved, true);
    assert.equal(saved.length, 1);
    const bad = await post('/api/adapters/endpoints', { camera: { id: 'gate', url: dev.url, credentials: { user: CAM.user, pass: 'wrong' } } });
    assert.equal(bad.status, 502);
    assert.match(bad.json.error, /rejected the login/);
  } finally { server.close(); await dev.close(); }
});
