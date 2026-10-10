/**
 * Turns a request into a Principal and checks it against the policy (server/authz/policy.ts), writing an access log line for
 * refusals and for sensitive uses. All identity lookups are injected, so the same code runs against Firebase in the server and
 * against fakes in tests.
 */
import type { Request, Response } from 'express';
import { ALL, SENSITIVE, decide, isRole, principalFromClaims, type Permission, type Principal } from './policy';

export interface AccessLogEntry {
  at: string;
  uid: string;
  role: string;
  source: Principal['source'] | 'none';
  permission: Permission | 'sign-in';
  allowed: boolean;
  reason?: string;
  method: string;
  path: string;
  /** Department of the resource, when the check was about one. */
  department?: string;
}
export interface AccessLog { record(entry: AccessLogEntry): void }

export interface VerifiedToken { uid: string; claims: Record<string, unknown> }

export interface AuthzDeps {
  /** Verifies an ID token. Throws when it is invalid, expired or (if checked) revoked. */
  verify(idToken: string): Promise<VerifiedToken>;
  /** The self-set role on the user's own document, for accounts that have no claims yet. Omit to turn that fallback off. */
  legacyProfile?: (uid: string) => Promise<{ role?: unknown; department?: unknown } | undefined>;
  /** Local demo: everyone is an admin named `demo`. */
  allowGuests?: boolean;
  /** False before Firebase is configured. */
  ready?: () => boolean;
  log?: AccessLog;
  now?: () => Date;
  warn?: (message: string) => void;
}

export interface Authz {
  /** The signed-in principal, or null after replying 401. */
  authenticate(req: Request, res: Response): Promise<Principal | null>;
  /** The principal if signed in and allowed `permission` (on `resource`), else null after replying 401 or 403. */
  require(req: Request, res: Response, permission: Permission, resource?: { department?: string | null }): Promise<Principal | null>;
  /** The same check for code that already has the principal (a resource found after the route started). */
  check(p: Principal, permission: Permission, resource: { department?: string | null } | undefined, req: Request): boolean;
}

const DENIAL: Record<Permission, string> = {
  'camera.view': 'You cannot view cameras.', 'camera.edit': 'You cannot change cameras.', 'camera.delete': 'Only an admin can delete cameras.',
  'camera.assign-gateway': 'Only an admin can assign a camera to a gateway.', 'event.view': 'You cannot view events.', 'alert.view': 'You cannot view alerts.',
  'alert.handle': 'Your role cannot acknowledge or resolve alerts.', 'rule.view': 'You cannot view alert rules.', 'rule.manage': 'Your role cannot change alert rules.',
  'tracking.run': 'Your role cannot start tracking jobs.', 'connector.query': 'Your role cannot query the connected systems.',
  'recording.view': 'Your role cannot view recordings.', 'recording.export': 'Your role cannot export recordings.', 'recording.manage': 'Only an admin can change recording settings.',
  'vms.view': 'Your role cannot view department systems.', 'vms.manage': 'Only an admin can manage department systems.', 'adapter.use': 'Only an admin can use the camera adapters.', 'profile.change': 'Only an admin can change playback profiles.',
  'gateway.manage': 'Only an admin can manage gateways.', 'audit.read': 'Only an admin can read the access log.', 'user.manage': 'Only an admin can manage users.',
};

/** Pulls the token out of an `Authorization: Bearer <token>` header (the one place this is parsed). */
export function bearerToken(req: { header(name: string): string | undefined }): string {
  const m = (req.header('Authorization') || '').match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : '';
}

