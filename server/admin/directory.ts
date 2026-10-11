/**
 * Who the administrators manage: departments, the people in them (username + password accounts), and which cameras each department
 * can see. The routes (routes.ts) talk to this interface; `firebaseDirectory.ts` implements it on Firebase Auth + Firestore and
 * `createMemoryDirectory` is the same behaviour in memory for tests.
 *
 * A department's id is its name (letters, digits, space . _ & -), because that is what camera events and the claims carry; renaming is
 * therefore not offered (create a new one and move the cameras).
 */
import { normaliseUsername, passwordProblem } from '../../src/lib/username';
import type { Role } from '../authz/policy';

export const DEPARTMENT_RE = /^[A-Za-z0-9][\w .&-]{0,59}$/;

export const STORAGE_KINDS = ['cloud', 'local', 'mixed'] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

/**
 * `retentionDays` and `storage` describe the department's OWN video system (Profile 3 keeps no video centrally): how long it keeps footage and
 * where. The dashboard uses them to say that video for an old event is likely no longer held. Both are optional (unknown).
 */
export interface Department { id: string; name: string; createdAt: string; createdBy: string; retentionDays?: number; storage?: StorageKind }
export interface DepartmentPatch { retentionDays?: number | null; storage?: StorageKind | null }
export interface DepartmentView extends Department { users: number; cameras: number }

export interface ManagedUser {
  uid: string;
  username: string;
  role: Role;
  /** Null for an admin, who covers every department. */
  departmentId: string | null;
  disabled: boolean;
  createdAt: string;
  createdBy: string;
  lastSignInAt: string | null;
}

export interface CameraRow {
  id: string; name: string; ownerUserId: string; departmentId: string | null;
  /** The camera's stream address with any login removed, so the same camera registered by several accounts can be recognised as one. */
  streamUrl?: string;
}

/** A stream address with the user:password part removed. */
export const withoutLogin = (url: unknown): string | undefined => (typeof url === 'string' && url ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1') : undefined);

export class DirectoryError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not_found' | 'conflict' | 'forbidden' | 'unavailable') {
    super(message);
    this.name = 'DirectoryError';
  }
}

export interface NewUser { username: string; password: string; role: Role; departmentId: string | null }
export interface UserPatch { password?: string; role?: Role; departmentId?: string | null; disabled?: boolean }

/**
 * What an administrator can look at across every department (the app only loads a person's own and their departments' faces, plates and logs).
 * Metadata only: a face's picture is never sent, a log is cut short.
 */
export const RECORD_KINDS = ['faces', 'watchlist', 'logs'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export interface RecordRow {
  id: string;
  ownerUserId: string;
  departmentId: string | null;
  /** The face's name, the plate, or the log's summary (up to 200 characters). */
  title: string;
  /** Logs: the camera and when. */
  cameraName?: string;
  at?: string;
  unusual?: boolean;
}

export interface AdminDirectory {
  listDepartments(): Promise<DepartmentView[]>;
  createDepartment(name: string, by: string): Promise<Department>;
  /** Sets or clears (null) the department's retention and storage description. */
  updateDepartment(id: string, patch: DepartmentPatch): Promise<Department>;
  /** Refuses while a user or a camera still belongs to it. */
  deleteDepartment(id: string): Promise<void>;
  listUsers(): Promise<ManagedUser[]>;
  createUser(u: NewUser, by: string): Promise<ManagedUser>;
  updateUser(uid: string, patch: UserPatch): Promise<ManagedUser>;
  deleteUser(uid: string): Promise<void>;
  listCameras(): Promise<CameraRow[]>;
  /** Gives the cameras to a department (null takes them back). Unknown camera ids are returned, not an error. */
  allotCameras(cameraIds: string[], departmentId: string | null): Promise<{ updated: number; missing: string[] }>;
  /** Faces, watchlist plates or logs of every department (or one), newest first for logs, at most `limit` (up to 500). */
  listRecords(kind: RecordKind, o: { departmentId?: string; limit?: number }): Promise<RecordRow[]>;
}

export function checkDepartmentName(raw: unknown): string {
  const n = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!DEPARTMENT_RE.test(n)) throw new DirectoryError('A department name is 1-60 characters: letters, digits, space and . _ & -, starting with a letter or digit.', 'invalid');
  return n;
}

