/**
 * HTTP side of the department-system connectors (docs/connectors-vms.md).
 *   GET    /api/vms                          connector types and the configured systems with their live status        (vms.view)
 *   POST   /api/vms/systems                  add a system { id, kind, baseUrl, credentials, ownerUserId, department, ... } (vms.manage)
 *   DELETE /api/vms/systems/:id              stop and remove it                                                       (vms.manage)
 *   POST   /api/vms/systems/:id/sync         one immediate round                                                      (vms.manage)
 *   GET    /api/vms/systems/:id/health       a live check of the system                                               (vms.view)
 *   GET    /api/vms/systems/:id/cameras      the system's cameras, read live                                          (vms.view)
 * Logins go in on creation and are never returned.
 */
import type { Express, Request, Response } from 'express';
import { VmsError } from './types';
import type { VmsService } from './service';

export type VmsPermission = 'vms.view' | 'vms.manage';

export interface VmsRoutesContext {
  service: VmsService;
  /** Replies 401/403 and returns null when the caller may not; else who they are. */
  allow(req: Request, res: Response, permission: VmsPermission): Promise<{ uid: string } | null>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function registerVmsRoutes(app: Express, ctx: VmsRoutesContext): void {
  const fail = (res: Response, e: unknown) => {
    if (e instanceof VmsError) {
      const status = e.code === 'protocol' ? 400 : e.code === 'auth' ? 502 : e.code === 'rate_limited' ? 503 : 502;
      res.status(status).json({ error: e.message, code: e.code });
      return;
    }
    console.error('[VMS]', e);
    res.status(500).json({ error: 'The request failed.' });
  };
  const sysId = (req: Request, res: Response): string | null => {
    const id = String(req.params.id);
    if (ID_RE.test(id) && ctx.service.get(id)) return id;
    res.status(404).json({ error: 'No such system.' });
    return null;
  };

  app.get('/api/vms', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.view'))) return;
    res.json({ types: ctx.service.types(), systems: ctx.service.list() });
  });

  app.post('/api/vms/systems', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    try { res.status(201).json({ system: await ctx.service.add(req.body) }); } catch (e) { fail(res, e); }
  });

  app.delete('/api/vms/systems/:id', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    const id = sysId(req, res);
    if (!id) return;
    try { await ctx.service.remove(id); res.json({ status: 'ok' }); } catch (e) { fail(res, e); }
  });

  app.post('/api/vms/systems/:id/sync', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.manage'))) return;
    const id = sysId(req, res);
    if (!id) return;
    try { res.json({ system: await ctx.service.syncNow(id) }); } catch (e) { fail(res, e); }
  });

  app.get('/api/vms/systems/:id/health', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.view'))) return;
    const id = sysId(req, res);
    if (!id) return;
    try { res.json({ health: await ctx.service.health(id) }); } catch (e) { fail(res, e); }
  });

  app.get('/api/vms/systems/:id/cameras', async (req, res) => {
    if (!(await ctx.allow(req, res, 'vms.view'))) return;
    const id = sysId(req, res);
    if (!id) return;
    try { const cams = (await ctx.service.cameras(id)) ?? []; res.json({ count: cams.length, cameras: cams.slice(0, 2000) }); } catch (e) { fail(res, e); }
  });
}
