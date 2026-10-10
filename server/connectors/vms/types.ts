/**
 * The contract between OmniSee and a department's Video Management System (federation plan A2, docs/federation-plan.md).
 * A `SourceAdapter` (server/adapters) knows how to reach one camera's stream; a `VmsConnector` knows a whole department system:
 * its camera list, the events it raises (motion, plates its own analytics read, tamper, alarms), its health, and where each
 * camera's stream is. It is READ-ONLY by construction: there is no method that creates, changes or deletes anything on the VMS,
 * which is how "existing departmental systems remain unaffected" is made true in the code and tested (tests/vmsConnectors.test.ts
 * counts every write the reference systems receive).
 *
 * A new vendor is one file implementing `VmsConnectorType` and one line in `index.ts`; see `referenceJson.ts` and `referenceXml.ts`.
 */
import type { StreamEndpoint } from '../../adapters/types';

/** One department system as configured by an administrator. Credentials are used for calls and never returned by any API. */
export interface VmsSystemConfig {
  /** Short stable name, letters/digits/_/-; becomes part of every camera id from this system. */
  id: string;
  label?: string;
  /** Which connector type speaks to it (`reference-json`, ...). */
  kind: string;
  baseUrl: string;
  credentials?: { user: string; pass: string };
  /** Who the system's cameras and events belong to until the shared multi-department model lands, and the department they carry. */
  ownerUserId: string;
  department?: string;
  /** For systems that report local times with no zone: minutes the system's clock is ahead of UTC (IST = 330). */
  timezoneOffsetMinutes?: number;
  /** Connector-specific settings. */
  options?: Record<string, unknown>;
}

export interface VmsCamera {
  /** The system's own id for the camera. */
  id: string;
  name: string;
  group?: string;
  /** Null when the system does not say. */
  online: boolean | null;
  location?: { lat: number; lng: number };
}

/** What happened, in a vocabulary shared by all connectors. Vendor codes are mapped into this by the connector. */
export type VmsEventKind = 'motion' | 'plate' | 'tamper' | 'line_crossing' | 'intrusion' | 'alarm';

export interface VmsEvent {
  /** The system's own id for the event; stable across polls, so a repeat is recognised. */
  id: string;
  cameraId: string;
  at: Date;
  kind: VmsEventKind;
  /** The vendor's own code, kept for display and debugging. */
  vendorCode: string;
  /** `plate`, `confidence`, `text`, ... */
  data: Record<string, unknown>;
}

export interface EventPage {
  events: VmsEvent[];
  /** Opaque; pass it back to get what came after. Persist it only after the events were handled. */
  cursor: string;
  /** More events are available right now (ask again at once). */
  more: boolean;
}

export interface VmsHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface VmsConnector {
  /** The system's cameras, all pages. */
  cameras(): Promise<VmsCamera[]>;
  /** Events after `cursor` (null = from now, not from the beginning of time), at most `limit`. */
  events(cursor: string | null, limit: number): Promise<EventPage>;
  /** Where the camera's stream is; the URL may carry a login, so treat it as a secret. */
  streams(cameraId: string): Promise<StreamEndpoint[]>;
  health(): Promise<VmsHealth>;
  /** Releases anything the connector holds open (a push connector keeps a connection to the device). Called when the system is removed or the server stops. */
  close?(): Promise<void>;
}

export interface VmsConnectorType {
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  create(config: VmsSystemConfig, deps?: VmsDeps): VmsConnector;
}

export interface VmsDeps {
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export class VmsError extends Error {
  constructor(message: string, readonly code: 'auth' | 'unreachable' | 'upstream' | 'protocol' | 'rate_limited') {
    super(message);
    this.name = 'VmsError';
  }
}

const SAFE = /^[A-Za-z0-9_-]{1,40}$/;

export function validateSystemConfig(raw: unknown): VmsSystemConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const id = str(r.id, 40), kind = str(r.kind, 40), baseUrl = str(r.baseUrl, 500), owner = str(r.ownerUserId, 200);
  if (!id || !SAFE.test(id)) throw new VmsError("'id' must be 1-40 letters, digits, _ or -.", 'protocol');
  if (!kind) throw new VmsError("'kind' is required.", 'protocol');
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) throw new VmsError("'baseUrl' must be an http:// or https:// address.", 'protocol');
  if (!owner) throw new VmsError("'ownerUserId' is required.", 'protocol');
  const cfg: VmsSystemConfig = { id, kind, baseUrl: baseUrl.replace(/\/+$/, ''), ownerUserId: owner };
  if (str(r.label, 120)) cfg.label = str(r.label, 120);
  if (str(r.department, 80)) cfg.department = str(r.department, 80);
  const c = r.credentials as { user?: unknown; pass?: unknown } | undefined;
  if (c && typeof c.user === 'string' && typeof c.pass === 'string') cfg.credentials = { user: c.user, pass: c.pass };
  if (r.timezoneOffsetMinutes !== undefined) {
    const tz = Number(r.timezoneOffsetMinutes);
    if (!Number.isInteger(tz) || tz < -720 || tz > 840) throw new VmsError("'timezoneOffsetMinutes' must be a whole number from -720 to 840.", 'protocol');
    cfg.timezoneOffsetMinutes = tz;
  }
  if (r.options && typeof r.options === 'object' && !Array.isArray(r.options)) cfg.options = r.options as Record<string, unknown>;
  return cfg;
}

/** The camera id the rest of the platform uses: stable, unique across systems, and valid everywhere camera ids are. */
export const platformCameraId = (systemId: string, vendorCameraId: string): string =>
  `${systemId}-${vendorCameraId.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
