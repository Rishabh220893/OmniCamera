/**
 * Statewide vehicle trail (docs/vehicle-trail.md). Permission event.view; everyone sees what their scope allows.
 *
 *   GET /api/trail/plates?days=7&q=GJ05          the plates read in the period (busiest first) with where and by whom; `q` filters; at most 200
 *   GET /api/trail/:plate?days=7                 the trail of one plate: segments, legs and flags, look-alike suggestions, counts elsewhere
 *       &also=GJ05AB1Z34,...                     look-alike plates a person confirmed as the same vehicle (at most 5)
 *       &from=&to=                               instead of days (at most 90 days apart)
 *       &format=json|csv                         csv is one row per sighting (evidence), spreadsheet-safe
 */
import type { Express, Request, Response } from 'express';
import type { Principal } from '../authz/policy';
import { eventScope } from '../authz/policy';
import { normalizePlate, routeToCsv } from '../../src/lib/plateTracking';
import { collectReads, summarisePlates, trailFor, type TrailDeps, type TrailScope } from './trail';

export interface TrailRoutesContext extends TrailDeps {
  allow(req: Request, res: Response): Promise<Principal | null>;
  now?: () => Date;
  maxEvents?: number;
}

const DAY = 86_400_000;
const date = (v: unknown): Date | null => { if (typeof v !== 'string' || !v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

export function registerTrailRoutes(app: Express, ctx: TrailRoutesContext): void {
  function window(req: Request, res: Response): { from: Date; to: Date } | null {
    const now = (ctx.now ?? (() => new Date()))();
    const to = date(req.query.to) ?? now;
    let from = date(req.query.from);
    if (!from) {
      const days = Number(req.query.days ?? 7);
      if (!Number.isFinite(days) || days < 1 || days > 90) { res.status(400).json({ error: "'days' must be from 1 to 90." }); return null; }
      from = new Date(to.getTime() - Math.round(days) * DAY);
    }
    if (from >= to) { res.status(400).json({ error: "'from' must be before 'to'." }); return null; }
    if (to.getTime() - from.getTime() > 90 * DAY) { res.status(400).json({ error: 'A trail covers at most 90 days.' }); return null; }
    return { from, to };
  }
  const scopeOf = (p: Principal): TrailScope => {
    const s = eventScope(p);
    return s === '*' ? { userId: p.uid, all: true } : Array.isArray(s) ? { userId: p.uid, departments: s } : { userId: p.uid };
  };

  app.get('/api/trail/plates', async (req, res) => {
    const p = await ctx.allow(req, res); if (!p) return;
    const w = window(req, res); if (!w) return;
    try {
      const q = typeof req.query.q === 'string' ? normalizePlate(req.query.q).slice(0, 12) : '';
      const { events, truncated } = await collectReads(ctx, scopeOf(p), w.from, w.to, ctx.maxEvents);
      const plates = summarisePlates(events).filter((x) => !q || x.plate.includes(q)).slice(0, 200);
      res.json({ window: { from: w.from.toISOString(), to: w.to.toISOString() }, truncated, plates });
    } catch (e) { console.error('[TRAIL]', e instanceof Error ? e.message : e); res.status(500).json({ error: 'The plate list could not be made.' }); }
  });

  app.get('/api/trail/:plate', async (req, res) => {
    const p = await ctx.allow(req, res); if (!p) return;
    const plate = normalizePlate(String(req.params.plate));
    if (plate.length < 4 || plate.length > 12) { res.status(400).json({ error: 'A plate is 4 to 12 letters and digits.' }); return; }
    const w = window(req, res); if (!w) return;
    const format = req.query.format === undefined ? 'json' : String(req.query.format);
    if (format !== 'json' && format !== 'csv') { res.status(400).json({ error: "'format' must be json or csv." }); return; }
    const also = (typeof req.query.also === 'string' ? req.query.also.split(',') : []).map(normalizePlate).filter(Boolean);
    if (also.length > 5 || also.some((a) => a.length < 4 || a.length > 12)) { res.status(400).json({ error: "'also' is up to 5 plates of 4 to 12 letters and digits." }); return; }
    try {
      const trail = await trailFor(ctx, scopeOf(p), plate, { ...w, also, maxEvents: ctx.maxEvents });
      res.setHeader('Cache-Control', 'no-store');
      if (format === 'csv') {
        res.type('text/csv; charset=utf-8').setHeader('Content-Disposition', `attachment; filename="trail-${plate}.csv"`);
        res.send(routeToCsv(plate, trail.route));
        return;
      }
      res.json(trail);
    } catch (e) { console.error('[TRAIL]', e instanceof Error ? e.message : e); res.status(500).json({ error: 'The trail could not be made.' }); }
  });
}
