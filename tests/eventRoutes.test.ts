import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registerEventRoutes } from '../server/events/routes.ts';
import { createAlertEngine } from '../server/events/alertEngine.ts';
import { createChannelRegistry, createLogChannel, createWebhookChannel, type Channel } from '../server/events/channels.ts';
import { createMemoryAlertStore } from '../server/events/store.ts';
import { makeEvent } from '../server/events/schema.ts';
import { REDACTED } from '../server/events/rules.ts';

const T0 = new Date('2026-10-10T10:00:00.000Z');
const cam = (userId: string, id = 'cam01') => ({ id, name: `Cam ${id}`, userId });
const mkEvent = (userId: string, type: string, o: { plate?: string; ms?: number; severity?: 'info' | 'notice' | 'warning' | 'critical'; camId?: string } = {}) =>
  makeEvent({ type, summary: `${type} ${o.plate ?? ''}`, severity: o.severity, data: o.plate ? { plate: o.plate } : {}, dedupeKey: o.plate }, { source: 't', camera: cam(userId, o.camId), ts: new Date(T0.getTime() + (o.ms ?? 0)) });

async function withApp(run: (call: (user: string | null, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>, h: { store: ReturnType<typeof createMemoryAlertStore>; engine: ReturnType<typeof createAlertEngine>; sent: unknown[] }) => Promise<void>, o: { maxRules?: number; webhook?: Channel } = {}) {
  const store = createMemoryAlertStore();
  const sent: unknown[] = [];
  const hook: Channel = o.webhook ?? { type: 'webhook', check: createWebhookChannel().check as never, deliver: async (cfg, ctx) => { sent.push({ cfg, event: ctx.event.type }); return { attempts: 1 }; } } as never;
  const channels = createChannelRegistry([hook as never, createLogChannel({ warn: () => {} }) as never]);
  const engine = createAlertEngine({ store, channels, now: () => T0, log: { warn: () => {}, info: () => {} }, ruleCacheMs: 0 });
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, {
    store, engine, channels, now: () => T0, maxRules: o.maxRules,
    requireUser: async (req, res) => { const u = req.header('x-user'); if (!u) { res.status(401).json({ error: 'Sign-in required.' }); return null; } return u; },
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (user, method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* an HTML error page from express */ }
      return { status: r.status, json };
    }, { store, engine, sent });
  } finally { server.close(); }
}

const RULE = { name: 'Watchlist plates', match: { types: ['plate.*'], minSeverity: 'critical' }, channels: [{ type: 'webhook', url: 'https://hooks.example.org/x', secret: 'topsecret' }], throttle: { windowMs: 60_000, by: ['event'] } };

test('routes: every route needs a signed-in user', async () => {
  await withApp(async (call) => {
    for (const [m, p] of [['GET', '/api/events'], ['GET', '/api/alert-rules'], ['POST', '/api/alert-rules'], ['PUT', '/api/alert-rules/x'], ['DELETE', '/api/alert-rules/x'], ['POST', '/api/alert-rules/x/test'], ['GET', '/api/alerts'], ['POST', '/api/alerts/x/acknowledge'], ['POST', '/api/alerts/x/resolve']] as const) {
      assert.equal((await call(null, m, p, {})).status, 401, `${m} ${p}`);
    }
    assert.equal((await call(null, 'GET', '/api/event-types')).status, 200, 'the catalogue is public');
  });
});

test('routes: rules - create, list (secret hidden), edit keeping the secret, delete', async () => {
  await withApp(async (call, h) => {
    const created = await call('u1', 'POST', '/api/alert-rules', RULE);
    assert.equal(created.status, 201);
    const id = created.json.rule.id as string;
    assert.equal(created.json.rule.channels[0].secret, REDACTED);
    assert.equal(JSON.stringify(created.json).includes('topsecret'), false);
    assert.equal((await h.store.getRule('u1', id))!.channels[0].type === 'webhook' && (await h.store.getRule('u1', id) as any).channels[0].secret, 'topsecret', 'stored for real');

    const list = await call('u1', 'GET', '/api/alert-rules');
    assert.equal(list.json.rules.length, 1);
    assert.equal(JSON.stringify(list.json).includes('topsecret'), false);

    const edited = await call('u1', 'PUT', `/api/alert-rules/${id}`, { ...RULE, name: 'Renamed', channels: [{ type: 'webhook', url: 'https://hooks.example.org/x', secret: REDACTED }] });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.rule.name, 'Renamed');
    assert.equal(((await h.store.getRule('u1', id)) as any).channels[0].secret, 'topsecret', 'the placeholder did not overwrite the secret');
    assert.equal(edited.json.rule.createdAt, created.json.rule.createdAt);

    assert.equal((await call('u1', 'DELETE', `/api/alert-rules/${id}`)).status, 200);
    assert.equal((await call('u1', 'DELETE', `/api/alert-rules/${id}`)).status, 404);
    assert.equal((await call('u1', 'GET', '/api/alert-rules')).json.rules.length, 0);
  });
});

