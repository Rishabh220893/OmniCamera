/**
 * The federation service (gap A7): who a department's system or a connector is when it talks to the platform, and how much it may do.
 *
 * A **client** is one identity (a department's system, an integrator's script, a connector) with
 *   - an API key, shown once when made; only its SHA-256 is kept (as for webhook tokens). The id is part of the key (`fed_<id>.<secret>`), so
 *     a request names no id of its own and cannot ask for another department's identity;
 *   - a **department**, fixed on the client: every event it pushes carries that department whatever the body says;
 *   - scopes (`events.push`, `sessions`), quotas (events a minute, events a day, live sessions at once) and an on/off switch.
 *
 * Quotas are checked before anything is accepted and are all-or-nothing per request. Session caps are leases: a lease that is not renewed
 * runs out by itself, so a viewer that crashed cannot hold a slot forever.
 *
 * State of use (counters, leases) is in this process's memory: with several server processes each keeps its own count (the limits are then
 * per process). Clients themselves are in a file (mode 0600), like the webhook sources. mTLS is not built; see docs/federation-service.md.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlatformEvent } from '../events/schema';
import { DEPARTMENT_NAME_RE } from '../events/rules';
import { FormatError, parseWebhookBody } from '../connectors/webhook/formats';
import { platformEventFromVms } from '../connectors/vms/mapping';
import type { VmsSystemConfig } from '../connectors/vms/types';
import { createMemoryUsageStore, type Lease, type UsageStore } from './usageStore';

export type { Lease } from './usageStore';

export const FEDERATION_SCOPES = ['events.push', 'sessions'] as const;
export type FederationScope = (typeof FEDERATION_SCOPES)[number];

export interface FederationQuotas {
  eventsPerMinute: number;
  eventsPerDay: number;
  maxSessions: number;
}

export const DEFAULT_QUOTAS: FederationQuotas = { eventsPerMinute: 600, eventsPerDay: 200_000, maxSessions: 4 };

export interface FederationClient {
  id: string;
  label?: string;
  department: string;
  /** Who the events belong to until every store is department-keyed (as for department systems and webhook sources). */
  ownerUserId: string;
  scopes: FederationScope[];
  quotas: FederationQuotas;
  enabled: boolean;
  keyHash: string;
  createdAt: string;
  timezoneOffsetMinutes?: number;
}

export interface FederationUsage {
  eventsLastMinute: number;
  eventsToday: number;
  activeSessions: number;
  received: number;
  rejected: number;
  lastSeenAt: string | null;
  lastError: string | null;
}

export type FederationClientView = Omit<FederationClient, 'keyHash'> & { usage: FederationUsage };

export type PushResult =
  | { status: 'ok'; accepted: number; ignored: string[] }
  | { status: 'forbidden' }
  | { status: 'quota'; which: 'minute' | 'day'; retryAfterS: number }
  | { status: 'bad_request'; error: string };

export type LeaseResult =
  | { status: 'ok'; lease: Lease }
  | { status: 'forbidden' }
  | { status: 'cap'; max: number; retryAfterS: number }
  | { status: 'gone' };


const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const DUMMY = sha256('no such client');
const KEY_PREFIX = 'fed_';
const newKey = (id: string) => `${KEY_PREFIX}${id}.${randomBytes(32).toString('base64url')}`;

export interface FederationServiceOptions {
  file: string;
  emit(events: PlatformEvent[]): Promise<unknown>;
  now?: () => Date;
  /** How long a session lease lasts without a renewal. Default 60 s. */
  leaseMs?: number;
  /** An upper bound on all sessions of one department together, over its clients. Unset: only the per-client cap applies. */
  departmentSessionCap?: number;
  /** Where counters and leases live. Default: in this process's memory; pass a Redis store to share limits between server processes. */
  store?: UsageStore;
  log?: Pick<Console, 'warn' | 'info'>;
}

