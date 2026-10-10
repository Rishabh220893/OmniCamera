/**
 * The one shape every analyzer's findings take once they leave the analysis step (docs/analytics.md).
 * Logs, plate sightings and alerts are all views of these events; rules and alerts work only from this shape, so a new
 * analyzer needs no change to alerting.
 */
import { createHash } from 'node:crypto';
import type { LogDocument } from '../eventStore';

export const SEVERITIES = ['info', 'notice', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: Severity): number => SEVERITIES.indexOf(s);
export const isSeverity = (s: unknown): s is Severity => typeof s === 'string' && (SEVERITIES as readonly string[]).includes(s);

/** `group.name`, lower case, e.g. `plate.watchlist_match`. Groups are what rules usually match (`plate.*`). */
export const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface EventCamera {
  id: string;
  name: string;
  userId: string;
  department?: string;
  location?: { lat: number; lng: number };
}

export interface PlatformEvent {
  /** Deterministic from what happened, so a retried job produces the same event and it is stored once. */
  id: string;
  type: string;
  /** The analyzer that found it. */
  source: string;
  severity: Severity;
  userId: string;
  cameraId: string;
  cameraName: string;
  department?: string;
  location?: { lat: number; lng: number };
  /** ISO time of the frame. */
  ts: string;
  summary: string;
  /** Type-specific details (a plate's text, a count, ...). Only JSON values. */
  data: Record<string, unknown>;
  confidence?: number;
  tags: string[];
}

/** What an analyzer hands over: no ids, camera or time, which the platform fills in. */
export interface EventDraft {
  type: string;
  summary: string;
  severity?: Severity;
  data?: Record<string, unknown>;
  confidence?: number;
  tags?: string[];
  /** The analyzer that found it; the pipeline fills this in with the analyzer's id when it is left out. */
  source?: string;
  /** Distinguishes two events of the same type in the same frame (e.g. two different plates). Defaults to the summary. */
  dedupeKey?: string;
}

/** The events the platform itself defines. Analyzers may add their own types as long as they follow EVENT_TYPE_RE. */
export const EVENT_CATALOGUE: Array<{ type: string; severity: Severity; description: string; data: string }> = [
  { type: 'plate.read', severity: 'info', description: 'A vehicle plate was read.', data: 'plate, confidence, formatValid, corrected, readBy' },
  { type: 'plate.watchlist_match', severity: 'critical', description: 'A plate on the watchlist was seen.', data: 'plate' },
  { type: 'plate.vehicle_flagged', severity: 'warning', description: 'A connected vehicle registry flagged a plate that was read (stolen, blacklisted, insurance or fitness expired). Severity is the worst flag.', data: 'connector, mock, plate, vehicle, flags' },
  { type: 'plate.wanted', severity: 'critical', description: 'A plate that was read is named in an open police record.', data: 'connector, mock, plate, record, flags' },
  { type: 'vms.motion', severity: 'info', description: 'A department video system reported motion on a camera.', data: 'system, vendorCode, vendorEventId' },
  { type: 'vms.line_crossing', severity: 'notice', description: 'A department video system reported a line crossing.', data: 'system, vendorCode, vendorEventId' },
  { type: 'vms.intrusion', severity: 'warning', description: 'A department video system reported an intrusion.', data: 'system, vendorCode, vendorEventId' },
  { type: 'vms.alarm', severity: 'notice', description: 'A department video system raised an alarm the platform has no specific type for.', data: 'system, vendorCode, text' },
  { type: 'camera.tamper', severity: 'warning', description: 'A department video system reports a camera covered or tampered with.', data: 'system, vendorCode' },
  { type: 'camera.offline', severity: 'warning', description: 'A department video system reports a camera went offline.', data: 'system, vendorCameraId' },
  { type: 'camera.online', severity: 'info', description: 'A department video system reports a camera is back online.', data: 'system, vendorCameraId' },
  { type: 'person.unknown', severity: 'warning', description: 'A person who is not a known face was seen.', data: 'names' },
  { type: 'person.known', severity: 'info', description: 'A known person was recognised.', data: 'name' },
  { type: 'scene.unusual', severity: 'warning', description: 'The scene was judged unusual or suspicious.', data: 'reason, sentiment' },
  { type: 'scene.alert', severity: 'warning', description: 'The scene analysis raised a specific warning.', data: 'text' },
  { type: 'analyzer.failed', severity: 'notice', description: 'An analyzer could not process a frame.', data: 'analyzer, error' },
  { type: 'gateway.offline', severity: 'critical', description: 'A regional gateway stopped reporting.', data: 'gatewayId, region, silentForS' },
  { type: 'gateway.degraded', severity: 'warning', description: 'A regional gateway is up but has a problem (link, backlog, failing cameras).', data: 'gatewayId, region, problems' },
  { type: 'gateway.online', severity: 'info', description: 'A regional gateway is reporting again.', data: 'gatewayId, region' },
  { type: 'system.test', severity: 'info', description: 'A test event sent from the alert rule editor.', data: '' },
];

