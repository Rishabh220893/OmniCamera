/**
 * Where a camera that was onboarded through an adapter is remembered: which adapter, how it is addressed (without its login), and
 * the sealed address the media server pulls from. The memory store is complete (tests, a server without a database); the Postgres
 * store keeps the same data durably. The login is never a column of its own: it only exists inside `sealed`.
 */
import type { PgLike } from '../eventStore';

/** The profile site all adapter cameras live under (their `cameraId` is the media-server path name). */
export const SOURCES_SITE = 'federated';
/** Every media-server path of an onboarded camera starts with this, so the apply can recognise (and remove) them. */
export const SOURCE_PATH_PREFIX = 'fed-';

export interface SourceRecord {
  site: string;
  /** The media-server path name and the profile's camera id, e.g. `fed-3f9a1c2b7d4e`. Unguessable on purpose (see docs/adapters.md). */
  cameraId: string;
  adapter: string;
  name: string;
  /** How the device is addressed, with no login: host, port, options, and a URL with its login removed. */
  ref: { host?: string; port?: number; url?: string; options?: Record<string, unknown> };
  /** `SecretBox.seal` of a JSON `{ rtspUrl }`: the address the media server pulls, login included. null when the source needs none stored. */
  sealed: string | null;
  /** The camera's document in the Registry (Firestore), once created. */
  registryId: string | null;
  ownerUid: string;
  departmentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceStore {
  readonly kind: string;
  ensureSchema(): Promise<void>;
  put(rec: SourceRecord): Promise<void>;
  get(site: string, cameraId: string): Promise<SourceRecord | null>;
  list(site: string): Promise<SourceRecord[]>;
  remove(site: string, cameraId: string): Promise<boolean>;
}

export function createMemorySourceStore(): SourceStore {
  const rows = new Map<string, SourceRecord>();
  const key = (s: string, c: string) => `${s}\u0000${c}`;
  return {
    kind: 'memory',
    async ensureSchema() { /* nothing to create */ },
    async put(rec) { rows.set(key(rec.site, rec.cameraId), structuredClone(rec)); },
    async get(site, id) { const r = rows.get(key(site, id)); return r ? structuredClone(r) : null; },
    async list(site) { return [...rows.values()].filter((r) => r.site === site).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => structuredClone(r)); },
    async remove(site, id) { return rows.delete(key(site, id)); },
  };
}

export const SOURCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS camera_sources (
  site        TEXT        NOT NULL,
  camera_id   TEXT        NOT NULL,
  adapter     TEXT        NOT NULL,
  department  TEXT,
  registry_id TEXT,
  created     TIMESTAMPTZ NOT NULL,
  doc         JSONB       NOT NULL,
  PRIMARY KEY (site, camera_id)
);
CREATE INDEX IF NOT EXISTS camera_sources_registry ON camera_sources (registry_id);
`;

export function createPostgresSourceStore(pg: PgLike): SourceStore {
  const docs = (rows: Array<{ doc: SourceRecord }>) => rows.map((r) => r.doc);
  return {
    kind: 'postgres',
    async ensureSchema() { await pg.query(SOURCE_SCHEMA); },
    async put(rec) {
      await pg.query(
        `INSERT INTO camera_sources (site, camera_id, adapter, department, registry_id, created, doc) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (site, camera_id) DO UPDATE SET adapter = EXCLUDED.adapter, department = EXCLUDED.department, registry_id = EXCLUDED.registry_id, doc = EXCLUDED.doc`,
        [rec.site, rec.cameraId, rec.adapter, rec.departmentId, rec.registryId, rec.createdAt, JSON.stringify(rec)]);
    },
    async get(site, id) { return docs((await pg.query('SELECT doc FROM camera_sources WHERE site = $1 AND camera_id = $2', [site, id])).rows)[0] ?? null; },
    async list(site) { return docs((await pg.query('SELECT doc FROM camera_sources WHERE site = $1 ORDER BY created', [site])).rows); },
    async remove(site, id) { return ((await pg.query('DELETE FROM camera_sources WHERE site = $1 AND camera_id = $2', [site, id])).rowCount ?? 0) > 0; },
  };
}
