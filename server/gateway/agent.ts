/**
 * The gateway's link to the centre: sends results from the outbox, a heartbeat, and keeps the list of assigned cameras current.
 *
 * A failed request is never fatal. The agent backs off (1 s doubling to 60 s, with jitter), the gateway keeps analysing, results pile up in
 * the outbox, and everything is sent when the link returns. Its own clock is corrected from the centre's answers, because a request
 * signed with a clock hours off is refused.
 */
import type { AssignedCamera, AssignmentResponse, HeartbeatRequest, HeartbeatResponse, IngestResponse, OutboxItem, UserContextResponse } from './protocol';
import { signRequest } from './protocol';
import type { Outbox } from './outbox';

export type LinkState = 'online' | 'degraded' | 'offline';

export interface AgentOptions {
  centralUrl: string;
  gatewayId: string;
  secret: string;
  outbox: Outbox;
  version?: string;
  region?: string;
  mediaUrl?: string;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  log?: Pick<Console, 'info' | 'warn'>;
  heartbeatEveryMs?: number;
  assignmentEveryMs?: number;
  flushEveryMs?: number;
  batchItems?: number;
  batchBytes?: number;
  requestTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** What the gateway's worker knows, for the heartbeat. */
  cameraCounts?: () => { assigned: number; failing: number };
}

export interface AgentStatus {
  link: LinkState;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  /** The centre refused our credentials (wrong secret, switched off): retrying will not help until it is fixed. */
  unauthorized: boolean;
  clockOffsetMs: number;
  sent: number;
  rejected: number;
  assignedCameras: number;
}

export interface Agent {
  start(): void;
  stop(): void;
  /** Sends one batch from the outbox. Returns how many items the centre confirmed. */
  flushOnce(): Promise<number>;
  heartbeatOnce(): Promise<boolean>;
  refreshAssignmentOnce(): Promise<boolean>;
  cameras(): AssignedCamera[];
  /** Calls back now (if cameras are known) and on every change. */
  onCameras(cb: (cameras: AssignedCamera[]) => void): () => void;
  userContext(userId: string, departmentId?: string): Promise<UserContextResponse>;
  status(): AgentStatus;
}

class CentralError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string, readonly serverTime?: number) { super(message); }
}

