import { auth } from './firebase';

export interface DepartmentRow { id: string; name: string; users: number; cameras: number; createdAt: string }
export interface UserRow { uid: string; username: string; role: 'viewer' | 'operator' | 'admin'; departmentId: string | null; disabled: boolean; lastSignInAt: string | null; createdAt: string }
export interface CameraRow { id: string; name: string; ownerUserId: string; departmentId: string | null; streamUrl?: string }

/** Calls the administrator endpoints as the signed-in user. Throws an Error whose message is safe to show. */
export async function call<T>(path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `The server answered ${res.status}.`);
  return data as T;
}

export const adminApi = {
  departments: () => call<{ departments: DepartmentRow[] }>('/api/admin/departments').then((r) => r.departments),
  createDepartment: (name: string) => call<{ department: DepartmentRow }>('/api/admin/departments', { method: 'POST', body: { name } }),
  deleteDepartment: (id: string) => call<{ status: string }>(`/api/admin/departments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  users: () => call<{ users: UserRow[] }>('/api/admin/users').then((r) => r.users),
  createUser: (u: { username: string; password: string; role: string; departmentId: string | null }) => call<{ user: UserRow }>('/api/admin/users', { method: 'POST', body: u }),
  updateUser: (uid: string, patch: { password?: string; role?: string; departmentId?: string | null; disabled?: boolean }) =>
    call<{ user: UserRow }>(`/api/admin/users/${encodeURIComponent(uid)}`, { method: 'PATCH', body: patch }),
  deleteUser: (uid: string) => call<{ status: string }>(`/api/admin/users/${encodeURIComponent(uid)}`, { method: 'DELETE' }),
  cameras: () => call<{ cameras: CameraRow[] }>('/api/admin/cameras').then((r) => r.cameras),
  allot: (cameraIds: string[], departmentId: string | null) => call<{ updated: number; missing: string[] }>('/api/admin/cameras/allot', { method: 'POST', body: { cameraIds, departmentId } }),
};