export function checkDepartmentPatch(raw: unknown): DepartmentPatch {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p: DepartmentPatch = {};
  if (r.retentionDays !== undefined) {
    if (r.retentionDays === null || r.retentionDays === '') p.retentionDays = null;
    else if (typeof r.retentionDays === 'number' && Number.isInteger(r.retentionDays) && r.retentionDays >= 1 && r.retentionDays <= 3650) p.retentionDays = r.retentionDays;
    else throw new DirectoryError("'retentionDays' is a whole number of days from 1 to 3650.", 'invalid');
  }
  if (r.storage !== undefined) {
    if (r.storage === null || r.storage === '') p.storage = null;
    else if (typeof r.storage === 'string' && (STORAGE_KINDS as readonly string[]).includes(r.storage)) p.storage = r.storage as StorageKind;
    else throw new DirectoryError("'storage' must be cloud, local or mixed.", 'invalid');
  }
  if (!Object.keys(p).length) throw new DirectoryError('Nothing to change.', 'invalid');
  return p;
}

/** Validates the body of "create a user"; the department must be named for everyone but an admin. */
export function checkNewUser(raw: unknown): NewUser {
  const r = (raw ?? {}) as Record<string, unknown>;
  const username = normaliseUsername(String(r.username ?? ''));
  if (!username) throw new DirectoryError('A username is 3-32 characters: lower-case letters, digits, . _ -, starting with a letter or digit.', 'invalid');
  const pw = passwordProblem(r.password);
  if (pw) throw new DirectoryError(pw, 'invalid');
  const role = r.role === undefined ? 'operator' : r.role;
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') throw new DirectoryError("'role' must be viewer, operator or admin.", 'invalid');
  const dept = r.departmentId === undefined || r.departmentId === null || r.departmentId === '' ? null : checkDepartmentName(r.departmentId);
  if (role !== 'admin' && !dept) throw new DirectoryError('Choose a department for this user.', 'invalid');
  return { username, password: String(r.password), role, departmentId: role === 'admin' ? null : dept };
}

export function checkUserPatch(raw: unknown): UserPatch {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p: UserPatch = {};
  if (r.password !== undefined) { const e = passwordProblem(r.password); if (e) throw new DirectoryError(e, 'invalid'); p.password = String(r.password); }
  if (r.role !== undefined) { if (r.role !== 'viewer' && r.role !== 'operator' && r.role !== 'admin') throw new DirectoryError("'role' must be viewer, operator or admin.", 'invalid'); p.role = r.role; }
  if (r.departmentId !== undefined) p.departmentId = r.departmentId === null || r.departmentId === '' ? null : checkDepartmentName(r.departmentId);
  if (r.disabled !== undefined) { if (typeof r.disabled !== 'boolean') throw new DirectoryError("'disabled' must be true or false.", 'invalid'); p.disabled = r.disabled; }
  if (!Object.keys(p).length) throw new DirectoryError('Nothing to change.', 'invalid');
  return p;
}

// ---- memory implementation (tests, and the reference for the Firebase one) -----------------------------------------------

export interface MemoryDirectory extends AdminDirectory {
  /** Test access: cameras can be added the way the app would add them. */
  addCamera(c: CameraRow): void;
  /** Test access: records of the three kinds. */
  addRecord(kind: RecordKind, r: RecordRow): void;
  /** The password last set for a username, so tests can check sign-in without a real identity service. */
  passwordOf(username: string): string | undefined;
  claimsOf(uid: string): { role: Role; departments: string[] } | undefined;
}

