/**
 * Per-user video access (gap A21, docs/security-architecture.md). Until now every signed-in person was given the media server's one shared viewer password,
 * which opens EVERY camera path: a person who knew (or guessed) a path name could watch a camera they have no right to. With `MEDIA_AUTH_MODE=token`:
 *
 *   1. `/api/media/config` gives a verified person a **signed token** in place of the shared password. It names who they are (uid, role, departments) and
 *      lasts `ttl` (10 minutes by default); the browser asks for a fresh one before it ends.
 *   2. MediaMTX is set to ask the app about each request (`authMethod: http`, `authHTTPAddress` = `/api/media/auth`). The app checks the token (signature,
 *      time) and then whether this person may read THIS path: they own a camera on it, or it is on a camera of a department they work for (an
 *      organisation-wide administrator: any camera). Anything else is refused (401).
 *   3. Publishing and the control API are allowed from loopback (or `MEDIA_INTERNAL_IPS`) without a token; reading never is.
 *
 * What it does not do: a person who may watch a camera can pass their token to someone else for its 10 minutes (tokens are bearer tokens, like the password
 * was, but shorter-lived and limited to what that person may see); and it protects the media server's HTTP paths and the paths MediaMTX asks about, not a
 * recording on disk (recordings go through the recording routes' own checks).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { ALL, type Principal } from '../authz/policy';

// ---- tokens ----------------------------------------------------------------------------------------------------------------------------

export interface TokenClaims { uid: string; role: Principal['role']; departments: string[]; exp: number }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function createStreamTokens(o: { secret: string | Buffer; ttlMs?: number; now?: () => number }) {
  const secret = typeof o.secret === 'string' ? Buffer.from(o.secret) : o.secret;
  if (secret.length < 16) throw new Error('MEDIA_TOKEN_SECRET must be at least 16 characters (use 32 random bytes).');
  const ttl = o.ttlMs ?? 10 * 60_000, now = o.now ?? Date.now;
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest();
  return {
    ttlMs: ttl,
    issue(p: Pick<Principal, 'uid' | 'role' | 'departments'>): { token: string; expiresAt: number } {
      const exp = now() + ttl;
      const body = b64(JSON.stringify({ u: p.uid, r: p.role, d: p.departments.slice(0, 50), e: exp }));
      return { token: `v1.${body}.${b64(sign(body))}`, expiresAt: exp };
    },
    verify(token: string | undefined): TokenClaims | null {
      const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token ?? '');
      if (!m) return null;
      const want = sign(m[1]), got = Buffer.from(m[2], 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
      try {
        const c = JSON.parse(Buffer.from(m[1], 'base64url').toString()) as { u?: unknown; r?: unknown; d?: unknown; e?: unknown };
        if (typeof c.u !== 'string' || typeof c.e !== 'number' || c.e <= now() || !Array.isArray(c.d) || (c.r !== 'viewer' && c.r !== 'operator' && c.r !== 'admin')) return null;
        return { uid: c.u, role: c.r, departments: c.d.filter((x): x is string => typeof x === 'string'), exp: c.e };
      } catch { return null; }
    },
  };
}
export type StreamTokens = ReturnType<typeof createStreamTokens>;

// ---- who may read which path -----------------------------------------------------------------------------------------------------------

export interface PathEntry { path: string; ownerUid: string; department?: string | null }

/** Path -> who owns a camera on it and which departments those cameras belong to. Built from the Registry; refreshed in the background and on a miss. */
export function createPathAccess(o: { load: () => Promise<PathEntry[]>; refreshMs?: number; missRefreshMs?: number; now?: () => number; log?: Pick<Console, 'warn'> }) {
  const now = o.now ?? Date.now, log = o.log ?? console;
  const refreshMs = o.refreshMs ?? 60_000, missMs = o.missRefreshMs ?? 10_000;
  let index = new Map<string, { owners: Set<string>; departments: Set<string> }>();
  let loadedAt = -Infinity, lastMissRefresh = -Infinity, loading: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    if (loading) return loading;
    loading = (async () => {
      try {
        const next = new Map<string, { owners: Set<string>; departments: Set<string> }>();
        for (const e of await o.load()) {
          if (!e.path) continue;
          const x = next.get(e.path) ?? { owners: new Set<string>(), departments: new Set<string>() };
          if (e.ownerUid) x.owners.add(e.ownerUid);
          if (e.department) x.departments.add(e.department);
          next.set(e.path, x);
        }
        index = next; loadedAt = now();
      } catch (e) { log.warn(`[MEDIA] could not load the camera paths: ${e instanceof Error ? e.message : e}`); }
    })().finally(() => { loading = null; });
    return loading;
  }

  const decide = (c: Pick<TokenClaims, 'uid' | 'role' | 'departments'>, path: string): boolean | null => {
    const e = index.get(path);
    if (!e) return null;
    if (e.owners.has(c.uid)) return true;
    if (c.role === 'admin' && c.departments.includes(ALL)) return true;
    for (const d of c.departments) if (d !== ALL && e.departments.has(d)) return true;
    return false;
  };

  return {
    refresh,
    /** May this person read this path? Unknown paths are looked up again (at most every `missRefreshMs`) before they are refused. */
    async canRead(c: Pick<TokenClaims, 'uid' | 'role' | 'departments'>, path: string): Promise<boolean> {
      if (now() - loadedAt > refreshMs) await refresh();
      let r = decide(c, path);
      if (r === null && now() - lastMissRefresh > missMs) { lastMissRefresh = now(); await refresh(); r = decide(c, path); }
      return r === true;
    },
    size: () => index.size,
  };
}
export type PathAccess = ReturnType<typeof createPathAccess>;

