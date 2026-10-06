import type { Firestore } from 'firebase-admin/firestore';
import type { buildLogDocument } from './logEntry';
import type { PlateSighting } from '../src/lib/plateTracking';
import { writeSightings as writeFirestoreSightings } from './sightingStore';

/**
 * Where the analysis worker puts what it finds.
 *
 * Firestore is a poor home for an event firehose: every analysis is a document write (plus index
 * entries), billed per operation, with no cheap range scans or aggregates. Events (logs and plate
 * sightings) therefore go through this interface so the system of record can be a real time-series
 * store (Postgres/TimescaleDB), while Firestore keeps what it is good at — camera config, auth,
 * and the live feed the current UI listens to.
 *
 *   EVENT_STORE=firestore            (default) every log and sighting goes to Firestore, as before
 *   EVENT_STORE=postgres             Postgres is the record; Firestore gets a bounded live feed
 *                                    (see FIRESTORE_LOG_MODE) so the existing UI keeps working
 */
export type LogDocument = ReturnType<typeof buildLogDocument>;

export interface EventStore {
  readonly kind: string;
  writeLog(doc: LogDocument): Promise<void>;
  writeSightings(userId: string, sightings: PlateSighting[]): Promise<void>;
}

/** Which logs also reach Firestore (the live feed the browser subscribes to). */
export type FirestoreLogMode = 'all' | 'notable' | 'none';

export const isNotable = (doc: Pick<LogDocument, 'isUnusual' | 'isWatchlistMatch' | 'alerts'>): boolean =>
  doc.isUnusual || doc.isWatchlistMatch || doc.alerts.length > 0;

export function createFirestoreEventStore(db: Firestore, logMode: FirestoreLogMode = 'all'): EventStore {
  return {
    kind: `firestore(${logMode})`,
    async writeLog(doc) {
      if (logMode === 'none' || (logMode === 'notable' && !isNotable(doc))) return;
      await db.collection('logs').add(doc);
    },
    // Sightings stay in Firestore: the Vehicle tracker reads them from there directly.
    writeSightings: (userId, sightings) => writeFirestoreSightings(db, userId, sightings),
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/** The slice of `pg`'s Pool this file uses, so tests can pass a fake. */
export interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_logs (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            TEXT        NOT NULL,
  camera_id          TEXT        NOT NULL,
  camera_name        TEXT        NOT NULL,
  ts                 TIMESTAMPTZ NOT NULL,
  summary            TEXT        NOT NULL,
  sentiment          TEXT        NOT NULL,
  is_unusual         BOOLEAN     NOT NULL,
  unusual_reason     TEXT        NOT NULL,
  is_watchlist_match BOOLEAN     NOT NULL,
  people             INTEGER     NOT NULL,
  vehicles           INTEGER     NOT NULL,
  other              INTEGER     NOT NULL,
  detected_plates    TEXT[]      NOT NULL,
  analyzed_by        TEXT        NOT NULL,
  doc                JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_logs_user_ts ON analysis_logs (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS analysis_logs_user_camera_ts ON analysis_logs (user_id, camera_id, ts DESC);
CREATE INDEX IF NOT EXISTS analysis_logs_notable ON analysis_logs (user_id, ts DESC) WHERE is_unusual OR is_watchlist_match;
CREATE TABLE IF NOT EXISTS plate_sightings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT        NOT NULL,
  plate       TEXT        NOT NULL,
  camera_id   TEXT        NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  doc         JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS plate_sightings_user_plate_ts ON plate_sightings (user_id, plate, ts DESC);
`;

const MAX_PAGE = 500;

export interface LogQuery { userId: string; cameraId?: string; from?: Date; to?: Date; onlyNotable?: boolean; limit?: number; before?: Date }

export interface PostgresEventStore extends EventStore {
  ensureSchema(): Promise<void>;
  queryLogs(q: LogQuery): Promise<Array<Record<string, unknown>>>;
  querySightings(userId: string, plate: string, limit?: number): Promise<Array<Record<string, unknown>>>;
}

export function createPostgresEventStore(pg: PgLike): PostgresEventStore {
  return {
    kind: 'postgres',
    ensureSchema: async () => { await pg.query(POSTGRES_SCHEMA); },

    async writeLog(doc) {
      await pg.query(
        `INSERT INTO analysis_logs (user_id, camera_id, camera_name, ts, summary, sentiment, is_unusual, unusual_reason,
           is_watchlist_match, people, vehicles, other, detected_plates, analyzed_by, doc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [doc.userId, doc.cameraId, doc.cameraName, doc.timestamp, doc.summary, doc.sentiment, doc.isUnusual, doc.unusualReason,
          doc.isWatchlistMatch, doc.counts.people, doc.counts.vehicles, doc.counts.other, doc.detectedPlates, doc.analyzedBy,
          JSON.stringify(doc)],
      );
    },

    async writeSightings(userId, sightings) {
      if (sightings.length === 0) return;
      // One round trip for the whole batch. Same id → same sighting, so a retried job can't double-count.
      const params: unknown[] = [];
      const rows = sightings.map((s, i) => {
        const base = i * 6;
        params.push(s.id, userId, s.plate, s.cameraId, s.timestamp, JSON.stringify(s));
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
      });
      await pg.query(
        `INSERT INTO plate_sightings (id, user_id, plate, camera_id, ts, doc) VALUES ${rows.join(',')} ON CONFLICT (id) DO NOTHING`,
        params,
      );
    },

    async queryLogs(q) {
      const where = ['user_id = $1'];
      const params: unknown[] = [q.userId];
      const add = (clause: string, value: unknown) => { params.push(value); where.push(clause.replace('?', `$${params.length}`)); };
      if (q.cameraId) add('camera_id = ?', q.cameraId);
      if (q.from) add('ts >= ?', q.from);
      if (q.to) add('ts < ?', q.to);
      if (q.before) add('ts < ?', q.before);
      if (q.onlyNotable) where.push('(is_unusual OR is_watchlist_match)');
      params.push(Math.min(Math.max(1, q.limit ?? 100), MAX_PAGE));
      const res = await pg.query(`SELECT doc FROM analysis_logs WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT $${params.length}`, params);
      return res.rows.map((r) => r.doc);
    },

    async querySightings(userId, plate, limit = 200) {
      const res = await pg.query(
        'SELECT doc FROM plate_sightings WHERE user_id = $1 AND plate = $2 ORDER BY ts DESC LIMIT $3',
        [userId, plate, Math.min(Math.max(1, limit), MAX_PAGE)],
      );
      return res.rows.map((r) => r.doc);
    },
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Writes to several stores. The first is the system of record: if it fails the write fails (so the
 * worker retries). Later stores are best-effort mirrors — a Firestore hiccup must not lose or
 * repeat an event that is already safely in Postgres.
 */
export function createTeeEventStore(primary: EventStore, mirrors: EventStore[], onMirrorError: (name: string, err: unknown) => void = () => {}): EventStore {
  const mirror = (name: string, run: (s: EventStore) => Promise<void>) =>
    Promise.all(mirrors.map((m) => run(m).catch((err) => onMirrorError(`${name} → ${m.kind}`, err))));
  return {
    kind: [primary.kind, ...mirrors.map((m) => m.kind)].join(' + '),
    async writeLog(doc) {
      await primary.writeLog(doc);
      await mirror('log', (m) => m.writeLog(doc));
    },
    async writeSightings(userId, sightings) {
      await primary.writeSightings(userId, sightings);
      await mirror('sightings', (m) => m.writeSightings(userId, sightings));
    },
  };
}