export function createMemoryDirectory(o: { now?: () => Date } = {}): MemoryDirectory {
  const now = o.now ?? (() => new Date());
  const departments = new Map<string, Department>();
  const users = new Map<string, ManagedUser & { password: string }>();
  const cameras = new Map<string, CameraRow>();
  const records: Record<RecordKind, RecordRow[]> = { faces: [], watchlist: [], logs: [] };
  let seq = 0;
  const strip = ({ password: _p, ...u }: ManagedUser & { password: string }): ManagedUser => u;
  const needDept = (id: string | null) => { if (id !== null && !departments.has(id)) throw new DirectoryError(`There is no department '${id}'.`, 'invalid'); };

  return {
    addRecord(kind, r) { records[kind].push(r); },
    async listRecords(kind, q) {
      const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 200) || 200));
      const rows = records[kind].filter((r) => !q.departmentId || r.departmentId === q.departmentId);
      return (kind === 'logs' ? [...rows].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))) : [...rows].sort((a, b) => a.title.localeCompare(b.title))).slice(0, limit);
    },
    async listDepartments() {
      return [...departments.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({
        ...d, users: [...users.values()].filter((u) => u.departmentId === d.id).length, cameras: [...cameras.values()].filter((c) => c.departmentId === d.id).length,
      }));
    },
    async createDepartment(name, by) {
      const n = checkDepartmentName(name);
      if ([...departments.keys()].some((k) => k.toLowerCase() === n.toLowerCase())) throw new DirectoryError(`A department named '${n}' already exists.`, 'conflict');
      const d: Department = { id: n, name: n, createdAt: now().toISOString(), createdBy: by };
      departments.set(n, d);
      return d;
    },
    async updateDepartment(id, patch) {
      const d = departments.get(id);
      if (!d) throw new DirectoryError('No such department.', 'not_found');
      if (patch.retentionDays !== undefined) { if (patch.retentionDays === null) delete d.retentionDays; else d.retentionDays = patch.retentionDays; }
      if (patch.storage !== undefined) { if (patch.storage === null) delete d.storage; else d.storage = patch.storage; }
      return { ...d };
    },
    async deleteDepartment(id) {
      if (!departments.has(id)) throw new DirectoryError('No such department.', 'not_found');
      const u = [...users.values()].filter((x) => x.departmentId === id).length, c = [...cameras.values()].filter((x) => x.departmentId === id).length;
      if (u || c) throw new DirectoryError(`The department still has ${u} user(s) and ${c} camera(s). Move or remove them first.`, 'conflict');
      departments.delete(id);
    },
    async listUsers() { return [...users.values()].sort((a, b) => a.username.localeCompare(b.username)).map(strip); },
    async createUser(u, by) {
      needDept(u.departmentId);
      if ([...users.values()].some((x) => x.username === u.username)) throw new DirectoryError(`The username '${u.username}' is taken.`, 'conflict');
      const m = { uid: `u${++seq}`, username: u.username, role: u.role, departmentId: u.departmentId, disabled: false, createdAt: now().toISOString(), createdBy: by, lastSignInAt: null, password: u.password };
      users.set(m.uid, m);
      return strip(m);
    },
    async updateUser(uid, patch) {
      const u = users.get(uid);
      if (!u) throw new DirectoryError('No such user.', 'not_found');
      const role = patch.role ?? u.role;
      const dept = patch.departmentId !== undefined ? patch.departmentId : u.departmentId;
      if (role !== 'admin' && !dept) throw new DirectoryError('Choose a department for this user.', 'invalid');
      needDept(role === 'admin' ? null : dept);
      if (patch.password) u.password = patch.password;
      u.role = role; u.departmentId = role === 'admin' ? null : dept;
      if (patch.disabled !== undefined) u.disabled = patch.disabled;
      return strip(u);
    },
    async deleteUser(uid) { if (!users.delete(uid)) throw new DirectoryError('No such user.', 'not_found'); },
    async listCameras() { return [...cameras.values()].sort((a, b) => a.name.localeCompare(b.name)); },
    async allotCameras(ids, departmentId) {
      needDept(departmentId);
      const missing: string[] = [];
      let updated = 0;
      for (const id of new Set(ids)) { const c = cameras.get(id); if (!c) { missing.push(id); continue; } c.departmentId = departmentId; updated++; }
      return { updated, missing };
    },
    addCamera: (c) => { cameras.set(c.id, { ...c }); },
    passwordOf: (username) => [...users.values()].find((u) => u.username === username)?.password,
    claimsOf: (uid) => { const u = users.get(uid); return u ? { role: u.role, departments: u.role === 'admin' ? ['*'] : [u.departmentId!] } : undefined; },
  };
}