// ---- MediaMTX's callback -----------------------------------------------------------------------------------------------------------------

/** What MediaMTX posts for each authentication request (the fields it documents; anything else is ignored). */
export interface MediaAuthRequest { user?: string; password?: string; ip?: string; action?: string; path?: string; protocol?: string; id?: string; query?: string }

const LOOPBACK = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;
const SAFE_PATH = /^[A-Za-z0-9_\-./]{1,200}$/;

export async function decideMediaAuth(r: MediaAuthRequest, d: { tokens: StreamTokens; access: PathAccess; internalIps?: (ip: string) => boolean }): Promise<boolean> {
  const ip = String(r.ip ?? '');
  const internal = d.internalIps ?? ((x: string) => LOOPBACK.test(x));
  const action = String(r.action ?? '');
  // Publishing and the control API are for the machine itself or an allowed network. NEVER reads: behind a reverse proxy on the same host every viewer
  // arrives from 127.0.0.1, so letting loopback read would let everyone in without a token.
  if (internal(ip) && ['publish', 'api', 'metrics', 'pprof'].includes(action)) return true;
  if (action !== 'read' && action !== 'playback') return false; // nobody may publish or use the API from outside
  const path = String(r.path ?? '').replace(/^\/+/, '').split('/')[0];
  if (!path || !SAFE_PATH.test(path)) return false;
  const claims = d.tokens.verify(r.password);
  if (!claims) return false;
  return d.access.canRead(claims, path);
}

/**
 * `POST /api/media/auth` is what MediaMTX calls. It answers 200 (allowed) or 401. It is protected by a secret in the URL MediaMTX is given
 * (`?s=<MEDIA_AUTH_SECRET>`), because anyone who could call it could ask "is this token good for this path"; keep it on the internal network as well.
 */
export function registerMediaAuth(app: Express, o: { tokens: StreamTokens; access: PathAccess; secret: string; internalIps?: (ip: string) => boolean }): void {
  const want = Buffer.from(o.secret);
  app.post('/api/media/auth', async (req: Request, res: Response) => {
    const given = Buffer.from(typeof req.query.s === 'string' ? req.query.s : '');
    if (given.length !== want.length || !timingSafeEqual(given, want)) { res.status(401).end(); return; }
    try {
      const ok = await decideMediaAuth((req.body ?? {}) as MediaAuthRequest, o);
      res.status(ok ? 200 : 401).end();
    } catch (e) { console.error('[MEDIA]', e instanceof Error ? e.message : e); res.status(500).end(); }
  });
}
