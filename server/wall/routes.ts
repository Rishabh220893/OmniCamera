/**
 * HTTP side of the video walls (docs/video-wall.md). Everything needs a sign-in.
 *
 *   GET    /api/wall-layouts                      layouts you own or that are shared with your department        (camera.view)
 *   POST   /api/wall-layouts                      { name, spec, department?, shared? }                            (camera.edit)
 *   PUT    /api/wall-layouts/:id                  { name?, spec?, department?, shared? }  owner, or an admin of its department
 *   DELETE /api/wall-layouts/:id
 *
 *   GET    /api/walls                             walls you may see, each with its state
 *   POST   /api/walls                             { id, name?, department?, maxViewers?, maxLiveTiles? }          (user.manage)
 *   PATCH  /api/walls/:id                         { name?, maxViewers?, maxLiveTiles? }                           (user.manage)
 *   DELETE /api/walls/:id                                                                                         (user.manage)
 *   GET    /api/walls/:id                         the wall's state (what it shows, who controls it, how many watch)
 *   POST   /api/walls/:id/sessions                { mode: 'viewer'|'controller', force? } -> 201 {sessionId, expiresAt, state}
 *                                                 409 {holder, since} when someone else controls it; 429 when it has all the viewers it allows
 *                                                 (controller needs camera.edit; force needs an administrator)
 *   POST   /api/walls/:id/sessions/:sid/heartbeat { mode } every ~15 s -> the state; 404 once the session ran out or was taken over
 *   DELETE /api/walls/:id/sessions/:sid?mode=
 *   PUT    /api/walls/:id/layout                  { sessionId, layoutId } or { sessionId, spec }  controller only -> 200 state; 403 otherwise
 *   GET    /api/walls/:id/audit                   who attached, took or forced control, changed the layout                (user.manage)
 */
import type { Express, Request, Response } from 'express';
import type { Permission, Principal } from '../authz/policy';
import { LayoutError, type WallService } from './service';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export interface WallRoutesContext {
  service: WallService;
  /** Replies 401/403 and returns null when the caller may not; else who they are. */
  allow(req: Request, res: Response, permission: Permission): Promise<Principal | null>;
}

