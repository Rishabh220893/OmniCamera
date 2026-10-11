/**
 * The registry's spatial read model in PostgreSQL + PostGIS (Model 1's suggested store).
 *
 * Firestore stays the system of record: the app's screens write cameras straight to it under per-user and per-department rules, and
 * those paths are not touched. This module keeps a COPY in `registry_cameras`, fed by a listener on the Firestore `cameras`
 * collection (so writes from the screens, the registry API and adapters are all caught), and answers the spatial questions
 * (bounding box, filters, uncovered zones) that Firestore cannot. Everything here fails soft: a database that is down, slow or
 * without PostGIS makes the mirror report "not ready" and callers fall back to Firestore. Nothing here throws into the app.
 * Off unless REGISTRY_POSTGIS=true and DATABASE_URL are set (server.ts).
 */
import type { RegistryCamera, RegistryFilter } from './query';

export interface SqlClient { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export const REGISTRY_DDL = [
  'CREATE EXTENSION IF NOT EXISTS postgis',
  `CREATE TABLE IF NOT EXISTS registry_cameras (
     id text PRIMARY KEY, user_id text NOT NULL DEFAULT '', department_id text, name text NOT NULL DEFAULT '', department text, ownership text, camera_type text,
     connectivity_status text NOT NULL DEFAULT 'unknown', maintenance_status text NOT NULL DEFAULT 'operational', install_date date, storage_details text,
     onboarded_via text, gateway_id text, geom geography(Point, 4326), updated_at timestamptz NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS registry_cameras_geom_idx ON registry_cameras USING gist (geom)',
  'CREATE INDEX IF NOT EXISTS registry_cameras_user_idx ON registry_cameras (user_id)',
  'CREATE INDEX IF NOT EXISTS registry_cameras_dept_idx ON registry_cameras (department)',
];

const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export interface RegistryRow {
  id: string; userId: string; departmentId: string | null; name: string; department: string | null; ownership: string | null; cameraType: string | null;
  connectivityStatus: string; maintenanceStatus: string; installDate: string | null; storageDetails: string | null; onboardedVia: string | null; gatewayId: string | null;
  lng: number | null; lat: number | null;
}

/** A Firestore camera document as a row. Bad values become null rather than failing the whole batch (the document is the user's, not ours to reject). */
export function toRow(id: string, d: Record<string, unknown>): RegistryRow {
  const loc = (d.location ?? {}) as { lat?: unknown; lng?: unknown };
  const lat = typeof loc.lat === 'number' && Number.isFinite(loc.lat) && Math.abs(loc.lat) <= 90 ? loc.lat : null;
  const lng = typeof loc.lng === 'number' && Number.isFinite(loc.lng) && Math.abs(loc.lng) <= 180 ? loc.lng : null;
  const date = str(d.installDate, 10);
  return {
    id: String(id).slice(0, 200), userId: str(d.userId, 200) ?? '', departmentId: str(d.departmentId, 200), name: str(d.name, 300) ?? '', department: str(d.department, 200), ownership: str(d.ownership, 300),
    cameraType: str(d.cameraType, 100), connectivityStatus: str(d.connectivityStatus, 20) ?? 'unknown', maintenanceStatus: str(d.maintenanceStatus, 30) ?? 'operational',
    installDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : null, storageDetails: str(d.storageDetails, 500), onboardedVia: str(d.onboardedVia, 30), gatewayId: str(d.gatewayId, 200),
    lng: lat !== null && lng !== null ? lng : null, lat: lat !== null && lng !== null ? lat : null,
  };
}

const COLS = 14; // placeholders per row below
export function upsertSql(rows: RegistryRow[]): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const values = rows.map((r, i) => {
    const b = i * COLS;
    params.push(r.id, r.userId, r.departmentId, r.name, r.department, r.ownership, r.cameraType, r.connectivityStatus, r.maintenanceStatus, r.installDate, r.storageDetails, r.onboardedVia, r.gatewayId, r.lng === null ? null : `POINT(${r.lng} ${r.lat})`);
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::date,$${b + 11},$${b + 12},$${b + 13},ST_GeogFromText($${b + 14}),now())`;
  });
  return {
    text: `INSERT INTO registry_cameras (id,user_id,department_id,name,department,ownership,camera_type,connectivity_status,maintenance_status,install_date,storage_details,onboarded_via,gateway_id,geom,updated_at) VALUES ${values.join(',')}
           ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, department_id=EXCLUDED.department_id, name=EXCLUDED.name, department=EXCLUDED.department, ownership=EXCLUDED.ownership, camera_type=EXCLUDED.camera_type,
             connectivity_status=EXCLUDED.connectivity_status, maintenance_status=EXCLUDED.maintenance_status, install_date=EXCLUDED.install_date, storage_details=EXCLUDED.storage_details,
             onboarded_via=EXCLUDED.onboarded_via, gateway_id=EXCLUDED.gateway_id, geom=EXCLUDED.geom, updated_at=now()`,
    params,
  };
}

