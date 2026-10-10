/**
 * A regional gateway (docs/regional-gateway.md). Run it next to a group of cameras, far from the centre:
 *
 *   CENTRAL_URL=https://omnisee.example.org GATEWAY_ID=gw-1a2b3c4d GATEWAY_SECRET=... GEMINI_API_KEY=... npm run gateway
 *
 * It pulls its cameras' frames over the local network, analyses them with the same analyzers as the centre, and sends only the results
 * (logs, plate sightings, events) to the centre. If the link drops it keeps going and sends everything when the link returns.
 * It needs no Firebase credentials: the centre hands it its camera list and the user data it needs.
 *
 *   required   CENTRAL_URL  GATEWAY_ID  GATEWAY_SECRET  GEMINI_API_KEY
 *   optional   GATEWAY_DATA_DIR (./gateway-data)   GATEWAY_REGION   GATEWAY_MEDIA_URL (where this region's media server is reachable)
 *              GATEWAY_OUTBOX_MAX_MB (200)   GATEWAY_OUTBOX_MAX_DAYS (7)   GATEWAY_STATUS_PORT (off; local status page on 127.0.0.1)
 *              ANALYSIS_CONCURRENCY (4)   ANALYSIS_GATE=off   ANALYZERS_OFF=camera-tamper,anpr-plates   ANPR_SERVICE_URL / ANPR_API_KEY
 *              STREAM_EMAIL / STREAM_PASSWORD / GATEWAY_GRID_RTSP_HOST  (only for cameras on the camera grid)
 */
import http from 'node:http';
import path from 'node:path';
import { createAnprClient } from './server/anprClient';
import { createDefaultPipeline } from './server/analytics';
import { createMotionGate } from './server/frameGate';
import { generateContentWithFallback, VISION_MODELS } from './server/gemini';
import { aiConfigured, aiKeyVar } from './server/llm';
import { grabFrame } from './server/frameSource';
import { createAgent } from './server/gateway/agent';
import { openOutbox } from './server/gateway/outbox';
import { createGatewayRuntime } from './server/gateway/runtime';

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is required (see the header of gateway.ts).`); process.exit(1); } return v; };
const centralUrl = need('CENTRAL_URL'), gatewayId = need('GATEWAY_ID'), secret = need('GATEWAY_SECRET');
if (!aiConfigured()) { console.error(`${aiKeyVar()} is required for AI_PROVIDER=${process.env.AI_PROVIDER || 'gemini'}.`); process.exit(1); }

const dataDir = path.resolve(process.env.GATEWAY_DATA_DIR || './gateway-data');
const concurrency = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY) || 4);
const creds = { email: process.env.STREAM_EMAIL || '', password: process.env.STREAM_PASSWORD || '' };

const outbox = openOutbox({ dir: path.join(dataDir, 'outbox'), maxBytes: (Number(process.env.GATEWAY_OUTBOX_MAX_MB) || 200) * 1e6, maxAgeMs: (Number(process.env.GATEWAY_OUTBOX_MAX_DAYS) || 7) * 86_400_000 });

const anpr = process.env.ANPR_SERVICE_URL
  ? createAnprClient({ url: process.env.ANPR_SERVICE_URL, apiKey: process.env.ANPR_API_KEY, timeoutMs: Number(process.env.ANPR_TIMEOUT_MS) || 8_000, minConfidence: process.env.ANPR_MIN_CONFIDENCE ? Number(process.env.ANPR_MIN_CONFIDENCE) : 0.6 })
  : null;
const pipeline = createDefaultPipeline({
  generate: (params) => generateContentWithFallback(VISION_MODELS, params as never),
  anpr, off: (process.env.ANALYZERS_OFF || '').split(',').map((x) => x.trim()).filter(Boolean),
});

let runtime: ReturnType<typeof createGatewayRuntime>;
const agent = createAgent({
  centralUrl, gatewayId, secret, outbox, version: process.env.npm_package_version || 'dev', region: process.env.GATEWAY_REGION, mediaUrl: process.env.GATEWAY_MEDIA_URL, concurrency,
  cameraCounts: () => runtime?.cameraCounts() ?? { assigned: 0, failing: 0 }, log: console,
});

runtime = createGatewayRuntime({
  agent, outbox, pipeline, log: console, workerOptions: { concurrency },
  gate: process.env.ANALYSIS_GATE === 'off' ? undefined : createMotionGate(),
  grabFrame: (camera) => grabFrame({ url: camera.remoteStreamUrl, localBaseUrl: '', creds, gridRtspHost: process.env.GATEWAY_GRID_RTSP_HOST || '' }),
  sendWebhook: async (url, payload) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
  },
});
agent.start();
runtime.start();
console.log(`[GATEWAY] ${gatewayId} started: centre ${centralUrl}, data ${dataDir}, concurrency ${concurrency}.`);

const statusPort = Number(process.env.GATEWAY_STATUS_PORT) || 0;
if (statusPort) {
  http.createServer((req, res) => {
    if (req.url !== '/status') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ gatewayId, link: agent.status(), outbox: outbox.stats(), cameras: runtime.cameraCounts(), worker: runtime.worker.status() }));
  }).listen(statusPort, '127.0.0.1', () => console.log(`[GATEWAY] status on http://127.0.0.1:${statusPort}/status`));
}

async function shutdown() {
  console.log('[GATEWAY] stopping...');
  runtime.stop();
  try { await Promise.race([agent.flushOnce(), new Promise((r) => setTimeout(r, 3000))]); } catch { /* whatever is left stays in the outbox for the next start */ }
  agent.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
