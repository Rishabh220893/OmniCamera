/**
 * HTTP side of the regional gateways.
 *
 * Administrators (Firebase ID token with role admin):
 *   GET    /api/gateways                      every gateway with its state and problems
 *   POST   /api/gateways                      { name, region } -> { gateway, secret }   (the secret is shown once)
 *   POST   /api/gateways/:id/rotate-secret    -> { secret }
 *   POST   /api/gateways/:id/disable | /enable
 *   DELETE /api/gateways/:id
 *
 * Gateways (signed requests, see protocol.ts):
 *   POST /api/gateway/heartbeat
 *   POST /api/gateway/ingest            { batchId, items: OutboxItem[] } -> { accepted, rejected }
 *   GET  /api/gateway/cameras           the cameras assigned to it (ETag / If-None-Match)
 *   GET  /api/gateway/user-context?userId=
 *
 * The signature covers the raw request body, so the app's JSON parser must keep it: pass `captureRawBody` as its `verify` option.
 */
import type { Express, Request, RequestHandler, Response } from 'express';
import { GatewayError, type GatewayCentral } from './central';
import { createNonceCache, verifyRequest, type HeartbeatRequest, type IngestRequest, type NonceCache } from './protocol';

/** `express.json({ verify: captureRawBody })` keeps the exact bytes of gateway requests so their signature can be checked. */
export function captureRawBody(req: { originalUrl?: string; url?: string }, _res: unknown, buf: Buffer): void {
  if ((req.originalUrl ?? req.url ?? '').startsWith('/api/gateway/')) (req as { rawBody?: Buffer }).rawBody = buf;
}

export interface GatewayRoutesContext {
  central: GatewayCentral;
  /** Answers false (and has already replied) when the caller is not an administrator. Returns the admin's user id otherwise. */
  requireAdmin(req: Request, res: Response): Promise<string | null>;
  nonces?: NonceCache;
  now?: () => number;
  maxBatchItems?: number;
}

const ID_RE = /^gw-[0-9a-f]{8}$/;

