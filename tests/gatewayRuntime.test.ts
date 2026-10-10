/**
 * The whole regional path with the real pieces: a gateway running the real analysis worker and analyzer pipeline (Gemini and the camera are
 * faked), the outbox on disk, the agent over real HTTP, the centre, the alert engine and a webhook. The link between them is cut part-way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createDefaultPipeline } from '../server/analytics/index.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, createWebhookChannel } from '../server/events/channels.ts';
import { validateRule } from '../server/events/rules.ts';
import { makeEvent } from '../server/events/schema.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { createAgent } from '../server/gateway/agent.ts';
import { createGatewayCentral, createMemoryGatewayDocs } from '../server/gateway/central.ts';
import { openOutbox } from '../server/gateway/outbox.ts';
import { captureRawBody, registerGatewayRoutes } from '../server/gateway/routes.ts';
import { createGatewayRuntime } from '../server/gateway/runtime.ts';

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const until = async (cond: () => boolean, ms = 8000, what = 'condition') => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

test('gateway end to end: analysis at the edge, results to the centre, alerts there - and a cut link loses nothing', async () => {
  // ---- the centre
  const logs: any[] = [];
  const store = createMemoryAlertStore();
  const hooks: Array<{ type: string; camera: string; rule: string }> = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => { const b = JSON.parse(String(init.body)); hooks.push({ type: b.event.type, camera: b.event.cameraId, rule: b.rule.name }); return new Response('', { status: 200 }); }) as never;
  const engine = createAlertEngine({ store, channels: createChannelRegistry([createWebhookChannel({ fetchImpl: fakeFetch }) as never]), log: quiet, ruleCacheMs: 0 });
  const camera = { id: 'cam-edge-1', userId: 'u1', name: 'Border post', remoteStreamUrl: 'rtsp://10.20.0.5/stream1', interval: 5, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, suspiciousRules: '', webhookUrl: '', department: 'Border' };
  const transitions: string[] = [];
  const central = createGatewayCentral({
    docs: createMemoryGatewayDocs(), cameras: async () => [camera], userContext: async () => ({ knownFaces: [], watchlist: [] }), log: quiet,
    offlineAfterMs: 400, assignmentCacheMs: 0,
    sinks: { writeLog: async (d) => { logs.push(d); }, writeSightings: async () => {}, emitEvents: async (e) => { await engine.ingest(e); }, updateCamera: async () => {} },
    onTransition: (g, from) => {
      const type = g.state === 'offline' ? 'gateway.offline' : g.state === 'online' && from !== 'never_seen' ? 'gateway.online' : null;
      if (!type) return;
      transitions.push(type);
      void engine.ingest([makeEvent({ type, summary: `Gateway ${g.name} ${type}`, dedupeKey: `${g.id}${type}${transitions.length}` }, { source: 'gateway-monitor', camera: { id: g.id, name: g.name, userId: g.ownerId }, ts: new Date() })]);
    },
  });
  const { gateway, secret } = await central.provision({ name: 'Border region', region: 'north', ownerId: 'u1' });
  await store.saveRule(validateRule({ name: 'unknown person', match: { types: ['person.unknown'] }, throttle: { windowMs: 0, by: ['camera'] }, channels: [{ type: 'webhook', url: 'https://hooks.example.org/a' }] }, { userId: 'u1', id: 'r-person', now: new Date() }));
  await store.saveRule(validateRule({ name: 'gateway health', match: { types: ['gateway.*'] }, throttle: { windowMs: 0, by: ['type'] }, channels: [{ type: 'webhook', url: 'https://hooks.example.org/b' }] }, { userId: 'u1', id: 'r-gw', now: new Date() }));

  const app = express();
  app.use(express.json({ limit: '25mb', verify: captureRawBody }));
  registerGatewayRoutes(app, { central, requireAdmin: async () => 'u1' });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sweeper = setInterval(() => central.sweep(), 50);

  // ---- the link
  const link = { cut: false };
  const linkFetch: typeof fetch = async (url, init) => { if (link.cut) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }); return fetch(url, init); };

  // ---- the gateway: real worker and pipeline, faked camera and model; time runs 50x so a 5 s camera interval passes in 100 ms
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-rt-'));
  const outbox = openOutbox({ dir });
  const agent = createAgent({ centralUrl: base, gatewayId: gateway.id, secret, outbox, fetchImpl: linkFetch, log: quiet, heartbeatEveryMs: 40, assignmentEveryMs: 100, flushEveryMs: 15, minBackoffMs: 15, maxBackoffMs: 100, cameraCounts: () => runtime.cameraCounts() });
  const t0 = Date.now();
  const generate = async () => ({ text: JSON.stringify({ summary: 'Two people at the barrier', counts: { people: 2, vehicles: 0, other: 0 }, people_identified: ['Unknown Person'], alerts: [], isUnusual: false, detected_plates: [], sentiment: 'neutral' }) });
  const runtime = createGatewayRuntime({
    agent, outbox, pipeline: createDefaultPipeline({ generate, anpr: null, off: ['camera-tamper'], log: quiet }), log: quiet,
    grabFrame: async () => Buffer.alloc(600, 1), sendWebhook: async () => {}, now: () => t0 + (Date.now() - t0) * 50, workerOptions: { tickMs: 20, concurrency: 2 },
  });
  agent.start();
  runtime.start();

  try {
    // 1. normal running: the camera list arrives, analysis runs at the edge, results and the alert reach the centre
    await until(() => agent.cameras().length === 1, 5000, 'camera assignment');
    await until(() => logs.length >= 3 && hooks.filter((h) => h.rule === 'unknown person').length >= 3, 8000, 'first results');
    assert.ok(logs[0].timestamp instanceof Date, 'logs arrive with real dates');
    assert.equal(logs[0].cameraId, 'cam-edge-1');
    assert.equal(logs[0].analyzedBy, 'server');
    assert.equal(hooks[0].camera, 'cam-edge-1');
    assert.equal((await central.list())[0].state, 'online');

    // 2. the link is cut: the gateway keeps analysing, the centre notices it is gone
    link.cut = true;
    const logsAtCut = logs.length;
    await until(() => transitions.includes('gateway.offline'), 5000, 'centre notices the silence');
    await until(() => outbox.stats().pending >= 12, 8000, 'results piling up while cut off (about three items per analysis)');
    await until(() => hooks.some((h) => h.type === 'gateway.offline'), 3000, 'offline alert');
    assert.equal(logs.length, logsAtCut, 'nothing reached the centre while cut off');
    assert.equal(agent.status().link, 'offline');

    // 3. the link returns: everything that piled up arrives, once, and the gateway is online again
    link.cut = false;
    await until(() => outbox.stats().pending === 0, 8000, 'backlog drained');
    await until(() => transitions.includes('gateway.online'), 5000, 'back online');
    await until(() => hooks.some((h) => h.type === 'gateway.online'), 3000, 'back-online alert');
    const stamps = logs.map((l) => l.timestamp.getTime());
    assert.equal(new Set(stamps).size, stamps.length, 'no analysis was recorded twice');
    assert.ok(logs.length - logsAtCut >= 3, `${logs.length - logsAtCut} results arrived after the outage`);
    assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), 'in the order they were made');
    // each analysed frame raised its own alert (throttle window 0): none lost or doubled by the outage
    await until(() => hooks.filter((h) => h.type === 'person.unknown').length === logs.length, 5000, 'one alert per analysed frame');
    assert.equal((await central.list())[0].state, 'online');
  } finally {
    runtime.stop(); agent.stop(); clearInterval(sweeper);
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  }
});
