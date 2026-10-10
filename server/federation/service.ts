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

export interface Lease { id: string; clientId: string; what: string; expiresAt: string }

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const DUMMY = sha256('no such client');
const KEY_PREFIX = 'fed_';
const newKey = (id: string) => `${KEY_PREFIX}${id}.${randomBytes(32).toString('base64url')}`;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export interface FederationServiceOptions {
  file: string;
  emit(events: PlatformEvent[]): Promise<unknown>;
  now?: () => Date;
  /** How long a session lease lasts without a renewal. Default 60 s. */
  leaseMs?: number;
  /** An upper bound on all sessions of one department together, over its clients. Unset: only the per-client cap applies. */
  departmentSessionCap?: number;
  log?: Pick<Console, 'warn' | 'info'>;
}

export function createFederationService(o: FederationServiceOptions) {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? console;
  const leaseMs = o.leaseMs ?? 60_000;
  const clients = new Map<string, FederationClient>();
  interface Stats { received: number; rejected: number; lastSeenAt: string | null; lastError: string | null; minute: Array<{ t: number; n: number }>; day: string; dayCount: number }
  const stats = new Map<string, Stats>();
  const leases = new Map<string, Lease & { until: number }>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => undefined); return r; };

  const statsOf = (id: string): Stats => {
    let s = stats.get(id);
    if (!s) { s = { received: 0, rejected: 0, lastSeenAt: null, lastError: null, minute: [], day: dayOf(now()), dayCount: 0 }; stats.set(id, s); }
    return s;
  };
  const roll = (s: Stats) => {
    const t = now().getTime();
    s.minute = s.minute.filter((x) => t - x.t < 60_000);
    if (s.day !== dayOf(now())) { s.day = dayOf(now()); s.dayCount = 0; }
  };
  const sweep = () => { const t = now().getTime(); for (const [id, l] of leases) if (l.until <= t) leases.delete(id); };
  const sessionsOf = (clientId: string) => { sweep(); return [...leases.values()].filter((l) => l.clientId === clientId).length; };
  const usage = (c: FederationClient): FederationUsage => {
    const s = statsOf(c.id); roll(s);
    return { eventsLastMinute: s.minute.reduce((a, x) => a + x.n, 0), eventsToday: s.dayCount, activeSessions: sessionsOf(c.id), received: s.received, rejected: s.rejected, lastSeenAt: s.lastSeenAt, lastError: s.lastError };
  };
  const view = (c: FederationClient): FederationClientView => { const { keyHash: _k, ...rest } = c; return { ...rest, usage: usage(c) }; };

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
        return { client: view(c), key };
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
      if (!next.enabled) for (const [lid, l] of leases) if (l.clientId === id) leases.delete(lid);
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
      return { client: view(clients.get(id)!), key };
    }),

    remove: (id: string) => serial(async () => {
      await ensureLoaded();
      if (!clients.delete(id)) return false;
      stats.delete(id);
      for (const [lid, l] of leases) if (l.clientId === id) leases.delete(lid);
      await persist();
      return true;
    }),

    list: (): FederationClientView[] => [...clients.values()].map(view),
    get: (id: string) => { const c = clients.get(id); return c ? view(c) : null; },
    authenticate,
    /** What a client may see about itself (never the hash). */
    whoami: (c: FederationClient): FederationClientView => view(c),

    /** Events pushed by a client. The body is the generic JSON format; the client's department is stamped on every event. */
    async push(c: FederationClient, body: string): Promise<PushResult> {
      if (!c.scopes.includes('events.push')) return { status: 'forbidden' };
      const s = statsOf(c.id); roll(s);
      s.lastSeenAt = now().toISOString();
      let batch;
      try { batch = parseWebhookBody('generic-json', body, { now: now(), timezoneOffsetMinutes: c.timezoneOffsetMinutes }); }
      catch (e) { s.rejected++; s.lastError = e instanceof Error ? e.message : String(e); if (e instanceof FormatError) return { status: 'bad_request', error: s.lastError }; throw e; }
      const n = batch.events.length;
      if (n === 0) { s.rejected++; s.lastError = batch.ignored[0] ?? 'no usable events in the body'; return { status: 'bad_request', error: s.lastError }; }
      const inMinute = s.minute.reduce((a, x) => a + x.n, 0);
      if (inMinute + n > c.quotas.eventsPerMinute) {
        s.rejected++; s.lastError = 'per-minute event quota reached';
        const oldest = s.minute[0]?.t ?? now().getTime();
        return { status: 'quota', which: 'minute', retryAfterS: Math.max(1, Math.ceil((oldest + 60_000 - now().getTime()) / 1000)) };
      }
      if (s.dayCount + n > c.quotas.eventsPerDay) {
        s.rejected++; s.lastError = 'daily event quota reached';
        const t = now(); const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
        return { status: 'quota', which: 'day', retryAfterS: Math.max(1, Math.ceil((midnight - t.getTime()) / 1000)) };
      }
      const system: VmsSystemConfig = { id: `fed-${c.id}`, kind: 'webhook', baseUrl: 'federation:', ownerUserId: c.ownerUserId, department: c.department };
      const events = batch.events.map((e) => platformEventFromVms(system, { id: e.cameraId, name: batch.names.get(e.cameraId) ?? e.cameraId, location: undefined }, e));
      await o.emit(events); // if the bus is down this throws and nothing is counted: the sender retries
      s.minute.push({ t: now().getTime(), n });
      s.dayCount += n; s.received += n; s.lastError = batch.ignored[0] ?? null;
      return { status: 'ok', accepted: n, ignored: batch.ignored };
    },

    /** Takes one live-session slot (a person watching a department's camera through the platform). */
    acquire(c: FederationClient, what: string): LeaseResult {
      if (!c.scopes.includes('sessions')) return { status: 'forbidden' };
      statsOf(c.id).lastSeenAt = now().toISOString();
      sweep();
      const mine = sessionsOf(c.id);
      const dept = [...leases.values()].filter((l) => clients.get(l.clientId)?.department === c.department).length;
      if (mine >= c.quotas.maxSessions || (o.departmentSessionCap !== undefined && dept >= o.departmentSessionCap)) {
        statsOf(c.id).rejected++;
        return { status: 'cap', max: mine >= c.quotas.maxSessions ? c.quotas.maxSessions : o.departmentSessionCap!, retryAfterS: Math.ceil(leaseMs / 1000) };
      }
      const until = now().getTime() + leaseMs;
      const lease = { id: randomBytes(12).toString('base64url'), clientId: c.id, what: what.slice(0, 120), expiresAt: new Date(until).toISOString(), until };
      leases.set(lease.id, lease);
      return { status: 'ok', lease: { id: lease.id, clientId: lease.clientId, what: lease.what, expiresAt: lease.expiresAt } };
    },

    /** Keeps a lease alive. A lease that ran out is gone: the caller has to acquire again (and may be refused). */
    renew(c: FederationClient, leaseId: string): LeaseResult {
      sweep();
      const l = leases.get(leaseId);
      if (!l || l.clientId !== c.id) return { status: 'gone' };
      l.until = now().getTime() + leaseMs; l.expiresAt = new Date(l.until).toISOString();
      return { status: 'ok', lease: { id: l.id, clientId: l.clientId, what: l.what, expiresAt: l.expiresAt } };
    },

    release(c: FederationClient, leaseId: string): boolean {
      const l = leases.get(leaseId);
      if (!l || l.clientId !== c.id) return false;
      return leases.delete(leaseId);
    },

    sessions: (): Lease[] => { sweep(); return [...leases.values()].map(({ until: _u, ...l }) => l); },
  };
}
export type FederationService = ReturnType<typeof createFederationService>;
