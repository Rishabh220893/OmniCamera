/**
 * The centre's side of the regional gateways: who they are, whether they are alive, which cameras each one owns, and what happens to the
 * results they send. All I/O is injected.
 *
 * A gateway can only write about cameras assigned to it (and the owner recorded on that camera); anything else it sends is refused, so a
 * stolen gateway secret exposes one region's cameras, not the whole registry.
 */
import { randomBytes } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { PlatformEvent } from '../events/schema';
import { EVENT_TYPE_RE, isSeverity } from '../events/schema';
import type { PlateSighting } from '../../src/lib/plateTracking';
import type { LogDocument } from '../eventStore';
import type { AssignedCamera, AssignmentResponse, HeartbeatRequest, HeartbeatResponse, IngestRequest, IngestResponse, OutboxItem, UserContextResponse } from './protocol';

export interface GatewayRecord {
  id: string;
  name: string;
  region: string;
  /** The user the gateway's own events (offline, back online) are raised for. */
  ownerId: string;
  secret: string;
  disabled: boolean;
  createdAt: string;
}

export type GatewayState = 'never_seen' | 'online' | 'degraded' | 'offline' | 'disabled';

export interface GatewayStatus {
  id: string;
  name: string;
  region: string;
  ownerId: string;
  state: GatewayState;
  createdAt: string;
  lastHeartbeatAt: string | null;
  /** Why it is degraded, in words. */
  problems: string[];
  heartbeat: HeartbeatRequest | null;
  assignedCameras: number | null;
  /** Items refused as not allowed or malformed since the centre started. */
  rejectedItems: number;
}

export interface GatewayDocs {
  get(id: string): Promise<GatewayRecord | null>;
  set(rec: GatewayRecord): Promise<void>;
  list(): Promise<GatewayRecord[]>;
  delete(id: string): Promise<void>;
}

export function createMemoryGatewayDocs(): GatewayDocs {
  const m = new Map<string, GatewayRecord>();
  return {
    async get(id) { const r = m.get(id); return r ? { ...r } : null; },
    async set(rec) { m.set(rec.id, { ...rec }); },
    async list() { return [...m.values()].map((r) => ({ ...r })); },
    async delete(id) { m.delete(id); },
  };
}

/** Gateways live in the Firestore collection `gateways` (Admin SDK only; the client rules deny it). */
export function createFirestoreGatewayDocs(db: Firestore): GatewayDocs {
  const col = db.collection('gateways');
  return {
    async get(id) { const d = await col.doc(id).get(); return d.exists ? (d.data() as GatewayRecord) : null; },
    async set(rec) { await col.doc(rec.id).set(rec); },
    async list() { return (await col.get()).docs.map((d) => d.data() as GatewayRecord); },
    async delete(id) { await col.doc(id).delete(); },
  };
}

export interface Sinks {
  writeLog(doc: LogDocument): Promise<void>;
  writeSightings(userId: string, sightings: PlateSighting[]): Promise<void>;
  emitEvents(events: PlatformEvent[]): Promise<void>;
  updateCamera(cameraId: string, patch: { lastAnalysisTime?: Date; lastAnalysisError?: string | null }): Promise<void>;
}

export interface CentralDeps {
  docs: GatewayDocs;
  /** The cameras assigned to a gateway (those whose record says `gatewayId`). */
  cameras(gatewayId: string): Promise<AssignedCamera[]>;
  userContext(userId: string, departmentId?: string): Promise<UserContextResponse>;
  sinks: Sinks;
  now?: () => number;
  log?: Pick<Console, 'warn' | 'info'>;
  /** No heartbeat for this long = offline. Gateways beat every 15 s by default. */
  offlineAfterMs?: number;
  /** A backlog bigger than this, or older than `degradedBacklogAgeS`, marks the gateway degraded. */
  degradedPending?: number;
  degradedBacklogAgeS?: number;
  /** Called when a gateway's state changes (from the heartbeat or from `sweep`). */
  onTransition?(g: GatewayStatus, from: GatewayState): void;
  /** How long assignments are remembered before being read again. */
  assignmentCacheMs?: number;
  /** Item ids remembered to ignore repeats. */
  maxApplied?: number;
}

