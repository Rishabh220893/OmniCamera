/**
 * HTTP side of incidents (docs/incidents.md). Visibility follows the same rule as events: an organisation-wide administrator sees every
 * incident, a department's people see the incidents that touch their department, everyone else sees incidents that involve their own cameras.
 *
 *   GET  /api/incidents?state=open|closed&limit=&before=      newest activity first
 *   GET  /api/incidents/:id                                   the incident and the events in it that the caller may see
 *   POST /api/incidents/:id/close      POST /api/incidents/:id/reopen
 *   POST /api/incidents/:id/notes      { text }
 *
 * An incident can span departments. Its summary (cameras, departments, counts) is shown to everyone it touches, but the events inside it
 * only to people who could already see those events: one department learns that its vehicle was also seen elsewhere, not what the other
 * department's system recorded.
 */
import type { Express, Request, Response } from 'express';
import type { Permission } from '../authz/policy';
import type { AlertStore } from '../events/store';
import { withNote } from './correlator';
import { incidentVisible, type Incident, type IncidentQuery, type IncidentState, type IncidentStore } from './store';

export interface IncidentRoutesContext {
  store: IncidentStore;
  events: Pick<AlertStore, 'queryEvents'>;
  requireUser(req: Request, res: Response, permission: Permission): Promise<string | null>;
  departmentScope?(req: Request, userId: string): Promise<string[] | '*' | null>;
  now?: () => Date;
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const asDate = (v: unknown) => { const d = typeof v === 'string' ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : undefined; };

export function registerIncidentRoutes(app: Express, ctx: IncidentRoutesContext): void {
  const now = ctx.now ?? (() => new Date());
  const fail = (res: Response, e: unknown) => { console.error('[INCIDENTS]', e); res.status(500).json({ error: 'The request failed.' }); };
  const scopeOf = async (req: Request, userId: string): Promise<Pick<IncidentQuery, 'userId' | 'departments' | 'all'>> => {
    const dept = (await ctx.departmentScope?.(req, userId)) ?? null;
    return dept === '*' ? { all: true } : Array.isArray(dept) ? { departments: dept } : { userId };
  };
  /** The incident if it exists and the caller may see it; replies 404 otherwise (a hidden incident looks like a missing one). */
  const visible = async (req: Request, res: Response, userId: string): Promise<{ incident: Incident; scope: Awaited<ReturnType<typeof scopeOf>> } | null> => {
    const scope = await scopeOf(req, userId);
    const id = String(req.params.id);
    const incident = ID_RE.test(id) ? await ctx.store.get(id) : null;
    if (!incident || !incidentVisible(incident, scope)) { res.status(404).json({ error: 'No such incident.' }); return null; }
    return { incident, scope };
  };

  app.get('/api/incidents', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'alert.view');
    if (!userId) return;
    try {
      const state = req.query.state === 'open' || req.query.state === 'closed' ? (req.query.state as IncidentState) : undefined;
      res.json({ incidents: await ctx.store.list({ ...(await scopeOf(req, userId)), state, before: asDate(req.query.before), limit: Number(req.query.limit) || 50 }) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/incidents/:id', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'alert.view');
    if (!userId) return;
    try {
      const v = await visible(req, res, userId);
      if (!v) return;
      const ids = new Set(v.incident.eventIds);
      const rows = await ctx.events.queryEvents({
        userId: v.scope.userId ?? '', departments: v.scope.departments, all: v.scope.all,
        from: new Date(new Date(v.incident.firstAt).getTime() - 1000), to: new Date(new Date(v.incident.lastAt).getTime() + 1000), limit: 500,
      });
      const events = rows.filter((e) => ids.has(e.id)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
      res.json({ incident: v.incident, events, hiddenEvents: v.incident.eventCount - events.length });
    } catch (e) { fail(res, e); }
  });

  for (const action of ['close', 'reopen'] as const) {
    app.post(`/api/incidents/:id/${action}`, async (req, res) => {
      const userId = await ctx.requireUser(req, res, 'alert.handle');
      if (!userId) return;
      try {
        const v = await visible(req, res, userId);
        if (!v) return;
        const i = v.incident;
        if (action === 'close' && i.state === 'open') { i.state = 'closed'; i.closedAt = now().toISOString(); i.closedBy = userId; await ctx.store.save(i); }
        if (action === 'reopen' && i.state === 'closed') { i.state = 'open'; delete i.closedAt; delete i.closedBy; await ctx.store.save(i); }
        res.json({ incident: i });
      } catch (e) { fail(res, e); }
    });
  }

  app.post('/api/incidents/:id/notes', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'alert.handle');
    if (!userId) return;
    try {
      const text = typeof (req.body as { text?: unknown } | undefined)?.text === 'string' ? (req.body as { text: string }).text.trim() : '';
      if (!text || text.length > 1000) { res.status(400).json({ error: "'text' is a note of 1 to 1000 characters." }); return; }
      const v = await visible(req, res, userId);
      if (!v) return;
      const updated = withNote(v.incident, text, userId, now());
      await ctx.store.save(updated);
      res.status(201).json({ incident: updated });
    } catch (e) { fail(res, e); }
  });
}
