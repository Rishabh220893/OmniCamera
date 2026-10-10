/**
 * HTTP side of events, alert rules and alerts. Every route acts for one signed-in user and only ever sees that user's data.
 *
 *   GET    /api/events?type=plate.*&cameraId=&minSeverity=&from=&to=&limit=&q=<text>&tag=<tag>&department=&source=&cursor=&count=1
 *                                  newest first; "nextCursor" (when a full page came back) is passed as "cursor" for the next page;
 *                                  count=1 adds "total", the number of matching events
 *   PUT    /api/events/:id/tags    { tags: [...] } replaces the tags of an event the caller may see (operators and administrators)
 *   GET    /api/event-types                       the events the platform defines
 *   GET    /api/alert-rules        POST /api/alert-rules        PUT|DELETE /api/alert-rules/:id
 *                                  (a rule with "department" is that department's: it fires for events on its cameras whoever owns them)
 *   POST   /api/alert-rules/:id/test              send a test event through the rule's channels
 *   GET    /api/alerts?state=open|acknowledged|resolved&limit=&before=
 *   POST   /api/alerts/:id/acknowledge            POST /api/alerts/:id/resolve
 */
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { Permission } from '../authz/policy';
import { AlertError, type AlertEngine } from './alertEngine';
import type { ChannelRegistry } from './channels';
import { DEPARTMENT_NAME_RE, RuleError, redactRule, validateRule, type AlertRule } from './rules';
import { EVENT_CATALOGUE, isSeverity } from './schema';
import { departmentOwner, eventPageSize, type AlertStore } from './store';

export interface EventRoutesContext {
  store: AlertStore;
  engine: AlertEngine;
  channels: ChannelRegistry;
  /** The signed-in user's id, or null after replying with an error. */
  /** The signed-in user's id when they may do `permission`, or null after replying 401/403. */
  requireUser(req: Request, res: Response, permission: Permission): Promise<string | null>;
  /**
   * For a caller whose role comes from claims: the departments they work for, or '*' for an organisation-wide administrator. Events,
   * alerts and department rules are then read (and alerts and rules handled) by department, whoever owns the cameras; '*' sees every
   * department and every camera. null = the caller sees their own data, as before.
   */
  departmentScope?(req: Request, userId: string): Promise<string[] | '*' | null>;
  now?: () => Date;
  /** At most this many rules per user. */
  maxRules?: number;
}

const asDate = (v: unknown) => { const d = typeof v === 'string' ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : undefined; };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_RE = /^[a-z0-9][a-z0-9 _:.-]{0,39}$/;
const MAX_TAGS = 20;
const MAX_TEXT = 100;
const DEPARTMENT_FILTER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

/** A cursor is the time and id of the last event of a page; opaque to callers. */
const encodeCursor = (e: { ts: string; id: string }) => Buffer.from(`${e.ts}|${e.id}`).toString('base64url');
function decodeCursor(v: unknown): { ts: string; id: string } | null {
  if (typeof v !== 'string' || v.length > 200) return null;
  const [ts, id, ...rest] = Buffer.from(v, 'base64url').toString().split('|');
  if (!ts || !id || rest.length || Number.isNaN(new Date(ts).getTime()) || !ID_RE.test(id)) return null;
  return { ts, id };
}
const listParam = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);

type Scope = string[] | '*' | null;
const coversDepartment = (scope: Scope, department: string) => scope === '*' || (Array.isArray(scope) && scope.includes(department));
const queryScope = (scope: Scope) => (scope === '*' ? { all: true as const } : Array.isArray(scope) ? { departments: scope } : {});

