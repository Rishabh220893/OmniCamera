import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDahuaAdapter, createHikvisionAdapter, dahuaSpec, hikvisionSpec } from '../server/adapters/vendorNvr.ts';
import { AdapterError, createDefaultAdapters, redactUrl } from '../server/adapters/index.ts';
import { startFakeNvr } from './lab/fakeNvr.ts';

const CREDS = { user: 'admin', pass: 'P@ss w0rd%1' };

// ---- addressing ----------------------------------------------------------------------------------------------------

test('Hikvision stream numbers: channel x 100 + 01 main / 02 sub, including IP channels past 32', () => {
  assert.equal(hikvisionSpec.rtspPath(1, 'main'), '/Streaming/Channels/101');
  assert.equal(hikvisionSpec.rtspPath(1, 'sub'), '/Streaming/Channels/102');
  assert.equal(hikvisionSpec.rtspPath(16, 'main'), '/Streaming/Channels/1601');
  assert.equal(hikvisionSpec.rtspPath(33, 'sub'), '/Streaming/Channels/3302');
  const u = (p: string) => new URL(`rtsp://h:554${p}`);
  assert.deepEqual(hikvisionSpec.parseRtspUrl(u('/Streaming/Channels/302')), { channel: 3, stream: 'sub' });
  assert.deepEqual(hikvisionSpec.parseRtspUrl(u('/Streaming/Channels/3301')), { channel: 33, stream: 'main' });
  assert.equal(hikvisionSpec.parseRtspUrl(u('/Streaming/Channels/103')), null, 'third stream is not offered');
  assert.equal(hikvisionSpec.parseRtspUrl(u('/Streaming/Channels/1')), null);
});

test('Dahua stream numbers: channel and subtype 0 main / 1 sub', () => {
  assert.equal(dahuaSpec.rtspPath(4, 'main'), '/cam/realmonitor?channel=4&subtype=0');
  assert.equal(dahuaSpec.rtspPath(4, 'sub'), '/cam/realmonitor?channel=4&subtype=1');
  assert.deepEqual(dahuaSpec.parseRtspUrl(new URL('rtsp://h/cam/realmonitor?channel=7&subtype=1')), { channel: 7, stream: 'sub' });
  assert.deepEqual(dahuaSpec.parseRtspUrl(new URL('rtsp://h/cam/realmonitor?channel=2')), { channel: 2, stream: 'main' });
  assert.equal(dahuaSpec.parseRtspUrl(new URL('rtsp://h/cam/realmonitor?channel=0&subtype=0')), null);
});

test('registry: a vendor rtsp:// URL goes to the vendor adapter, any other rtsp:// URL to plain RTSP', () => {
  const r = createDefaultAdapters();
  assert.equal(r.resolve({ id: 'a', url: 'rtsp://10.0.0.9:554/Streaming/Channels/101' }).kind, 'hikvision');
  assert.equal(r.resolve({ id: 'a', url: 'rtsp://10.0.0.9/cam/realmonitor?channel=1&subtype=0' }).kind, 'dahua');
  assert.equal(r.resolve({ id: 'a', url: 'rtsp://10.0.0.9/live/ch1' }).kind, 'rtsp');
  assert.equal(r.resolve({ id: 'a', adapter: 'dahua', host: '10.0.0.9' }).kind, 'dahua');
});

