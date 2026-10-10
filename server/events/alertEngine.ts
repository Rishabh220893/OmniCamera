/**
 * Turns events into alerts: store them (once), find the rules they match, fold repeats into one alert, deliver new alerts, and
 * keep the acknowledge / resolve lifecycle. All I/O is injected.
 *
 * Limits worth knowing: folding repeats is serialised inside one process. Several server instances ingesting the same user's
 * events at the same moment can each open an alert for the same key (the event itself is still stored once).
 */
import { randomUUID } from 'node:crypto';
import type { Alert, ChannelRegistry, Delivery } from './channels';
import { redactRule, ruleMatches, throttleKey, type AlertRule } from './rules';
import { severityRank, type PlatformEvent } from './schema';
import { departmentOwner, type AlertStore } from './store';

export class AlertError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'bad_state') { super(message); this.name = 'AlertError'; }
}

export interface AlertEngineDeps {
  store: AlertStore;
  channels: ChannelRegistry;
  now?: () => Date;
  newId?: () => string;
  log?: Pick<Console, 'warn' | 'info'>;
  /** How long a user's rules are remembered between events. */
  ruleCacheMs?: number;
}

/** Who is asking: a user id (their own alerts), the departments they work for, or everything (an organisation-wide administrator). */
export type AlertScope = string | { departments: string[] } | { all: true };

export interface IngestResult {
  /** Events that were new (not seen before). */
  stored: number;
  /** Alerts opened or extended by this batch. */
  alerts: Array<{ alert: Alert; opened: boolean }>;
}

