/**
 * Per-user video access (server/media/streamAuth.ts): the tokens, who may read which path, the callback decision, and a REAL MediaMTX configured with
 * `authMethod: http` asking a real callback server, with real HLS requests (skipped when MediaMTX or ffmpeg is not available).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createPathAccess, createStreamTokens, decideMediaAuth, registerMediaAuth, type PathEntry } from '../server/media/streamAuth.ts';

const SECRET = 'a-long-random-signing-secret-1234';
const entries: PathEntry[] = [
  { path: 'cam01', ownerUid: 'alice', department: null },
  { path: 'cam01', ownerUid: 'bob', department: 'Traffic' },
  { path: 'cam02', ownerUid: 'carol', department: 'Police' },
  { path: 'fed-3f9a1c2b7d4e', ownerUid: 'admin-1', department: 'Traffic' },
];
const alice = { uid: 'alice', role: 'operator' as const, departments: [] as string[] };
const tom = { uid: 'tom', role: 'operator' as const, departments: ['Traffic'] };
const root = { uid: 'root', role: 'admin' as const, departments: ['*'] };
const deptAdmin = { uid: 'wes', role: 'admin' as const, departments: ['Water'] };

test('tokens: signed, short-lived, bound to the person; a changed byte, another secret, expiry and junk are all refused', () => {
  let t = 1_000_000;
  const tokens = createStreamTokens({ secret: SECRET, ttlMs: 60_000, now: () => t });
  const { token, expiresAt } = tokens.issue(tom);
  assert.equal(expiresAt, 1_060_000);
  assert.deepEqual(tokens.verify(token), { uid: 'tom', role: 'operator', departments: ['Traffic'], exp: 1_060_000 });
  const [v, body, sig] = token.split('.');
  assert.equal(tokens.verify(`${v}.${body}.${sig.slice(0, -2)}AA`), null, 'signature changed');
  const forged = Buffer.from(JSON.stringify({ u: 'root', r: 'admin', d: ['*'], e: 9_999_999 })).toString('base64url');
  assert.equal(tokens.verify(`${v}.${forged}.${sig}`), null, 'claims changed (a viewer making themselves an administrator)');
  assert.equal(createStreamTokens({ secret: 'another-secret-another-secret', now: () => t }).verify(token), null, 'another secret');
  t = 1_060_001;
  assert.equal(tokens.verify(token), null, 'expired');
  for (const junk of ['', 'abc', 'v1.x', 'v1..', 'v2.a.b', undefined]) assert.equal(tokens.verify(junk as string), null, String(junk));
  assert.throws(() => createStreamTokens({ secret: 'short' }), /at least 16/);
});

test('who may read a path: the owner of a camera on it; a member of its department; an organisation-wide admin; nobody else; an unknown path is looked up once, then refused', async () => {
  let loads = 0, t = 0;
  const access = createPathAccess({ load: async () => { loads++; return entries; }, now: () => t, refreshMs: 60_000, missRefreshMs: 10_000 });
  assert.equal(await access.canRead(alice, 'cam01'), true, 'owner');
  assert.equal(await access.canRead(alice, 'cam02'), false, 'not hers');
  assert.equal(await access.canRead(tom, 'cam01'), true, 'Traffic works on a camera Bob owns that is in Traffic');
  assert.equal(await access.canRead(tom, 'cam02'), false, 'Police\'s camera');
  assert.equal(await access.canRead(root, 'cam02'), true, 'an administrator of every department');
  assert.equal(await access.canRead(deptAdmin, 'cam02'), false, 'an administrator of Water only is not everyone\'s');
  assert.equal(await access.canRead(deptAdmin, 'fed-3f9a1c2b7d4e'), false);
  assert.equal(await access.canRead({ ...alice, departments: ['*'] }, 'cam02'), false, 'a "*" without the admin role is nothing');
  const before = loads;
  assert.equal(await access.canRead(root, 'cam99'), false, 'an unknown path is refused even for an administrator');
  assert.equal(loads, before + 1, 'after one look-up');
  assert.equal(await access.canRead(root, 'cam98'), false);
  assert.equal(loads, before + 1, 'not again within the miss interval');
  t += 11_000;
  await access.canRead(root, 'cam97');
  assert.equal(loads, before + 2);
  assert.equal(access.size(), 3);
});

test('the callback decision: reading needs a good token for that path; publishing and the control API only from inside; nothing is read without a token, even from loopback', async () => {
  const tokens = createStreamTokens({ secret: SECRET });
  const access = createPathAccess({ load: async () => entries });
  const d = { tokens, access };
  const read = (pw: string | undefined, p = 'cam01', ip = '203.0.113.7', action = 'read') => decideMediaAuth({ user: 'viewer', password: pw, ip, action, path: p }, d);
  const a = tokens.issue(alice).token, tm = tokens.issue(tom).token, r = tokens.issue(root).token;
  assert.deepEqual([await read(a), await read(tm), await read(r), await read(a, 'cam02'), await read(tm, 'cam02'), await read(r, 'cam02')], [true, true, true, false, false, true]);
  assert.equal(await read(undefined), false, 'no token');
  assert.equal(await read('v1.junk.junk'), false);
  assert.equal(await read(a, 'cam01/extra/segment.mp4'), true, 'a path with a trailing part is judged by its first segment');
  assert.equal(await read(a, '../cam02'), false, 'path tricks');
  assert.equal(await read(a, ''), false);
  assert.equal(await read(a, 'cam01', '127.0.0.1'), true);
  assert.equal(await read(undefined, 'cam01', '127.0.0.1'), false, 'from loopback WITHOUT a token: refused (behind a reverse proxy every viewer is loopback)');
  assert.equal(await read(undefined, 'cam01', '::1', 'playback'), false);
  const act = (action: string, ip: string) => decideMediaAuth({ action, ip, path: 'x' }, d);
  assert.deepEqual([await act('publish', '127.0.0.1'), await act('api', '::1'), await act('metrics', '::ffff:127.0.0.1')], [true, true, true]);
  assert.deepEqual([await act('publish', '203.0.113.7'), await act('api', '203.0.113.7'), await act('pprof', '10.0.0.5')], [false, false, false]);
  assert.equal(await decideMediaAuth({ action: 'publish', ip: '10.0.0.5' }, { ...d, internalIps: (ip) => ip.startsWith('10.') }), true, 'a configured internal network');
});

// ---- a real MediaMTX asking a real callback ------------------------------------------------------------------------------------------

const MEDIAMTX = path.resolve('media-server/bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const have = existsSync(MEDIAMTX) && spawnSync('ffmpeg', ['-version']).status === 0;
const skip = have ? false : 'MediaMTX or ffmpeg is not available';
const procs: ChildProcess[] = [];
let dir = '';
after(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } } });
const freePort = () => new Promise<number>((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); s.on('error', reject); });

test('real MediaMTX with HTTP auth: a viewer with the right token gets the playlist, everyone else gets 401; publishing from the machine still works; the callback is reached with the secret', { skip, timeout: 120_000 }, async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'media-auth-'));
  const [hlsPort, rtspPort, appPort, apiPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const tokens = createStreamTokens({ secret: SECRET });
  const access = createPathAccess({ load: async () => entries });
  const calls: Array<{ action?: string; path?: string; user?: string; ipSeen: string; ok: boolean }> = [];
  const app = express();
  app.use(express.json());
  registerMediaAuth(app, { tokens, access, secret: 'callback-secret' });
  app.use('/api/media/auth', (_req, _res, next) => next());
  const logged = express();
  logged.use(express.json());
  logged.post('/api/media/auth', async (req, res, next) => {
    const ok = await decideMediaAuth(req.body, { tokens, access });
    calls.push({ action: req.body?.action, path: req.body?.path, user: req.body?.user, ipSeen: String(req.body?.ip), ok });
    next();
  });
  logged.use(app);
  const appServer = http.createServer(logged);
  await new Promise<void>((r) => appServer.listen(appPort, '127.0.0.1', r));
  try {
    writeFileSync(path.join(dir, 'm.yml'), `logLevel: error
authMethod: http
authHTTPAddress: http://127.0.0.1:${appPort}/api/media/auth?s=callback-secret
api: true
apiAddress: 127.0.0.1:${apiPort}
metrics: false
pprof: false
playback: false
rtsp: true
rtspTransports: [tcp]
rtspAddress: 127.0.0.1:${rtspPort}
rtmp: false
webrtc: false
srt: false
moq: false
hls: true
hlsAddress: 127.0.0.1:${hlsPort}
paths:
  cam01: {}
  cam02: {}
`);
    mkdirSync(path.join(dir, 'cwd'));
    const mtx = spawn(MEDIAMTX, [path.join(dir, 'm.yml')], { stdio: 'ignore', cwd: path.join(dir, 'cwd') });
    procs.push(mtx);
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(mtx.exitCode, null, 'MediaMTX started with HTTP auth');
    for (const cam of ['cam01', 'cam02']) procs.push(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${rtspPort}/${cam}`], { stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(calls.some((c) => c.action === 'publish' && c.ok), true, 'the camera publishers were let in from the machine (the callback was asked)');

    const get = async (p: string, pw?: string) => (await fetch(`http://127.0.0.1:${hlsPort}/${p}/index.m3u8?cookieCheck=1`, { headers: pw === undefined ? {} : { Authorization: `Basic ${Buffer.from(`viewer:${pw}`).toString('base64')}` } })).status;
    const A = tokens.issue(alice).token, T = tokens.issue(tom).token, R = tokens.issue(root).token, W = tokens.issue(deptAdmin).token;
    assert.equal(await get('cam01', A), 200, 'alice owns a camera on cam01');
    assert.equal(await get('cam01', T), 200, 'Tom works for Traffic, which has a camera on cam01');
    assert.equal(await get('cam01', R), 200, 'an organisation-wide administrator');
    assert.equal(await get('cam02', A), 401, 'alice has no right to cam02: the shared-password hole is closed');
    assert.equal(await get('cam02', T), 401);
    assert.equal(await get('cam02', W), 401, 'an administrator of one department only');
    assert.equal(await get('cam02', R), 200);
    assert.equal(await get('cam01'), 401, 'no login at all');
    assert.equal(await get('cam01', 'viewerpassword'), 401, 'the old shared password is no longer good');
    assert.equal(await get('cam01', A.slice(0, -3) + 'abc'), 401, 'a changed token');
    const seen = calls.filter((c) => c.action === 'read' || c.action === 'playback').length;
    assert.equal(seen > 0, true, 'MediaMTX asked the callback about the reads');
    // The callback itself refuses a wrong secret.
    const bad = await fetch(`http://127.0.0.1:${appPort}/api/media/auth?s=wrong`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read', path: 'cam01', password: A, ip: '203.0.113.1' }) });
    assert.equal(bad.status, 401);
    const good = await fetch(`http://127.0.0.1:${appPort}/api/media/auth?s=callback-secret`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read', path: 'cam01', password: A, ip: '203.0.113.1' }) });
    assert.equal(good.status, 200);
  } finally { appServer.close(); }
});
