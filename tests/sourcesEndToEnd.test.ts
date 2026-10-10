/**
 * The whole onboarding path with nothing mocked except the Registry and the stores' storage: a real MediaMTX plays the "department's
 * camera system" (a live H.264 stream over RTSP behind a login with awkward characters), the real rtsp adapter probes it with the real
 * ffprobe/ffmpeg, the onboarding service seals the address, and the sources' path is then put on a SECOND real MediaMTX through its control
 * API (the "OmniSee media server"). Finally the camera's HLS playlist and a video segment are fetched from that second server, which can only
 * work if it pulled the camera with the stored login. Skipped when MediaMTX or ffmpeg is not available.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAdapterRegistry } from '../server/adapters/index.ts';
import { directRtspAdapter } from '../server/adapters/directRtsp.ts';
import { createSecretBox } from '../server/sources/secretBox.ts';
import { SOURCES_SITE, createMemorySourceStore } from '../server/sources/store.ts';
import { createOnboarding } from '../server/sources/onboard.ts';
import { applySourcesMedia } from '../server/sources/apply.ts';
import { openSourceAddress } from '../server/sources/address.ts';
import { listPaths } from '../server/mediaApply.ts';
import type { PathBuildOptions } from '../server/mediaPaths.ts';
import { memoryProfileStore } from './fixtures/memoryProfileStore.ts';

const MEDIAMTX = path.resolve('media-server/bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const have = existsSync(MEDIAMTX) && spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = have ? false : 'MediaMTX or ffmpeg is not available';

const CAM = { user: 'cam', pass: 'P@ss#w&rd$1' };
const PUB = { user: 'pub', pass: 'pubpass' };

let dir = '', camPort = 0, apiPort = 0, hlsPort = 0;
const procs: ChildProcess[] = [];
const logs: Record<string, string> = {};

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

before(async () => {
  if (!have) return;
  dir = mkdtempSync(path.join(tmpdir(), 'sources-e2e-'));
  [camPort, apiPort, hlsPort] = [await freePort(), await freePort(), await freePort()];
  // 1. the department's camera system: RTSP only, a read login, one live stream
  writeFileSync(path.join(dir, 'camera-system.yml'), `logLevel: error
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
rtspAddress: 127.0.0.1:${camPort}
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
`);
  // 2. the OmniSee media server: control API and HLS, no paths yet (the onboarding adds them)
  writeFileSync(path.join(dir, 'omnisee-media.yml'), `logLevel: error
api: true
apiAddress: 127.0.0.1:${apiPort}
metrics: false
pprof: false
playback: false
rtsp: false
rtmp: false
webrtc: false
srt: false
moq: false
hls: true
hlsAddress: 127.0.0.1:${hlsPort}
paths: {}
`);
  // Each in a directory of its own: MediaMTX writes throwaway TLS files into its working directory.
  for (const f of ['camera-system.yml', 'omnisee-media.yml']) {
    const cwd = path.join(dir, f.replace('.yml', ''));
    mkdirSync(cwd);
    const p = spawn(MEDIAMTX, [path.join(dir, f)], { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    p.stdout?.on('data', (d) => { logs[f] += String(d); }); p.stderr?.on('data', (d) => { logs[f] += String(d); });
    logs[f] = '';
    procs.push(p);
  }
  await new Promise((r) => setTimeout(r, 1800));
  const dead = procs.findIndex((p) => p.exitCode !== null);
  if (dead >= 0) throw new Error(`A MediaMTX did not start (${Object.keys(logs)[dead]}): ${Object.values(logs)[dead].slice(0, 300)}`);
  procs.push(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-g', '50', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://${PUB.user}:${PUB.pass}@127.0.0.1:${camPort}/gate`], { stdio: 'ignore' }));
  await new Promise((r) => setTimeout(r, 2500));
});

after(() => {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ } }
});

const build: PathBuildOptions = {
  site: { host: '127.0.0.1', rtspPort: 1, pathPrefix: 'x' }, credentials: () => { throw new Error('the grid login must not be used'); },
  transcode: { ffmpeg: 'ffmpeg', bitrate: '2500k', publishPort: 18554, scaleFilter: null }, startTimeout: '30s', closeAfter: '5s',
};

test('a camera behind a login is onboarded, put on the media server, and played back as HLS from there', { skip, timeout: 150_000 }, async () => {
  const box = createSecretBox(Buffer.alloc(32, 9));
  const profiles = memoryProfileStore();
  const sources = createMemorySourceStore();
  const created: Array<{ sourceId: string; streamUrl: string }> = [];
  const onboarding = createOnboarding({
    adapters: createAdapterRegistry([directRtspAdapter]), profiles: profiles.store, sources, box, encoder: 'none',
    registry: { create: async (c) => { created.push(c); return `reg-${created.length}`; }, remove: async () => {} },
    mediaBase: () => `http://127.0.0.1:${hlsPort}`, log: { warn() {}, info() {} },
  });

  // 1. onboard: the real probe, with the real login
  const r = await onboarding.onboardOne({ camera: { id: 'device', url: `rtsp://127.0.0.1:${camPort}/gate`, credentials: CAM }, name: 'Gate', ownerUid: 'admin-1', sampleSec: 6 });
  assert.ok(r.ok === true, r.ok === false ? r.error : '');
  if (!r.ok) return;
  assert.equal(r.recipe, 'A', `a clean H.264 stream is a plain pull (${r.reason})`);
  const rec = (await sources.get(SOURCES_SITE, r.cameraId))!;
  assert.equal(JSON.stringify(rec).includes('w&rd'), false, 'the login is not stored in clear');
  assert.equal(openSourceAddress(rec, box).rtspUrl.includes('P%40ss%23w%26rd%241'), true, 'it is there, sealed, in URL form');
  const prof = (await profiles.store.getProfile(SOURCES_SITE, r.cameraId))!;
  assert.equal(prof.report.describe?.codec, 'h264');
  assert.ok((prof.report.sample?.frames ?? 0) > 50, 'real frames were measured');

  // 2. put the path on the second media server through its control API
  const api = `http://127.0.0.1:${apiPort}`;
  const common = { profiles: profiles.store, sources, box, encoder: 'none' as const, sourcesBuild: build, grid: null, api };
  const dry = await applySourcesMedia({ ...common, dryRun: true });
  assert.deepEqual(dry.add, [r.cameraId]);
  assert.equal((await listPaths({ api })).some((p) => p.name === r.cameraId), false, 'a dry run adds nothing');
  const done = await applySourcesMedia({ ...common, dryRun: false });
  assert.deepEqual(done.errors, []);
  const onServer = (await listPaths({ api })).find((p) => p.name === r.cameraId);
  assert.ok(onServer, 'the path is on the running server');
  assert.equal(onServer!.sourceOnDemand, true);

  // 3. play it: the server pulls the camera with the stored login on the first request and serves HLS
  const base = `http://127.0.0.1:${hlsPort}/${r.cameraId}`;
  let playlist = '';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/index.m3u8?cookieCheck=1`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (res?.ok) { playlist = await res.text(); if (/#EXTM3U/.test(playlist)) break; }
    await new Promise((x) => setTimeout(x, 1000));
  }
  assert.match(playlist, /#EXTM3U/, 'the camera is served as HLS');
  // a real video segment comes back (not just a playlist)
  const frame = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${base}/index.m3u8?cookieCheck=1`, '-frames:v', '1', path.join(dir, 'frame.jpg')], { timeout: 45_000 });
  assert.equal(frame.status, 0, String(frame.stderr));
  assert.ok(existsSync(path.join(dir, 'frame.jpg')), 'a picture was decoded from the stream the media server serves');

  // 4. take the camera out: its path leaves the server on the next apply, although it no longer has a profile to name it
  assert.equal(await onboarding.remove(r.cameraId), true);
  const gone = await applySourcesMedia({ ...common, dryRun: false });
  assert.deepEqual(gone.remove, [r.cameraId]);
  assert.equal((await listPaths({ api })).some((p) => p.name === r.cameraId), false);
});

test('a wrong login is refused before anything is added, using the real probe', { skip, timeout: 60_000 }, async () => {
  const profiles = memoryProfileStore();
  const sources = createMemorySourceStore();
  const onboarding = createOnboarding({
    adapters: createAdapterRegistry([directRtspAdapter]), profiles: profiles.store, sources, box: createSecretBox(Buffer.alloc(32, 9)), encoder: 'none',
    registry: { create: async () => 'x', remove: async () => {} }, mediaBase: () => 'http://127.0.0.1:1', log: { warn() {}, info() {} },
  });
  const r = await onboarding.onboardOne({ camera: { id: 'device', url: `rtsp://127.0.0.1:${camPort}/gate`, credentials: { user: 'cam', pass: 'wrong' } }, ownerUid: 'a', sampleSec: 5 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'bad_credentials', r.error);
  assert.equal((await sources.list(SOURCES_SITE)).length, 0);
  assert.equal((await profiles.store.listProfiles(SOURCES_SITE)).length, 0);
});