const DEFAULT_SEVERITY = new Map(EVENT_CATALOGUE.map((e) => [e.type, e.severity]));

export class EventError extends Error {}

/** Turns a draft into a stored event. Throws EventError for a draft that breaks the contract (an analyzer bug). */
export function makeEvent(draft: EventDraft, ctx: { source: string; camera: EventCamera; ts: Date }): PlatformEvent {
  if (!EVENT_TYPE_RE.test(draft.type)) throw new EventError(`Event type '${draft.type}' must look like 'group.name' (lower case letters, digits, _).`);
  if (!draft.summary || typeof draft.summary !== 'string') throw new EventError(`Event '${draft.type}' needs a summary.`);
  if (Number.isNaN(ctx.ts.getTime())) throw new EventError('Event time is not a valid date.');
  const severity = draft.severity ?? DEFAULT_SEVERITY.get(draft.type) ?? 'info';
  if (!isSeverity(severity)) throw new EventError(`Unknown severity '${String(severity)}'.`);
  const c = ctx.camera;
  const ts = ctx.ts.toISOString();
  const id = createHash('sha1').update([c.userId, c.id, draft.type, ts, draft.dedupeKey ?? draft.summary].join('\u0000')).digest('hex').slice(0, 32);
  const ev: PlatformEvent = {
    id, type: draft.type, source: draft.source ?? ctx.source, severity, userId: c.userId, cameraId: c.id, cameraName: c.name, ts,
    summary: draft.summary.slice(0, 500), data: toJson(draft.data ?? {}), tags: [...new Set((draft.tags ?? []).map(String))].slice(0, 20),
  };
  if (c.department) ev.department = c.department;
  if (c.location) ev.location = c.location;
  if (typeof draft.confidence === 'number' && Number.isFinite(draft.confidence)) ev.confidence = Math.min(1, Math.max(0, draft.confidence));
  return ev;
}

/** Keeps only what survives JSON (functions, undefined, cycles and huge values would break storage and webhooks). */
function toJson(v: Record<string, unknown>): Record<string, unknown> {
  try {
    const text = JSON.stringify(v);
    if (text.length > 20_000) return { truncated: true };
    return JSON.parse(text) as Record<string, unknown>;
  } catch { return { unserialisable: true }; }
}

/**
 * The events that the existing log document already implies, so alerting works for the Gemini/ANPR analysis exactly as it will for a
 * new analyzer. Plate reads are one event each; the alert-worthy facts (watchlist, unknown person, unusual, alerts) get their own.
 */
export function eventsFromLog(doc: Pick<LogDocument, 'detectedPlates' | 'plateReads' | 'plateSource' | 'detectedItems' | 'isUnusual' | 'unusualReason' | 'sentiment' | 'alerts' | 'isWatchlistMatch'>, watchlist: string[] = []): EventDraft[] {
  const out: EventDraft[] = [];
  const clean = (p: string) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const wl = new Set(watchlist.map(clean));
  const reads = new Map(doc.plateReads.map((r) => [r.plate, r]));
  for (const plate of doc.detectedPlates) {
    const r = reads.get(plate);
    const onList = wl.has(clean(plate));
    out.push({
      source: doc.plateSource, type: 'plate.read', summary: `Plate ${plate} read${r ? ` (${Math.round(r.confidence * 100)}%)` : ''}`, dedupeKey: plate,
      data: { plate, confidence: r?.confidence ?? null, formatValid: r?.formatValid ?? null, corrected: r?.corrected ?? null, readBy: doc.plateSource },
      confidence: r?.confidence, tags: onList ? ['watchlist'] : [],
    });
    if (onList) out.push({ source: doc.plateSource, type: 'plate.watchlist_match', summary: `Watchlist plate ${plate} seen`, dedupeKey: plate, data: { plate, readBy: doc.plateSource }, confidence: r?.confidence, tags: ['watchlist'] });
  }
  const unknown = doc.detectedItems.filter((n) => n === 'Unknown Person');
  if (unknown.length) out.push({ source: 'gemini-scene', type: 'person.unknown', summary: 'An unknown person was seen', data: { names: unknown } });
  for (const name of doc.detectedItems) if (name && name !== 'Unknown Person' && name !== 'N/A') out.push({ source: 'gemini-scene', type: 'person.known', summary: `${name} recognised`, dedupeKey: name, data: { name } });
  if (doc.isUnusual) out.push({ source: 'gemini-scene', type: 'scene.unusual', summary: doc.unusualReason || 'Unusual activity', data: { reason: doc.unusualReason, sentiment: doc.sentiment } });
  for (const text of doc.alerts) {
    if (text.startsWith('Watchlist match:')) continue; // already a plate.watchlist_match event
    out.push({ source: 'gemini-scene', type: 'scene.alert', summary: text, dedupeKey: text, data: { text } });
  }
  return out;
}
