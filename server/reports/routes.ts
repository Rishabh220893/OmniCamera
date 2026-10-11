/**
 * GET /api/reports/federated  (permission event.view; everyone sees what their scope allows, see federated.ts)
 *   ?days=7                 the last N days (1 to 90, default 7: the planning window for cross-department evidence), or
 *   ?from=&to=              ISO dates (at most 90 days apart)
 *   &department=Traffic     detail for one department you cover
 *   &tz=330                 minutes ahead of UTC for the hour-of-day chart (default 330)
 *   &format=json|csv|html   json (default); csv is one row per department; html is a self-contained page to read or print
 */
import type { Express, Request, Response } from 'express';
import type { Principal } from '../authz/policy';
import { eventScope } from '../authz/policy';
import { DEPARTMENT_NAME_RE } from '../events/rules';
import { federatedReport, reportCsv, reportHtml, type CollectDeps } from './federated';

export interface ReportRoutesContext extends CollectDeps {
  /** Replies 401/403 and returns null when the caller may not; else who they are. */
  allow(req: Request, res: Response): Promise<Principal | null>;
  now?: () => Date;
  /** Most events read per report. Default 20,000. */
  maxEvents?: number;
}

const DAY = 86_400_000;
const date = (v: unknown): Date | null => { if (typeof v !== 'string' || !v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

export function registerReportRoutes(app: Express, ctx: ReportRoutesContext): void {
  app.get('/api/reports/federated', async (req, res) => {
    const p = await ctx.allow(req, res);
    if (!p) return;
    try {
      const now = (ctx.now ?? (() => new Date()))();
      const to = date(req.query.to) ?? now;
      let from = date(req.query.from);
      if (!from) {
        const days = Number(req.query.days ?? 7);
        if (!Number.isFinite(days) || days < 1 || days > 90) { res.status(400).json({ error: "'days' must be from 1 to 90." }); return; }
        from = new Date(to.getTime() - Math.round(days) * DAY);
      }
      if (from >= to) { res.status(400).json({ error: "'from' must be before 'to'." }); return; }
      if (to.getTime() - from.getTime() > 90 * DAY) { res.status(400).json({ error: 'A report covers at most 90 days.' }); return; }
      const department = typeof req.query.department === 'string' && req.query.department ? req.query.department : undefined;
      if (department && !DEPARTMENT_NAME_RE.test(department)) { res.status(400).json({ error: "'department' must be a department name." }); return; }
      const tz = req.query.tz === undefined ? 330 : Number(req.query.tz);
      if (!Number.isInteger(tz) || tz < -720 || tz > 840) { res.status(400).json({ error: "'tz' must be a whole number of minutes from -720 to 840." }); return; }
      const format = req.query.format === undefined ? 'json' : String(req.query.format);
      if (!['json', 'csv', 'html'].includes(format)) { res.status(400).json({ error: "'format' must be json, csv or html." }); return; }

      const scope = eventScope(p);
      const reportScope = scope === '*' ? { userId: p.uid, all: true } : Array.isArray(scope) ? { userId: p.uid, departments: scope } : { userId: p.uid };
      if (department && scope !== '*' && !(Array.isArray(scope) && scope.includes(department))) { res.status(403).json({ error: 'That is not one of your departments.' }); return; }

      const report = await federatedReport(ctx, reportScope, { from, to, department, tzMinutes: tz, maxEvents: ctx.maxEvents, now });
      res.setHeader('Cache-Control', 'no-store');
      const stamp = now.toISOString().slice(0, 10);
      if (format === 'csv') { res.type('text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="federated-report-${stamp}.csv"`); res.send(reportCsv(report)); return; }
      if (format === 'html') { res.type('text/html; charset=utf-8').setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'"); res.send(reportHtml(report)); return; }
      res.json(report);
    } catch (e) {
      console.error('[REPORT]', e instanceof Error ? e.message : e);
      res.status(500).json({ error: 'The report could not be made.' });
    }
  });
}
