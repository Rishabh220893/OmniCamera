import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerAdapterRoutes, parseCameraRef, type AdapterRoutesContext } from '../server/adapterRoutes.ts';
import { createAdapterRegistry, AdapterError, type SourceAdapter } from '../server/adapters/index.ts';
import type { ProbeReport } from '../server/cameraProfile.ts';

const report = (id: string): ProbeReport => ({ cameraId: id, site: 'fake', transport: 'tcp', probedAt: 'x', probeVersion: 1, reachable: true, failure: null, failureDetail: null, describe: null, sample: null, whep: null, flags: [] });

const fake: SourceAdapter = {
  kind: 'fake', label: 'Fake', description: 'd', accepts: (r) => !!r.url?.startsWith('http://cams.example.org'),
  discover: async () => [{ adapter: 'fake', address: '1.2.3.4', serviceUrls: ['http://1.2.3.4/x'], scopes: [] }],
  endpoints: async (r) => [{ protocol: 'rtsp', role: 'analysis', url: `rtsp://${r.credentials?.user}:${r.credentials?.pass}@cams.example.org/s` }],
  probe: async (r) => { if (r.id === 'boom') throw new AdapterError('device said no', 'device'); return report(r.id); },
};

async function withServer(ctx: Partial<AdapterRoutesContext>, run: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerAdapterRoutes(app, { adapters: createAdapterRegistry([fake]), requireAdmin: async () => true, allowPrivate: false, ...ctx });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    });
  } finally { server.close(); }
}

test('camera reference: validated, trimmed, and incomplete ones refused', () => {
  const r = parseCameraRef({ id: 'c-1', url: ' http://cams.example.org/x ', port: '554', credentials: { user: 'u', pass: 'p' }, junk: 1 });
  assert.deepEqual(r, { id: 'c-1', url: 'http://cams.example.org/x', port: 554, credentials: { user: 'u', pass: 'p' }, name: undefined, adapter: undefined, host: undefined, site: undefined });
  for (const bad of [null, {}, { id: '../x', url: 'http://a' }, { id: 'a' }, { id: 'a', host: 'h', port: 70000 }, { id: 'a', host: 'h', site: 'a b' }]) {
    assert.throws(() => parseCameraRef(bad), AdapterError);
  }
});

test('routes: list, discover, endpoints (login removed), probe (saved)', async () => {
  const saved: ProbeReport[] = [];
  await withServer({ save: async (r) => { saved.push(r); } }, async (call) => {
    const list = await call('GET', '/api/adapters');
    assert.equal(list.json.adapters[0].kind, 'fake');
    assert.equal(list.json.adapters[0].canDiscover, true);
    const d = await call('POST', '/api/adapters/discover', { adapter: 'fake' });
    assert.equal(d.json.devices[0].address, '1.2.3.4');
    assert.equal((await call('POST', '/api/adapters/discover', { adapter: 'nope' })).status, 404);
    const e = await call('POST', '/api/adapters/endpoints', { camera: { id: 'c1', url: 'http://cams.example.org/a', credentials: { user: 'u', pass: 'secret' } } });
    assert.equal(e.json.endpoints[0].url, 'rtsp://***@cams.example.org/s');
    assert.ok(!JSON.stringify(e.json).includes('secret'));
    const p = await call('POST', '/api/adapters/probe', { camera: { id: 'c1', url: 'http://cams.example.org/a' } });
    assert.equal(p.json.saved, true);
    assert.equal(saved[0].cameraId, 'c1');
    assert.equal((await call('POST', '/api/adapters/device', { camera: { id: 'c1', url: 'http://cams.example.org/a' } })).status, 501);
  });
});

test('routes: private addresses refused by default, allowed by setting; adapter errors become clear statuses', async () => {
  const cam = { id: 'c1', adapter: 'fake', url: 'http://192.168.1.20/x' };
  await withServer({}, async (call) => {
    const r = await call('POST', '/api/adapters/probe', { camera: cam });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /private network/);
    assert.equal((await call('POST', '/api/adapters/probe', { camera: { id: 'c1', url: 'http://cams.example.org' } })).status, 200);
    assert.equal((await call('POST', '/api/adapters/probe', { camera: { id: 'boom', url: 'http://cams.example.org' } })).status, 502);
    assert.equal((await call('POST', '/api/adapters/probe', { camera: { id: 'c1', url: 'http://nobody.example.org' } })).status, 404);
    assert.equal((await call('POST', '/api/adapters/probe', { camera: { id: '..' } })).status, 400);
  });
  await withServer({ allowPrivate: true }, async (call) => {
    assert.equal((await call('POST', '/api/adapters/probe', { camera: cam })).status, 200);
  });
});

test('routes: a caller who is not an admin gets nothing, and a failed save does not lose the report', async () => {
  await withServer({ requireAdmin: async (_q, res) => { res.status(403).json({ error: 'no' }); return false; } }, async (call) => {
    assert.equal((await call('GET', '/api/adapters')).status, 403);
    assert.equal((await call('POST', '/api/adapters/probe', { camera: { id: 'c1', url: 'http://cams.example.org' } })).status, 403);
  });
  await withServer({ save: async () => { throw new Error('db down'); } }, async (call) => {
    const r = await call('POST', '/api/adapters/probe', { camera: { id: 'c1', url: 'http://cams.example.org' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.saved, false);
    assert.equal(r.json.report.cameraId, 'c1');
  });
});

test('routes: a recorder lists its channels as ready-to-register cameras without echoing the login; a non-recorder adapter answers 501', async () => {
  const recorder: SourceAdapter = {
    ...fake, kind: 'rec', accepts: (r) => r.adapter === 'rec',
    channels: async () => [{ channel: 1, name: 'Gate', online: true, address: '10.0.0.5' }, { channel: 2, name: null, online: null, address: null }],
  };
  await withServer({ adapters: createAdapterRegistry([fake, recorder]), allowPrivate: true }, async (call) => {
    const r = await call('POST', '/api/adapters/channels', { camera: { id: 'nvr', adapter: 'rec', host: '10.0.0.9', credentials: { user: 'a', pass: 'SECRET' }, options: { rtspPort: 8554 } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.channels.length, 2);
    assert.deepEqual(r.json.channels[0].camera, { id: 'nvr-ch1', name: 'Gate', adapter: 'rec', host: '10.0.0.9', options: { rtspPort: 8554, channel: 1 } });
    assert.ok(!JSON.stringify(r.json).includes('SECRET'));
    assert.equal(r.json.channels[1].camera.name, undefined);
    assert.equal((await call('POST', '/api/adapters/channels', { camera: { id: 'c', adapter: 'fake', host: '10.0.0.9' } })).status, 501);
    assert.equal((await call('GET', '/api/adapters')).json.adapters.find((a: any) => a.kind === 'rec').canListChannels, true);
  });
});
