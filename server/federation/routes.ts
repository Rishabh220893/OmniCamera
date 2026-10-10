/**
 * HTTP side of the federation service (docs/federation-service.md).
 *
 * For a department's system or connector (public; an API key identifies it: `Authorization: Bearer fed_<id>.<secret>` or `X-Api-Key`):
 *   GET    /api/federation/me                       who this key is, its quotas and its use so far
 *   POST   /api/federation/events                   generic-JSON events (see webhook formats); the client's department is stamped on all of them
 *                                                   202 {accepted, ignored[]}; 400; 401 (any bad key, same answer); 403 scope; 413; 429 + Retry-After
 *   POST   /api/federation/sessions                 { what } take a live-session slot -> 201 {lease}; 429 when the cap is reached
 *   POST   /api/federation/sessions/:id/renew       keep it alive (it runs out after about a minute otherwise) -> 404 once gone
 *   DELETE /api/federation/sessions/:id             give the slot back
 *
 * For an administrator (permission vms.view / vms.manage):
 *   GET    /api/federation/clients                  clients with their use (never keys)
 *   POST   /api/federation/clients                  { id, department, label?, scopes?, quotas?, timezoneOffsetMinutes? } -> { client, key } (key shown once)
 *   PATCH  /api/federation/clients/:id              { label?, scopes?, quotas?, enabled? }
 *   POST   /api/federation/clients/:id/rotate       a new key; the old one stops working at once
 *   DELETE /api/federation/clients/:id
 *   GET    /api/federation/sessions                 every live lease
 */
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { FormatError } from '../connectors/webhook/formats';
import type { FederationClient, FederationService } from './service';

export const MAX_BODY = '512kb';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LEASE_RE = /^[A-Za-z0-9_-]{1,40}$/;

function keyOf(req: Request): string | undefined {
  const bearer = req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return bearer ?? req.header('x-api-key') ?? undefined;
}

/**
 * Registers the client routes. Mounted BEFORE the global body parser (they are public and have their own small limit); `getService` is
 * looked up per request so the routes can be mounted before the service exists (503 until then).
 */
export function registerFederationClientRoutes(app: Express, getService: () => FederationService | null): void {
  const gate = (handler: (svc: FederationService, c: FederationClient, req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response) => {
      const svc = getService();
      if (!svc) { res.status(503).json({ error: 'The federation service is not ready.' }); return; }
      const c = svc.authenticate(keyOf(req));
      if (!c) { res.setHeader('WWW-Authenticate', 'Bearer realm="omnisee-federation"'); res.status(401).json({ error: 'Unauthorized.' }); return; }
      try { await handler(svc, c, req, res); }
      catch (e) { console.error('[FEDERATION]', e instanceof Error ? e.message : e); res.status(503).json({ error: 'Could not handle the request right now; try again.' }); }
    };
  const tooBig = (err: { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.status === 413 || err?.type === 'entity.too.large') { res.status(413).json({ error: 'The body is too large.' }); return; }
    next(err);
  };
  const raw = (limit: string) => express.raw({ type: () => true, limit });
  const text = (req: Request) => (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');

  app.get('/api/federation/me', gate((svc, c, _req, res) => { res.json(svc.whoami(c)); }));

  app.post('/api/federation/events', raw(MAX_BODY), gate(async (svc, c, req, res) => {
    const r = await svc.push(c, text(req));
    if (r.status === 'ok') { res.status(202).json({ accepted: r.accepted, ignored: r.ignored }); return; }
    if (r.status === 'forbidden') { res.status(403).json({ error: "This key may not push events." }); return; }
    if (r.status === 'quota') { res.setHeader('Retry-After', String(r.retryAfterS)); res.status(429).json({ error: r.which === 'day' ? 'Daily event quota reached.' : 'Event quota for this minute reached.' }); return; }
    res.status(400).json({ error: r.error });
  }), tooBig);

  app.post('/api/federation/sessions', raw('8kb'), gate((svc, c, req, res) => {
    let what = 'session';
    try { const j = JSON.parse(text(req) || '{}'); if (typeof j?.what === 'string' && j.what.trim()) what = j.what; } catch { res.status(400).json({ error: 'The body is not valid JSON.' }); return; }
    const r = svc.acquire(c, what);
    if (r.status === 'ok') { res.status(201).json({ lease: r.lease }); return; }
    if (r.status === 'forbidden') { res.status(403).json({ error: 'This key may not open sessions.' }); return; }
    if (r.status === 'cap') { res.setHeader('Retry-After', String(r.retryAfterS)); res.status(429).json({ error: `Session cap reached (${r.max}).` }); return; }
    res.status(404).json({ error: 'No such session.' });
  }), tooBig);

  app.post('/api/federation/sessions/:id/renew', gate((svc, c, req, res) => {
    const id = String(req.params.id);
    const r = LEASE_RE.test(id) ? svc.renew(c, id) : { status: 'gone' as const };
    if (r.status === 'ok') { res.json({ lease: r.lease }); return; }
    res.status(404).json({ error: 'That session is gone (it ran out or was released). Open a new one.' });
  }));

  app.delete('/api/federation/sessions/:id', gate((svc, c, req, res) => {
    const id = String(req.params.id);
    if (!LEASE_RE.test(id) || !svc.release(c, id)) { res.status(404).json({ error: 'No such session.' }); return; }
    res.json({ status: 'ok' });
  }));
}

export interface FederationAdminContext {
  service: FederationService;
  /** Replies 401/403 and returns null when the caller may not; else who they are. */
  allow(req: Request, res: Response, permission: 'vms.view' | 'vms.manage'): Promise<{ uid: string } | null>;
}

export function registerFederationAdminRoutes(app: Express, ctx: FederationAdminContext): void {
  const fail = (res: Response, e: unknown) => {
    if (e instanceof FormatError) { res.status(400).json({ error: e.message }); return; }
    console.error('[FEDERATION]', e);
    res.status(500).json({ error: 'The request failed.' });
  };
  const bad = (id: string) => !ID_RE.test(id);

  app.get('/api/federation/clients', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.view'))) return;
    res.json({ clients: ctx.service.list() });
  });

  app.get('/api/federation/sessions', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.view'))) return;
    res.json({ sessions: ctx.service.sessions() });
  });

  app.post('/api/federation/clients', async (req, res) => {
    const who = await ctx.allow(req, res, 'vms.manage');
    if (!who) return;
    try {
      const { client, key } = await ctx.service.create(req.body, who.uid);
      res.status(201).json({ client, key, note: 'This key is shown only now. Give it to the department; if it is lost, rotate it.' });
    } catch (e) { fail(res, e); }
  });

  app.patch('/api/federation/clients/:id', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    const id = String(req.params.id);
    if (bad(id)) { res.status(404).json({ error: 'No such client.' }); return; }
    try {
      const c = await ctx.service.update(id, req.body);
      if (!c) { res.status(404).json({ error: 'No such client.' }); return; }
      res.json({ client: c });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/federation/clients/:id/rotate', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    const id = String(req.params.id);
    if (bad(id)) { res.status(404).json({ error: 'No such client.' }); return; }
    try {
      const r = await ctx.service.rotate(id);
      if (!r) { res.status(404).json({ error: 'No such client.' }); return; }
      res.json({ client: r.client, key: r.key, note: 'The old key no longer works.' });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/federation/clients/:id', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    const id = String(req.params.id);
    if (bad(id) || !(await ctx.service.remove(id))) { res.status(404).json({ error: 'No such client.' }); return; }
    res.json({ status: 'ok' });
  });
}
