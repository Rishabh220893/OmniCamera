import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, KeyRound, Trash2, UserPlus, Users, Video } from 'lucide-react';
import { adminApi, type CameraRow, type DepartmentRow, type UserRow } from '../lib/adminApi';
import { PASSWORD_MIN } from '../lib/username';

const ROLE_LABEL = { viewer: 'Viewer', operator: 'Operator', admin: 'Admin' } as const;

function errText(e: unknown) { return e instanceof Error ? e.message : String(e); }

/** Administrators: create departments, create username + password accounts, and give cameras to departments. */
export default function AdminUsersPanel() {
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [cameras, setCameras] = useState<CameraRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [deptName, setDeptName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'viewer' | 'operator' | 'admin'>('operator');
  const [userDept, setUserDept] = useState('');

  const [allotDept, setAllotDept] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const [d, u, c] = await Promise.all([adminApi.departments(), adminApi.users(), adminApi.cameras()]);
      setDepartments(d); setUsers(u); setCameras(c); setLoadError(null);
    } catch (e) { setLoadError(errText(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const run = async (okText: string, fn: () => Promise<unknown>) => {
    setBusy(true); setNotice(null);
    try { await fn(); setNotice({ kind: 'ok', text: okText }); await reload(); return true; }
    catch (e) { setNotice({ kind: 'error', text: errText(e) }); return false; }
    finally { setBusy(false); }
  };

  // The same physical camera is often registered by several accounts (each demo account loads the grid). Show it once; choosing it
  // chooses every copy, so the department gets all of them and whichever copy a person's app opens is theirs.
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; name: string; ids: string[]; owners: Set<string>; departments: Set<string> }>();
    for (const c of cameras) {
      const key = c.streamUrl ? `url:${c.streamUrl}` : `name:${c.name.toLowerCase()}`;
      const g = byKey.get(key) ?? { key, name: c.name, ids: [], owners: new Set<string>(), departments: new Set<string>() };
      g.ids.push(c.id); g.owners.add(c.ownerUserId); g.departments.add(c.departmentId ?? '');
      byKey.set(key, g);
    }
    return [...byKey.values()];
  }, [cameras]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return groups.filter((g) => !f || g.name.toLowerCase().includes(f) || g.ids.some((i) => i.toLowerCase().includes(f)) || [...g.departments].some((d) => d.toLowerCase().includes(f)));
  }, [groups, filter]);
  const isPicked = (g: { ids: string[] }) => g.ids.every((i) => picked.has(i));
  const togglePick = (g: { ids: string[] }) => setPicked((p) => { const n = new Set(p); if (isPicked(g)) g.ids.forEach((i) => n.delete(i)); else g.ids.forEach((i) => n.add(i)); return n; });
  const allShownPicked = shown.length > 0 && shown.every(isPicked);
  const label = (g: { departments: Set<string> }) => { const d = [...g.departments]; return d.length === 1 ? (d[0] || 'not given to a department') : 'in several departments'; };

  return (
    <div className="card p-8" data-testid="admin-users-panel">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-11 h-11 rounded-2xl bg-accent-soft flex items-center justify-center text-accent"><Users className="w-5.5 h-5.5" strokeWidth={1.75} /></div>
        <div>
          <h2 className="text-lg font-bold font-display text-ink">Users, departments &amp; camera access</h2>
          <p className="text-xs text-ink-muted">Create people who sign in with a username and password, put them in a department, and choose which cameras that department can see.</p>
        </div>
      </div>

      {loadError && (
        <div className="badge-critical rounded-2xl p-4 mb-5 !inline-block w-full !normal-case text-xs" role="alert">
          <p className="font-bold text-critical">Could not load users and departments.</p>
          <p className="text-ink-muted mt-1">{loadError}</p>
          <p className="text-ink-muted mt-1">This needs the server to have Firebase Admin configured, and your account to be an administrator.</p>
        </div>
      )}
      {notice && (
        <div role="status" className={notice.kind === 'ok' ? 'badge-success rounded-xl px-4 py-2 mb-5 !inline-block w-full !normal-case text-xs font-semibold' : 'badge-critical rounded-xl px-4 py-2 mb-5 !inline-block w-full !normal-case text-xs font-semibold'}>{notice.text}</div>
      )}

      {/* Departments */}
      <section className="space-y-3 mb-8">
        <h3 className="text-sm font-bold text-ink flex items-center gap-2"><Building2 className="w-4 h-4 text-accent" strokeWidth={1.75} /> Departments</h3>
        <form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run(`Department '${deptName.trim()}' created.`, () => adminApi.createDepartment(deptName))) setDeptName(''); }}>
          <input className="input flex-1 min-w-[12rem]" placeholder="New department, e.g. Traffic Police" value={deptName} onChange={(e) => setDeptName(e.target.value)} maxLength={60} aria-label="New department name" />
          <button className="btn-primary !py-2 !px-4 text-xs" disabled={busy || !deptName.trim()}>Add department</button>
        </form>
        {loading ? <p className="text-xs text-ink-muted">Loading...</p> : departments.length === 0 ? <p className="text-xs text-ink-muted">No departments yet.</p> : (
          <ul className="divide-y divide-border border border-border rounded-xl">
            {departments.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                <span className="font-semibold text-ink">{d.name}</span>
                <span className="text-ink-muted">{d.users} user{d.users === 1 ? '' : 's'} &middot; {d.cameras} camera{d.cameras === 1 ? '' : 's'}</span>
                <button className="btn-ghost !p-1.5 text-critical" title={d.users || d.cameras ? 'Move its users and cameras first' : 'Delete department'} disabled={busy || d.users > 0 || d.cameras > 0} aria-label={`Delete department ${d.name}`}
                  onClick={() => run(`Department '${d.name}' deleted.`, () => adminApi.deleteDepartment(d.id))}><Trash2 className="w-4 h-4" strokeWidth={1.75} /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Users */}
      <section className="space-y-3 mb-8">
        <h3 className="text-sm font-bold text-ink flex items-center gap-2"><UserPlus className="w-4 h-4 text-accent" strokeWidth={1.75} /> People</h3>
        <form className="grid sm:grid-cols-5 gap-2" autoComplete="off" onSubmit={async (e) => {
          e.preventDefault();
          const who = username.trim().toLowerCase();
          if (await run(`'${who}' can now sign in with that username and password.`, () => adminApi.createUser({ username, password, role, departmentId: role === 'admin' ? null : userDept || null }))) { setUsername(''); setPassword(''); }
        }}>
          <input className="input" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" maxLength={32} aria-label="New user's username" />
          <input className="input" type="password" placeholder={`Password (${PASSWORD_MIN}+ characters)`} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={128} aria-label="New user's password" />
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="Role">
            <option value="operator">Operator (watch and edit)</option>
            <option value="viewer">Viewer (watch only)</option>
            <option value="admin">Admin (everything)</option>
          </select>
          <select className="input" value={userDept} onChange={(e) => setUserDept(e.target.value)} disabled={role === 'admin'} aria-label="Department">
            <option value="">{role === 'admin' ? 'All departments' : 'Choose department'}</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn-primary !py-2 !px-4 text-xs" disabled={busy || !username.trim() || password.length < PASSWORD_MIN || (role !== 'admin' && !userDept)}>Create user</button>
        </form>
        <p className="text-[10px] text-ink-muted">Usernames are 3-32 lower-case letters, digits, . _ -. Give the person the username and password yourself; you can reset the password here at any time.</p>
        {users.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-muted uppercase tracking-wider text-[10px]"><th className="py-2 pr-3">Username</th><th className="pr-3">Role</th><th className="pr-3">Department</th><th className="pr-3">Last sign-in</th><th className="text-right">Actions</th></tr></thead>
              <tbody className="divide-y divide-border">
                {users.map((u) => (
                  <tr key={u.uid} className={u.disabled ? 'opacity-60' : ''}>
                    <td className="py-2 pr-3 font-semibold text-ink">{u.username}{u.disabled && <span className="ml-2 badge-warning !text-[9px]">disabled</span>}</td>
                    <td className="pr-3">{ROLE_LABEL[u.role]}</td>
                    <td className="pr-3">{u.departmentId ?? 'All'}</td>
                    <td className="pr-3 text-ink-muted">{u.lastSignInAt ? new Date(u.lastSignInAt).toLocaleString() : 'never'}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="btn-ghost !p-1.5" title="Set a new password" aria-label={`Reset password for ${u.username}`} disabled={busy} onClick={() => {
                        const pw = window.prompt(`New password for ${u.username} (${PASSWORD_MIN}+ characters):`);
                        if (pw) void run(`Password for ${u.username} changed. They must sign in again.`, () => adminApi.updateUser(u.uid, { password: pw }));
                      }}><KeyRound className="w-4 h-4" strokeWidth={1.75} /></button>
                      <button className="btn-ghost !px-2 !py-1 text-[10px] font-bold" disabled={busy} onClick={() => run(`${u.username} ${u.disabled ? 'can sign in again' : 'is disabled'}.`, () => adminApi.updateUser(u.uid, { disabled: !u.disabled }))}>{u.disabled ? 'Enable' : 'Disable'}</button>
                      <button className="btn-ghost !p-1.5 text-critical" title="Delete user" aria-label={`Delete user ${u.username}`} disabled={busy} onClick={() => { if (window.confirm(`Delete ${u.username}? They will no longer be able to sign in.`)) void run(`${u.username} deleted.`, () => adminApi.deleteUser(u.uid)); }}><Trash2 className="w-4 h-4" strokeWidth={1.75} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Camera allotment */}
      <section className="space-y-3">
        <h3 className="text-sm font-bold text-ink flex items-center gap-2"><Video className="w-4 h-4 text-accent" strokeWidth={1.75} /> Cameras for a department</h3>
        <div className="flex flex-wrap gap-2 items-center">
          <select className="input !w-auto" value={allotDept} onChange={(e) => setAllotDept(e.target.value)} aria-label="Department to give cameras to">
            <option value="">Choose department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input className="input flex-1 min-w-[10rem]" placeholder="Filter cameras by name, id or department" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter cameras" />
          <button className="btn-primary !py-2 !px-4 text-xs" disabled={busy || !allotDept || picked.size === 0}
            onClick={async () => { if (await run(`${picked.size} camera(s) now belong to ${allotDept}.`, () => adminApi.allot([...picked], allotDept))) setPicked(new Set()); }}>Give {shown.filter(isPicked).length || ''} to department</button>
          <button className="btn-secondary !py-2 !px-4 text-xs" disabled={busy || picked.size === 0}
            onClick={async () => { if (await run(`${picked.size} camera(s) taken back from their departments.`, () => adminApi.allot([...picked], null))) setPicked(new Set()); }}>Take back</button>
        </div>
        <div className="border border-border rounded-xl max-h-72 overflow-y-auto">
          <label className="flex items-center gap-3 px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-muted border-b border-border sticky top-0 bg-surface">
            <input type="checkbox" checked={allShownPicked} onChange={() => setPicked((p) => { const n = new Set(p); if (allShownPicked) shown.forEach((g) => g.ids.forEach((i) => n.delete(i))); else shown.forEach((g) => g.ids.forEach((i) => n.add(i))); return n; })} aria-label="Select all shown cameras" />
            {shown.length} camera{shown.length === 1 ? '' : 's'} shown &middot; {shown.filter(isPicked).length} selected
          </label>
          {shown.length === 0 ? <p className="px-4 py-3 text-xs text-ink-muted">{loading ? 'Loading...' : 'No cameras match.'}</p> : shown.slice(0, 1000).map((g) => (
            <label key={g.key} className="flex items-center gap-3 px-4 py-2 text-xs hover:bg-surface-muted cursor-pointer">
              <input type="checkbox" checked={isPicked(g)} onChange={() => togglePick(g)} />
              <span className="flex-1 font-medium text-ink truncate">{g.name}{g.ids.length > 1 && <span className="ml-2 text-ink-muted font-normal" title={`${g.ids.length} copies registered by ${g.owners.size} account(s); they are handled together`}>&times;{g.ids.length}</span>}</span>
              <span className="text-ink-muted">{label(g)}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] text-ink-muted">People in a department see its cameras in their own Monitor, Map and Registry, in addition to the alerts raised on them. Cameras not given to a department stay with whoever registered them.</p>
      </section>
    </div>
  );
}
