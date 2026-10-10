/**
 * How a regional gateway proves who it is to the centre, and the shape of what they exchange (docs/regional-gateway.md).
 *
 * Every request carries four headers and a signature over the method, path, body and time, made with the gateway's secret (HMAC-SHA256).
 * The centre refuses requests that are too old or too new (clock check), repeat a nonce (replay), or do not verify (tampering, wrong secret).
 * The secret itself never travels.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlatformEvent } from '../events/schema';

export const HEADER = { id: 'x-gateway-id', time: 'x-gateway-time', nonce: 'x-gateway-nonce', signature: 'x-gateway-signature' } as const;

/** Requests older or newer than this (by the centre's clock) are refused. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export function signingString(o: { time: number; nonce: string; method: string; path: string; body: Buffer | string }): string {
  return `${o.time}.${o.nonce}.${o.method.toUpperCase()}.${o.path}.${sha256(o.body)}`;
}

export interface SignedHeaders { [k: string]: string }

export function signRequest(o: { gatewayId: string; secret: string; method: string; path: string; body?: Buffer | string; now?: number; nonce?: string }): SignedHeaders {
  const time = o.now ?? Date.now();
  const nonce = o.nonce ?? randomBytes(12).toString('hex');
  const signature = createHmac('sha256', o.secret).update(signingString({ time, nonce, method: o.method, path: o.path, body: o.body ?? '' })).digest('hex');
  return { [HEADER.id]: o.gatewayId, [HEADER.time]: String(time), [HEADER.nonce]: nonce, [HEADER.signature]: signature };
}

export type VerifyFailure = 'missing_headers' | 'unknown_gateway' | 'disabled' | 'clock' | 'replay' | 'bad_signature';
export type Verified = { ok: true; gatewayId: string } | { ok: false; reason: VerifyFailure; /** For 'clock': the centre's time, so the gateway can correct itself. */ serverTime?: number };

/** Remembers recent nonces so a captured request cannot be sent again. */
export interface NonceCache { seen(gatewayId: string, nonce: string, now: number): boolean }

export function createNonceCache(ttlMs = 2 * MAX_CLOCK_SKEW_MS, maxEntries = 200_000): NonceCache {
  const m = new Map<string, number>();
  return {
    seen(gatewayId, nonce, now) {
      for (const [k, at] of m) { if (now - at > ttlMs || m.size > maxEntries) m.delete(k); else break; } // oldest first: insertion order
      const key = `${gatewayId}:${nonce}`;
      if (m.has(key)) return true;
      m.set(key, now);
      return false;
    },
  };
}

export function verifyRequest(o: {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  body: Buffer | string;
  /** The gateway's secret, or null when there is no such gateway; `disabled` when it was switched off. */
  lookup(gatewayId: string): { secret: string; disabled?: boolean } | null;
  nonces: NonceCache;
  now?: number;
  maxSkewMs?: number;
}): Verified {
  const get = (k: string) => { const v = o.headers[k]; return Array.isArray(v) ? v[0] : v; };
  const id = get(HEADER.id), time = Number(get(HEADER.time)), nonce = get(HEADER.nonce), sig = get(HEADER.signature);
  if (!id || !nonce || !sig || !Number.isFinite(time) || !/^[0-9a-f]{64}$/i.test(sig) || nonce.length > 64) return { ok: false, reason: 'missing_headers' };
  const rec = o.lookup(id);
  if (!rec) return { ok: false, reason: 'unknown_gateway' };
  if (rec.disabled) return { ok: false, reason: 'disabled' };
  const now = o.now ?? Date.now();
  // The signature is checked before the clock so that only a holder of the secret learns the centre's time.
  const want = createHmac('sha256', rec.secret).update(signingString({ time, nonce, method: o.method, path: o.path, body: o.body })).digest();
  const given = Buffer.from(sig, 'hex');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'bad_signature' };
  if (Math.abs(now - time) > (o.maxSkewMs ?? MAX_CLOCK_SKEW_MS)) return { ok: false, reason: 'clock', serverTime: now };
  if (o.nonces.seen(id, nonce, now)) return { ok: false, reason: 'replay' };
  return { ok: true, gatewayId: id };
}

// ---- messages -----------------------------------------------------------------------------------------------------

export type OutboxKind = 'log' | 'sightings' | 'events' | 'camera';

/** One thing the gateway wants the centre to record. `id` is unique forever and is what makes redelivery harmless. */
export interface OutboxItem {
  id: string;
  kind: OutboxKind;
  /** Time the gateway produced it (ms since epoch, gateway clock). */
  at: number;
  /** log: the log document. sightings: { userId, sightings }. events: PlatformEvent[]. camera: { cameraId, patch }. */
  payload: unknown;
}

export interface IngestRequest { batchId: string; items: OutboxItem[] }
export interface IngestResponse {
  /** Items the centre has applied (or had already applied): the gateway may forget them. */
  accepted: string[];
  /** Items that can never be applied (the gateway is not allowed to write them, or they are malformed). Forgotten, and counted. */
  rejected: Array<{ id: string; reason: string }>;
  /** Everything else was not applied because of a temporary problem; send it again later. */
}

export interface HeartbeatRequest {
  version: string;
  region?: string;
  sentAt: number;
  uptimeS: number;
  cameras: { assigned: number; failing: number };
  outbox: { pending: number; bytes: number; oldestAgeS: number; dropped: number };
  link: 'online' | 'degraded' | 'offline';
  mediaUrl?: string;
  concurrency: number;
}
export interface HeartbeatResponse { ok: true; serverTime: number; assignmentVersion: string }

export interface AssignedCamera {
  id: string;
  userId: string;
  name: string;
  remoteStreamUrl: string;
  interval: number;
  sensitivity: number;
  peopleThreshold: number;
  vehicleThreshold: number;
  suspiciousRules: string;
  webhookUrl: string;
  department?: string;
  /** The department the camera was given to; its faces and watchlist apply to the camera. */
  departmentId?: string;
  location?: { lat: number; lng: number };
}
export interface AssignmentResponse { version: string; cameras: AssignedCamera[] }

export interface UserContextResponse { knownFaces: Array<{ name: string; imageData: string }>; watchlist: string[] }

export type { PlatformEvent };