export function registerWallRoutes(app: Express, ctx: WallRoutesContext): void {
  const { service } = ctx;
  const fail = (res: Response, e: unknown) => {
    if (e instanceof LayoutError) { res.status(400).json({ error: e.message }); return; }
    console.error('[WALL]', e);
    res.status(500).json({ error: 'The request failed.' });
  };
  const noWall = (res: Response) => res.status(404).json({ error: 'No such wall.' });
  const modeOf = (v: unknown): 'viewer' | 'controller' | null => (v === 'viewer' || v === 'controller' ? v : null);

  app.get('/api/wall-layouts', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.view'); if (!p) return;
    res.json({ layouts: await service.listLayouts(p) });
  });
  app.post('/api/wall-layouts', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.edit'); if (!p) return;
    try { res.status(201).json({ layout: await service.createLayout(req.body, p) }); } catch (e) { fail(res, e); }
  });
  app.put('/api/wall-layouts/:id', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.edit'); if (!p) return;
    try {
      const r = await service.updateLayout(String(req.params.id), req.body, p);
      if (r === null) { res.status(404).json({ error: 'No such layout.' }); return; }
      if (r === 'forbidden') { res.status(403).json({ error: 'Only its owner, or an administrator of its department, can change this layout.' }); return; }
      res.json({ layout: r });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/wall-layouts/:id', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.edit'); if (!p) return;
    try {
      const r = await service.removeLayout(String(req.params.id), p);
      if (r === null) { res.status(404).json({ error: 'No such layout.' }); return; }
      if (r === 'forbidden') { res.status(403).json({ error: 'Only its owner, or an administrator of its department, can remove this layout.' }); return; }
      res.json({ status: 'ok' });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/walls', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.view'); if (!p) return;
    res.json({ walls: await service.listWalls(p) });
  });
  app.post('/api/walls', async (req, res) => {
    const p = await ctx.allow(req, res, 'user.manage'); if (!p) return;
    try { res.status(201).json({ state: await service.createWall(req.body, p) }); } catch (e) { fail(res, e); }
  });
  app.patch('/api/walls/:id', async (req, res) => {
    const p = await ctx.allow(req, res, 'user.manage'); if (!p) return;
    try { const s = await service.updateWall(String(req.params.id), req.body, p); if (!s) { noWall(res); return; } res.json({ state: s }); } catch (e) { fail(res, e); }
  });
  app.delete('/api/walls/:id', async (req, res) => {
    const p = await ctx.allow(req, res, 'user.manage'); if (!p) return;
    if (!ID_RE.test(String(req.params.id)) || !(await service.removeWall(String(req.params.id), p))) { noWall(res); return; }
    res.json({ status: 'ok' });
  });
  app.get('/api/walls/:id', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.view'); if (!p) return;
    const s = ID_RE.test(String(req.params.id)) ? await service.getWall(String(req.params.id), p) : null;
    if (!s) { noWall(res); return; }
    res.json({ state: s });
  });
  app.get('/api/walls/:id/audit', async (req, res) => {
    const p = await ctx.allow(req, res, 'user.manage'); if (!p) return;
    const id = String(req.params.id);
    if (!ID_RE.test(id) || !(await service.getWall(id, p))) { noWall(res); return; }
    res.json({ audit: service.audit(id) });
  });

  app.post('/api/walls/:id/sessions', async (req, res) => {
    const mode = modeOf((req.body as { mode?: unknown } | undefined)?.mode);
    if (!mode) { res.status(400).json({ error: "'mode' must be 'viewer' or 'controller'." }); return; }
    const p = await ctx.allow(req, res, mode === 'controller' ? 'camera.edit' : 'camera.view'); if (!p) return;
    const id = String(req.params.id);
    if (!ID_RE.test(id)) { noWall(res); return; }
    try {
      const force = (req.body as { force?: unknown }).force === true;
      if (force && p.role !== 'admin') { res.status(403).json({ error: 'Only an administrator can take control by force.' }); return; }
      const r = await service.attach(id, p, mode, force);
      if (r.status === 'not_found') { noWall(res); return; }
      if (r.status === 'busy') { res.status(409).json({ error: `${r.holder} is controlling this wall.`, holder: r.holder, since: r.since }); return; }
      if (r.status === 'full') { res.setHeader('Retry-After', '45'); res.status(429).json({ error: `This wall already has its ${r.max} viewers.` }); return; }
      if (r.status === 'forbidden') { res.status(403).json({ error: 'Not allowed.' }); return; }
      const state = await service.getWall(id, p);
      res.status(201).json({ sessionId: r.sessionId, mode: r.mode, expiresAt: r.expiresAt, state });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/walls/:id/sessions/:sid/heartbeat', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.view'); if (!p) return;
    const mode = modeOf((req.body as { mode?: unknown } | undefined)?.mode) ?? 'viewer';
    const id = String(req.params.id), sid = String(req.params.sid);
    if (!ID_RE.test(id) || !ID_RE.test(sid)) { res.status(404).json({ error: 'That session is gone.' }); return; }
    const s = await service.heartbeat(id, p, sid, mode);
    if (!s) { res.status(404).json({ error: 'That session ran out or was taken over. Join again.' }); return; }
    res.json({ state: s });
  });

  app.delete('/api/walls/:id/sessions/:sid', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.view'); if (!p) return;
    const mode = modeOf(req.query.mode) ?? 'viewer';
    const id = String(req.params.id), sid = String(req.params.sid);
    if (!ID_RE.test(id) || !ID_RE.test(sid) || !(await service.detach(id, p, sid, mode))) { res.status(404).json({ error: 'No such session.' }); return; }
    res.json({ status: 'ok' });
  });

  app.put('/api/walls/:id/layout', async (req, res) => {
    const p = await ctx.allow(req, res, 'camera.edit'); if (!p) return;
    const id = String(req.params.id);
    const sid = (req.body as { sessionId?: unknown } | undefined)?.sessionId;
    if (!ID_RE.test(id)) { noWall(res); return; }
    if (typeof sid !== 'string' || !ID_RE.test(sid)) { res.status(403).json({ error: 'Take control of the wall first.' }); return; }
    try {
      const r = await service.setLayout(id, p, sid, req.body);
      if (r.status === 'not_found') { noWall(res); return; }
      if (r.status === 'not_controller') { res.status(403).json({ error: 'You are not controlling this wall (your control ran out or was taken). Take control again.' }); return; }
      res.json({ state: r.state });
    } catch (e) { fail(res, e); }
  });
}