export function createAlertEngine(deps: AlertEngineDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? console;
  const ruleCacheMs = deps.ruleCacheMs ?? 5000;
  const ruleCache = new Map<string, { at: number; rules: Promise<AlertRule[]> }>();
  const chains = new Map<string, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();

  function rulesFor(userId: string): Promise<AlertRule[]> {
    const c = ruleCache.get(userId);
    if (c && now().getTime() - c.at < ruleCacheMs) return c.rules;
    const rules = deps.store.listRules(userId).then((rs) => rs.filter((r) => r.enabled));
    ruleCache.set(userId, { at: now().getTime(), rules });
    rules.catch(() => ruleCache.delete(userId));
    return rules;
  }

  /** One user's events are handled one batch at a time, so two frames of the same plate cannot both open an alert. */
  function serial<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const prev = chains.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    chains.set(userId, next);
    const done = next.finally(() => { if (chains.get(userId) === next) chains.delete(userId); });
    pending.add(done);
    done.then(() => pending.delete(done), () => pending.delete(done));
    return next;
  }

  async function deliver(rule: AlertRule, alert: Alert, event: PlatformEvent): Promise<Delivery[]> {
    const results = await Promise.all(rule.channels.map(async (cfg): Promise<Delivery> => {
      const channel = deps.channels.get(cfg.type);
      const at = now().toISOString();
      if (!channel) return { channel: cfg.type, ok: false, at, attempts: 0, error: `Channel '${cfg.type}' is not available on this server.` };
      try {
        const { attempts } = await channel.deliver(cfg, { alert, event, rule: { id: rule.id, name: rule.name } });
        return { channel: cfg.type, ok: true, at, attempts };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log.warn(`[ALERT] Delivery to ${cfg.type} failed for rule "${rule.name}": ${error}`);
        return { channel: cfg.type, ok: false, at, attempts: 0, error: error.slice(0, 300) };
      }
    }));
    return results;
  }

  /** An alert is found by its owner, or by the department(s) it belongs to. */
  const findAlert = (scope: AlertScope, id: string) => (typeof scope === 'string' ? deps.store.getAlert(scope, id) : 'all' in scope ? deps.store.getAlertAny(id) : deps.store.getAlertForDepartments(scope.departments, id));

  /**
   * Opens or extends alerts for `fresh` events under `owner`'s rules. `owner` is a person's id (their own rules, events on their cameras)
   * or `dept:<name>` (a department's rules, events on that department's cameras whoever owns them); the alert and its folding window
   * belong to that owner key.
   */
  async function raise(owner: string, fresh: PlatformEvent[], rules: AlertRule[], out: IngestResult): Promise<void> {
    for (const ev of fresh) {
      for (const rule of rules) {
        if (!ruleMatches(rule, ev)) continue;
        const key = throttleKey(rule, ev);
        const evMs = new Date(ev.ts).getTime();
        const live = rule.throttle.windowMs > 0 ? await deps.store.findLiveAlert(owner, rule.id, key, evMs - rule.throttle.windowMs) : null;
        if (live) {
          live.eventCount++;
          live.lastEventId = ev.id;
          if (ev.ts > live.lastEventAt) live.lastEventAt = ev.ts;
          if (severityRank(ev.severity) > severityRank(live.severity)) live.severity = ev.severity;
          await deps.store.saveAlert(live);
          out.alerts.push({ alert: live, opened: false });
          continue;
        }
        const alert: Alert = {
          id: newId(), userId: owner, ruleId: rule.id, ruleName: rule.name, key, state: 'open', severity: ev.severity,
          title: `${ev.summary} - ${ev.cameraName}`.slice(0, 300), cameraId: ev.cameraId, cameraName: ev.cameraName, ...(ev.department ? { department: ev.department } : {}),
          firstEventId: ev.id, lastEventId: ev.id, eventCount: 1, createdAt: now().toISOString(), lastEventAt: ev.ts, deliveries: [],
        };
        await deps.store.saveAlert(alert); // the alert exists even if delivery crashes
        alert.deliveries = await deliver(rule, alert, ev);
        await deps.store.saveAlert(alert);
        out.alerts.push({ alert, opened: true });
      }
    }
  }

  async function ingestForUser(userId: string, events: PlatformEvent[]): Promise<{ result: IngestResult; fresh: PlatformEvent[] }> {
    const fresh = await deps.store.saveEvents(events);
    const result: IngestResult = { stored: fresh.length, alerts: [] };
    if (fresh.length > 0) await raise(userId, fresh, await rulesFor(userId), result);
    return { result, fresh };
  }

  /** The department's own rules, for events (already stored) on that department's cameras. */
  async function ingestForDepartment(department: string, fresh: PlatformEvent[]): Promise<IngestResult> {
    const owner = departmentOwner(department);
    const result: IngestResult = { stored: 0, alerts: [] };
    await raise(owner, fresh, await rulesFor(owner), result);
    return result;
  }

  return {
    /** Stores events and raises alerts. Events of one user are processed in order; different users run side by side. */
    async ingest(events: PlatformEvent[]): Promise<IngestResult> {
      const byUser = new Map<string, PlatformEvent[]>();
      for (const e of events) byUser.set(e.userId, [...(byUser.get(e.userId) ?? []), e]);
      const parts = await Promise.all([...byUser].map(([u, list]) => serial(u, () => ingestForUser(u, list))));
      // A department's rules see every new event on its cameras, whoever owns the camera. Each department is handled one batch at a time.
      const byDept = new Map<string, PlatformEvent[]>();
      for (const p of parts) for (const e of p.fresh) if (e.department) byDept.set(e.department, [...(byDept.get(e.department) ?? []), e]);
      const deptParts = await Promise.all([...byDept].map(([d, list]) => serial(departmentOwner(d), () => ingestForDepartment(d, list))));
      const all = [...parts.map((p) => p.result), ...deptParts];
      return { stored: all.reduce((n, p) => n + p.stored, 0), alerts: all.flatMap((p) => p.alerts) };
    },

    /** Call after a rule is created, changed or deleted so the next event sees it. For a department's rule pass the rule's `userId` (`dept:<name>`). */
    invalidate(owner: string) { ruleCache.delete(owner); },

    async acknowledge(scope: AlertScope, alertId: string, by: string): Promise<Alert> {
      const a = await findAlert(scope, alertId);
      if (!a) throw new AlertError('No such alert.', 'not_found');
      if (a.state === 'resolved') throw new AlertError('The alert is already resolved.', 'bad_state');
      if (a.state === 'open') { a.state = 'acknowledged'; a.ackBy = by; a.ackAt = now().toISOString(); await deps.store.saveAlert(a); }
      return a;
    },

    async resolve(scope: AlertScope, alertId: string, by: string): Promise<Alert> {
      const a = await findAlert(scope, alertId);
      if (!a) throw new AlertError('No such alert.', 'not_found');
      if (a.state !== 'resolved') { a.state = 'resolved'; a.resolvedBy = by; a.resolvedAt = now().toISOString(); await deps.store.saveAlert(a); }
      return a;
    },

    /** Sends a made-up event through a rule's channels, so the receiver can be checked. Nothing is stored. */
    async test(rule: AlertRule, camera: { id: string; name: string }): Promise<Delivery[]> {
      const ts = now().toISOString();
      const event: PlatformEvent = { id: `test-${newId()}`, type: 'system.test', source: 'rule-test', severity: 'info', userId: rule.userId, cameraId: camera.id, cameraName: camera.name, ts, summary: `Test of rule "${rule.name}"`, data: { test: true }, tags: [] };
      const alert: Alert = { id: `test-${newId()}`, userId: rule.userId, ruleId: rule.id, ruleName: rule.name, key: 'test', state: 'open', severity: 'info', title: event.summary, cameraId: camera.id, cameraName: camera.name, firstEventId: event.id, lastEventId: event.id, eventCount: 1, createdAt: ts, lastEventAt: ts, deliveries: [] };
      return deliver(rule, alert, event);
    },

    redactRule,
    /** Resolves when everything started so far has finished (tests, shutdown). */
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}

export type AlertEngine = ReturnType<typeof createAlertEngine>;
