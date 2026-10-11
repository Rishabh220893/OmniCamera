/**
 * Recording at the edge with a central clip fetch (gap A16): real ffmpeg video, a real gateway agent and clip worker, and the centre's routes over
 * real HTTP. Skipped when ffmpeg is not installed.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createGatewayCentral, createMemoryGatewayDocs } from '../server/gateway/central.ts';
import { captureRawBody } from '../server/gateway/routes.ts';
import { createAgent } from '../server/gateway/agent.ts';
import { signRequest } from '../server/gateway/protocol.ts';
import { openOutbox } from '../server/gateway/outbox.ts';
import { createClipRequestStore, registerClipRoutes, registerClipUpload, type ClipRoutesContext } from '../server/gateway/clips.ts';
import { createClipWorker } from '../server/gateway/clipWorker.ts';
import { createRecordingStore, segmentName } from '../server/recording/store.ts';
import { createHoldStore, createPolicyStore } from '../server/recording/retention.ts';
import { registerRecordingRoutes } from '../server/recording/routes.ts';
import { generateEvidenceKey, readCustody, signingKeyFromEnv, verifyCustody, verifyManifest } from '../server/recording/evidence.ts';
import { sha256File } from '../server/recording/clip.ts';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = haveFfmpeg ? false : 'ffmpeg is not available';
const root = mkdtempSync(path.join(tmpdir(), 'gw-clips-'));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* locked on Windows */ } });
const quiet = { info() {}, warn() {} };
const until = async (cond: () => boolean | Promise<boolean>, ms = 8000, what = 'condition') => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 20)); } };

