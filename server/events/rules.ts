/**
 * Alert rules: which events matter to whom, when, and how often they may fire. Pure functions, no I/O.
 * A rule matches on the event's shape only (type, severity, camera, department, tags, fields of `data`), never on which analyzer
 * produced it.
 */
import { isSeverity, severityRank, EVENT_TYPE_RE, type PlatformEvent, type Severity } from './schema';

export type CondOp = 'eq' | 'neq' | 'in' | 'contains' | 'startsWith' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
export interface Cond { field: string; op: CondOp; value?: unknown }

export type ChannelConfig =
  | { type: 'webhook'; url: string; secret?: string }
  | { type: 'log' };

export interface Schedule {
  /** 0 = Sunday ... 6 = Saturday, in the rule's time zone. Empty or absent = every day. */
  days?: number[];
  /** `HH:MM`. `from` later than `to` means overnight (22:00 to 06:00). */
  from?: string;
  to?: string;
  /** Minutes east of UTC (India = 330). Default 0. */
  tzOffsetMin?: number;
}

export type ThrottleKey = 'camera' | 'type' | 'event' | 'rule';
export interface Throttle {
  /** After an alert fires, the same key is folded into it for this long instead of alerting again. 0 = every event alerts. */
  windowMs: number;
  /** What makes two events "the same": same camera, same type, same dedupe id (e.g. same plate), or everything for the rule. */
  by: ThrottleKey[];
}

export interface AlertRule {
  id: string;
  /** The owner key: a person's id, or `dept:<department>` for a department's rule (see `department`). */
  userId: string;
  /** Set on a department's rule: it fires for events on that department's cameras, whoever owns the camera. */
  department?: string;
  /** Who made a department's rule (its `userId` is the department's). */
  createdBy?: string;
  name: string;
  enabled: boolean;
  match: {
    /** Exact types or groups with a trailing `.*` (`plate.*`). Empty = any type. */
    types?: string[];
    minSeverity?: Severity;
    cameraIds?: string[];
    departments?: string[];
    sources?: string[];
    /** The event must carry all of these tags. */
    tags?: string[];
    /** Every condition must hold. `field` is `data.<key>`, `confidence`, `severity`, `cameraId`, ... */
    where?: Cond[];
  };
  schedule?: Schedule;
  throttle: Throttle;
  channels: ChannelConfig[];
  createdAt: string;
  updatedAt: string;
}

export class RuleError extends Error {
  constructor(readonly problems: string[]) { super(problems.join(' ')); this.name = 'RuleError'; }
}

const OPS: readonly CondOp[] = ['eq', 'neq', 'in', 'contains', 'startsWith', 'gt', 'gte', 'lt', 'lte', 'exists'];
const PATH_RE = /^(data\.)?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TOP_FIELDS = new Set(['type', 'source', 'severity', 'cameraId', 'cameraName', 'department', 'confidence', 'summary']);

const strList = (v: unknown, max: number, what: string, problems: string[], each?: (s: string) => string | null): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x || x.length > 200)) { problems.push(`'${what}' must be a list of up to ${max} non-empty strings.`); return undefined; }
  for (const s of v as string[]) { const bad = each?.(s); if (bad) problems.push(bad); }
  return v as string[];
};

