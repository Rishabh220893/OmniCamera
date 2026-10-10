/**
 * Who may do what (gap G8). Pure functions, no I/O: a Principal (a verified person with a role and the departments they
 * work for) and a permission name in, a yes or no out. Everything that guards a route goes through `can`, so the rules
 * live here and nowhere else.
 */
export type Role = 'viewer' | 'operator' | 'admin';

/** `*` in `departments` means every department (and cameras that have none). */
export interface Principal {
  uid: string;
  role: Role;
  departments: string[];
  /** Where the role came from. `legacy` is the self-set field on the user's own Firestore document, which is not trustworthy. */
  source: 'claims' | 'legacy' | 'guest' | 'default';
}

export const PERMISSIONS = [
  'camera.view', 'camera.edit', 'camera.delete', 'camera.assign-gateway',
  'event.view', 'alert.view', 'alert.handle',
  'rule.view', 'rule.manage',
  'tracking.run', 'connector.query',
  'recording.view', 'recording.export', 'recording.manage',
  'vms.view', 'vms.manage',
  'adapter.use', 'profile.change', 'gateway.manage',
  'audit.read', 'user.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = ['camera.view', 'event.view', 'alert.view', 'rule.view'];
const OPERATOR: Permission[] = [...VIEWER, 'camera.edit', 'alert.handle', 'rule.manage', 'tracking.run', 'connector.query', 'recording.view', 'recording.export', 'vms.view'];

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  operator: new Set(OPERATOR),
  admin: new Set(PERMISSIONS),
};

/** Permissions whose use is worth a line in the access log even when allowed (everything else logs only refusals). */
export const SENSITIVE: ReadonlySet<Permission> = new Set<Permission>([
  'camera.delete', 'camera.assign-gateway', 'rule.manage', 'adapter.use', 'profile.change', 'gateway.manage', 'audit.read', 'user.manage',
  'event.view', 'alert.view', 'alert.handle', 'tracking.run', 'connector.query',
  'recording.view', 'recording.export', 'recording.manage', 'vms.view', 'vms.manage',
]);

export const isRole = (v: unknown): v is Role => v === 'viewer' || v === 'operator' || v === 'admin';

export const ALL = '*';

/** Whether the principal's departments cover a resource's department. A resource with no department is admin-wide only. */
export function coversDepartment(p: Principal, department?: string | null): boolean {
  if (p.departments.includes(ALL)) return true;
  if (!department) return false;
  return p.departments.includes(department);
}

/** Permissions that act on one department's data. Everything else an admin may do platform-wide. */
const DEPARTMENT_SCOPED = /^(camera|event|alert).|^recording.(view|export)$/;

export interface Decision { allowed: boolean; reason?: 'role' | 'department' }

/**
 * `resource.department`, when given, must be covered by the principal. Admin permissions that act on the platform rather
 * than on one department's data (gateways, profiles, adapters, users, audit) ignore it.
 */
export function decide(p: Principal, permission: Permission, resource?: { department?: string | null }): Decision {
  if (!GRANTS[p.role].has(permission)) return { allowed: false, reason: 'role' };
  const platformWide = p.role === 'admin' && !DEPARTMENT_SCOPED.test(permission);
  if (resource && !platformWide && !coversDepartment(p, resource.department)) return { allowed: false, reason: 'department' };
  return { allowed: true };
}

export const can = (p: Principal, permission: Permission, resource?: { department?: string | null }): boolean => decide(p, permission, resource).allowed;

/** Keeps the items whose department the principal covers (for lists built from many departments' data). */
export function visibleTo<T extends { department?: string | null }>(p: Principal, items: T[]): T[] {
  return p.departments.includes(ALL) ? items : items.filter((i) => coversDepartment(p, i.department));
}

/** Reads the role and departments out of a verified token's custom claims. Returns null when there is no valid role claim. */
export function principalFromClaims(uid: string, claims: Record<string, unknown> | undefined): Principal | null {
  if (!claims || !isRole(claims.role)) return null;
  const raw = claims.departments;
  const list = Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length <= 80).slice(0, 50) : [];
  // An admin with no departments listed is an organisation-wide admin; any other role with none sees nothing department-owned.
  const departments = claims.role === 'admin' && list.length === 0 ? [ALL] : list;
  return { uid, role: claims.role, departments, source: 'claims' };
}

/** The claim set to store on an account (what the `set-role` script writes). Validates, so a typo cannot create an odd role. */
export function claimsFor(role: string, departments: string[]): { role: Role; departments: string[] } {
  if (!isRole(role)) throw new Error(`Role must be viewer, operator or admin (got '${role}').`);
  const ds = [...new Set(departments.map((d) => d.trim()).filter(Boolean))];
  for (const d of ds) if (d !== ALL && !/^[\w .&-]{1,80}$/.test(d)) throw new Error(`Department '${d}' has characters that are not allowed.`);
  if (ds.includes(ALL) && role !== 'admin') throw new Error("Only an admin may cover all departments ('*').");
  return { role, departments: role === 'admin' && ds.length === 0 ? [ALL] : ds };
}

/**
 * Whose events, alerts and department rules a person reads, and handles, beyond their own. Only for a role that comes from claims
 * (the old self-set field is not trusted for this):
 *   - an organisation-wide administrator ('*'): every department, and cameras that have none  -> '*'
 *   - anyone with departments listed (an administrator too): those departments, whoever owns the cameras -> the list
 *   - everyone else: null, they see what they own, as before.
 */
export function eventScope(p: Principal | undefined | null): string[] | '*' | null {
  if (!p || p.source !== 'claims') return null;
  if (p.departments.includes(ALL)) return p.role === 'admin' ? '*' : null;
  return p.departments.length > 0 ? p.departments : null;
}