export function registerGatewayRoutes(app: Express, ctx: GatewayRoutesContext): void {
  const nonces = ctx.nonces ?? createNonceCache();
  const maxItems = ctx.maxBatchItems ?? 500;

  const fail = (res: Response, e: unknown) => {
    if (e instanceof GatewayError) { res.status(e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400).json({ error: e.message }); return; }
    console.error('[GATEWAY]', e);
    res.status(500).json({ error: 'The request failed.' });
  };

  // ---- administrators
  app.get('/api/gateways', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    try { res.json({ gateways: await ctx.central.list() }); } catch (e) { fail(res, e); }
  });

  app.post('/api/gateways', async (req, res) => {
    const admin = await ctx.requireAdmin(req, res);
    if (!admin) return;
    try {
      const b = (req.body ?? {}) as { name?: unknown; region?: unknown };
      res.status(201).json(await ctx.central.provision({ name: String(b.name ?? ''), region: String(b.region ?? ''), ownerId: admin }));
    } catch (e) { fail(res, e); }
  });

  for (const [action, run] of [
    ['rotate-secret', async (id: string) => ({ secret: await ctx.central.rotateSecret(id) })],
    ['disable', async (id: string) => { await ctx.central.setDisabled(id, true); return { status: 'ok' }; }],
    ['enable', async (id: string) => { await ctx.central.setDisabled(id, false); return { status: 'ok' }; }],
  ] as const) {
    app.post(`/api/gateways/:id/${action}`, async (req, res) => {
      if (!(await ctx.requireAdmin(req, res))) return;
      try { if (!ID_RE.test(req.params.id)) throw new GatewayError('No such gateway.', 'not_found'); res.json(await run(req.params.id)); } catch (e) { fail(res, e); }
    });
  }

  app.delete('/api/gateways/:id', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    try { if (!ID_RE.test(req.params.id)) throw new GatewayError('No such gateway.', 'not_found'); await ctx.central.remove(req.params.id); res.json({ status: 'ok' }); } catch (e) { fail(res, e); }
  });

  // ---- gateways
  /** Verifies the signature; replies 401 and returns null when it does not hold. */
  async function gateway(req: Request, res: Response): Promise<string | null> {
    try { await ctx.central.refresh(); } catch (e) { fail(res, e); return null; }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const v = verifyRequest({ headers: req.headers, method: req.method, path: req.originalUrl, body: raw, lookup: (id) => ctx.central.lookup(id), nonces, now: ctx.now?.() });
    if (v.ok === true) return v.gatewayId;
    const failure = v as Extract<typeof v, { ok: false }>;
    // 'unknown_gateway' and 'bad_signature' look the same from outside, so the API does not reveal which gateway ids exist.
    const reason = failure.reason === 'unknown_gateway' ? 'bad_signature' : failure.reason;
    res.status(401).json({ error: `Request refused: ${reason}.`, reason, ...(failure.reason === 'clock' ? { serverTime: failure.serverTime } : {}) });
    return null;
  }

  const guarded = (handler: (id: string, req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res) => {
    const id = await gateway(req, res);
    if (!id) return;
    try { await handler(id, req, res); } catch (e) { fail(res, e); }
  };

  app.post('/api/gateway/heartbeat', guarded(async (id, req, res) => {
    const b = req.body as Partial<HeartbeatRequest> | undefined;
    if (!b || typeof b.version !== 'string' || !b.cameras || !b.outbox || !['online', 'degraded', 'offline'].includes(String(b.link))) { res.status(400).json({ error: 'Malformed heartbeat.' }); return; }
    const hb: HeartbeatRequest = {
      version: b.version.slice(0, 40), region: typeof b.region === 'string' ? b.region.slice(0, 60) : undefined, sentAt: Number(b.sentAt) || 0, uptimeS: Number(b.uptimeS) || 0,
      cameras: { assigned: Number(b.cameras.assigned) || 0, failing: Number(b.cameras.failing) || 0 },
      outbox: { pending: Number(b.outbox.pending) || 0, bytes: Number(b.outbox.bytes) || 0, oldestAgeS: Number(b.outbox.oldestAgeS) || 0, dropped: Number(b.outbox.dropped) || 0 },
      link: b.link as HeartbeatRequest['link'], mediaUrl: typeof b.mediaUrl === 'string' ? b.mediaUrl.slice(0, 300) : undefined, concurrency: Number(b.concurrency) || 0,
    };
    const out = ctx.central.heartbeat(id, hb);
    out.assignmentVersion = (await ctx.central.assignment(id)).version;
    res.json(out);
  }));

  app.post('/api/gateway/ingest', guarded(async (id, req, res) => {
    const b = req.body as Partial<IngestRequest> | undefined;
    if (!b || !Array.isArray(b.items)) { res.status(400).json({ error: "'items' must be a list." }); return; }
    if (b.items.length > maxItems) { res.status(413).json({ error: `At most ${maxItems} items per batch.` }); return; }
    res.json(await ctx.central.ingest(id, { batchId: String(b.batchId ?? ''), items: b.items }));
  }));

  app.get('/api/gateway/cameras', guarded(async (id, req, res) => {
    const a = await ctx.central.assignment(id);
    res.setHeader('ETag', `"${a.version}"`);
    if (req.header('If-None-Match') === `"${a.version}"`) { res.status(304).end(); return; }
    res.json(a);
  }));

  app.get('/api/gateway/user-context', guarded(async (id, req, res) => {
    const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
    if (!userId) { res.status(400).json({ error: "'userId' is required." }); return; }
    const departmentId = typeof req.query.departmentId === 'string' && req.query.departmentId ? req.query.departmentId : undefined;
    res.json(await ctx.central.userContext(id, userId, departmentId));
  }));
}