/** The filter of the registry API as a parameterised query; every value is bound, never spliced into the text. */
export function selectSql(userId: string, f: RegistryFilter): { text: string; params: unknown[] } {
  const params: unknown[] = [userId];
  const where = ['user_id = $1'];
  const add = (cond: (p: string) => string, v: unknown) => { params.push(v); where.push(cond(`$${params.length}`)); };
  if (f.q) add((p) => `(name ILIKE ${p} OR department ILIKE ${p} OR ownership ILIKE ${p} OR storage_details ILIKE ${p})`, `%${f.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  if (f.department) add((p) => `lower(department) = lower(${p})`, f.department);
  if (f.status) add((p) => `connectivity_status = ${p}`, f.status);
  if (f.maintenance) add((p) => `maintenance_status = ${p}`, f.maintenance);
  if (f.type) add((p) => `camera_type = ${p}`, f.type);
  if (f.installedBefore) add((p) => `install_date < ${p}::date`, f.installedBefore);
  if (f.bbox) {
    params.push(...f.bbox);
    const n = params.length;
    where.push(`geom && ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)::geography`);
  }
  return {
    text: `SELECT id, user_id, department_id, name, department, ownership, camera_type, connectivity_status, maintenance_status, to_char(install_date, 'YYYY-MM-DD') AS install_date, storage_details, onboarded_via, gateway_id, ST_X(geom::geometry) AS lng, ST_Y(geom::geometry) AS lat
           FROM registry_cameras WHERE ${where.join(' AND ')} ORDER BY name, id`,
    params,
  };
}

/** A row in the shape of the registry API's JSON (the same field names the Firestore documents use). */
export function fromRow(r: any): RegistryCamera {
  const o: RegistryCamera = {
    id: r.id, userId: r.user_id, name: r.name, connectivityStatus: r.connectivity_status, maintenanceStatus: r.maintenance_status,
  };
  if (r.department_id) o.departmentId = r.department_id;
  if (r.department) o.department = r.department;
  if (r.ownership) o.ownership = r.ownership;
  if (r.camera_type) o.cameraType = r.camera_type;
  if (r.install_date) o.installDate = r.install_date;
  if (r.storage_details) o.storageDetails = r.storage_details;
  if (r.onboarded_via) o.onboardedVia = r.onboarded_via;
  if (r.gateway_id) o.gatewayId = r.gateway_id;
  if (typeof r.lat === 'number' && typeof r.lng === 'number') o.location = { lat: r.lat, lng: r.lng };
  return o;
}

export interface MirrorStatus { enabled: boolean; ready: boolean; mirrored: number; lastSyncAt: string | null; errors: number; lastError: string | null }

export interface RegistryMirror {
  /** Creates the table and indexes. Returns false (and records why) when the database or PostGIS is not usable. */
  init(): Promise<boolean>;
  /** Applies a batch of Firestore changes. Never throws. */
  apply(upserts: Array<{ id: string; data: Record<string, unknown> }>, removed: string[]): Promise<void>;
  /** Marks the first full copy as complete (after the listener's first snapshot has been applied). */
  markReady(): void;
  /** Null when the mirror cannot be trusted right now: the caller then reads Firestore. */
  list(userId: string, filter: RegistryFilter): Promise<RegistryCamera[] | null>;
  /** Uncovered squares for one user's cameras, computed in the database. Null when not available. */
  gaps(userId: string, o: { radiusMeters: number; department?: string }): Promise<GapResult | null>;
  status(): MirrorStatus;
}

export interface GapResult { cameras: number; located: number; radiusMeters: number; cellMeters: number; cellsChecked: number; uncoveredTotal: number; zones: Array<{ lat: number; lng: number; nearestMeters: number }> }

const CHUNK = 400;           // rows per INSERT (14 params each stays under the 65,535 parameter limit)
const MAX_CELLS = 2500;
/** After this many failures in a row the mirror reads as not ready until a write or a retry succeeds. */
const FAIL_LIMIT = 3;

export function createRegistryMirror(db: SqlClient, log: (m: string) => void = console.log): RegistryMirror {
  let ready = false, initDone = false, mirrored = 0, errors = 0, consecutive = 0, lastError: string | null = null, lastSyncAt: string | null = null;
  const fail = (e: unknown) => { errors++; consecutive++; lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300); if (consecutive === 1 || consecutive === FAIL_LIMIT) log(`[REGISTRY POSTGIS] ${lastError}`); };
  const ok = () => { consecutive = 0; lastSyncAt = new Date().toISOString(); };
  const trusted = () => ready && initDone && consecutive < FAIL_LIMIT;

  return {
    async init() {
      try { for (const s of REGISTRY_DDL) await db.query(s); initDone = true; ok(); return true; }
      catch (e) { fail(e); return false; }
    },
    async apply(upserts, removed) {
      if (!initDone) return;
      try {
        for (let i = 0; i < upserts.length; i += CHUNK) {
          const q = upsertSql(upserts.slice(i, i + CHUNK).map((u) => toRow(u.id, u.data)));
          await db.query(q.text, q.params);
        }
        for (let i = 0; i < removed.length; i += 1000) await db.query('DELETE FROM registry_cameras WHERE id = ANY($1::text[])', [removed.slice(i, i + 1000)]);
        mirrored = Math.max(0, mirrored + upserts.length - removed.length); // a rough running figure; status() asks the table when it matters
        ok();
      } catch (e) { fail(e); }
    },
    markReady() { ready = true; },
    async list(userId, filter) {
      if (!trusted()) return null;
      try { const q = selectSql(userId, filter); const r = await db.query(q.text, q.params); return r.rows.map(fromRow); }
      catch (e) { fail(e); return null; }
    },
    async gaps(userId, o) {
      if (!trusted()) return null;
      try {
        const dept = o.department ? 'AND lower(department) = lower($2)' : '';
        const base: unknown[] = o.department ? [userId, o.department] : [userId];
        const ext = await db.query(`SELECT count(*)::int AS cameras, count(geom)::int AS located, min(ST_X(geom::geometry)) AS min_lng, min(ST_Y(geom::geometry)) AS min_lat,
          max(ST_X(geom::geometry)) AS max_lng, max(ST_Y(geom::geometry)) AS max_lat FROM registry_cameras WHERE user_id = $1 ${dept}`, base);
        const e = ext.rows[0];
        if (!e || e.located < 3) { ok(); return { cameras: e?.cameras ?? 0, located: e?.located ?? 0, radiusMeters: o.radiusMeters, cellMeters: 0, cellsChecked: 0, uncoveredTotal: 0, zones: [] }; }
        const midLat = (e.min_lat + e.max_lat) / 2, pad = o.radiusMeters;
        const hM = (e.max_lat - e.min_lat) * 111320 + 2 * pad, wM = (e.max_lng - e.min_lng) * 111320 * Math.cos((midLat * Math.PI) / 180) + 2 * pad;
        const cell = Math.max(Math.round(o.radiusMeters / 2), Math.ceil(Math.sqrt((hM * wM) / MAX_CELLS)));
        // A local projection (UTM zone of the area's middle) so squares are squares; coverage itself is measured on the sphere.
        const zone = Math.min(60, Math.max(1, Math.floor(((e.min_lng + e.max_lng) / 2 + 180) / 6) + 1));
        const srid = (midLat >= 0 ? 32600 : 32700) + zone;
        const gp = [...base, pad / 111320, e.min_lng, e.min_lat, e.max_lng, e.max_lat, cell, srid, o.radiusMeters];
        const n = base.length;
        const sql = `WITH env AS (SELECT ST_Transform(ST_Expand(ST_MakeEnvelope($${n + 2}::float8, $${n + 3}::float8, $${n + 4}::float8, $${n + 5}::float8, 4326), $${n + 1}::float8), $${n + 7}::int) AS g),
          grid AS (SELECT ST_Transform(ST_Centroid((ST_SquareGrid($${n + 6}::float8, g)).geom), 4326)::geography AS c FROM env),
          dist AS (SELECT c, (SELECT min(ST_Distance(cam.geom, c)) FROM registry_cameras cam WHERE cam.user_id = $1 ${dept} AND cam.geom IS NOT NULL) AS nearest FROM grid)
          SELECT ST_Y(c::geometry) AS lat, ST_X(c::geometry) AS lng, round(nearest)::int AS nearest, count(*) OVER ()::int AS total, sum((nearest - $${n + 6}::float8 * 0.7071 <= $${n + 8}::float8)::int) OVER ()::int AS covered
          FROM dist ORDER BY nearest DESC`;
        const r = await db.query(sql, gp);
        const all = r.rows;
        // Covered = any part of the square is within the radius of a camera (the same rule as src/lib/registryReport.ts).
        const uncovered = all.filter((x) => x.nearest - cell * 0.7071 > o.radiusMeters);
        ok();
        return { cameras: e.cameras, located: e.located, radiusMeters: o.radiusMeters, cellMeters: cell, cellsChecked: all.length, uncoveredTotal: uncovered.length, zones: uncovered.map((x) => ({ lat: +x.lat.toFixed(5), lng: +x.lng.toFixed(5), nearestMeters: x.nearest })) };
      } catch (err) { fail(err); return null; }
    },
    status() { return { enabled: true, ready: trusted(), mirrored, lastSyncAt, errors, lastError }; },
  };
}

export interface SnapshotSource {
  collection(name: string): { onSnapshot(next: (s: SnapshotLike) => void, error: (e: Error) => void): () => void };
}
export interface SnapshotLike { docChanges(): Array<{ type: 'added' | 'modified' | 'removed'; doc: { id: string; data(): Record<string, unknown> } }> }

/**
 * Follows the Firestore `cameras` collection and mirrors every change. The first snapshot is the whole collection (the backfill); the mirror is
 * marked ready once it has been applied. A listener error re-subscribes after a pause. Returns a stop function.
 */
export function startRegistrySync(source: SnapshotSource, mirror: RegistryMirror, o: { log?: (m: string) => void; retryMs?: number } = {}): () => void {
  const log = o.log ?? console.log;
  let stopped = false, unsubscribe: (() => void) | null = null, first = true, timer: ReturnType<typeof setTimeout> | null = null;
  // Changes are applied one batch at a time, in order, so an update never overtakes the insert before it.
  let chain: Promise<void> = Promise.resolve();
  const subscribe = () => {
    first = true;
    try {
      unsubscribe = source.collection('cameras').onSnapshot((snap) => {
        const up: Array<{ id: string; data: Record<string, unknown> }> = [], rm: string[] = [];
        for (const c of snap.docChanges()) { if (c.type === 'removed') rm.push(c.doc.id); else up.push({ id: c.doc.id, data: c.doc.data() }); }
        const wasFirst = first; first = false;
        chain = chain.then(() => mirror.apply(up, rm)).then(() => { if (wasFirst) { mirror.markReady(); log(`[REGISTRY POSTGIS] First copy applied (${up.length} cameras); the mirror is live.`); } });
      }, (err) => {
        log(`[REGISTRY POSTGIS] The Firestore listener failed (${err.message}); retrying.`);
        unsubscribe?.(); unsubscribe = null;
        if (!stopped) timer = setTimeout(subscribe, o.retryMs ?? 15_000);
      });
    } catch (e) { log(`[REGISTRY POSTGIS] Could not start the listener: ${e instanceof Error ? e.message : e}`); if (!stopped) timer = setTimeout(subscribe, o.retryMs ?? 15_000); }
  };
  subscribe();
  return () => { stopped = true; if (timer) clearTimeout(timer); unsubscribe?.(); };
}