test('routes: rules - bad input is explained, private webhook addresses are refused, the limit holds', async () => {
  await withApp(async (call) => {
    const bad = await call('u1', 'POST', '/api/alert-rules', { name: '', match: { types: ['Nope'] }, channels: [] });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.problems.length >= 3);
    assert.equal(bad.json.error, bad.json.problems[0]);
    const priv = await call('u1', 'POST', '/api/alert-rules', { ...RULE, channels: [{ type: 'webhook', url: 'http://192.168.0.9/hook' }] });
    assert.equal(priv.status, 400);
    assert.match(priv.json.error, /private network/);
    assert.equal((await call('u1', 'POST', '/api/alert-rules', { ...RULE, channels: [{ type: 'webhook', url: 'ftp://x' }] })).status, 400);
    assert.equal((await call('u1', 'PUT', '/api/alert-rules/nope', RULE)).status, 404);
    assert.equal((await call('u1', 'PUT', '/api/alert-rules/..%2F..', RULE)).status, 404);
    assert.equal((await call('u1', 'POST', '/api/alert-rules', 'not an object' as never)).status, 400);
  });
  await withApp(async (call) => {
    assert.equal((await call('u1', 'POST', '/api/alert-rules', RULE)).status, 201);
    assert.equal((await call('u1', 'POST', '/api/alert-rules', RULE)).status, 201);
    const over = await call('u1', 'POST', '/api/alert-rules', RULE);
    assert.equal(over.status, 409);
    assert.equal((await call('u2', 'POST', '/api/alert-rules', RULE)).status, 201, 'the limit is per user');
  }, { maxRules: 2 });
});

test('routes: users cannot see or change each other\'s rules, events or alerts', async () => {
  await withApp(async (call, h) => {
    const id = (await call('u1', 'POST', '/api/alert-rules', { ...RULE, throttle: { windowMs: 0, by: ['rule'] }, match: {} })).json.rule.id as string;
    await h.engine.ingest([mkEvent('u1', 'plate.read', { plate: 'AAA111' })]);
    const alertId = (await call('u1', 'GET', '/api/alerts')).json.alerts[0].id as string;

    assert.equal((await call('u2', 'GET', '/api/alert-rules')).json.rules.length, 0);
    assert.equal((await call('u2', 'PUT', `/api/alert-rules/${id}`, RULE)).status, 404);
    assert.equal((await call('u2', 'DELETE', `/api/alert-rules/${id}`)).status, 404);
    assert.equal((await call('u2', 'POST', `/api/alert-rules/${id}/test`)).status, 404);
    assert.equal((await call('u2', 'GET', '/api/events')).json.events.length, 0);
    assert.equal((await call('u2', 'GET', '/api/alerts')).json.alerts.length, 0);
    assert.equal((await call('u2', 'POST', `/api/alerts/${alertId}/acknowledge`)).status, 404);
    assert.equal((await call('u2', 'POST', `/api/alerts/${alertId}/resolve`)).status, 404);
    assert.equal((await call('u1', 'GET', '/api/alert-rules')).json.rules.length, 1, 'u1 still has the rule');
  });
});

