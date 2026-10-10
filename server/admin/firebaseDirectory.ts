/**
 * The administrators' directory on Firebase: people are Firebase Auth accounts (e-mail = `<username>@omnisee.local`, see
 * src/lib/username.ts) carrying a role and department as custom claims; departments are documents in `departments`; a camera belongs to
 * a department through `departmentId` on its document. All writes go through the Admin SDK, which is what keeps people from granting
 * themselves access (the Firestore rules refuse clients any of these fields).
 *
 * NOT RUN against a Firebase project: nothing here could be tested without one (no emulator or credentials in the test environment).
 * The same behaviour in memory is `createMemoryDirectory`, and `tests/adminDirectory.test.ts` pins it.
 */
import type { Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { usernameToEmail } from '../../src/lib/username';
import { claimsFor, type Role } from '../authz/policy';
import {
  DirectoryError, checkDepartmentName, withoutLogin,
  type AdminDirectory, type CameraRow, type Department, type DepartmentView, type ManagedUser, type NewUser, type UserPatch,
} from './directory';

const MAX_CAMERAS = 20_000;

export function createFirebaseDirectory(auth: Auth, db: Firestore, o: { now?: () => Date } = {}): AdminDirectory {
  const now = o.now ?? (() => new Date());

  const authCode = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');
  const wrap = (e: unknown): never => {
    if (e instanceof DirectoryError) throw e;
    const c = authCode(e);
    if (c === 'auth/email-already-exists') throw new DirectoryError('That username is taken.', 'conflict');
    if (c === 'auth/user-not-found') throw new DirectoryError('No such user.', 'not_found');
    if (c === 'auth/invalid-password') throw new DirectoryError('The password was refused (it must be at least 6 characters).', 'invalid');
    if (c === 'auth/operation-not-allowed' || c === 'auth/configuration-not-found') throw new DirectoryError('Email/Password sign-in is not enabled in the Firebase project (Authentication > Sign-in method).', 'unavailable');
    throw new DirectoryError(e instanceof Error ? e.message : 'The directory request failed.', 'unavailable');
  };

  async function needDepartment(id: string | null) {
    if (id === null) return;
    if (!(await db.collection('departments').doc(id).get()).exists) throw new DirectoryError(`There is no department '${id}'.`, 'invalid');
  }

  const view = async (uid: string, d: FirebaseFirestore.DocumentData): Promise<ManagedUser> => {
    const rec = await auth.getUser(uid).catch(() => null);
    const claims = (rec?.customClaims ?? {}) as { role?: Role; departments?: string[] };
    return {
      uid, username: String(d.username ?? ''), role: claims.role ?? 'operator', departmentId: typeof d.departmentId === 'string' ? d.departmentId : null,
      disabled: !!rec?.disabled, createdAt: String(d.createdAt ?? ''), createdBy: String(d.createdBy ?? ''),
      lastSignInAt: rec?.metadata.lastSignInTime ? new Date(rec.metadata.lastSignInTime).toISOString() : null,
    };
  };

  /** A managed account is one this directory created; the directory never touches any other account. */
  async function managed(uid: string) {
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.managed !== true) throw new DirectoryError('No such user.', 'not_found');
    return { ref, data: snap.data()! };
  }

  return {
    async listDepartments(): Promise<DepartmentView[]> {
      try {
        const [deps, users, cams] = await Promise.all([
          db.collection('departments').get(),
          db.collection('users').where('managed', '==', true).select('departmentId').get(),
          db.collection('cameras').select('departmentId').limit(MAX_CAMERAS).get(),
        ]);
        const count = (snap: FirebaseFirestore.QuerySnapshot) => {
          const m = new Map<string, number>();
          snap.forEach((d) => { const id = d.get('departmentId'); if (typeof id === 'string') m.set(id, (m.get(id) ?? 0) + 1); });
          return m;
        };
        const uc = count(users), cc = count(cams);
        return deps.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), createdAt: String(d.get('createdAt') ?? ''), createdBy: String(d.get('createdBy') ?? ''), users: uc.get(d.id) ?? 0, cameras: cc.get(d.id) ?? 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { return wrap(e); }
    },

    async createDepartment(name, by): Promise<Department> {
      const n = checkDepartmentName(name);
      try {
        const all = await db.collection('departments').get();
        if (all.docs.some((d) => d.id.toLowerCase() === n.toLowerCase())) throw new DirectoryError(`A department named '${n}' already exists.`, 'conflict');
        const dep: Department = { id: n, name: n, createdAt: now().toISOString(), createdBy: by };
        await db.collection('departments').doc(n).create(dep);
        return dep;
      } catch (e) { return wrap(e); }
    },

    async deleteDepartment(id) {
      try {
        const ref = db.collection('departments').doc(id);
        if (!(await ref.get()).exists) throw new DirectoryError('No such department.', 'not_found');
        const [u, c] = await Promise.all([db.collection('users').where('departmentId', '==', id).limit(1).get(), db.collection('cameras').where('departmentId', '==', id).limit(1).get()]);
        if (!u.empty || !c.empty) throw new DirectoryError('The department still has users or cameras. Move or remove them first.', 'conflict');
        await ref.delete();
      } catch (e) { wrap(e); }
    },

    async listUsers() {
      try {
        const snap = await db.collection('users').where('managed', '==', true).get();
        return (await Promise.all(snap.docs.map((d) => view(d.id, d.data())))).sort((a, b) => a.username.localeCompare(b.username));
      } catch (e) { return wrap(e); }
    },

    async createUser(u: NewUser, by) {
      let uid: string | null = null;
      try {
        await needDepartment(u.departmentId);
        const rec = await auth.createUser({ email: usernameToEmail(u.username), password: u.password, displayName: u.username, emailVerified: true, disabled: false });
        uid = rec.uid;
        const claims = claimsFor(u.role, u.departmentId ? [u.departmentId] : []);
        await auth.setCustomUserClaims(uid, claims);
        const doc = {
          managed: true, username: u.username, departmentId: u.departmentId, department: u.departmentId ?? '', theme: 'dark', googleSheetsId: '', streamAccessPassword: '', streamAccessEmail: '',
          createdAt: now().toISOString(), createdBy: by, updatedAt: FieldValue.serverTimestamp(),
        };
        await db.collection('users').doc(uid).set(doc);
        return await view(uid, doc);
      } catch (e) {
        // Do not leave an account that can sign in but has no role or profile.
        if (uid) await auth.deleteUser(uid).catch(() => undefined);
        return wrap(e);
      }
    },

    async updateUser(uid, patch: UserPatch) {
      try {
        const { ref, data } = await managed(uid);
        const rec = await auth.getUser(uid);
        const cur = (rec.customClaims ?? {}) as { role?: Role };
        const role = patch.role ?? cur.role ?? 'operator';
        const dept = patch.departmentId !== undefined ? patch.departmentId : typeof data.departmentId === 'string' ? data.departmentId : null;
        if (role !== 'admin' && !dept) throw new DirectoryError('Choose a department for this user.', 'invalid');
        const finalDept = role === 'admin' ? null : dept;
        await needDepartment(finalDept);
        const authChange: { password?: string; disabled?: boolean } = {};
        if (patch.password) authChange.password = patch.password;
        if (patch.disabled !== undefined) authChange.disabled = patch.disabled;
        if (Object.keys(authChange).length) await auth.updateUser(uid, authChange);
        if (patch.role !== undefined || patch.departmentId !== undefined) {
          await auth.setCustomUserClaims(uid, { ...(rec.customClaims ?? {}), ...claimsFor(role, finalDept ? [finalDept] : []) });
          await ref.update({ departmentId: finalDept, department: finalDept ?? '', updatedAt: FieldValue.serverTimestamp() });
        }
        // Make every session pick up the change (and a disabled or re-passworded account sign in again).
        await auth.revokeRefreshTokens(uid);
        return await view(uid, { ...data, departmentId: finalDept });
      } catch (e) { return wrap(e); }
    },

    async deleteUser(uid) {
      try {
        const { ref } = await managed(uid);
        await auth.deleteUser(uid);
        await ref.delete();
      } catch (e) { wrap(e); }
    },

    async listCameras(): Promise<CameraRow[]> {
      try {
        const snap = await db.collection('cameras').select('name', 'userId', 'departmentId', 'remoteStreamUrl').limit(MAX_CAMERAS).get();
        return snap.docs.map((d) => ({ id: d.id, name: String(d.get('name') ?? d.id), ownerUserId: String(d.get('userId') ?? ''), departmentId: typeof d.get('departmentId') === 'string' ? d.get('departmentId') : null, streamUrl: withoutLogin(d.get('remoteStreamUrl')) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { return wrap(e); }
    },

    async allotCameras(ids, departmentId) {
      try {
        await needDepartment(departmentId);
        const unique = [...new Set(ids)].slice(0, 2000);
        const refs = unique.map((id) => db.collection('cameras').doc(id));
        const missing: string[] = [];
        const found: FirebaseFirestore.DocumentReference[] = [];
        for (let i = 0; i < refs.length; i += 300) {
          const snaps = await db.getAll(...refs.slice(i, i + 300));
          snaps.forEach((s, j) => { if (s.exists) found.push(refs[i + j]); else missing.push(unique[i + j]); });
        }
        for (let i = 0; i < found.length; i += 400) {
          const batch = db.batch();
          for (const ref of found.slice(i, i + 400)) {
            batch.update(ref, departmentId
              ? { departmentId, department: departmentId, updatedAt: FieldValue.serverTimestamp() }
              : { departmentId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
          }
          await batch.commit();
        }
        return { updated: found.length, missing };
      } catch (e) { return wrap(e); }
    },
  };
}