// Footage recorded at the edge, ending a few minutes ago (the centre refuses a range in the future).
const T0 = new Date(Math.floor((Date.now() - 10 * 60_000) / 1000) * 1000);
const at = (s: number) => new Date(T0.getTime() + s * 1000);
function seg(dir: string, cam: string, start: Date, sec: number) {
  mkdirSync(path.join(dir, cam), { recursive: true });
  const file = path.join(dir, cam, segmentName(start, 'utc'));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${sec}:size=160x90:rate=10`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-movflags', 'frag_keyframe+empty_moov', file]);
  assert.equal(r.status, 0, String(r.stderr));
  const m = new Date(start.getTime() + sec * 1000);
  utimesSync(file, m, m);
}

interface Lab {
  call: (method: string, p: string, body?: unknown, who?: string) => Promise<{ status: number; json: any; buf: Buffer }>;
  gatewayId: string; secret: string; base: string;
  edge: { store: ReturnType<typeof createRecordingStore>; holds: ReturnType<typeof createHoldStore>; worker: ReturnType<typeof createClipWorker>; agent: ReturnType<typeof createAgent> };
  exportsDir: string; requests: ReturnType<typeof createClipRequestStore>;
  signing: ReturnType<typeof signingKeyFromEnv>;
}

async function withLab(run: (l: Lab) => Promise<void>, o: { leaseMs?: number; maxBytes?: number; signing?: boolean; maxPending?: number } = {}) {
  const dir = mkdtempSync(path.join(root, 'lab-'));
  const edgeDir = path.join(dir, 'edge');
  seg(edgeDir, 'camA', at(0), 4); seg(edgeDir, 'camA', at(4), 4);
  const exportsDir = path.join(dir, 'exports');
  const signing = o.signing ? signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: generateEvidenceKey().privatePem }) : null;

  // The centre
  const docs = createMemoryGatewayDocs();
  const central = createGatewayCentral({ docs, cameras: async () => [], userContext: async () => ({ faces: [], watchlist: [] }) as never, sinks: { writeLog: async () => undefined, writeSightings: async () => undefined, emitEvents: async () => undefined, updateCamera: async () => undefined }, log: quiet });
  const prov = await central.provision({ name: 'Rajkot', region: 'Saurashtra', ownerId: 'admin-1' });
  const requests = createClipRequestStore({ file: path.join(dir, 'clips.json'), leaseMs: o.leaseMs });
  const ctxRef: { ctx: ClipRoutesContext | null } = { ctx: null };
  const app = express();
  registerClipUpload(app, () => ctxRef.ctx);
  app.use(express.json({ limit: '5mb', verify: captureRawBody }));
  const accounts: Record<string, { uid: string; ok: boolean }> = { bob: { uid: 'bob', ok: true }, eve: { uid: 'eve', ok: false } };
  const ctx: ClipRoutesContext = {
    store: requests, exportsDir, signing, maxBytes: o.maxBytes, maxPendingPerGateway: o.maxPending,
    access: async (req, res, _perm, cameraId) => {
      const a = accounts[String(req.header('X-User'))];
      if (!a) { res.status(401).json({ error: 'sign in' }); return null; }
      if (cameraId && cameraId !== 'camA') { res.status(404).json({ error: 'No such camera.' }); return null; }
      if (!a.ok) { res.status(403).json({ error: 'no' }); return null; }
      return { uid: a.uid };
    },
    gateways: { exists: async (id) => (await central.list()).some((g) => g.id === id), lookup: (id) => central.lookup(id), refresh: () => central.refresh() },
  };
  ctxRef.ctx = ctx;
  registerClipRoutes(app, ctx);
  // The ordinary export routes serve the fetched clip (a clip fetched from a gateway is an export like any other).
  registerRecordingRoutes(app, {
    store: createRecordingStore({ hotDir: path.join(dir, 'central-rec'), nameTime: 'utc' }), policies: createPolicyStore(path.join(dir, 'policy.json')), holds: createHoldStore(path.join(dir, 'holds-central.json')), exportsDir, signing,
    access: async (req, res, _p, cameraId) => { const a = accounts[String(req.header('X-User'))]; if (!a) { res.status(401).json({ error: 'sign in' }); return null; } if (!a.ok) { res.status(403).json({ error: 'no' }); return null; } if (cameraId && cameraId !== 'camA') { res.status(404).json({ error: 'x' }); return null; } return { uid: a.uid }; },
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The gateway
  const store = createRecordingStore({ hotDir: edgeDir, nameTime: 'utc' });
  const holds = createHoldStore(path.join(dir, 'edge-holds.json'));
  const agent = createAgent({ centralUrl: base, gatewayId: prov.gateway.id, secret: prov.secret, outbox: openOutbox({ dir: path.join(dir, 'outbox'), maxBytes: 1e6, maxAgeMs: 1e9 }), log: quiet });
  const worker = createClipWorker({ agent, store, holds, workDir: path.join(dir, 'edge-work'), log: quiet });
  try {
    await run({
      gatewayId: prov.gateway.id, secret: prov.secret, base, edge: { store, holds, worker, agent }, exportsDir, requests, signing,
      call: async (method, p, body, who = 'bob') => {
        const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-User': who }, body: body === undefined ? undefined : JSON.stringify(body) });
        const buf = Buffer.from(await r.arrayBuffer());
        let json: any = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
        return { status: r.status, json, buf };
      },
    });
  } finally { server.close(); agent.stop(); worker.stop(); }
}

test('fetch a clip: asked for at the centre, held and cut at the edge, checked and filed as an evidence export, signed, with a chain of custody; the download matches its hash', { skip, timeout: 90_000 }, async () => {
  await withLab(async ({ call, gatewayId, edge, exportsDir, requests }) => {
    const asked = await call('POST', `/api/gateways/${gatewayId}/clips`, { cameraId: 'camA', from: at(0).toISOString(), to: at(8).toISOString(), reason: 'FIR 12/2026' });
    assert.equal(asked.status, 202);
    const id = asked.json.request.id;
    assert.equal(asked.json.request.state, 'pending');
    assert.equal((await call('GET', `/api/gateway-clips/${id}`)).json.request.state, 'pending', 'it waits until the gateway asks');

    assert.equal(await edge.worker.tick(), 1);
    const done = (await call('GET', `/api/gateway-clips/${id}`)).json.request;
    assert.deepEqual([done.state, done.exportId], ['ready', id]);
    assert.equal(done.bytes > 1000, true);

    // At the edge: the footage is held.
    const held = await edge.holds.list('camA');
    assert.equal(held.length, 1);
    assert.match(held[0].reason, /Central clip request/);

    // At the centre: an ordinary export, with manifest, signature and custody.
    const ex = (await call('GET', `/api/recording-exports/${id}`)).json;
    assert.deepEqual([ex.export.source, ex.export.cameraId, ex.export.reason, ex.export.exportedBy, ex.export.holdId], [`gateway:${(await requests.get(id))!.gatewayId}`, 'camA', 'FIR 12/2026', 'bob', held[0].id]);
    assert.equal(ex.export.sha256, await sha256File(path.join(exportsDir, id, 'camA.mp4')));
    assert.equal(ex.export.segments.length, 2);
    assert.deepEqual(ex.custody.map((e: any) => `${e.action}:${e.by.split(':')[0]}`), ['exported:bob', 'fetched:gateway']);
    assert.equal(ex.custodyIntact, true);
    const dl = await call('GET', `/api/recording-exports/${id}/file`);
    assert.equal(dl.status, 200);
    assert.equal(dl.buf.length, ex.export.bytes);
    const v = await call('POST', `/api/recording-exports/${id}/verify`);
    assert.deepEqual([v.json.fileMatchesManifest, v.json.custody.ok], [true, true]);
    assert.equal(verifyCustody(await readCustody(path.join(exportsDir, id))).ok, true);
    assert.equal((await edge.worker.tick()), 0, 'nothing more to do; the same request is not served twice');
  }, { signing: true });
});

test('the signed manifest of a fetched clip checks with the public key alone, and not after a change', { skip, timeout: 90_000 }, async () => {
  await withLab(async ({ call, gatewayId, edge, signing }) => {
    const r = await call('POST', `/api/gateways/${gatewayId}/clips`, { cameraId: 'camA', from: at(0).toISOString(), to: at(8).toISOString(), reason: 'case 7' });
    await edge.worker.tick();
    const ex = (await call('GET', `/api/recording-exports/${r.json.request.id}`)).json;
    assert.equal(ex.signature.keyId, signing!.keyId);
    assert.equal(verifyManifest(ex.export, ex.signature, signing!.publicPem), true);
    assert.equal(verifyManifest({ ...ex.export, reason: 'changed' }, ex.signature, signing!.publicPem), false);
    assert.equal(verifyManifest({ ...ex.export, sha256: '0'.repeat(64) }, ex.signature, signing!.publicPem), false, 'a different hash does not verify either');
  }, { signing: true });
});

test('a clip that cannot be made is reported as failed with the reason; nothing is filed; the hold is still placed (the footage is not lost while it is sorted out)', { skip, timeout: 60_000 }, async () => {
  await withLab(async ({ call, gatewayId, edge, exportsDir }) => {
    const r = await call('POST', `/api/gateways/${gatewayId}/clips`, { cameraId: 'camA', from: at(100).toISOString(), to: at(108).toISOString(), reason: 'FIR 99' });
    await edge.worker.tick();
    const st = (await call('GET', `/api/gateway-clips/${r.json.request.id}`)).json.request;
    assert.equal(st.state, 'failed');
    assert.match(st.error, /no recording/i);
    assert.equal((await call('GET', `/api/recording-exports/${r.json.request.id}`)).status, 404);
    assert.equal((await edge.holds.list('camA')).length, 1);
    void exportsDir;
  });
});

test('asking: needs a sign-in and the right on that camera; the gateway, camera, times and reason are checked; too many waiting is refused', { skip, timeout: 60_000 }, async () => {
  await withLab(async ({ call, gatewayId }) => {
    const body = { cameraId: 'camA', from: at(0).toISOString(), to: at(8).toISOString(), reason: 'FIR 1/2026' };
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, body, 'nobody')).status, 401);
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, body, 'eve')).status, 403);
    assert.equal((await call('POST', '/api/gateways/gw-00000000/clips', body)).status, 404, 'no such gateway');
    assert.equal((await call('POST', '/api/gateways/not-an-id/clips', body)).status, 404);
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, { ...body, cameraId: 'camZ' })).status, 404, 'a camera you cannot see');
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, { ...body, cameraId: '../x' })).status, 400);
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, { ...body, reason: 'x' })).status, 400);
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, { ...body, to: at(-5).toISOString() })).status, 400, 'to before from');
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, { ...body, to: new Date(Date.now() + 3_600_000).toISOString() })).status, 400, 'in the future');
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, { ...body, from: at(-10_000).toISOString() })).status, 400, 'over an hour');
    assert.equal((await call('GET', '/api/gateway-clips/not-a-uuid')).status, 404);
    assert.equal((await call('GET', '/api/gateway-clips/00000000-0000-0000-0000-000000000000')).status, 404);
  });
  await withLab(async ({ call, gatewayId }) => {
    const body = { cameraId: 'camA', from: at(0).toISOString(), to: at(8).toISOString(), reason: 'FIR 2/2026' };
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, body)).status, 202);
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, body)).status, 202);
    assert.equal((await call('POST', `/api/gateways/${gatewayId}/clips`, body)).status, 429, 'more waiting than the limit');
  }, { maxPending: 2 });
});

test('a request a gateway took and never finished goes back to waiting; one gateway cannot take or answer another\'s request', { skip, timeout: 60_000 }, async () => {
  await withLab(async ({ call, gatewayId, requests }) => {
    const r = await call('POST', `/api/gateways/${gatewayId}/clips`, { cameraId: 'camA', from: at(0).toISOString(), to: at(8).toISOString(), reason: 'FIR 3/2026' });
    const id = r.json.request.id;
    assert.equal((await requests.claim(gatewayId, 5)).length, 1);
    assert.equal((await requests.claim(gatewayId, 5)).length, 0, 'taken: not handed out again straight away');
    await new Promise((res) => setTimeout(res, 80));
    assert.equal((await requests.claim(gatewayId, 5)).length, 1, 'the lease ran out: waiting again');
    assert.equal((await requests.claim('gw-ffffffff', 5)).length, 0, 'another gateway gets nothing');
    assert.equal(await requests.setMeta(id, 'gw-ffffffff', { sha256: 'a'.repeat(64), bytes: 1, actualFrom: '', durationSec: 1, segments: [], gaps: [] }), null);
  }, { leaseMs: 50 });
});

test('upload integrity: an unsigned or wrongly signed upload, a hash that does not match the bytes, a wrong size and a request of another gateway are all refused and nothing is filed', { skip, timeout: 60_000 }, async () => {
  await withLab(async ({ call, gatewayId, secret, base, requests, exportsDir }) => {
    const r = await call('POST', `/api/gateways/${gatewayId}/clips`, { cameraId: 'camA', from: at(0).toISOString(), to: at(8).toISOString(), reason: 'FIR 4/2026' });
    const id = r.json.request.id;
    const [claimed] = await requests.claim(gatewayId, 1);
    assert.equal(claimed.id, id);
    const bytes = Buffer.from('not really a video, but bytes');
    const goodHash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    await requests.setMeta(id, gatewayId, { sha256: goodHash, bytes: bytes.length, actualFrom: at(0).toISOString(), durationSec: 8, segments: [], gaps: [] });
    const put = (headers: Record<string, string>, body: Buffer, p = `/api/gateway/clip-requests/${id}/file`) =>
      fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length), ...headers }, body }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));
    const sign = (hash: string, id2 = gatewayId, sec = secret) => ({ 'X-Clip-SHA256': hash, ...signRequest({ gatewayId: id2, secret: sec, method: 'PUT', path: `/api/gateway/clip-requests/${id}/file`, body: hash }) });

    assert.equal((await put({ 'X-Clip-SHA256': goodHash }, bytes)).status, 401, 'unsigned');
    assert.equal((await put(sign(goodHash, gatewayId, 'wrong-secret'), bytes)).status, 401, 'wrong secret');
    assert.equal((await put(sign('b'.repeat(64)), bytes)).status, 422, 'a hash other than the one declared');
    assert.equal((await put(sign(goodHash), Buffer.concat([bytes, Buffer.from('x')]))).status, 413, 'a different size than declared');
    assert.equal((await requests.get(id))!.state, 'working', 'refusals before the data arrived leave the request as it was');
    const damaged = Buffer.from(bytes); damaged[3] ^= 0xff;
    const bad = await put(sign(goodHash), damaged);
    assert.equal(bad.status, 422, 'bytes that do not match their hash');
    assert.equal((await requests.get(id))!.state, 'failed');
    await assert.rejects(fsStat(path.join(exportsDir, id, 'manifest.json')), 'nothing was filed');
  });
});
const fsStat = async (p: string) => (await import('node:fs/promises')).stat(p);

test('an agent whose clock is wrong is corrected by the centre and still gets and sends a clip; a request it has not claimed is refused', { skip, timeout: 60_000 }, async () => {
  await withLab(async ({ call, gatewayId, secret, base, requests, exportsDir, edge }) => {
    const r = await call('POST', `/api/gateways/${gatewayId}/clips`, { cameraId: 'camA', from: at(0).toISOString(), to: at(8).toISOString(), reason: 'FIR 5/2026' });
    const id = r.json.request.id;
    // Not claimed yet: the centre will not take details or a file for it.
    await assert.rejects(edge.agent.postClipDetails(id, { sha256: 'a'.repeat(64), bytes: 1, actualFrom: '', durationSec: 1, segments: [], gaps: [] }), /No such request|centre answered/);

    // An agent whose clock is 20 minutes slow (more than the centre accepts) is told the time and signs again.
    const skewed = createAgent({ centralUrl: base, gatewayId, secret, outbox: openOutbox({ dir: path.join(tmpdir(), `ob-${Date.now()}`), maxBytes: 1e6, maxAgeMs: 1e9 }), now: () => Date.now() - 20 * 60_000, log: quiet });
    const got = await skewed.clipRequests();
    assert.equal(got.length, 1, 'it got the request although its clock was wrong');
    assert.equal(Math.abs(skewed.status().clockOffsetMs - 20 * 60_000) < 5000, true, 'and learned the centre\'s time');
    const body = Buffer.from('small stand-in for a clip');
    const file = path.join(tmpdir(), `clip-${Date.now()}.mp4`);
    writeFileSync(file, body);
    const sha = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');
    await skewed.postClipDetails(id, { sha256: sha, bytes: body.length, actualFrom: at(0).toISOString(), durationSec: 8, segments: [], gaps: [] });
    await skewed.uploadClip(id, file, sha, body.length);
    assert.equal((await requests.get(id))!.state, 'ready');
    assert.equal(readFileSync(path.join(exportsDir, id, 'camA.mp4')).equals(body), true, 'the bytes that arrived are the bytes that were sent');
    skewed.stop();
  });
});
