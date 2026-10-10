import { call } from './adminApi';

export type Severity = 'info' | 'notice' | 'warning' | 'critical';
export const SEVERITIES: Severity[] = ['info', 'notice', 'warning', 'critical'];

export interface EventRow {
  id: string; type: string; source: string; severity: Severity; cameraId: string; cameraName: string; department?: string;
  ts: string; summary: string; data: Record<string, unknown>; confidence?: number; tags: string[];
}
export interface AlertRow {
  id: string; ruleId: string; ruleName: string; state: 'open' | 'acknowledged' | 'resolved'; severity: Severity; title: string;
  cameraId: string; cameraName: string; department?: string; eventCount: number; createdAt: string; lastEventAt: string;
  ackBy?: string; resolvedBy?: string; deliveries: Array<{ channel: string; ok: boolean; error?: string }>;
}
export type ChannelCfg = { type: 'webhook'; url: string; secret?: string } | { type: 'log' };
export interface RuleRow {
  id: string; name: string; enabled: boolean; department?: string;
  match: { types?: string[]; minSeverity?: Severity; tags?: string[]; cameraIds?: string[]; departments?: string[]; sources?: string[] };
  throttle: { windowMs: number; by: Array<'camera' | 'type' | 'event' | 'rule'> };
  channels: ChannelCfg[];
  schedule?: unknown;
}
export interface RuleInput { name: string; enabled: boolean; match: RuleRow['match']; throttle: RuleRow['throttle']; channels: ChannelCfg[]; schedule?: unknown; department?: string }
export interface EventFilters { q?: string; types?: string[]; minSeverity?: Severity; tag?: string; department?: string; from?: Date; cursor?: string; limit?: number; count?: boolean }
export interface GatewayRow { id: string; name: string; region: string; state: string; lastHeartbeatAt: string | null; problems: string[]; assignedCameras: number | null }
export interface VmsSystemRow { id: string; label?: string; kind: string; department?: string; status: null | { state: string; lastOkAt: string | null; lastError: string | null; cameras: number; eventsForwarded: number } }

const qs = (o: Record<string, string | string[] | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]) p.append(k, x);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** A server without the service answers the page itself (or nothing useful): say so instead of showing an empty list. */
function list<T>(v: T[] | undefined): T[] {
  if (!Array.isArray(v)) throw new Error('This server does not offer this service.');
  return v;
}

export const eventsApi = {
  events: (f: EventFilters = {}) => call<{ events: EventRow[]; nextCursor?: string; total?: number }>('/api/events' + qs({
    q: f.q?.trim(), type: f.types, minSeverity: f.minSeverity, tag: f.tag?.trim().toLowerCase(), department: f.department?.trim(), from: f.from?.toISOString(),
    cursor: f.cursor, limit: String(f.limit ?? 50), count: f.count ? '1' : undefined,
  })).then((r) => ({ ...r, events: list(r.events) })),
  setTags: (id: string, tags: string[]) => call<{ event: EventRow }>(`/api/events/${encodeURIComponent(id)}/tags`, { method: 'PUT', body: { tags } }).then((r) => r.event),
  eventTypes: () => call<{ types: Array<{ type: string; severity: Severity; description: string }> }>('/api/event-types').then((r) => r.types),
  alerts: (state?: AlertRow['state']) => call<{ alerts: AlertRow[] }>('/api/alerts' + qs({ state, limit: '100' })).then((r) => list(r.alerts)),
  acknowledge: (id: string) => call<{ alert: AlertRow }>(`/api/alerts/${encodeURIComponent(id)}/acknowledge`, { method: 'POST', body: {} }).then((r) => r.alert),
  resolve: (id: string) => call<{ alert: AlertRow }>(`/api/alerts/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: {} }).then((r) => r.alert),
  rules: () => call<{ rules: RuleRow[] }>('/api/alert-rules').then((r) => list(r.rules)),
  createRule: (rule: RuleInput) => call<{ rule: RuleRow }>('/api/alert-rules', { method: 'POST', body: rule }).then((r) => r.rule),
  updateRule: (id: string, rule: RuleInput) => call<{ rule: RuleRow }>(`/api/alert-rules/${encodeURIComponent(id)}`, { method: 'PUT', body: rule }).then((r) => r.rule),
  deleteRule: (id: string) => call<{ status: string }>(`/api/alert-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testRule: (id: string) => call<{ deliveries: Array<{ channel: string; ok: boolean; error?: string }> }>(`/api/alert-rules/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} }).then((r) => r.deliveries),
  gateways: () => call<{ gateways: GatewayRow[] }>('/api/gateways').then((r) => list(r.gateways)),
  vmsSystems: () => call<{ systems: VmsSystemRow[] }>('/api/vms').then((r) => list(r.systems)),
};

/** Rule fields the server accepts back on an edit (it refuses the read-only ones such as id and createdAt). */
export const ruleInputOf = (r: RuleRow, patch: Partial<RuleInput> = {}): RuleInput => ({
  name: r.name, enabled: r.enabled, match: r.match, throttle: r.throttle, channels: r.channels, ...(r.schedule ? { schedule: r.schedule } : {}), ...patch,
});
