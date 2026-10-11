/** Health probes and metrics for an orchestrator (server/security/ops.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerOps, renderMetrics } from '../server/security/ops.ts';

async function withApp(o: Parameters<typeof registerOps>[1], run: (get: (p: string, h?: Record<string, string>) => Promise<{ status: number; text: string; type: string }>) => Promise<void>) {
  const app = express();
  registerOps(app, o);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run(async (p, h) => { const r = await fetch(base + p, { headers: h }); return { status: r.status, text: await r.text(), type: r.headers.get('content-type') ?? '' }; }); } finally { server.close(); }
}

test('liveness always answers; readiness follows the server\'s own flag', async () => {
  let ready = false;
  await withApp({ ready: () => ready }, async (get) => {
    assert.deepEqual([(await get('/healthz')).status, (await get('/readyz')).status], [200, 503]);
    ready = true;
    const r = await get('/readyz');
    assert.deepEqual([r.status, JSON.parse(r.text).status], [200, 'ready']);
    ready = false;
    assert.equal((await get('/readyz')).status, 503, 'not ready again while shutting down');
    assert.equal((await get('/healthz')).status, 200, 'but still alive');
    assert.equal((await get('/metrics')).status, 404, 'metrics are off unless asked for');
  });
});

test('metrics: Prometheus text with the built-in gauges and the supplied ones; a token is required when set; bad names and non-numbers are left out', async () => {
  await withApp({
    ready: () => true, metrics: { enabled: true, token: 's3cret' },
    gauges: { omnisee_queue: { help: 'Jobs waiting.', value: () => 7 }, omnisee_by_state: { help: 'Cameras by state.', value: () => ({ ok: 40, 'bad "one"': 2 }) }, 'Bad Name': { help: 'x', value: () => 1 }, omnisee_nan: { help: 'x', value: () => NaN }, omnisee_throws: { help: 'x', value: () => { throw new Error('boom'); } } },
  }, async (get) => {
    assert.equal((await get('/metrics')).status, 401);
    assert.equal((await get('/metrics', { Authorization: 'Bearer wrong' })).status, 401);
    const r = await get('/metrics', { Authorization: 'Bearer s3cret' });
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/plain.*version=0\.0\.4/);
    assert.match(r.text, /# TYPE omnisee_uptime_seconds gauge/);
    assert.match(r.text, /^omnisee_ready 1$/m);
    assert.match(r.text, /^omnisee_queue 7$/m);
    assert.match(r.text, /^omnisee_by_state\{label="ok"\} 40$/m);
    assert.match(r.text, /omnisee_by_state\{label="bad \\"one\\""\} 2/, 'label values are escaped');
    assert.equal(/Bad Name|omnisee_nan|omnisee_throws/.test(r.text), false);
  });
  await withApp({ ready: () => true, metrics: { enabled: true } }, async (get) => { assert.equal((await get('/metrics')).status, 200, 'no token set: open (for a closed network; restrict it with a network policy)'); });
  assert.equal(renderMetrics({}).trim(), '');
});