export function createAgent(o: AgentOptions): Agent {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? (() => Date.now());
  const random = o.random ?? Math.random;
  const log = o.log ?? console;
  const base = o.centralUrl.replace(/\/+$/, '');
  const startedAt = now();
  const hbEvery = o.heartbeatEveryMs ?? 15_000;
  const asnEvery = o.assignmentEveryMs ?? 30_000;
  const flushEvery = o.flushEveryMs ?? 2_000;
  const batchItems = o.batchItems ?? 200;
  const batchBytes = o.batchBytes ?? 512_000;
  const timeoutMs = o.requestTimeoutMs ?? 15_000;
  const minBackoff = o.minBackoffMs ?? 1_000;
  const maxBackoff = o.maxBackoffMs ?? 60_000;

  let clockOffsetMs = 0;
  let failures = 0;
  /** Failed sends in a row. A heartbeat that arrives proves the link works; failing sends beside it mean the centre cannot take our results. */
  let flushFailures = 0;
  let lastSuccessAt: number | null = null;
  let lastError: string | null = null;
  let unauthorized = false;
  let sent = 0, rejected = 0;
  let cams: AssignedCamera[] = [];
  let camsVersion: string | null = null;
  let haveCams = false;
  const listeners = new Set<(c: AssignedCamera[]) => void>();
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let running = false;

  const ok = () => { failures = 0; lastSuccessAt = now(); lastError = null; unauthorized = false; };
  const bad = (e: unknown) => {
    failures++;
    lastError = e instanceof Error ? e.message : String(e);
    if (e instanceof CentralError && e.status === 401 && e.reason !== 'clock' && e.reason !== 'replay') unauthorized = true;
  };

  /** One signed request. A clock refusal is retried once with the centre's time. */
  async function call<T>(method: 'GET' | 'POST', pathAndQuery: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: T | null; etag: string | null }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = body === undefined ? '' : JSON.stringify(body);
      const headers = { ...extra, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...signRequest({ gatewayId: o.gatewayId, secret: o.secret, method, path: pathAndQuery, body: raw, now: now() + clockOffsetMs }) };
      let res: Response;
      try { res = await doFetch(base + pathAndQuery, { method, headers, body: body === undefined ? undefined : raw, signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) { throw new CentralError(`could not reach the centre: ${(e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.message : String(e))}`, 0); }
      if (res.status === 401) {
        const j = (await res.json().catch(() => ({}))) as { reason?: string; serverTime?: number; error?: string };
        if (j.reason === 'clock' && typeof j.serverTime === 'number' && attempt === 0) { clockOffsetMs = j.serverTime - now(); continue; }
        throw new CentralError(j.error ?? 'the centre refused the request', 401, j.reason, j.serverTime);
      }
      if (res.status === 304) return { status: 304, json: null, etag: res.headers.get('etag') };
      if (!res.ok) throw new CentralError(`the centre answered ${res.status}`, res.status);
      return { status: res.status, json: (await res.json()) as T, etag: res.headers.get('etag') };
    }
    throw new CentralError('clock could not be corrected', 401, 'clock');
  }

  const linkState = (): LinkState => (failures === 0 && lastSuccessAt !== null ? 'online' : failures < 3 && lastSuccessAt !== null ? 'degraded' : 'offline');

  async function flushOnce(): Promise<number> {
    const items: OutboxItem[] = o.outbox.peek(batchItems, batchBytes);
    if (items.length === 0) return 0;
    try {
      const { json } = await call<IngestResponse>('POST', '/api/gateway/ingest', { batchId: `${o.outbox.epoch}-${items[0].id}`, items });
      const accepted = json?.accepted ?? [];
      const gone = json?.rejected ?? [];
      o.outbox.ack([...accepted, ...gone.map((r) => r.id)]);
      sent += accepted.length; rejected += gone.length;
      if (gone.length) log.warn(`[GATEWAY] The centre refused ${gone.length} item(s), e.g. ${gone[0].id}: ${gone[0].reason}. They were discarded.`);
      ok();
      flushFailures = 0;
      return accepted.length + gone.length;
    } catch (e) { flushFailures++; bad(e); throw e; }
  }

  async function heartbeatOnce(): Promise<boolean> {
    const st = o.outbox.stats();
    const c = o.cameraCounts?.() ?? { assigned: cams.length, failing: 0 };
    const hb: HeartbeatRequest = {
      version: o.version ?? 'dev', region: o.region, sentAt: now() + clockOffsetMs, uptimeS: Math.round((now() - startedAt) / 1000),
      cameras: c, outbox: { pending: st.pending, bytes: st.bytes, oldestAgeS: st.oldestAgeS, dropped: st.dropped }, link: flushFailures >= 3 ? 'degraded' : 'online', mediaUrl: o.mediaUrl, concurrency: o.concurrency ?? 0,
    };
    try {
      const sentAtLocal = now();
      const { json } = await call<HeartbeatResponse>('POST', '/api/gateway/heartbeat', hb);
      if (json) {
        // Keep the clock in step: the centre's time, less half the round trip.
        clockOffsetMs = json.serverTime - (sentAtLocal + now()) / 2;
        if (json.assignmentVersion && json.assignmentVersion !== camsVersion && haveCams) void refreshAssignmentOnce().catch(() => {});
      }
      ok();
      return true;
    } catch (e) { bad(e); return false; }
  }

  async function refreshAssignmentOnce(): Promise<boolean> {
    try {
      const r = await call<AssignmentResponse>('GET', '/api/gateway/cameras', undefined, camsVersion ? { 'If-None-Match': `"${camsVersion}"` } : {});
      ok();
      if (r.status === 304 || !r.json) return true;
      camsVersion = r.json.version; cams = r.json.cameras; haveCams = true;
      for (const cb of listeners) { try { cb(cams); } catch (e) { log.warn('[GATEWAY] camera listener failed:', e); } }
      return true;
    } catch (e) { bad(e); return false; }
  }

  // ---- the loops
  const jitter = (ms: number) => Math.round(ms * (0.5 + random() * 0.5));
  const backoff = () => Math.min(maxBackoff, minBackoff * 2 ** Math.max(0, failures - 1));
  function loop(run: () => Promise<unknown>, every: () => number) {
    const tick = async () => {
      if (!running) return;
      try { await run(); } catch { /* recorded by bad() */ }
      if (!running) return;
      timers.push(setTimeout(tick, every()));
    };
    timers.push(setTimeout(tick, 0));
  }

  return {
    start() {
      if (running) return;
      running = true;
      // Flush at once while there is more to send; otherwise wait. After a failure wait out the backoff.
      loop(flushOnce, () => (failures > 0 ? jitter(backoff()) : o.outbox.stats().pending > 0 ? 50 : flushEvery));
      loop(heartbeatOnce, () => (failures > 0 && lastSuccessAt === null ? jitter(backoff()) : hbEvery));
      loop(refreshAssignmentOnce, () => (haveCams ? asnEvery : failures > 0 ? jitter(backoff()) : 1_000));
    },
    stop() { running = false; for (const t of timers) clearTimeout(t); timers = []; },
    flushOnce, heartbeatOnce, refreshAssignmentOnce,
    cameras: () => cams,
    onCameras(cb) { listeners.add(cb); if (haveCams) cb(cams); return () => { listeners.delete(cb); }; },
    async userContext(userId, departmentId) {
      try { const { json } = await call<UserContextResponse>('GET', `/api/gateway/user-context?userId=${encodeURIComponent(userId)}${departmentId ? `&departmentId=${encodeURIComponent(departmentId)}` : ''}`); ok(); return json!; }
      catch (e) { bad(e); throw e; }
    },
    status: () => ({ link: linkState(), lastSuccessAt, consecutiveFailures: failures, lastError, unauthorized, clockOffsetMs: Math.round(clockOffsetMs), sent, rejected, assignedCameras: cams.length }),
  };
}