test('endpoints: both streams, the right numbers, a snapshot without a login, an awkward password encoded', async () => {
  const a = createHikvisionAdapter();
  const eps = await a.endpoints({ id: 'n', host: '10.0.0.9', options: { channel: 5 }, credentials: CREDS });
  assert.equal(eps.length, 3);
  assert.equal(eps[0].url, 'rtsp://admin:P%40ss%20w0rd%251@10.0.0.9:554/Streaming/Channels/501');
  assert.equal(eps[1].url, 'rtsp://admin:P%40ss%20w0rd%251@10.0.0.9:554/Streaming/Channels/502');
  assert.equal(eps[2].protocol, 'snapshot');
  assert.equal(eps[2].url, 'http://10.0.0.9:80/ISAPI/Streaming/channels/501/picture');
  assert.ok(!eps[2].url.includes('w0rd'));
  assert.ok(!redactUrl(eps[0].url).includes('w0rd'));

  const d = await createDahuaAdapter().endpoints({ id: 'n', host: 'cams.example.org', port: 8080, options: { channel: 3, rtspPort: 8554, https: false } });
  assert.equal(d[0].url, 'rtsp://cams.example.org:8554/cam/realmonitor?channel=3&subtype=0');
  assert.equal(d[1].url, 'rtsp://cams.example.org:8554/cam/realmonitor?channel=3&subtype=1');
  assert.equal(d[2].url, 'http://cams.example.org:8080/cgi-bin/snapshot.cgi?channel=3');
});

test('endpoints: channel, stream and rtsp port read from a vendor URL; its login is kept; options override it', async () => {
  const a = createHikvisionAdapter();
  const eps = await a.endpoints({ id: 'n', url: 'rtsp://u:p@10.0.0.9:8554/Streaming/Channels/302' });
  assert.equal(eps[0].url, 'rtsp://u:p@10.0.0.9:8554/Streaming/Channels/301');
  assert.equal(eps[2].url, 'http://10.0.0.9:80/ISAPI/Streaming/channels/302/picture', 'the snapshot follows the stream in the URL');
  const o = await a.endpoints({ id: 'n', url: 'rtsp://10.0.0.9/Streaming/Channels/302', options: { channel: 4, stream: 'main' } });
  assert.ok(o[2].url.endsWith('/401/picture'));
});

test('bad input is refused with a reason, not guessed at', async () => {
  const a = createHikvisionAdapter();
  for (const ref of [
    { id: 'n' },
    { id: 'n', host: 'h', options: { channel: 0 } },
    { id: 'n', host: 'h', options: { channel: 'abc' } },
    { id: 'n', host: 'h', options: { channel: 100000 } },
    { id: 'n', host: 'h', options: { stream: 'third' } },
    { id: 'n', host: 'h', options: { rtspPort: 99999 } },
    { id: 'n', url: 'rtsp://h/some/other/path' },
  ]) {
    await assert.rejects(a.endpoints(ref), (e) => e instanceof AdapterError && e.code === 'bad_ref', JSON.stringify(ref));
  }
  assert.ok(!(await a.endpoints({ id: 'n', url: 'rtsp://u:SECRET@h/some/other' }).catch((e: Error) => e.message)).toString().includes('SECRET'));
});

// ---- the device's own API, against a fake that checks logins -----------------------------------------------------

