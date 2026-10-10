/**
 * The webhook receiver's sources (federation plan step 3): a system that can only PUSH its events gets a source here, with its own secret
 * token. Each request is checked against the token, turned into events by the source's format, mapped like any connector's events
 * (`platformEventFromVms`) and handed to `emit` (the bus). The token is shown once, when it is made; only its SHA-256 is kept.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlatformEvent } from '../../events/schema';
import { DEPARTMENT_NAME_RE } from '../../events/rules';
import { platformEventFromVms } from '../vms/mapping';
import { platformCameraId, type VmsSystemConfig } from '../vms/types';
import { FormatError, WEBHOOK_FORMATS, parseWebhookBody, type WebhookFormat } from './formats';

export interface WebhookSource {
  id: string;
  label?: string;
  format: WebhookFormat;
  /** Who the events belong to until the multi-department model covers them (as for department systems), and the department they carry. */
  ownerUserId: string;
  department?: string;
  timezoneOffsetMinutes?: number;
  tokenHash: string;
  createdAt: string;
}

export interface WebhookSourceView extends Omit<WebhookSource, 'tokenHash'> {
  received: number;
  rejected: number;
  lastReceivedAt: string | null;
  lastError: string | null;
}

export type ReceiveResult =
  | { status: 'ok'; accepted: number; ignored: string[] }
  | { status: 'unauthorized' }
  | { status: 'rate_limited'; retryAfterS: number }
  | { status: 'bad_request'; error: string };

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => `wh_${randomBytes(32).toString('base64url')}`;
const DUMMY = sha256('no such source');

export interface WebhookServiceOptions {
  file: string;
  emit(events: PlatformEvent[]): Promise<unknown>;
  now?: () => Date;
  /** Requests per window per source. Default 200 per 10 s. */
  maxRequests?: number;
  windowMs?: number;
  log?: Pick<Console, 'warn' | 'info'>;
}