export function createAuthz(deps: AuthzDeps): Authz {
  const now = deps.now ?? (() => new Date());
  const warned = new Set<string>();
  const log = (e: Omit<AccessLogEntry, 'at'>) => { try { deps.log?.record({ at: now().toISOString(), ...e }); } catch { /* the log must never break a request */ } };

  async function resolve(idToken: string): Promise<Principal> {
    const t = await deps.verify(idToken);
    const fromClaims = principalFromClaims(t.uid, t.claims);
    if (fromClaims) return fromClaims;
    if (deps.legacyProfile) {
      const doc = await deps.legacyProfile(t.uid).catch(() => undefined);
      if (!warned.has(t.uid)) {
        warned.add(t.uid);
        deps.warn?.(`[AUTHZ] ${t.uid} has no role claim; using the self-set role on its user document. Run "npm run set-role" to move it to claims.`);
      }
      // Same as before G8: a self-set 'admin' is an admin; anyone else is an operator who is not limited to a department.
      if (doc?.role === 'admin') return { uid: t.uid, role: 'admin', departments: [ALL], source: 'legacy' };
      const department = typeof doc?.department === 'string' && doc.department ? [doc.department] : [ALL];
      return { uid: t.uid, role: isRole(doc?.role) && doc.role !== 'admin' ? doc.role : 'operator', departments: department, source: 'legacy' };
    }
    // Signed in, but nobody has given this account a role: read-only and no department's data.
    return { uid: t.uid, role: 'viewer', departments: [], source: 'default' };
  }

  async function authenticate(req: Request, res: Response): Promise<Principal | null> {
    if (deps.allowGuests) return { uid: 'demo', role: 'admin', departments: [ALL], source: 'guest' };
    const idToken = bearerToken(req);
    if (!idToken || (deps.ready && !deps.ready())) {
      log({ uid: '', role: '', source: 'none', permission: 'sign-in', allowed: false, reason: idToken ? 'not configured' : 'no token', method: req.method, path: req.path });
      res.status(401).json({ error: 'Sign-in required.' });
      return null;
    }
    try { return await resolve(idToken); } catch {
      log({ uid: '', role: '', source: 'none', permission: 'sign-in', allowed: false, reason: 'token not verified', method: req.method, path: req.path });
      res.status(401).json({ error: 'Sign-in could not be verified.' });
      return null;
    }
  }

  function check(p: Principal, permission: Permission, resource: { department?: string | null } | undefined, req: Request): boolean {
    const d = decide(p, permission, resource);
    if (!d.allowed || SENSITIVE.has(permission)) {
      log({ uid: p.uid, role: p.role, source: p.source, permission, allowed: d.allowed, reason: d.reason, method: req.method, path: req.path, department: resource?.department ?? undefined });
    }
    return d.allowed;
  }

  return {
    authenticate,
    check,
    async require(req, res, permission, resource) {
      const p = await authenticate(req, res);
      if (!p) return null;
      if (check(p, permission, resource, req)) return p;
      res.status(403).json({ error: decide(p, permission, resource).reason === 'department' ? 'That belongs to a department you do not work for.' : DENIAL[permission] });
      return null;
    },
  };
}

/** Keeps the last `max` entries in memory (readable through the access-log route) and forwards each to `next`, if given. */
export function createRingLog(max = 2000, next?: AccessLog): AccessLog & { recent(limit?: number, filter?: { uid?: string; allowed?: boolean }): AccessLogEntry[]; dropped: number } {
  const buf: AccessLogEntry[] = [];
  const log = {
    dropped: 0,
    record(e: AccessLogEntry) {
      buf.push(e);
      if (buf.length > max) { buf.shift(); log.dropped++; }
      next?.record(e);
    },
    recent(limit = 200, filter: { uid?: string; allowed?: boolean } = {}) {
      return buf.filter((e) => (filter.uid === undefined || e.uid === filter.uid) && (filter.allowed === undefined || e.allowed === filter.allowed)).slice(-Math.min(limit, max)).reverse();
    },
  };
  return log;
}

/**
 * Writes entries somewhere durable in batches (Firestore in the server). Bounded: when the sink is down for long, the oldest
 * entries are dropped and counted rather than growing without limit.
 */
export function createBatchedLog(write: (batch: AccessLogEntry[]) => Promise<void>, o: { flushMs?: number; maxQueue?: number; maxBatch?: number } = {}): AccessLog & { flush(): Promise<void>; stop(): Promise<void>; dropped: number; failures: number } {
  const maxQueue = o.maxQueue ?? 5000, maxBatch = o.maxBatch ?? 400;
  let queue: AccessLogEntry[] = [];
  let busy: Promise<void> | null = null;
  const log = {
    dropped: 0, failures: 0,
    record(e: AccessLogEntry) { queue.push(e); if (queue.length > maxQueue) { queue.shift(); log.dropped++; } },
    async flush() {
      if (busy) return busy;
      busy = (async () => {
        while (queue.length) {
          const batch = queue.slice(0, maxBatch);
          try { await write(batch); const sent = new Set(batch); queue = queue.filter((e) => !sent.has(e)); } catch { log.failures++; return; }
        }
      })().finally(() => { busy = null; });
      return busy;
    },
    async stop() { clearInterval(timer); await log.flush(); },
  };
  const timer = setInterval(() => { void log.flush(); }, o.flushMs ?? 2000);
  timer.unref?.();
  return log;
}
