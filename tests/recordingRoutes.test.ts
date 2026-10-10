import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerRecordingRoutes, type RecordingPermission } from '../server/recording/routes.ts';
import { createRecordingStore, segmentName } from '../server/recording/store.ts';
import { createHoldStore, createPolicyStore } from '../server/recording/retention.ts';
import { sha256File } from '../server/recording/clip.ts';
import { can, decide, type Principal } from '../server/authz/policy.ts';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = haveFfmpeg ? false : 'ffmpeg is not available';
const root = mkdtempSync(path.join(tmpdir(), 'rec-routes-'));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

const T0 = new Date('2026-10-10T10:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
function seg(dir: string, cam: string, start: Date, sec: number) {
  mkdirSync(path.join(dir, cam), { recursive: true });
  const file = path.join(dir, cam, segmentName(start, 'utc'));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${sec}:size=160x90:rate=10`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', file]);
  assert.equal(r.status, 0);
  const m = new Date(start.getTime() + sec * 1000);
  utimesSync(file, m, m);
}

type Who = { uid: string; role: 'viewer' | 'operator' | 'admin' } | null;

async function withRoutes(run: (c: { call: (method: string, p: string, body?: unknown, who?: string) => Promise<{ status: number; json: any; headers: Headers; buf: Buffer }>; dir: string; exportsDir: string; holds: ReturnType<typeof createHoldStore>; denied: string[] }) => Promise<void>, over: { maxConcurrent?: number } = {}) {
  const dir = mkdtempSync(path.join(root, 'r-'));
  seg(dir, 'camA', at(0), 4); seg(dir, 'camA', at(4), 4); seg(dir, 'camA', at(12), 4);
  const exportsDir = path.join(dir, 'exports');
  const store = createRecordingStore({ hotDir: dir, now: () => at(100), nameTime: 'utc' });
  const holds = createHoldStore(path.join(dir, 'holds.json'), () => at(100));
  const policies = createPolicyStore(path.join(dir, 'policy.json'));
  const denied: string[] = [];
  // Accounts: bob owns camA; ann is an operator in another department; eve is a viewer; root is an admin.
  const accounts: Record<string, Who & { dept?: string }> = { bob: { uid: 'bob', role: 'operator' }, ann: { uid: 'ann', role: 'operator' }, eve: { uid: 'eve', role: 'viewer' }, root: { uid: 'root', role: 'admin' } };
  const app = express();
  app.use(express.json());
  registerRecordingRoutes(app, {
    store, policies, holds, exportsDir, now: () => at(100), maxConcurrent: over.maxConcurrent,
    access: async (req, res, permission: RecordingPermission, cameraId) => {
      const a = accounts[String(req.header('X-User'))];
      if (!a) { res.status(401).json({ error: 'Sign-in required.' }); return null; }
      const p: Principal = { uid: a.uid, role: a.role, departments: a.uid === 'ann' ? ['water'] : ['*'], source: 'claims' };
      if (cameraId && cameraId !== 'camA') { res.status(404).json({ error: 'No such camera.' }); return null; }
      const owner = a.uid === 'bob';
      if (!decide(p, permission, cameraId && !owner ? { department: 'traffic' } : undefined).allowed) { denied.push(`${a.uid}:${permission}`); res.status(403).json({ error: 'no' }); return null; }
      return { uid: a.uid };
    },
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({
      dir, exportsDir, holds, denied,
      call: async (method, p, body, who = 'bob') => {
        const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-User': who }, body: body === undefined ? undefined : JSON.stringify(body) });
        const buf = Buffer.from(await r.arrayBuffer());
        let json: any = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        return { status: r.status, json, headers: r.headers, buf };
      },
    });
  } finally { server.close(); }
}

const Q = (from: number, to: number) => `from=${encodeURIComponent(at(from).toISOString())}&to=${encodeURIComponent(at(to).toISOString())}`;

test('timeline: segments, gaps, recorded time and whether each is held', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call, holds }) => {
    const r = await call('GET', `/api/recordings/camA?${Q(0, 20)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.segments.length, 3);
    assert.ok(Math.abs(r.json.recordedSec - 12) <= 1);
    assert.deepEqual(r.json.gaps.map((g: any) => [(Date.parse(g.from) - T0.getTime()) / 1000, (Date.parse(g.to) - T0.getTime()) / 1000]), [[8, 12], [16, 20]]);
    assert.ok(r.json.segments.every((s: any) => s.held === false && s.tier === 'hot'));
    await holds.add({ cameraId: 'camA', from: at(0), to: at(3), reason: 'x', by: 'root' });
    assert.deepEqual((await call('GET', `/api/recordings/camA?${Q(0, 20)}`)).json.segments.map((s: any) => s.held), [true, false, false]);
  });
});

