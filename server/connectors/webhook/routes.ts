/**
 * HTTP side of the webhook receiver (docs/connectors-vms.md, "Devices that only push").
 *
 * The receiver is public by design: a camera or recorder cannot sign in. It is protected by a per-source secret token instead.
 *
 *   POST /api/ingest/webhook/:id        what a device or system pushes. Token as `Authorization: Bearer <token>`, `X-Webhook-Token: <token>`,
 *                                       or (for devices that cannot set headers) `?token=<token>`, which proxies and logs can see. 512 KB at most.
 *                                       202 {accepted, ignored[]}; 400 with the reason; 401 for a wrong token OR an unknown source (the same
 *                                       answer, so ids cannot be probed); 413; 429 with Retry-After; 5xx means "try again".
 *
 * The management routes need an administrator (permission vms.manage / vms.view):
 *   GET    /api/webhooks                list sources (never the token)
 *   POST   /api/webhooks                { id, format?, label?, department?, ownerUserId?, timezoneOffsetMinutes? } -> { source, token }  (token shown once)
 *   POST   /api/webhooks/:id/rotate     a new token; the old one stops working at once
 *   DELETE /api/webhooks/:id
 */
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { FormatError, WEBHOOK_FORMATS } from './formats';
import type { WebhookService } from './service';

export const MAX_BODY = '512kb';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function tokenOf(req: Request): string | undefined {
  const auth = req.header('authorization');
  const bearer = auth?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const q = typeof req.query.token === 'string' ? req.query.token : undefined;
  return bearer ?? req.header('x-webhook-token') ?? q;
}

/**
 * Registers the receiver. `getService` is looked up per request so the route can be mounted before the service exists (it must be mounted
 * BEFORE the app's global body parser, which would read up to 25 MB of an unauthenticated JSON body); until then it answers 503.
 */
export function registerWebhookIngest(app: Express, getService: () => WebhookService | null): void {
  app.post(
    '/api/ingest/webhook/:id',
    express.raw({ type: () => true, limit: MAX_BODY }),
    async (req: Request, res: Response) => {
      const svc = getService();
      if (!svc) { res.status(503).json({ error: 'The webhook receiver is not ready.' }); return; }
      const id = String(req.params.id);
      const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      try {
        const r = ID_RE.test(id) ? await svc.receive(id, tokenOf(req), body) : { status: 'unauthorized' as const };
        if (r.status === 'ok') { res.status(202).json({ accepted: r.accepted, ignored: r.ignored }); return; }
        if (r.status === 'unauthorized') { res.setHeader('WWW-Authenticate', 'Bearer realm="omnisee-webhook"'); res.status(401).json({ error: 'Unauthorized.' }); return; }
        if (r.status === 'rate_limited') { res.setHeader('Retry-After', String(r.retryAfterS)); res.status(429).json({ error: 'Too many requests.' }); return; }
        res.status(400).json({ error: r.error });
      } catch (e) {
        console.error('[WEBHOOK]', e instanceof Error ? e.message : e);
        res.status(503).json({ error: 'Could not accept the events right now; try again.' });
      }
    },
    // A body over the limit, or one the parser could not read, is answered in JSON (and before any token was looked at).
    (err: { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
      if (err?.status === 413 || err?.type === 'entity.too.large') { res.status(413).json({ error: 'The body is too large (512 KB at most).' }); return; }
      next(err);
    },
  );
}

export interface WebhookAdminContext {
  service: WebhookService;
  /** Replies 401/403 and returns null when the caller may not; else who they are. */
  allow(req: Request, res: Response, permission: 'vms.view' | 'vms.manage'): Promise<{ uid: string } | null>;
}

export function registerWebhookAdminRoutes(app: Express, ctx: WebhookAdminContext): void {
  const fail = (res: Response, e: unknown) => {
    if (e instanceof FormatError) { res.status(400).json({ error: e.message }); return; }
    console.error('[WEBHOOK]', e);
    res.status(500).json({ error: 'The request failed.' });
  };
  const path = (id: string) => `/api/ingest/webhook/${id}`;

  app.get('/api/webhooks', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.view'))) return;
    res.json({ formats: WEBHOOK_FORMATS, sources: ctx.service.list().map((s) => ({ ...s, path: path(s.id) })) });
  });

  app.post('/api/webhooks', async (req, res) => {
    const who = await ctx.allow(req, res, 'vms.manage');
    if (!who) return;
    try {
      const { source, token } = await ctx.service.create(req.body, who.uid);
      res.status(201).json({ source: { ...source, path: path(source.id) }, token, note: 'This token is shown only now. Give it to the sending system; if it is lost, rotate it.' });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/webhooks/:id/rotate', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    if (!ID_RE.test(String(req.params.id))) { res.status(404).json({ error: 'No such source.' }); return; }
    try {
      const r = await ctx.service.rotate(String(req.params.id));
      if (!r) { res.status(404).json({ error: 'No such source.' }); return; }
      res.json({ source: { ...r.source, path: path(r.source.id) }, token: r.token, note: 'The old token no longer works.' });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/webhooks/:id', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    if (!ID_RE.test(String(req.params.id)) || !(await ctx.service.remove(String(req.params.id)))) { res.status(404).json({ error: 'No such source.' }); return; }
    res.json({ status: 'ok' });
  });
}