export function createWebhookService(o: WebhookServiceOptions) {
  const now = o.now ?? (() => new Date());
  const log = o.log ?? console;
  const sources = new Map<string, WebhookSource>();
  const stats = new Map<string, { received: number; rejected: number; lastReceivedAt: string | null; lastError: string | null; window: number[] }>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => undefined); return r; };
  const maxReq = o.maxRequests ?? 200, windowMs = o.windowMs ?? 10_000;

  const statsOf = (id: string) => { let s = stats.get(id); if (!s) { s = { received: 0, rejected: 0, lastReceivedAt: null, lastError: null, window: [] }; stats.set(id, s); } return s; };
  const view = (s: WebhookSource): WebhookSourceView => { const { tokenHash: _t, ...rest } = s; const st = statsOf(s.id); return { ...rest, received: st.received, rejected: st.rejected, lastReceivedAt: st.lastReceivedAt, lastError: st.lastError }; };

  async function persist() {
    await fs.mkdir(path.dirname(o.file), { recursive: true });
    const tmp = `${o.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...sources.values()], null, 2), { mode: 0o600 });
    await fs.rename(tmp, o.file);
  }

  function validate(raw: unknown): Omit<WebhookSource, 'tokenHash' | 'createdAt'> {
    const r = (raw ?? {}) as Record<string, unknown>;
    const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const id = s(r.id, 40);
    if (!id || !ID_RE.test(id)) throw new FormatError("'id' must be 1-40 letters, digits, _ or -.");
    const format = r.format === undefined ? 'generic-json' : r.format;
    if (!WEBHOOK_FORMATS.includes(format as WebhookFormat)) throw new FormatError(`'format' must be one of ${WEBHOOK_FORMATS.join(', ')}.`);
    const owner = s(r.ownerUserId, 200);
    if (!owner) throw new FormatError("'ownerUserId' is required.");
    const department = s(r.department, 80);
    if (department && !DEPARTMENT_NAME_RE.test(department)) throw new FormatError("'department' must be a department name.");
    const out: Omit<WebhookSource, 'tokenHash' | 'createdAt'> = { id, format: format as WebhookFormat, ownerUserId: owner };
    if (s(r.label, 120)) out.label = s(r.label, 120);
    if (department) out.department = department;
    if (r.timezoneOffsetMinutes !== undefined) {
      const tz = Number(r.timezoneOffsetMinutes);
      if (!Number.isInteger(tz) || tz < -720 || tz > 840) throw new FormatError("'timezoneOffsetMinutes' must be a whole number from -720 to 840.");
      out.timezoneOffsetMinutes = tz;
    }
    return out;
  }

  // Loaded once; a memoized promise (not the serial queue) so the queued operations below can wait for it without waiting on themselves.
  let loadP: Promise<void> | null = null;
  const ensureLoaded = (): Promise<void> => (loadP ??= (async () => {
    try { for (const s of JSON.parse(await fs.readFile(o.file, 'utf8')) as WebhookSource[]) if (s?.id && s.tokenHash) sources.set(s.id, s); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`[WEBHOOK] could not read ${o.file}: ${e instanceof Error ? e.message : e}`); }
  })());

  const checkToken = (s: WebhookSource | undefined, token: string | undefined) => {
    // Always compare something, so an unknown id and a wrong token cost the same time and answer the same way.
    const want = Buffer.from(s?.tokenHash ?? DUMMY, 'hex'), got = Buffer.from(sha256(token ?? ''), 'hex');
    return timingSafeEqual(want, got) && !!s && !!token;
  };

  return {
    load: ensureLoaded,

    /** Makes a source and its token. The token is returned this once and never again. */
    async create(raw: unknown, creator: string): Promise<{ source: WebhookSourceView; token: string }> {
      await ensureLoaded();
      return serial(async () => {
        const v = validate({ ownerUserId: creator, ...(raw as object) });
        if (sources.has(v.id)) throw new FormatError(`A source named '${v.id}' already exists.`);
        const token = newToken();
        const src: WebhookSource = { ...v, tokenHash: sha256(token), createdAt: now().toISOString() };
        sources.set(src.id, src);
        await persist();
        return { source: view(src), token };
      });
    },

    /** Replaces the token (the old one stops working at once). */
    rotate: (id: string) => serial(async () => {
      await ensureLoaded();
      const s = sources.get(id);
      if (!s) return null;
      const token = newToken();
      sources.set(id, { ...s, tokenHash: sha256(token) });
      await persist();
      return { source: view(sources.get(id)!), token };
    }),

    remove: (id: string) => serial(async () => { await ensureLoaded(); if (!sources.delete(id)) return false; stats.delete(id); await persist(); return true; }),
    list: (): WebhookSourceView[] => [...sources.values()].map(view),
    get: (id: string) => { const s = sources.get(id); return s ? view(s) : null; },

    /** One request from a device. `body` is the raw text; `token` is whatever the sender presented. */
    async receive(id: string, token: string | undefined, body: string): Promise<ReceiveResult> {
      await ensureLoaded();
      const src = sources.get(id);
      if (!checkToken(src, token)) return { status: 'unauthorized' };
      const st = statsOf(id);
      const t = now().getTime();
      st.window = st.window.filter((x) => t - x < windowMs);
      if (st.window.length >= maxReq) { st.rejected++; return { status: 'rate_limited', retryAfterS: Math.ceil(windowMs / 1000) }; }
      st.window.push(t);
      try {
        const batch = parseWebhookBody(src!.format, body, { now: now(), timezoneOffsetMinutes: src!.timezoneOffsetMinutes });
        const system: VmsSystemConfig = { id: src!.id, kind: 'webhook', baseUrl: 'webhook:', ownerUserId: src!.ownerUserId, department: src!.department };
        const events = batch.events.map((e) => platformEventFromVms(system, { id: e.cameraId, name: batch.names.get(e.cameraId) ?? e.cameraId, location: undefined }, e));
        if (events.length) await o.emit(events);
        st.received += events.length;
        st.lastReceivedAt = now().toISOString();
        st.lastError = batch.ignored.length ? batch.ignored[0] : null;
        if (events.length === 0) return { status: 'bad_request', error: batch.ignored[0] ?? 'no usable events in the body' };
        return { status: 'ok', accepted: events.length, ignored: batch.ignored };
      } catch (e) {
        st.rejected++;
        const msg = e instanceof FormatError ? e.message : e instanceof Error ? e.message : String(e);
        st.lastError = msg;
        if (e instanceof FormatError) return { status: 'bad_request', error: msg };
        throw e; // the bus is down: the sender should retry, so this is a server error, not a bad request
      }
    },
    platformCameraId,
  };
}
export type WebhookService = ReturnType<typeof createWebhookService>;