test('routes: events - filters', async () => {
  await withApp(async (call, h) => {
    await h.engine.ingest([
      mkEvent('u1', 'plate.read', { plate: 'A', ms: 0 }), mkEvent('u1', 'plate.watchlist_match', { plate: 'A', ms: 1000 }), mkEvent('u1', 'scene.unusual', { ms: 2000, camId: 'cam02' }),
      mkEvent('u1', 'person.unknown', { ms: 3000, severity: 'critical' }),
    ]);
    const q = async (qs: string) => ((await call('u1', 'GET', `/api/events${qs}`)).json.events as Array<{ type: string }>).map((e) => e.type);
    assert.deepEqual(await q(''), ['person.unknown', 'scene.unusual', 'plate.watchlist_match', 'plate.read']);
    assert.deepEqual(await q('?type=plate.*'), ['plate.watchlist_match', 'plate.read']);
    assert.deepEqual(await q('?type=scene.unusual&type=person.unknown'), ['person.unknown', 'scene.unusual']);
    assert.deepEqual(await q('?minSeverity=critical'), ['person.unknown', 'plate.watchlist_match']);
    assert.deepEqual(await q('?cameraId=cam02'), ['scene.unusual']);
    assert.deepEqual(await q('?limit=2'), ['person.unknown', 'scene.unusual']);
    assert.deepEqual(await q(`?before=${new Date(T0.getTime() + 2000).toISOString()}`), ['plate.watchlist_match', 'plate.read']);
    assert.deepEqual(await q(`?from=${new Date(T0.getTime() + 1000).toISOString()}&to=${new Date(T0.getTime() + 3000).toISOString()}`), ['scene.unusual', 'plate.watchlist_match']);
    assert.deepEqual(await q('?minSeverity=bogus&from=notadate'), ['person.unknown', 'scene.unusual', 'plate.watchlist_match', 'plate.read'], 'unusable filters are ignored, not an error');
    assert.deepEqual(await q('?type=BAD;DROP'), ['person.unknown', 'scene.unusual', 'plate.watchlist_match', 'plate.read']);
    assert.ok((await call(null, 'GET', '/api/event-types')).json.types.some((t: { type: string }) => t.type === 'plate.watchlist_match'));
  });
});

test('routes: an event raises an alert that can be listed, acknowledged and resolved', async () => {
  await withApp(async (call, h) => {
    await call('u1', 'POST', '/api/alert-rules', { ...RULE, match: { types: ['plate.watchlist_match'] } });
    await h.engine.ingest([mkEvent('u1', 'plate.read', { plate: 'A' }), mkEvent('u1', 'plate.watchlist_match', { plate: 'A', ms: 100, severity: 'critical' })]);
    assert.deepEqual(h.sent, [{ cfg: { type: 'webhook', url: 'https://hooks.example.org/x', secret: 'topsecret' }, event: 'plate.watchlist_match' }]);
    const open = (await call('u1', 'GET', '/api/alerts?state=open')).json.alerts;
    assert.equal(open.length, 1);
    assert.equal(open[0].severity, 'critical');
    assert.equal((await call('u1', 'GET', '/api/alerts?state=resolved')).json.alerts.length, 0);
    const id = open[0].id as string;
    assert.equal((await call('u1', 'POST', `/api/alerts/${id}/acknowledge`)).json.alert.state, 'acknowledged');
    assert.equal((await call('u1', 'GET', '/api/alerts?state=open')).json.alerts.length, 0);
    assert.equal((await call('u1', 'GET', '/api/alerts?state=acknowledged')).json.alerts.length, 1);
    assert.equal((await call('u1', 'POST', `/api/alerts/${id}/resolve`)).json.alert.state, 'resolved');
    const again = await call('u1', 'POST', `/api/alerts/${id}/acknowledge`);
    assert.equal(again.status, 409);
    assert.equal((await call('u1', 'POST', '/api/alerts/does-not-exist/resolve')).status, 404);
    assert.equal((await call('u1', 'POST', '/api/alerts/..%2Fx/resolve')).status, 404);
    assert.equal((await call('u1', 'GET', '/api/alerts?state=bogus')).json.alerts.length, 1, 'an unknown state filter is ignored');
  });
});

test('routes: a rule can be tested without creating an alert, and a receiver that fails is reported', async () => {
  await withApp(async (call, h) => {
    const id = (await call('u1', 'POST', '/api/alert-rules', RULE)).json.rule.id as string;
    const t = await call('u1', 'POST', `/api/alert-rules/${id}/test`);
    assert.equal(t.status, 200);
    assert.deepEqual(t.json.deliveries.map((d: { ok: boolean }) => d.ok), [true]);
    assert.equal((h.sent[0] as { event: string }).event, 'system.test');
    assert.equal((await call('u1', 'GET', '/api/alerts')).json.alerts.length, 0);
    assert.equal((await call('u1', 'GET', '/api/events')).json.events.length, 0);
  });
  await withApp(async (call) => {
    const id = (await call('u1', 'POST', '/api/alert-rules', RULE)).json.rule.id as string;
    const t = await call('u1', 'POST', `/api/alert-rules/${id}/test`);
    assert.equal(t.status, 200);
    assert.equal(t.json.deliveries[0].ok, false);
    assert.match(t.json.deliveries[0].error, /receiver is down/);
  }, { webhook: { type: 'webhook', check: () => null, deliver: async () => { throw new Error('receiver is down'); } } as never });
});
