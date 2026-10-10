import { call } from './adminApi';

export type FederationScope = 'events.push' | 'sessions';
export const FEDERATION_SCOPES: Array<{ id: FederationScope; label: string; hint: string }> = [
  { id: 'events.push', label: 'Send events', hint: 'May push events (motion, plates, alarms) into the platform.' },
  { id: 'sessions', label: 'Open live sessions', hint: 'May take live-viewing slots, up to its session limit.' },
];

export interface FederationQuotas { eventsPerMinute: number; eventsPerDay: number; maxSessions: number }
export interface FederationUsage { eventsLastMinute: number; eventsToday: number; activeSessions: number; received: number; rejected: number; lastSeenAt: string | null; lastError: string | null }
export interface FederationClientRow {
  id: string; label?: string; department: string; ownerUserId: string; scopes: FederationScope[]; quotas: FederationQuotas; enabled: boolean; createdAt: string; usage: FederationUsage;
}
export interface FederationSessionRow { id: string; clientId: string; what: string; expiresAt: string }

const base = '/api/federation';
const enc = encodeURIComponent;

export const federationApi = {
  clients: () => call<{ clients: FederationClientRow[] }>(`${base}/clients`).then((r) => r.clients),
  sessions: () => call<{ sessions: FederationSessionRow[] }>(`${base}/sessions`).then((r) => r.sessions),
  create: (c: { id: string; department: string; label?: string; scopes: FederationScope[]; quotas: Partial<FederationQuotas> }) =>
    call<{ client: FederationClientRow; key: string }>(`${base}/clients`, { method: 'POST', body: c }),
  update: (id: string, patch: { label?: string; scopes?: FederationScope[]; quotas?: Partial<FederationQuotas>; enabled?: boolean }) =>
    call<{ client: FederationClientRow }>(`${base}/clients/${enc(id)}`, { method: 'PATCH', body: patch }),
  rotate: (id: string) => call<{ client: FederationClientRow; key: string }>(`${base}/clients/${enc(id)}/rotate`, { method: 'POST', body: {} }),
  remove: (id: string) => call<{ status: string }>(`${base}/clients/${enc(id)}`, { method: 'DELETE' }),
};