const hhmm = (s: unknown) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Checks a rule from outside (the API) and returns the clean version. `existing` supplies id, owner and creation time on update. */
export function validateRule(input: unknown, o: { userId: string; id: string; now: Date; existing?: AlertRule; allowChannel?: (c: ChannelConfig) => string | null; department?: string; createdBy?: string }): AlertRule {
  const problems: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuleError(['The rule must be a JSON object.']);
  const r = input as Record<string, any>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || name.length > 120) problems.push("'name' is required (up to 120 characters).");

  const m = (r.match && typeof r.match === 'object' && !Array.isArray(r.match) ? r.match : {}) as Record<string, any>;
  const match: AlertRule['match'] = {};
  const types = strList(m.types, 30, 'match.types', problems, (t) => (EVENT_TYPE_RE.test(t) || /^[a-z][a-z0-9_]*\.\*$/.test(t) ? null : `'${t}' is not an event type; use 'group.name' or 'group.*'.`));
  if (types?.length) match.types = types;
  if (m.minSeverity !== undefined) { if (isSeverity(m.minSeverity)) match.minSeverity = m.minSeverity; else problems.push("'match.minSeverity' must be info, notice, warning or critical."); }
  for (const key of ['cameraIds', 'departments', 'sources', 'tags'] as const) {
    const l = strList(m[key], 200, `match.${key}`, problems);
    if (l?.length) match[key] = l;
  }
  if (m.where !== undefined) {
    if (!Array.isArray(m.where) || m.where.length > 20) problems.push("'match.where' must be a list of up to 20 conditions.");
    else {
      const where: Cond[] = [];
      m.where.forEach((c: any, i: number) => {
        if (!c || typeof c !== 'object') { problems.push(`match.where[${i}] must be an object.`); return; }
        const top = typeof c.field === 'string' ? c.field.split('.')[0] : '';
        if (typeof c.field !== 'string' || !PATH_RE.test(c.field) || (!c.field.startsWith('data.') && !TOP_FIELDS.has(top))) { problems.push(`match.where[${i}].field must be 'data.<name>' or one of ${[...TOP_FIELDS].join(', ')}.`); return; }
        if (!OPS.includes(c.op)) { problems.push(`match.where[${i}].op must be one of ${OPS.join(', ')}.`); return; }
        if (c.op !== 'exists' && c.value === undefined) { problems.push(`match.where[${i}] needs a value.`); return; }
        if (c.op === 'in' && !Array.isArray(c.value)) { problems.push(`match.where[${i}]: 'in' needs a list.`); return; }
        if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && typeof c.value !== 'number') { problems.push(`match.where[${i}]: '${c.op}' needs a number.`); return; }
        where.push({ field: c.field, op: c.op, ...(c.value !== undefined ? { value: c.value } : {}) });
      });
      if (where.length) match.where = where;
    }
  }

  let schedule: Schedule | undefined;
  if (r.schedule !== undefined && r.schedule !== null) {
    const s = r.schedule as Record<string, any>;
    schedule = {};
    if (s.days !== undefined) {
      if (!Array.isArray(s.days) || s.days.some((d: unknown) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) problems.push("'schedule.days' must be numbers 0 (Sunday) to 6.");
      else if (s.days.length) schedule.days = [...new Set<number>(s.days)].sort();
    }
    if ((s.from === undefined) !== (s.to === undefined)) problems.push("'schedule' needs both 'from' and 'to', or neither.");
    else if (s.from !== undefined) { if (hhmm(s.from) && hhmm(s.to)) { schedule.from = s.from; schedule.to = s.to; } else problems.push("'schedule.from' and 'schedule.to' must be HH:MM."); }
    if (s.tzOffsetMin !== undefined) { if (Number.isInteger(s.tzOffsetMin) && Math.abs(s.tzOffsetMin) <= 14 * 60) schedule.tzOffsetMin = s.tzOffsetMin; else problems.push("'schedule.tzOffsetMin' must be minutes between -840 and 840."); }
    if (!schedule.days && !schedule.from) schedule = undefined;
  }

  const t = (r.throttle && typeof r.throttle === 'object' ? r.throttle : {}) as Record<string, any>;
  const windowMs = t.windowMs === undefined ? 5 * 60_000 : t.windowMs;
  if (!Number.isFinite(windowMs) || windowMs < 0 || windowMs > 7 * 24 * 3_600_000) problems.push("'throttle.windowMs' must be between 0 and 7 days.");
  const by: ThrottleKey[] = t.by === undefined ? ['camera', 'type'] : t.by;
  if (!Array.isArray(by) || by.length === 0 || by.some((k) => !['camera', 'type', 'event', 'rule'].includes(k))) problems.push("'throttle.by' must list camera, type, event or rule.");

  const channels: ChannelConfig[] = [];
  if (!Array.isArray(r.channels) || r.channels.length === 0 || r.channels.length > 5) problems.push("'channels' must list 1 to 5 delivery channels.");
  else {
    r.channels.forEach((c: any, i: number) => {
      if (c?.type === 'log') channels.push({ type: 'log' });
      else if (c?.type === 'webhook') {
        if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url) || c.url.length > 1000) { problems.push(`channels[${i}].url must be an http(s) address.`); return; }
        // An edit may send back the redacted secret; keep the stored one then.
        const prev = o.existing?.channels.find((x): x is Extract<ChannelConfig, { type: 'webhook' }> => x.type === 'webhook' && x.url === c.url);
        const secret = c.secret === REDACTED ? prev?.secret : typeof c.secret === 'string' && c.secret ? c.secret.slice(0, 200) : undefined;
        const ch: ChannelConfig = { type: 'webhook', url: c.url, ...(secret ? { secret } : {}) };
        const bad = o.allowChannel?.(ch);
        if (bad) problems.push(`channels[${i}]: ${bad}`); else channels.push(ch);
      } else problems.push(`channels[${i}].type must be 'webhook' or 'log'.`);
    });
  }

  if (problems.length) throw new RuleError(problems);
  return {
    id: o.id, userId: o.userId, ...(o.department ? { department: o.department } : {}), ...(o.createdBy ? { createdBy: o.createdBy } : {}), name, enabled: r.enabled !== false, match, ...(schedule ? { schedule } : {}),
    throttle: { windowMs, by: [...new Set(by)] }, channels,
    createdAt: o.existing?.createdAt ?? o.now.toISOString(), updatedAt: o.now.toISOString(),
  };
}