for (const vendor of ['hikvision', 'dahua'] as const) {
  const adapter = () => (vendor === 'hikvision' ? createHikvisionAdapter() : createDahuaAdapter());

  for (const auth of ['digest', 'basic', 'none'] as const) {
    test(`${vendor}: device information over ${auth} login`, async () => {
      const dev = await startFakeNvr({ vendor, auth });
      try {
        const info = await adapter().deviceInfo!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
        if (vendor === 'hikvision') assert.deepEqual(info, { manufacturer: 'Hikvision', model: 'DS-7608NI-K2', firmware: 'V4.30.085', serial: 'DS-7608NI-K20820200101', hardwareId: '48ab' });
        else assert.deepEqual(info, { manufacturer: 'Dahua', model: 'NVR4216-4KS2', firmware: '4.001.0000000.2,build:2023-05-18', serial: '4K0123ABCD', hardwareId: '1.00' });
      } finally { await dev.close(); }
    });
  }

  test(`${vendor}: a wrong or missing login is "refused the login", never a crash or an empty result`, async () => {
    const dev = await startFakeNvr({ vendor });
    try {
      for (const credentials of [{ user: 'admin', pass: 'wrong' }, undefined, { user: 'nobody', pass: CREDS.pass }]) {
        await assert.rejects(adapter().channels!({ id: 'n', host: dev.host, port: dev.port, credentials }), /refused the login/);
        await assert.rejects(adapter().deviceInfo!({ id: 'n', host: dev.host, port: dev.port, credentials }), /refused the login/);
      }
    } finally { await dev.close(); }
  });

  test(`${vendor}: channel list with names and connection state`, async () => {
    const dev = await startFakeNvr({ vendor });
    try {
      const ch = await adapter().channels!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
      assert.deepEqual(ch.map((c) => [c.channel, c.name, c.online]), [[1, 'Gate', true], [2, 'Yard', false]]);
      if (vendor === 'hikvision') assert.deepEqual(ch.map((c) => c.address), ['10.1.0.11', '10.1.0.12']);
    } finally { await dev.close(); }
  });

  test(`${vendor}: older firmware without the status calls still lists channels (state unknown)`, async () => {
    const dev = await startFakeNvr({ vendor, oldFirmware: true });
    try {
      const ch = await adapter().channels!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
      assert.deepEqual(ch.map((c) => [c.channel, c.online]), [[1, null], [2, null]]);
      const info = await adapter().deviceInfo!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
      assert.ok(info.model, 'model still read');
    } finally { await dev.close(); }
  });

  test(`${vendor}: 16 channels in any order come back sorted and complete`, async () => {
    const channels = Array.from({ length: 16 }, (_, i) => ({ channel: i + 1, name: `Cam ${i + 1}`, online: true })).reverse();
    const dev = await startFakeNvr({ vendor, channels });
    try {
      const ch = await adapter().channels!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
      assert.deepEqual(ch.map((c) => c.channel), Array.from({ length: 16 }, (_, i) => i + 1));
    } finally { await dev.close(); }
  });

  test(`${vendor}: a device that does not answer is an error that names what failed`, async () => {
    const dev = await startFakeNvr({ vendor });
    const port = dev.port;
    await dev.close();
    await assert.rejects(adapter().channels!({ id: 'n', host: dev.host, port, credentials: CREDS }));
  });
}

test('hikvision: a plain DVR with no IP-camera list falls back to its video inputs', async () => {
  const dev = await startFakeNvr({ vendor: 'hikvision', dvr: true, channels: [{ channel: 1, name: 'Lobby' }, { channel: 2, name: 'Car park' }] });
  try {
    const ch = await createHikvisionAdapter().channels!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
    assert.deepEqual(ch.map((c) => [c.channel, c.name, c.online, c.address]), [[1, 'Lobby', null, null], [2, 'Car park', null, null]]);
  } finally { await dev.close(); }
});

test('dahua: a camera name containing = and unicode survives', async () => {
  const dev = await startFakeNvr({ vendor: 'dahua', channels: [{ channel: 1, name: 'Gate = North दरवाज़ा' }] });
  try {
    const ch = await createDahuaAdapter().channels!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
    assert.equal(ch[0].name, 'Gate = North दरवाज़ा');
  } finally { await dev.close(); }
});

test('digest login is negotiated once per call (one refusal, then success), not repeated', async () => {
  const dev = await startFakeNvr({ vendor: 'hikvision' });
  try {
    await createHikvisionAdapter().deviceInfo!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS });
    assert.equal(dev.refused, 1);
  } finally { await dev.close(); }
});

test('40 parallel channel reads against one recorder all succeed', async () => {
  const dev = await startFakeNvr({ vendor: 'dahua', delayMs: 5 });
  try {
    const a = createDahuaAdapter();
    const all = await Promise.all(Array.from({ length: 40 }, () => a.channels!({ id: 'n', host: dev.host, port: dev.port, credentials: CREDS })));
    assert.ok(all.every((c) => c.length === 2));
  } finally { await dev.close(); }
});

