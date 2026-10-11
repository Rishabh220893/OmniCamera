/**
 * Recorded snippets: short clips taken straight from a camera's stream for review, demos and evidence notes.
 *
 * The VIDEO is a file in SNIPPETS_DIR; the METADATA (who, which camera, when, how long, how big, did it work) is a row. Rows live in PostgreSQL
 * when DATABASE_URL is set (the same database the events use), else in a JSON file next to the videos, so it also works on a laptop with
 * nothing installed. Both stores answer the same interface and are held to the same tests.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type SnippetStatus = 'recording' | 'ready' | 'failed';

export interface Snippet {
  id: string;
  userId: string;
  cameraId: string;
  cameraName: string;
  department: string | null;
  title: string;
  status: SnippetStatus;
  /** Seconds asked for, and seconds actually recorded (set when it is ready). */
  requestedSeconds: number;
  actualSeconds: number | null;
  bytes: number;
  hasThumb: boolean;
  error: string | null;
  /** SHA-256 of the file, so a copy can be shown to be the same footage. */
  sha256: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface SnippetQuery {
  /** Only this user's snippets; absent means every user's (an administrator). */
  userId?: string;
  cameraId?: string;
  limit?: number;
}

export interface SnippetStore {
  readonly kind: 'file' | 'postgres';
  insert(s: Snippet): Promise<void>;
  /** Changes some fields of one snippet; false when it does not exist. */
  update(id: string, patch: Partial<Omit<Snippet, 'id' | 'userId'>>): Promise<boolean>;
  get(id: string): Promise<Snippet | null>;
  /** Newest first. */
  list(q?: SnippetQuery): Promise<Snippet[]>;
  remove(id: string): Promise<boolean>;
  /** A snippet still marked "recording" when the server starts was cut off by the restart: mark those failed. Returns how many. */
  failInterrupted(reason: string, now: Date): Promise<number>;
  /** Total bytes of all snippets (for the disk cap). */
  totalBytes(): Promise<number>;
}

const newestFirst = (a: Snippet, b: Snippet) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1);

/** A JSON file, rewritten atomically on every change (a snippet list is small and changes rarely). */
export function createFileSnippetStore(file: string): SnippetStore {
  let rows: Snippet[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const load = async () => {
    if (rows) return rows;
    try { const j = JSON.parse(await readFile(file, 'utf8')); rows = Array.isArray(j) ? (j as Snippet[]) : []; } catch { rows = []; }
    return rows;
  };
  const save = async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(rows ?? [], null, 1));
    await rename(tmp, file);
  };
  // One change at a time, so two quick updates never write over each other.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = chain.then(fn, fn); chain = next.catch(() => undefined); return next; };
  return {
    kind: 'file',
    insert: (s) => serial(async () => { (await load()).push({ ...s }); await save(); }),
    update: (id, patch) => serial(async () => { const r = await load(); const i = r.findIndex((x) => x.id === id); if (i < 0) return false; r[i] = { ...r[i], ...patch }; await save(); return true; }),
    get: (id) => serial(async () => { const x = (await load()).find((r) => r.id === id); return x ? { ...x } : null; }),
    list: (q = {}) => serial(async () => (await load()).filter((r) => (!q.userId || r.userId === q.userId) && (!q.cameraId || r.cameraId === q.cameraId)).sort(newestFirst).slice(0, Math.min(500, q.limit ?? 200)).map((r) => ({ ...r }))),
    remove: (id) => serial(async () => { const r = await load(); const i = r.findIndex((x) => x.id === id); if (i < 0) return false; r.splice(i, 1); await save(); return true; }),
    failInterrupted: (reason, now) => serial(async () => { let n = 0; for (const r of await load()) if (r.status === 'recording') { r.status = 'failed'; r.error = reason; r.finishedAt = now.toISOString(); n++; } if (n) await save(); return n; }),
    totalBytes: () => serial(async () => (await load()).reduce((a, r) => a + (r.bytes || 0), 0)),
  };
}