export const REDACTED = '********';

/** A department name as the platform accepts it (the same rule as the claims in server/authz). */
export const DEPARTMENT_NAME_RE = /^[\w .&-]{1,80}$/;

/** The rule as the API shows it: secrets replaced. */
export function redactRule(rule: AlertRule): AlertRule {
  return { ...rule, channels: rule.channels.map((c) => (c.type === 'webhook' && c.secret ? { ...c, secret: REDACTED } : c)) };
}

// ---- matching -----------------------------------------------------------------------------------------------------

export function getField(ev: PlatformEvent, field: string): unknown {
  if (field.startsWith('data.')) return field.slice(5).split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ev.data);
  return (ev as unknown as Record<string, unknown>)[field];
}

function holds(c: Cond, ev: PlatformEvent): boolean {
  const v = getField(ev, c.field);
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null;
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'in': return Array.isArray(c.value) && c.value.includes(v);
    case 'contains': return Array.isArray(v) ? v.includes(c.value) : typeof v === 'string' && typeof c.value === 'string' && v.toLowerCase().includes(c.value.toLowerCase());
    case 'startsWith': return typeof v === 'string' && typeof c.value === 'string' && v.toLowerCase().startsWith(c.value.toLowerCase());
    default: {
      if (typeof v !== 'number' || typeof c.value !== 'number') return false;
      return c.op === 'gt' ? v > c.value : c.op === 'gte' ? v >= c.value : c.op === 'lt' ? v < c.value : v <= c.value;
    }
  }
}

const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

/** Whether `at` falls in the schedule (always true without one). */
export function inSchedule(s: Schedule | undefined, at: Date): boolean {
  if (!s) return true;
  const local = new Date(at.getTime() + (s.tzOffsetMin ?? 0) * 60_000);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  let day = local.getUTCDay();
  if (s.from && s.to) {
    const from = minutesOf(s.from), to = minutesOf(s.to);
    if (from === to) return false;
    if (from < to) { if (mins < from || mins >= to) return false; }
    else {
      if (mins >= from) { /* evening part: today's day */ }
      else if (mins < to) day = (day + 6) % 7; // the morning part belongs to the day the window started
      else return false;
    }
  }
  return !s.days?.length || s.days.includes(day);
}

/** Whether the event should fire the rule. `at` is the time used for the schedule: when the event happened. */
export function ruleMatches(rule: AlertRule, ev: PlatformEvent): boolean {
  if (!rule.enabled) return false;
  const m = rule.match;
  if (m.types?.length && !m.types.some((t) => (t.endsWith('.*') ? ev.type.startsWith(t.slice(0, -1)) : ev.type === t))) return false;
  if (m.minSeverity && severityRank(ev.severity) < severityRank(m.minSeverity)) return false;
  if (m.cameraIds?.length && !m.cameraIds.includes(ev.cameraId)) return false;
  if (m.departments?.length && !(ev.department && m.departments.includes(ev.department))) return false;
  if (m.sources?.length && !m.sources.includes(ev.source)) return false;
  if (m.tags?.length && !m.tags.every((t) => ev.tags.includes(t))) return false;
  if (m.where?.length && !m.where.every((c) => holds(c, ev))) return false;
  return inSchedule(rule.schedule, new Date(ev.ts));
}

/** Events with the same key fold into one alert while the window lasts. */
export function throttleKey(rule: AlertRule, ev: PlatformEvent): string {
  const parts: string[] = [rule.id];
  for (const k of [...rule.throttle.by].sort()) {
    if (k === 'camera') parts.push(`camera=${ev.cameraId}`);
    else if (k === 'type') parts.push(`type=${ev.type}`);
    else if (k === 'event') parts.push(`event=${dedupeOf(ev)}`);
  }
  return parts.join('|');
}

/** What identifies "the same thing" across frames: the plate, the person's name, or else the summary. */
function dedupeOf(ev: PlatformEvent): string {
  const d = ev.data;
  const pick = d.plate ?? d.name ?? d.text ?? d.reason ?? ev.summary;
  return String(pick);
}