// ---- a real stream behind the vendor address ----------------------------------------------------------------------

const MEDIAMTX = path.resolve('media-server/bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const have = existsSync(MEDIAMTX) && spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = have ? false : 'MediaMTX or ffmpeg is not available';
const CAM = { user: 'cam', pass: 'camPass9' };
const PUB = { user: 'pub', pass: 'pubpass' };
let dir = '', rtspPort = 0, mtx: ChildProcess | null = null; const pubs: ChildProcess[] = [];

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

before(async () => {
  if (!have) return;
  dir = mkdtempSync(path.join(tmpdir(), 'vendor-e2e-'));
  rtspPort = await freePort();
  writeFileSync(path.join(dir, 'mediamtx.yml'), `logLevel: error
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
rtspAddress: 127.0.0.1:${rtspPort}
authInternalUsers:
  - user: ${PUB.user}
    pass: ${PUB.pass}
    ips: []
    permissions: [{ action: publish }]
  - user: ${CAM.user}
    pass: ${CAM.pass}
    ips: []
    permissions: [{ action: read }]
paths:
  Streaming/Channels/201: {}
  cam/realmonitor: {}
`);
  mtx = spawn(MEDIAMTX, [path.join(dir, 'mediamtx.yml')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  if (mtx.exitCode !== null) throw new Error('MediaMTX did not start');
  for (const p of ['Streaming/Channels/201', 'cam/realmonitor']) {
    pubs.push(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-g', '50', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://${PUB.user}:${PUB.pass}@127.0.0.1:${rtspPort}/${p}`], { stdio: 'ignore' }));
  }
  await new Promise((r) => setTimeout(r, 2500));
});

after(() => {
  for (const p of [...pubs, mtx]) { try { p?.kill('SIGKILL'); } catch { /* gone */ } }
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ } }
});

test('probe a Hikvision channel (201) over real RTSP: codec, size, frames', { skip, timeout: 60_000 }, async () => {
  const r = await createHikvisionAdapter().probe({ id: 'hik2', host: '127.0.0.1', credentials: CAM, site: 'lab', options: { channel: 2, rtspPort } }, { sampleSec: 5 });
  assert.equal(r.failure, null, JSON.stringify(r.failureDetail));
  assert.equal(r.describe?.codec, 'h264');
  assert.equal(r.describe?.width, 640);
  assert.ok((r.sample?.frames ?? 0) >= 80, `frames: ${r.sample?.frames}`);
  assert.ok(!JSON.stringify(r).includes(CAM.pass));
});

test('probe a Dahua channel from its rtsp:// URL over real RTSP', { skip, timeout: 60_000 }, async () => {
  const r = await createDahuaAdapter().probe({ id: 'dh1', url: `rtsp://127.0.0.1:${rtspPort}/cam/realmonitor?channel=1&subtype=0`, credentials: CAM }, { sampleSec: 5 });
  assert.equal(r.failure, null, JSON.stringify(r.failureDetail));
  assert.ok((r.sample?.frames ?? 0) >= 80);
});

test('probe with a wrong stream login is bad_credentials; a channel the recorder does not have is a failure', { skip, timeout: 60_000 }, async () => {
  const bad = await createHikvisionAdapter().probe({ id: 'h', host: '127.0.0.1', credentials: { user: 'cam', pass: 'nope' }, options: { channel: 2, rtspPort } }, { sampleSec: 5 });
  assert.equal(bad.failure, 'bad_credentials', JSON.stringify(bad.failureDetail));
  assert.ok(!JSON.stringify(bad).includes('nope'));
  const none = await createHikvisionAdapter().probe({ id: 'h', host: '127.0.0.1', credentials: CAM, options: { channel: 9, rtspPort } }, { sampleSec: 5 });
  assert.ok(none.failure, 'a missing channel must not look healthy');
  assert.equal(none.sample?.frames ?? 0, 0);
});