export function createFederationService(o: FederationServiceOptions) {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? console;
  const leaseMs = o.leaseMs ?? 60_000;
  const store = o.store ?? createMemoryUsageStore();
  const clients = new Map<string, FederationClient>();
  interface Stats { received: number; rejected: number; lastSeenAt: string | null; lastError: string | null }
  const stats = new Map<string, Stats>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => undefined); return r; };

  const statsOf = (id: string): Stats => {
    let s = stats.get(id);
    if (!s) { s = { received: 0, rejected: 0, lastSeenAt: null, lastError: null }; stats.set(id, s); }
    return s;
  };
  const usage = async (c: FederationClient): Promise<FederationUsage> => {
    const s = statsOf(c.id), t = now().getTime();
    const [ev, active] = await Promise.all([store.eventsUsed(c.id, t), store.activeSessions(c.id, t)]);
    return { eventsLastMinute: ev.minute, eventsToday: ev.day, activeSessions: active, received: s.received, rejected: s.rejected, lastSeenAt: s.lastSeenAt, lastError: s.lastError };
  };
  const view = async (c: FederationClient): Promise<FederationClientView> => { const { keyHash: _k, ...rest } = c; return { ...rest, usage: await usage(c) }; };

  async function persist() {
    await fs.mkdir(path.dirname(o.file), { recursive: true });
    const tmp = `${o.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...clients.values()], null, 2), { mode: 0o600 });
    await fs.rename(tmp, o.file);
  }

  const posInt = (v: unknown, name: string, max: number): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new FormatError(`'${name}' must be a whole number from 0 to ${max}.`);
    return n;
  };

  function readQuotas(raw: unknown, base: FederationQuotas): FederationQuotas {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      eventsPerMinute: r.eventsPerMinute === undefined ? base.eventsPerMinute : posInt(r.eventsPerMinute, 'quotas.eventsPerMinute', 100_000),
      eventsPerDay: r.eventsPerDay === undefined ? base.eventsPerDay : posInt(r.eventsPerDay, 'quotas.eventsPerDay', 100_000_000),
      maxSessions: r.maxSessions === undefined ? base.maxSessions : posInt(r.maxSessions, 'quotas.maxSessions', 1000),
    };
  }
  function readScopes(raw: unknown, base: FederationScope[]): FederationScope[] {
    if (raw === undefined) return base;
    if (!Array.isArray(raw) || !raw.every((x) => FEDERATION_SCOPES.includes(x as FederationScope))) throw new FormatError(`'scopes' must be a list of ${FEDERATION_SCOPES.join(', ')}.`);
    return [...new Set(raw as FederationScope[])];
  }

  let loadP: Promise<void> | null = null;
  const ensureLoaded = (): Promise<void> => (loadP ??= (async () => {
    try { for (const c of JSON.parse(await fs.readFile(o.file, 'utf8')) as FederationClient[]) if (c?.id && c.keyHash) clients.set(c.id, c); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`[FEDERATION] could not read ${o.file}: ${e instanceof Error ? e.message : e}`); }
  })());

  /** The client a key belongs to, or null. An unknown id, a wrong secret and a switched-off client look the same to the caller. */
  function authenticate(key: string | undefined): FederationClient | null {
    const m = key?.match(/^fed_([A-Za-z0-9_-]{1,40})\.\S+$/);
    const c = m ? clients.get(m[1]) : undefined;
    const want = Buffer.from(c?.keyHash ?? DUMMY, 'hex'), got = Buffer.from(sha256(key ?? ''), 'hex');
    const same = timingSafeEqual(want, got);
    return same && c && c.enabled ? c : null;
  }

  return {
    load: ensureLoaded,

    /** Makes a client and its key. The key is returned this once. */
    async create(raw: unknown, creator: string): Promise<{ client: FederationClientView; key: string }> {
      await ensureLoaded();
      return serial(async () => {
        const r = (raw ?? {}) as Record<string, unknown>;
        const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
        const id = str(r.id, 40);
        if (!id || !ID_RE.test(id)) throw new FormatError("'id' must be 1-40 letters, digits, _ or -.");
        if (clients.has(id)) throw new FormatError(`A client named '${id}' already exists.`);
        const department = str(r.department, 80);
        if (!department || !DEPARTMENT_NAME_RE.test(department)) throw new FormatError("'department' is required and must be a department name.");
        const c: FederationClient = {
          id, department, ownerUserId: str(r.ownerUserId, 200) ?? creator,
          scopes: readScopes(r.scopes, ['events.push']), quotas: readQuotas(r.quotas, DEFAULT_QUOTAS), enabled: true, keyHash: '', createdAt: now().toISOString(),
        };
        if (str(r.label, 120)) c.label = str(r.label, 120);
        if (r.timezoneOffsetMinutes !== undefined) {
          const tz = Number(r.timezoneOffsetMinutes);
          if (!Number.isInteger(tz) || tz < -720 || tz > 840) throw new FormatError("'timezoneOffsetMinutes' must be a whole number from -720 to 840.");
          c.timezoneOffsetMinutes = tz;
        }
        const key = newKey(id);
        c.keyHash = sha256(key);
        clients.set(id, c);
        await persist();
        return { client: await view(c), key };
      });
    },

    /** Changes label, scopes, quotas or the on/off switch. The department and the key are not changed here. */
    update: (id: string, raw: unknown) => serial(async () => {
      await ensureLoaded();
      const c = clients.get(id);
      if (!c) return null;
      const r = (raw ?? {}) as Record<string, unknown>;
      const next: FederationClient = { ...c, scopes: readScopes(r.scopes, c.scopes), quotas: readQuotas(r.quotas, c.quotas) };
      if (r.enabled !== undefined) { if (typeof r.enabled !== 'boolean') throw new FormatError("'enabled' must be true or false."); next.enabled = r.enabled; }
      if (typeof r.label === 'string') next.label = r.label.trim().slice(0, 120) || undefined;
      clients.set(id, next);
      if (!next.enabled) await store.dropClient(id);
      await persist();
      return view(next);
    }),

    /** A new key; the old one stops working at once. */
    rotate: (id: string) => serial(async () => {
      await ensureLoaded();
      const c = clients.get(id);
      if (!c) return null;
      const key = newKey(id);
      clients.set(id, { ...c, keyHash: sha256(key) });
      await persist();
      return { client: await view(clients.get(id)!), key };
    }),

    remove: (id: string) => serial(async () => {
      await ensureLoaded();
      if (!clients.delete(id)) return false;
      stats.delete(id);
      await store.dropClient(id);
      await persist();
      return true;
    }),

    list: (): Promise<FederationClientView[]> => Promise.all([...clients.values()].map(view)),
    get: async (id: string) => { const c = clients.get(id); return c ? view(c) : null; },
    count: () => clients.size,
    authenticate,
    /** What a client may see about itself (never the hash). */
    whoami: (c: FederationClient): Promise<FederationClientView> => view(c),

    /** Events pushed by a client. The body is the generic JSON format; the client's department is stamped on every event. */
    async push(c: FederationClient, body: string): Promise<PushResult> {
      if (!c.scopes.includes('events.push')) return { status: 'forbidden' };
      const s = statsOf(c.id);
      s.lastSeenAt = now().toISOString();
      let batch;
      try { batch = parseWebhookBody('generic-json', body, { now: now(), timezoneOffsetMinutes: c.timezoneOffsetMinutes }); }
      catch (e) { s.rejected++; s.lastError = e instanceof Error ? e.message : String(e); if (e instanceof FormatError) return { status: 'bad_request', error: s.lastError }; throw e; }
      const n = batch.events.length;
      if (n === 0) { s.rejected++; s.lastError = batch.ignored[0] ?? 'no usable events in the body'; return { status: 'bad_request', error: s.lastError }; }
      // Counted first (atomically, so several servers cannot both take the last of a quota) and given back if the bus then refuses.
      const r = await store.reserveEvents(c.id, n, { perMinute: c.quotas.eventsPerMinute, perDay: c.quotas.eventsPerDay }, now().getTime());
      if (r.ok === false) {
        s.rejected++; s.lastError = r.which === 'day' ? 'daily event quota reached' : 'per-minute event quota reached';
        return { status: 'quota', which: r.which, retryAfterS: Math.max(1, Math.ceil(r.retryAfterMs / 1000)) };
      }
      const system: VmsSystemConfig = { id: `fed-${c.id}`, kind: 'webhook', baseUrl: 'federation:', ownerUserId: c.ownerUserId, department: c.department };
      const events = batch.events.map((e) => platformEventFromVms(system, { id: e.cameraId, name: batch.names.get(e.cameraId) ?? e.cameraId, location: undefined }, e));
      try { await o.emit(events); }
      catch (e) { await store.unreserveEvents(c.id, n, now().getTime()).catch(() => undefined); throw e; } // the bus is down: the sender retries, so this use is given back
      s.received += n; s.lastError = batch.ignored[0] ?? null;
      return { status: 'ok', accepted: n, ignored: batch.ignored };
    },

    /** Takes one live-session slot (a person watching a department's camera through the platform). */
    async acquire(c: FederationClient, what: string): Promise<LeaseResult> {
      if (!c.scopes.includes('sessions')) return { status: 'forbidden' };
      statsOf(c.id).lastSeenAt = now().toISOString();
      const r = await store.acquire({ id: randomBytes(12).toString('base64url'), clientId: c.id, department: c.department, what: what.slice(0, 120) }, { client: c.quotas.maxSessions, department: o.departmentSessionCap }, now().getTime(), leaseMs);
      if (r.ok === false) { statsOf(c.id).rejected++; return { status: 'cap', max: r.max, retryAfterS: Math.ceil(leaseMs / 1000) }; }
      return { status: 'ok', lease: r.lease };
    },

    /** Keeps a lease alive. A lease that ran out is gone: the caller has to acquire again (and may be refused). */
    async renew(c: FederationClient, leaseId: string): Promise<LeaseResult> {
      const l = await store.renew(c.id, leaseId, now().getTime(), leaseMs);
      return l ? { status: 'ok', lease: l } : { status: 'gone' };
    },

    release: (c: FederationClient, leaseId: string): Promise<boolean> => store.release(c.id, leaseId),

    sessions: (): Promise<Lease[]> => store.leases(now().getTime()),
    storeKind: store.kind,
  };
}
export type FederationService = ReturnType<typeof createFederationService>;