test('timeline: bad input is refused clearly', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call }) => {
    for (const q of ['', 'from=x&to=y', Q(20, 0), `from=${at(0).toISOString()}`, `from=${at(0).toISOString()}&to=${new Date(T0.getTime() + 40 * 86_400_000).toISOString()}`]) {
      assert.equal((await call('GET', `/api/recordings/camA?${q}`)).status, 400, q);
    }
    assert.equal((await call('GET', `/api/recordings/${encodeURIComponent('../x')}?${Q(0, 5)}`)).status, 404);
    assert.equal((await call('GET', `/api/recordings/other?${Q(0, 5)}`)).status, 404);
    assert.equal((await call('GET', `/api/recordings/camA?${Q(0, 5)}`, undefined, 'nobody')).status, 401);
  });
});

test('clip: streams a playable MP4, reports where it really starts and how many gaps, leaves no temporary file; no footage is 404', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call, exportsDir, dir }) => {
    const r = await call('GET', `/api/recordings/camA/clip?${Q(2, 14)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('x-clip-gaps'), '1');
    assert.ok(r.headers.get('x-clip-actual-from'));
    assert.equal(r.buf.subarray(4, 8).toString('latin1'), 'ftyp', 'an MP4');
    assert.equal(r.buf.length, Number(r.headers.get('content-length')));
    const f = path.join(dir, 'got.mp4');
    (await import('node:fs')).writeFileSync(f, r.buf);
    const d = parseFloat(String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).stdout));
    assert.ok(d > 7 && d < 13, `duration ${d}`);
    await new Promise((x) => setTimeout(x, 200));
    const tmp = path.join(exportsDir, 'tmp');
    assert.equal(existsSync(tmp) ? readdirSync(tmp).length : 0, 0, 'the temporary clip is deleted after sending');
    assert.equal((await call('GET', `/api/recordings/camA/clip?${Q(60, 70)}`)).status, 404);
    assert.equal((await call('GET', `/api/recordings/camA/clip?${Q(0, 5000)}`)).status, 400, 'longer than 15 minutes');
  });
});

test('clip: only so many are cut at once', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call }) => {
    const results = await Promise.all(Array.from({ length: 5 }, () => call('GET', `/api/recordings/camA/clip?${Q(0, 8)}`)));
    const codes = results.map((r) => r.status);
    assert.ok(codes.includes(429), `statuses: ${codes}`);
    assert.ok(codes.includes(200));
    assert.ok(codes.every((c) => c === 200 || c === 429));
    assert.equal((await call('GET', `/api/recordings/camA/clip?${Q(0, 8)}`)).status, 200, 'free again afterwards');
  }, { maxConcurrent: 1 });
});

test('export: needs a reason, makes a hashed manifest and a hold, and the file matches its hash; a stranger is refused', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call, holds, exportsDir, denied }) => {
    assert.equal((await call('POST', '/api/recordings/camA/export', { from: at(0).toISOString(), to: at(8).toISOString() })).status, 400);
    assert.equal((await call('POST', '/api/recordings/camA/export', { from: at(0).toISOString(), to: at(8).toISOString(), reason: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/recordings/camA/export', { from: at(0).toISOString(), to: at(8000).toISOString(), reason: 'FIR 12/2026' })).status, 400, 'over an hour');
    assert.equal((await call('POST', '/api/recordings/camA/export', { from: at(50).toISOString(), to: at(58).toISOString(), reason: 'FIR 12/2026' })).status, 404);
    assert.equal((await holds.list()).length, 0, 'a failed export holds nothing');

    const r = await call('POST', '/api/recordings/camA/export', { from: at(0).toISOString(), to: at(8).toISOString(), reason: 'FIR 12/2026' });
    assert.equal(r.status, 201);
    const m = r.json.export;
    assert.deepEqual([m.cameraId, m.reason, m.exportedBy, m.segments.length], ['camA', 'FIR 12/2026', 'bob', 2]);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.equal(m.sha256, await sha256File(path.join(exportsDir, m.id, 'camA.mp4')));
    const hs = await holds.list('camA');
    assert.deepEqual([hs.length, hs[0].id, hs[0].reason], [1, m.holdId, 'FIR 12/2026']);

    assert.deepEqual((await call('GET', `/api/recording-exports/${m.id}`)).json.export.sha256, m.sha256);
    const f = await call('GET', `/api/recording-exports/${m.id}/file`);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('x-content-sha256'), m.sha256);
    assert.match(f.headers.get('content-disposition') ?? '', /attachment/);

    assert.equal((await call('GET', `/api/recording-exports/${m.id}`, undefined, 'eve')).status, 403, 'a viewer cannot read exports');
    assert.equal((await call('POST', '/api/recordings/camA/export', { from: at(0).toISOString(), to: at(8).toISOString(), reason: 'curious' }, 'ann')).status, 403, 'another department');
    assert.ok(denied.includes('ann:recording.export'));
    for (const bad of ['nope', '../../x', '00000000-0000-0000-0000-000000000000']) assert.equal((await call('GET', `/api/recording-exports/${encodeURIComponent(bad)}`)).status, 404, bad);
  });
});

test('permissions: viewers cannot see recordings; other departments cannot; only an admin manages policy, holds and retention', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call }) => {
    assert.equal((await call('GET', `/api/recordings/camA?${Q(0, 20)}`, undefined, 'eve')).status, 403);
    assert.equal((await call('GET', `/api/recordings/camA?${Q(0, 20)}`, undefined, 'ann')).status, 403);
    assert.equal((await call('GET', `/api/recordings/camA?${Q(0, 20)}`, undefined, 'root')).status, 200);
    for (const [m, p] of [['GET', '/api/recordings/usage'], ['POST', '/api/recordings/retention'], ['GET', '/api/recording-holds'], ['GET', '/api/recording-policy'], ['PUT', '/api/recording-policy/camA'], ['DELETE', '/api/recording-policy/camA']] as const) {
      assert.equal((await call(m, p, m === 'GET' ? undefined : { mode: 'continuous' }, 'bob')).status, 403, `${m} ${p} for an operator`);
    }
    assert.equal((await call('GET', '/api/recordings/usage', undefined, 'root')).status, 200);
  });
});

test('policy: set, read back, validated, cleared; retention dry run reports without deleting', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call }) => {
    assert.equal((await call('PUT', '/api/recording-policy/camA', { mode: 'continuous', keepDays: 30 }, 'root')).status, 200);
    assert.equal((await call('PUT', '/api/recording-policy/camA', { mode: 'always' }, 'root')).status, 400);
    assert.equal((await call('PUT', '/api/recording-policy/camA', { mode: 'continuous', keepDays: 0 }, 'root')).status, 400);
    assert.equal((await call('PUT', '/api/recording-policy/..%2Fx', { mode: 'off' }, 'root')).status, 404);
    assert.equal((await call('PUT', '/api/recording-policy', { default: { mode: 'continuous', keepDays: 3 } }, 'root')).json.default.keepDays, 3);
    const got = (await call('GET', '/api/recording-policy', undefined, 'root')).json;
    assert.deepEqual([got.cameras.camA.keepDays, got.default.keepDays], [30, 3]);
    await call('DELETE', '/api/recording-policy/camA', undefined, 'root');
    assert.equal(Object.keys((await call('GET', '/api/recording-policy', undefined, 'root')).json.cameras).length, 0);
    // a policy of 1 day makes every (100-second-old) segment current, so nothing is due; 2026 data vs the real clock is long past retention in the fake "now" of 100 s
    const dry = await call('POST', '/api/recordings/retention?dryRun=1', undefined, 'root');
    assert.equal(dry.status, 200);
    assert.equal(dry.json.dryRun, true);
    assert.equal(dry.json.deleted, 0);
  });
});

test('holds: listed, released once, then gone from the active list but kept on record', { skip, timeout: 60_000 }, async () => {
  await withRoutes(async ({ call, holds }) => {
    const h = await holds.add({ cameraId: 'camA', from: at(0), to: at(5), reason: 'case', by: 'root' });
    assert.equal((await call('GET', '/api/recording-holds', undefined, 'root')).json.holds.length, 1);
    assert.equal((await call('POST', `/api/recording-holds/${h.id}/release`, undefined, 'root')).status, 200);
    assert.equal((await call('POST', `/api/recording-holds/${h.id}/release`, undefined, 'root')).status, 404);
    assert.equal((await call('GET', '/api/recording-holds', undefined, 'root')).json.holds.length, 0);
    assert.equal((await call('GET', '/api/recording-holds?all=1', undefined, 'root')).json.holds.length, 1);
    assert.equal((await call('POST', '/api/recording-holds/not-an-id/release', undefined, 'root')).status, 404);
  });
});

test('authz policy: recordings are department-scoped even for an admin limited to one department; managing them is platform-wide', () => {
  const adminWater: Principal = { uid: 'a', role: 'admin', departments: ['water'], source: 'claims' };
  assert.ok(!can(adminWater, 'recording.view', { department: 'traffic' }));
  assert.ok(can(adminWater, 'recording.view', { department: 'water' }));
  assert.ok(can(adminWater, 'recording.manage', { department: 'traffic' }));
  const viewer: Principal = { uid: 'v', role: 'viewer', departments: ['*'], source: 'claims' };
  assert.ok(!can(viewer, 'recording.view'), 'viewers do not see recordings');
  assert.ok(can({ ...viewer, role: 'operator' }, 'recording.export'));
});