export function registerEventRoutes(app: Express, ctx: EventRoutesContext): void {
  const now = ctx.now ?? (() => new Date());
  const maxRules = ctx.maxRules ?? 100;
  const fail = (res: Response, e: unknown) => {
    if (e instanceof RuleError) { res.status(400).json({ error: e.problems[0], problems: e.problems }); return; }
    if (e instanceof AlertError) { res.status(e.code === 'not_found' ? 404 : 409).json({ error: e.message }); return; }
    console.error('[EVENTS]', e);
    res.status(500).json({ error: 'The request failed.' });
  };

  app.get('/api/event-types', (_req, res) => { res.json({ types: EVENT_CATALOGUE }); });

  app.get('/api/events', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'event.view');
    if (!userId) return;
    try {
      const types = (Array.isArray(req.query.type) ? req.query.type : req.query.type ? [req.query.type] : []).map(String).filter((t) => /^[a-z][a-z0-9_.]*(\.\*)?$/.test(t)).slice(0, 20);
      const minSeverity = isSeverity(req.query.minSeverity) ? req.query.minSeverity : undefined;
      const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
      let after: { ts: string; id: string } | undefined;
      if (req.query.cursor !== undefined) {
        after = decodeCursor(req.query.cursor) ?? undefined;
        if (!after) { res.status(400).json({ error: "'cursor' is not one this server returned." }); return; }
      }
      const tags = listParam(req.query.tag).map((t) => t.trim().toLowerCase());
      if (tags.length > MAX_TAGS || tags.some((t) => !TAG_RE.test(t))) { res.status(400).json({ error: 'A tag is lower case letters, digits, space and _ : . - (at most 40).' }); return; }
      const text = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_TEXT) : '';
      const department = typeof req.query.department === 'string' && req.query.department ? req.query.department : undefined;
      if (department && !DEPARTMENT_FILTER_RE.test(department)) { res.status(400).json({ error: "'department' must be a department name." }); return; }
      const limit = eventPageSize(Number(req.query.limit) || 100);
      const query = {
        userId, ...queryScope(scope), types, minSeverity, cameraId: typeof req.query.cameraId === 'string' ? req.query.cameraId : undefined,
        from: asDate(req.query.from), to: asDate(req.query.to), before: asDate(req.query.before), after, limit,
        text: text || undefined, tags: tags.length ? tags : undefined, department, source: typeof req.query.source === 'string' && req.query.source ? req.query.source.slice(0, 80) : undefined,
      };
      const events = await ctx.store.queryEvents(query);
      const out: { events: typeof events; nextCursor?: string; total?: number } = { events };
      if (events.length >= limit) out.nextCursor = encodeCursor(events[events.length - 1]);
      if (req.query.count === '1' || req.query.count === 'true') out.total = await ctx.store.countEvents(query);
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  app.put('/api/events/:id/tags', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'alert.handle');
    if (!userId) return;
    try {
      const raw = req.body && typeof req.body === 'object' ? (req.body as { tags?: unknown }).tags : undefined;
      if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string')) { res.status(400).json({ error: "'tags' must be a list of text." }); return; }
      const tags = [...new Set((raw as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))];
      if (tags.length > MAX_TAGS) { res.status(400).json({ error: `At most ${MAX_TAGS} tags.` }); return; }
      if (tags.some((t) => !TAG_RE.test(t))) { res.status(400).json({ error: 'A tag is lower case letters, digits, space and _ : . - (at most 40).' }); return; }
      if (!ID_RE.test(req.params.id)) { res.status(404).json({ error: 'No such event.' }); return; }
      const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
      const event = await ctx.store.updateEventTags({ userId, ...queryScope(scope) }, req.params.id, tags);
      if (!event) { res.status(404).json({ error: 'No such event.' }); return; }
      res.json({ event });
    } catch (e) { fail(res, e); }
  });

  /** A rule the caller may handle: their own, or a department's rule for a department they cover. */
  async function findRule(userId: string, scope: Scope, id: string): Promise<AlertRule | null> {
    if (!ID_RE.test(id)) return null;
    const own = await ctx.store.getRule(userId, id);
    if (own) return own;
    if (!scope) return null;
    return (await ctx.store.listDepartmentRules(scope === '*' ? null : scope)).find((r) => r.id === id) ?? null;
  }

  app.get('/api/alert-rules', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'rule.view');
    if (!userId) return;
    try {
      const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
      const own = await ctx.store.listRules(userId);
      const shared = scope ? await ctx.store.listDepartmentRules(scope === '*' ? null : scope) : [];
      res.json({ rules: [...own, ...shared].map(redactRule) });
    } catch (e) { fail(res, e); }
  });

  const channelCheck = (c: Parameters<ChannelRegistry['check']>[0]) => ctx.channels.check(c);

  app.post('/api/alert-rules', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'rule.manage');
    if (!userId) return;
    try {
      // "department" makes it that department's rule: only for a department the caller works for (an organisation-wide admin: any).
      const department = req.body && typeof req.body === 'object' && 'department' in req.body ? (req.body as { department?: unknown }).department : undefined;
      let owner = userId;
      if (department !== undefined && department !== null && department !== '') {
        if (typeof department !== 'string' || !DEPARTMENT_NAME_RE.test(department)) { res.status(400).json({ error: "'department' must be a department name." }); return; }
        const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
        if (!coversDepartment(scope, department)) { res.status(403).json({ error: 'You can only make rules for a department you work for.' }); return; }
        owner = departmentOwner(department);
      }
      if ((await ctx.store.listRules(owner)).length >= maxRules) { res.status(409).json({ error: `At most ${maxRules} rules.` }); return; }
      const rule = validateRule(req.body, { userId: owner, id: randomUUID(), now: now(), allowChannel: channelCheck, ...(owner !== userId ? { department: department as string, createdBy: userId } : {}) });
      await ctx.store.saveRule(rule);
      ctx.engine.invalidate(owner);
      res.status(201).json({ rule: redactRule(rule) });
    } catch (e) { fail(res, e); }
  });

  app.put('/api/alert-rules/:id', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'rule.manage');
    if (!userId) return;
    try {
      const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
      const existing = await findRule(userId, scope, String(req.params.id));
      if (!existing) { res.status(404).json({ error: 'No such rule.' }); return; }
      const rule = validateRule(req.body, { userId: existing.userId, id: existing.id, now: now(), existing, allowChannel: channelCheck, department: existing.department, createdBy: existing.createdBy });
      await ctx.store.saveRule(rule);
      ctx.engine.invalidate(existing.userId);
      res.json({ rule: redactRule(rule) });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/alert-rules/:id', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'rule.manage');
    if (!userId) return;
    try {
      const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
      const existing = await findRule(userId, scope, String(req.params.id));
      if (!existing || !(await ctx.store.deleteRule(existing.userId, existing.id))) { res.status(404).json({ error: 'No such rule.' }); return; }
      ctx.engine.invalidate(existing.userId);
      res.json({ status: 'ok' });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/alert-rules/:id/test', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'rule.manage');
    if (!userId) return;
    try {
      const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
      const rule = await findRule(userId, scope, String(req.params.id));
      if (!rule) { res.status(404).json({ error: 'No such rule.' }); return; }
      res.json({ deliveries: await ctx.engine.test(rule, { id: 'test-camera', name: 'Test camera' }) });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/alerts', async (req, res) => {
    const userId = await ctx.requireUser(req, res, 'alert.view');
    if (!userId) return;
    try {
      const state = ['open', 'acknowledged', 'resolved'].includes(String(req.query.state)) ? (req.query.state as 'open' | 'acknowledged' | 'resolved') : undefined;
      const scope = (await ctx.departmentScope?.(req, userId)) ?? null;
      res.json({ alerts: await ctx.store.listAlerts({ userId, ...queryScope(scope), state, before: asDate(req.query.before), limit: Number(req.query.limit) || 100 }) });
    } catch (e) { fail(res, e); }
  });

  for (const action of ['acknowledge', 'resolve'] as const) {
    app.post(`/api/alerts/:id/${action}`, async (req, res) => {
      const userId = await ctx.requireUser(req, res, 'alert.handle');
      if (!userId) return;
      try {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(req.params.id)) { res.status(404).json({ error: 'No such alert.' }); return; }
        const dept = (await ctx.departmentScope?.(req, userId)) ?? null;
        const scope = dept === '*' ? { all: true as const } : dept ? { departments: dept } : userId;
        res.json({ alert: await (action === 'acknowledge' ? ctx.engine.acknowledge(scope, String(req.params.id), userId) : ctx.engine.resolve(scope, String(req.params.id), userId)) });
      } catch (e) { fail(res, e); }
    });
  }
}