const newId = () => `gw-${randomBytes(4).toString('hex')}`;
const newSecret = () => randomBytes(32).toString('base64url');

export class GatewayError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'bad_request' | 'forbidden') { super(message); this.name = 'GatewayError'; }
}

const asDate = (v: unknown): Date | null => { const d = new Date(v as string); return typeof v === 'string' && !Number.isNaN(d.getTime()) ? d : null; };

export function createGatewayCentral(deps: CentralDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? console;
  const offlineAfterMs = deps.offlineAfterMs ?? 90_000;
  const degradedPending = deps.degradedPending ?? 5000;
  const degradedAge = deps.degradedBacklogAgeS ?? 600;
  const cacheMs = deps.assignmentCacheMs ?? 30_000;
  const maxApplied = deps.maxApplied ?? 500_000;

  const records = new Map<string, GatewayRecord>();
  let loadedAt = 0;
  const live = new Map<string, { hb: HeartbeatRequest; at: number; state: GatewayState }>();
  const lastState = new Map<string, GatewayState>();
  const assignments = new Map<string, { at: number; cameras: Promise<AssignedCamera[]> }>();
  const applied = new Map<string, number>();
  let rejectedItems = new Map<string, number>();

  async function reload(force = false) {
    if (!force && now() - loadedAt < 30_000) return;
    const list = await deps.docs.list();
    records.clear();
    for (const r of list) records.set(r.id, r);
    loadedAt = now();
  }

  const rec = (id: string): GatewayRecord => {
    const r = records.get(id);
    if (!r) throw new GatewayError('No such gateway.', 'not_found');
    return r;
  };

  function assigned(id: string): Promise<AssignedCamera[]> {
    const c = assignments.get(id);
    if (c && now() - c.at < cacheMs) return c.cameras;
    const cameras = deps.cameras(id);
    assignments.set(id, { at: now(), cameras });
    cameras.catch(() => assignments.delete(id));
    return cameras;
  }

  function computeState(r: GatewayRecord): { state: GatewayState; problems: string[] } {
    if (r.disabled) return { state: 'disabled', problems: ['switched off by an administrator'] };
    const l = live.get(r.id);
    if (!l) return { state: 'never_seen', problems: [] };
    if (now() - l.at > offlineAfterMs) return { state: 'offline', problems: [`no heartbeat for ${Math.round((now() - l.at) / 1000)} s`] };
    const problems: string[] = [];
    const hb = l.hb;
    if (hb.link !== 'online') problems.push(`its link to the centre is ${hb.link}`);
    if (hb.outbox.pending > degradedPending) problems.push(`${hb.outbox.pending} results waiting to be sent`);
    if (hb.outbox.oldestAgeS > degradedAge) problems.push(`the oldest waiting result is ${Math.round(hb.outbox.oldestAgeS / 60)} minutes old`);
    if (hb.outbox.dropped > 0) problems.push(`${hb.outbox.dropped} results were dropped because the disk limit was reached`);
    if (hb.cameras.assigned > 0 && hb.cameras.failing / hb.cameras.assigned > 0.5) problems.push(`${hb.cameras.failing} of ${hb.cameras.assigned} cameras are failing`);
    return { state: problems.length ? 'degraded' : 'online', problems };
  }

  function status(r: GatewayRecord): GatewayStatus {
    const { state, problems } = computeState(r);
    const l = live.get(r.id);
    return {
      id: r.id, name: r.name, region: r.region, ownerId: r.ownerId, state, createdAt: r.createdAt, problems,
      lastHeartbeatAt: l ? new Date(l.at).toISOString() : null, heartbeat: l?.hb ?? null,
      assignedCameras: l?.hb.cameras.assigned ?? null, rejectedItems: rejectedItems.get(r.id) ?? 0,
    };
  }

  function noteState(r: GatewayRecord) {
    const s = status(r);
    const from = lastState.get(r.id) ?? 'never_seen';
    if (s.state !== from) {
      lastState.set(r.id, s.state);
      if (!(from === 'never_seen' && s.state === 'online')) { try { deps.onTransition?.(s, from); } catch (e) { log.warn('[GATEWAY] transition handler failed:', e); } }
    }
  }

  const bumpRejected = (id: string, n: number) => rejectedItems.set(id, (rejectedItems.get(id) ?? 0) + n);

  return {
    /** Loads the gateway list; call once at start. */
    async ready() { await reload(true); },

    /** For request verification: the secret of a gateway, from memory. Refresh with `refresh()` first when a request arrives. */
    lookup(id: string) { const r = records.get(id); return r ? { secret: r.secret, disabled: r.disabled } : null; },
    async refresh() { await reload(); },

    async provision(o: { name: string; region: string; ownerId: string }): Promise<{ gateway: GatewayStatus; secret: string }> {
      const name = o.name.trim(), region = o.region.trim();
      if (!name || name.length > 80) throw new GatewayError("'name' is required (up to 80 characters).", 'bad_request');
      if (!/^[A-Za-z0-9 ._-]{1,60}$/.test(region)) throw new GatewayError("'region' is required (letters, digits, space, . _ -).", 'bad_request');
      await reload(true);
      let id = newId();
      while (records.has(id)) id = newId();
      const secret = newSecret();
      const r: GatewayRecord = { id, name, region, ownerId: o.ownerId, secret, disabled: false, createdAt: new Date(now()).toISOString() };
      await deps.docs.set(r);
      records.set(id, r);
      return { gateway: status(r), secret };
    },

    async rotateSecret(id: string): Promise<string> {
      await reload(true);
      const r = rec(id);
      r.secret = newSecret();
      await deps.docs.set(r);
      return r.secret;
    },

    async setDisabled(id: string, disabled: boolean) {
      await reload(true);
      const r = rec(id);
      r.disabled = disabled;
      await deps.docs.set(r);
      noteState(r);
    },

    async remove(id: string) {
      await reload(true);
      rec(id);
      await deps.docs.delete(id);
      records.delete(id); live.delete(id); lastState.delete(id); assignments.delete(id);
    },

    async list(): Promise<GatewayStatus[]> {
      await reload();
      return [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(status);
    },

    heartbeat(id: string, hb: HeartbeatRequest): HeartbeatResponse {
      const r = rec(id);
      live.set(id, { hb, at: now(), state: 'online' });
      noteState(r);
      return { ok: true, serverTime: now(), assignmentVersion: '' };
    },

    async assignment(id: string): Promise<AssignmentResponse> {
      rec(id);
      const cameras = [...(await assigned(id))].sort((a, b) => a.id.localeCompare(b.id));
      // A cheap fingerprint of what the gateway should be running; changes when any camera's settings change.
      let h = 5381;
      for (const c of JSON.stringify(cameras)) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
      return { version: `${cameras.length}-${(h >>> 0).toString(36)}`, cameras };
    },

    async userContext(id: string, userId: string, departmentId?: string): Promise<UserContextResponse> {
      rec(id);
      const cams = await assigned(id);
      if (!cams.some((c) => c.userId === userId)) throw new GatewayError('That user has no camera on this gateway.', 'forbidden');
      // A department's faces and watchlist go only to a gateway that holds one of that department's cameras.
      if (departmentId && !cams.some((c) => c.userId === userId && c.departmentId === departmentId)) throw new GatewayError('That department has no camera of that user on this gateway.', 'forbidden');
      return deps.userContext(userId, departmentId);
    },

    /**
     * Applies what a gateway sends. Each item stands alone: one that cannot be applied now does not hold up the rest.
     * Items already applied are accepted again without being applied twice.
     */
    async ingest(id: string, req: IngestRequest): Promise<IngestResponse> {
      rec(id);
      const cams = new Map((await assigned(id)).map((c) => [c.id, c]));
      const res: IngestResponse = { accepted: [], rejected: [] };
      const reject = (item: OutboxItem, reason: string) => { res.rejected.push({ id: item.id, reason }); bumpRejected(id, 1); };
      for (const item of req.items) {
        if (typeof item?.id !== 'string' || !item.id) continue;
        const key = `${id}:${item.id}`;
        if (applied.has(key)) { res.accepted.push(item.id); continue; }
        try {
          const verdict = await apply(item, cams);
          if (verdict === true) { remember(key); res.accepted.push(item.id); }
          else reject(item, verdict);
        } catch (e) {
          log.warn(`[GATEWAY] ${id}: could not apply ${item.kind} ${item.id} yet:`, e instanceof Error ? e.message : e); // left out of both lists: sent again later
        }
      }
      return res;
    },

    /** Re-evaluates every gateway (a silent one becomes offline) and reports changes. Run it every few seconds. */
    sweep() {
      for (const r of records.values()) noteState(r);
    },

    /** For tests and diagnostics. */
    _appliedCount: () => applied.size,
    _resetRejected: () => { rejectedItems = new Map(); },
  };

  function remember(key: string) {
    applied.set(key, now());
    if (applied.size > maxApplied) for (const k of applied.keys()) { applied.delete(k); if (applied.size <= maxApplied * 0.9) break; }
  }

  /** true = applied; a string = refused for good, with the reason; a throw = try again later. */
  async function apply(item: OutboxItem, cams: Map<string, AssignedCamera>): Promise<true | string> {
    const p = item.payload as any;
    switch (item.kind) {
      case 'log': {
        const cam = cams.get(p?.cameraId);
        if (!cam) return 'camera is not assigned to this gateway';
        if (p.userId !== cam.userId) return 'log owner does not match the camera';
        const ts = asDate(p.timestamp);
        if (!ts || typeof p.summary !== 'string' || !p.counts) return 'malformed log';
        await deps.sinks.writeLog({ ...p, timestamp: ts });
        return true;
      }
      case 'sightings': {
        if (typeof p?.userId !== 'string' || !Array.isArray(p.sightings)) return 'malformed sightings';
        const out: PlateSighting[] = [];
        for (const s of p.sightings) {
          const cam = cams.get(s?.cameraId);
          if (!cam || cam.userId !== p.userId) return 'a sighting is for a camera that is not assigned to this gateway';
          const ts = asDate(s.timestamp);
          if (!ts || typeof s.plate !== 'string' || typeof s.id !== 'string') return 'malformed sighting';
          out.push({ ...s, timestamp: ts });
        }
        await deps.sinks.writeSightings(p.userId, out);
        return true;
      }
      case 'events': {
        if (!Array.isArray(p)) return 'malformed events';
        const events: PlatformEvent[] = [];
        for (const e of p) {
          const cam = cams.get(e?.cameraId);
          if (!cam || cam.userId !== e.userId) return 'an event is for a camera that is not assigned to this gateway';
          if (typeof e.id !== 'string' || !EVENT_TYPE_RE.test(e.type ?? '') || !isSeverity(e.severity) || !asDate(e.ts) || typeof e.summary !== 'string') return 'malformed event';
          events.push(e as PlatformEvent);
        }
        if (events.length) await deps.sinks.emitEvents(events);
        return true;
      }
      case 'camera': {
        const cam = cams.get(p?.cameraId);
        if (!cam) return 'camera is not assigned to this gateway';
        const patch: { lastAnalysisTime?: Date; lastAnalysisError?: string | null } = {};
        if (p.patch?.lastAnalysisTime !== undefined) { const d = asDate(p.patch.lastAnalysisTime); if (!d) return 'malformed camera update'; patch.lastAnalysisTime = d; }
        if (p.patch?.lastAnalysisError !== undefined) { if (p.patch.lastAnalysisError !== null && typeof p.patch.lastAnalysisError !== 'string') return 'malformed camera update'; patch.lastAnalysisError = p.patch.lastAnalysisError === null ? null : String(p.patch.lastAnalysisError).slice(0, 500); }
        if (Object.keys(patch).length === 0) return true;
        await deps.sinks.updateCamera(p.cameraId, patch);
        return true;
      }
      default:
        return `unknown item kind '${String((item as { kind?: unknown }).kind)}'`;
    }
  }
}

export type GatewayCentral = ReturnType<typeof createGatewayCentral>;