export interface SqlClient { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export const SNIPPETS_DDL = [
  `CREATE TABLE IF NOT EXISTS recording_snippets (
     id text PRIMARY KEY, user_id text NOT NULL, camera_id text NOT NULL, camera_name text NOT NULL DEFAULT '', department text, title text NOT NULL DEFAULT '',
     status text NOT NULL, requested_seconds integer NOT NULL, actual_seconds double precision, bytes bigint NOT NULL DEFAULT 0, has_thumb boolean NOT NULL DEFAULT false,
     error text, sha256 text, created_at timestamptz NOT NULL, finished_at timestamptz)`,
  'CREATE INDEX IF NOT EXISTS recording_snippets_user_idx ON recording_snippets (user_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS recording_snippets_camera_idx ON recording_snippets (camera_id, created_at DESC)',
];

const COLUMN: Record<string, string> = {
  userId: 'user_id', cameraId: 'camera_id', cameraName: 'camera_name', department: 'department', title: 'title', status: 'status', requestedSeconds: 'requested_seconds',
  actualSeconds: 'actual_seconds', bytes: 'bytes', hasThumb: 'has_thumb', error: 'error', sha256: 'sha256', createdAt: 'created_at', finishedAt: 'finished_at',
};
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null);
function fromRow(r: any): Snippet {
  return {
    id: r.id, userId: r.user_id, cameraId: r.camera_id, cameraName: r.camera_name, department: r.department ?? null, title: r.title, status: r.status, requestedSeconds: Number(r.requested_seconds),
    actualSeconds: r.actual_seconds === null || r.actual_seconds === undefined ? null : Number(r.actual_seconds), bytes: Number(r.bytes ?? 0), hasThumb: !!r.has_thumb, error: r.error ?? null, sha256: r.sha256 ?? null,
    createdAt: iso(r.created_at)!, finishedAt: iso(r.finished_at),
  };
}

/** PostgreSQL. `init()` creates the table; every value is a bound parameter. */
export function createPostgresSnippetStore(db: SqlClient): SnippetStore & { init(): Promise<void> } {
  return {
    kind: 'postgres',
    async init() { for (const s of SNIPPETS_DDL) await db.query(s); },
    async insert(s) {
      await db.query(
        `INSERT INTO recording_snippets (id,user_id,camera_id,camera_name,department,title,status,requested_seconds,actual_seconds,bytes,has_thumb,error,sha256,created_at,finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [s.id, s.userId, s.cameraId, s.cameraName, s.department, s.title, s.status, s.requestedSeconds, s.actualSeconds, s.bytes, s.hasThumb, s.error, s.sha256, s.createdAt, s.finishedAt]);
    },
    async update(id, patch) {
      const sets: string[] = [], params: unknown[] = [id];
      for (const [k, v] of Object.entries(patch)) { const col = COLUMN[k]; if (!col || v === undefined) continue; params.push(v); sets.push(`${col} = $${params.length}`); }
      if (!sets.length) return (await db.query('SELECT 1 FROM recording_snippets WHERE id = $1', [id])).rows.length > 0;
      const r = await db.query(`UPDATE recording_snippets SET ${sets.join(', ')} WHERE id = $1`, params);
      return (r.rowCount ?? 0) > 0;
    },
    async get(id) { const r = await db.query('SELECT * FROM recording_snippets WHERE id = $1', [id]); return r.rows[0] ? fromRow(r.rows[0]) : null; },
    async list(q = {}) {
      const params: unknown[] = [], where: string[] = [];
      if (q.userId) { params.push(q.userId); where.push(`user_id = $${params.length}`); }
      if (q.cameraId) { params.push(q.cameraId); where.push(`camera_id = $${params.length}`); }
      params.push(Math.min(500, q.limit ?? 200));
      const r = await db.query(`SELECT * FROM recording_snippets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params);
      return r.rows.map(fromRow);
    },
    async remove(id) { const r = await db.query('DELETE FROM recording_snippets WHERE id = $1', [id]); return (r.rowCount ?? 0) > 0; },
    async failInterrupted(reason, now) { const r = await db.query(`UPDATE recording_snippets SET status = 'failed', error = $1, finished_at = $2 WHERE status = 'recording'`, [reason, now.toISOString()]); return r.rowCount ?? 0; },
    async totalBytes() { const r = await db.query('SELECT COALESCE(SUM(bytes), 0)::bigint AS n FROM recording_snippets'); return Number(r.rows[0]?.n ?? 0); },
  };
}
