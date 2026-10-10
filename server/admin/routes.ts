/**
 * HTTP side of user and department administration (docs/admin-users.md). Admin only (`user.manage`); every use is in the access log.
 *   GET    /api/admin/departments                 departments with their user and camera counts
 *   POST   /api/admin/departments                 { name }
 *   DELETE /api/admin/departments/:id             refused while it still has users or cameras
 *   GET    /api/admin/users                       accounts created here (never other accounts); never shows a password
 *   POST   /api/admin/users                       { username, password, role?, departmentId }
 *   PATCH  /api/admin/users/:uid                  { password?, role?, departmentId?, disabled? }
 *   DELETE /api/admin/users/:uid
 *   GET    /api/admin/cameras                     every camera with its owner and department
 *   POST   /api/admin/cameras/allot               { cameraIds: [...], departmentId | null }
 */
import type { Express, Request, Response } from 'express';
import { DirectoryError, checkDepartmentName, checkNewUser, checkUserPatch, type AdminDirectory } from './directory';

export interface AdminRoutesContext {
  directory: AdminDirectory;
  /** Replies 401/403 and returns null unless the caller is an administrator. */
  requireAdmin(req: Request, res: Response): Promise<{ uid: string } | null>;
}

export function registerAdminRoutes(app: Express, ctx: AdminRoutesContext): void {
  const fail = (res: Response, e: unknown) => {
    if (e instanceof DirectoryError) {
      const status = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403, unavailable: 502 }[e.code];
      res.status(status).json({ error: e.message, code: e.code });
      return;
    }
    console.error('[ADMIN]', e instanceof Error ? e.message : e);
    res.status(500).json({ error: 'The request failed.' });
  };
  // Nothing from the body of these routes (it may hold a password) is ever logged here.
  const guard = (handler: (req: Request, res: Response, who: { uid: string }) => Promise<void>) => async (req: Request, res: Response) => {
    const who = await ctx.requireAdmin(req, res);
    if (!who) return;
    try { await handler(req, res, who); } catch (e) { fail(res, e); }
  };
  const idParam = (req: Request) => decodeURIComponent(String(req.params.id));

  app.get('/api/admin/departments', guard(async (_req, res) => { res.json({ departments: await ctx.directory.listDepartments() }); }));

  app.post('/api/admin/departments', guard(async (req, res, who) => {
    const name = checkDepartmentName((req.body as { name?: unknown } | undefined)?.name);
    res.status(201).json({ department: await ctx.directory.createDepartment(name, who.uid) });
  }));

  app.delete('/api/admin/departments/:id', guard(async (req, res) => {
    await ctx.directory.deleteDepartment(idParam(req));
    res.json({ status: 'ok' });
  }));

  app.get('/api/admin/users', guard(async (_req, res) => { res.json({ users: await ctx.directory.listUsers() }); }));

  app.post('/api/admin/users', guard(async (req, res, who) => {
    res.status(201).json({ user: await ctx.directory.createUser(checkNewUser(req.body), who.uid) });
  }));

  app.patch('/api/admin/users/:uid', guard(async (req, res, who) => {
    const uid = String(req.params.uid);
    const patch = checkUserPatch(req.body);
    // An administrator cannot lock themselves out or take their own role away through this screen.
    if (uid === who.uid && (patch.disabled === true || (patch.role !== undefined && patch.role !== 'admin'))) throw new DirectoryError('You cannot disable or demote your own account.', 'forbidden');
    res.json({ user: await ctx.directory.updateUser(uid, patch) });
  }));

  app.delete('/api/admin/users/:uid', guard(async (req, res, who) => {
    const uid = String(req.params.uid);
    if (uid === who.uid) throw new DirectoryError('You cannot delete your own account.', 'forbidden');
    await ctx.directory.deleteUser(uid);
    res.json({ status: 'ok' });
  }));

  app.get('/api/admin/cameras', guard(async (_req, res) => { res.json({ cameras: await ctx.directory.listCameras() }); }));

  app.post('/api/admin/cameras/allot', guard(async (req, res) => {
    const b = (req.body ?? {}) as { cameraIds?: unknown; departmentId?: unknown };
    if (!Array.isArray(b.cameraIds) || !b.cameraIds.length || b.cameraIds.length > 2000 || !b.cameraIds.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200 && !x.includes('/'))) {
      throw new DirectoryError("'cameraIds' must be a list of 1-2000 camera ids.", 'invalid');
    }
    const dept = b.departmentId === null || b.departmentId === undefined || b.departmentId === '' ? null : checkDepartmentName(b.departmentId);
    res.json(await ctx.directory.allotCameras(b.cameraIds as string[], dept));
  }));
}
