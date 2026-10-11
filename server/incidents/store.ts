/**
 * Where incidents live (docs/incidents.md). An incident groups events that belong together across cameras, sources and departments,
 * so it is visible to every owner and department it touches, not to one owner like an alert. The memory store is complete and is
 * what the tests and a server without a database use; the Postgres store keeps the same data durably.
 */
import type { PgLike } from '../eventStore';
import type { Severity } from '../events/schema';

export type IncidentKind = 'plate_trail' | 'watchlist' | 'multi_source';
export type IncidentState = 'open' | 'closed';

export interface IncidentNote { text: string; by: string; at: string }

export interface Incident {
  id: string;
  kind: IncidentKind;
  /** What ties the events together, e.g. `trail:GJ01AB1234` or `cam:cam07`. One open incident per kind and key. */
  key: string;
  title: string;
  severity: Severity;
  state: IncidentState;
  /** Ids of the events in it (the newest 500). */
  eventIds: string[];
  eventCount: number;
  cameraIds: string[];
  cameraNames: string[];
  departments: string[];
  /** The owners of the cameras involved: they may see the incident (their own cameras are part of it). */
  userIds: string[];
  /** More than one department's cameras are involved. */
  crossDepartment: boolean;
  firstAt: string;
  lastAt: string;
  createdAt: string;
  closedAt?: string;
  closedBy?: string;
  /** When the incident was announced as an `incident.opened` event (once). */
  notifiedAt?: string;
  notes: IncidentNote[];
}

/** Who is asking: one user's, these departments', or everything (an organisation-wide administrator). */
export interface IncidentQuery { userId?: string; departments?: string[]; all?: boolean; state?: IncidentState; before?: Date; limit?: number }

export interface IncidentStore {
  readonly kind: string;
  ensureSchema(): Promise<void>;
  save(i: Incident): Promise<void>;
  get(id: string): Promise<Incident | null>;
  /** The open incident of this kind and key that last changed at or after `since` (ms). */
  findOpen(kind: IncidentKind, key: string, since: number): Promise<Incident | null>;
  list(q: IncidentQuery): Promise<Incident[]>;
}

const MAX_PAGE = 200;
const pageSize = (n: number | undefined) => Math.min(Math.max(1, Math.floor(n ?? 50) || 50), MAX_PAGE);
const clone = <T,>(v: T): T => structuredClone(v);

/** Whether a caller with this scope may see the incident. */
export function incidentVisible(i: Pick<Incident, 'userIds' | 'departments'>, scope: Pick<IncidentQuery, 'userId' | 'departments' | 'all'>): boolean {
  if (scope.all) return true;
  if (scope.departments) return i.departments.some((d) => scope.departments!.includes(d));
  return !!scope.userId && i.userIds.includes(scope.userId);
}

export function createMemoryIncidentStore(o: { max?: number } = {}): IncidentStore {
  const max = o.max ?? 2_000;
  const all = new Map<string, Incident>();
  return {
    kind: 'memory',
    async ensureSchema() { /* nothing to create */ },
    async save(i) {
      all.set(i.id, clone(i));
      if (all.size > max) {
        const oldest = [...all.values()].sort((a, b) => (a.lastAt < b.lastAt ? -1 : 1))[0];
        all.delete(oldest.id);
      }
    },
    async get(id) { const i = all.get(id); return i ? clone(i) : null; },
    async findOpen(kind, key, since) {
      const hit = [...all.values()].filter((i) => i.kind === kind && i.key === key && i.state === 'open' && new Date(i.lastAt).getTime() >= since)
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))[0];
      return hit ? clone(hit) : null;
    },
    async list(q) {
      return [...all.values()]
        .filter((i) => incidentVisible(i, q) && (!q.state || i.state === q.state) && (!q.before || new Date(i.lastAt).getTime() < q.before.getTime()))
        .sort((a, b) => (a.lastAt === b.lastAt ? (a.id < b.id ? 1 : -1) : a.lastAt < b.lastAt ? 1 : -1))
        .slice(0, pageSize(q.limit)).map(clone);
    },
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform_incidents (
  id          TEXT PRIMARY KEY,
  kind        TEXT        NOT NULL,
  key         TEXT        NOT NULL,
  state       TEXT        NOT NULL,
  last_at     TIMESTAMPTZ NOT NULL,
  user_ids    TEXT[]      NOT NULL DEFAULT '{}',
  departments TEXT[]      NOT NULL DEFAULT '{}',
  doc         JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_incidents_key ON platform_incidents (kind, key, last_at DESC);
CREATE INDEX IF NOT EXISTS platform_incidents_last ON platform_incidents (last_at DESC);
`;

export function createPostgresIncidentStore(pg: PgLike): IncidentStore {
  const docs = (rows: Array<{ doc: Incident }>) => rows.map((r) => r.doc);
  return {
    kind: 'postgres',
    async ensureSchema() { await pg.query(SCHEMA); },
    async save(i) {
      await pg.query(
        `INSERT INTO platform_incidents (id, kind, key, state, last_at, user_ids, departments, doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, last_at = EXCLUDED.last_at, user_ids = EXCLUDED.user_ids, departments = EXCLUDED.departments, doc = EXCLUDED.doc`,
        [i.id, i.kind, i.key, i.state, i.lastAt, i.userIds, i.departments, JSON.stringify(i)]);
    },
    async get(id) { return docs((await pg.query('SELECT doc FROM platform_incidents WHERE id = $1', [id])).rows)[0] ?? null; },
    async findOpen(kind, key, since) {
      return docs((await pg.query(
        `SELECT doc FROM platform_incidents WHERE kind = $1 AND key = $2 AND state = 'open' AND last_at >= $3 ORDER BY last_at DESC LIMIT 1`,
        [kind, key, new Date(since)])).rows)[0] ?? null;
    },
    async list(q) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (!q.all) {
        if (q.departments) { params.push(q.departments); where.push(`departments && $${params.length}`); }
        else { params.push(q.userId ?? ''); where.push(`$${params.length} = ANY(user_ids)`); }
      }
      if (q.state) { params.push(q.state); where.push(`state = $${params.length}`); }
      if (q.before) { params.push(q.before); where.push(`last_at < $${params.length}`); }
      params.push(pageSize(q.limit));
      return docs((await pg.query(`SELECT doc FROM platform_incidents WHERE ${where.join(' AND ') || 'TRUE'} ORDER BY last_at DESC, id DESC LIMIT $${params.length}`, params)).rows);
    },
  };
}
