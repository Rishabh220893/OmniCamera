/**
 * What a pushing device or system may send to the webhook receiver, and how each format becomes events. A format turns the request body into
 * `VmsEvent`s (the same shared vocabulary every connector uses), so mapping, bus, rules and alerts need nothing new.
 *
 *   generic-json    OmniSee's own simple shape, for any system that can POST JSON (a department's own software, a script, an integrator):
 *                     { "events": [ { "id": "evt-1", "camera": "gate-1" | { "id": "gate-1", "name": "Main gate" }, "type": "intrusion",
 *                       "at": "2026-10-10T10:00:00Z", "text": "Person at the gate", "plate": "GJ01AB1234", "confidence": 0.9, "data": { } } ] }
 *                   a single event object, or an array of them, is accepted too.
 *   hikvision-xml   A Hikvision device's "HTTP listening" push: the same EventNotificationAlert document the live stream carries, as the body
 *                   or inside a multipart body (pictures are ignored).
 *
 * NOT VERIFIED against a real Hikvision device pushing to a listener; the format is from its public documentation.
 */
import { createHash } from 'node:crypto';
import { parseHikvisionAlert } from '../vms/hikvisionEvents';
import type { VmsEvent, VmsEventKind } from '../vms/types';

export const WEBHOOK_FORMATS = ['generic-json', 'hikvision-xml'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export class FormatError extends Error { constructor(message: string) { super(message); this.name = 'FormatError'; } }

export const MAX_EVENTS_PER_REQUEST = 100;
const KINDS: readonly VmsEventKind[] = ['motion', 'plate', 'tamper', 'line_crossing', 'intrusion', 'alarm'];

export interface ParsedBatch {
  events: VmsEvent[];
  /** Cameras' names when the sender gave them, by their id. */
  names: Map<string, string>;
  /** Things in the body that could not be used (one short reason each), so the sender can be told. */
  ignored: string[];
}

export interface FormatContext { now: Date; timezoneOffsetMinutes?: number }

const str = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function genericEvent(raw: unknown, i: number, ctx: FormatContext, names: Map<string, string>): VmsEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FormatError(`event ${i + 1} is not an object`);
  const r = raw as Record<string, unknown>;
  const cam = r.camera;
  const cameraId = typeof cam === 'string' ? str(cam, 100) : typeof cam === 'object' && cam ? str((cam as Record<string, unknown>).id, 100) : undefined;
  if (!cameraId) throw new FormatError(`event ${i + 1} has no camera`);
  const cname = typeof cam === 'object' && cam ? str((cam as Record<string, unknown>).name, 120) : undefined;
  if (cname) names.set(cameraId, cname);
  const plate = str(r.plate, 20);
  const type = r.type === undefined ? (plate ? 'plate' : 'alarm') : r.type;
  if (typeof type !== 'string' || !KINDS.includes(type as VmsEventKind)) throw new FormatError(`event ${i + 1} has an unknown type (use ${KINDS.join(', ')})`);
  let at = ctx.now;
  if (r.at !== undefined) {
    const d = new Date(String(r.at));
    if (Number.isNaN(d.getTime())) throw new FormatError(`event ${i + 1} has a time that cannot be read`);
    // A clock far in the future would sort ahead of everything; a sender with a wrong clock is told, not trusted.
    if (d.getTime() > ctx.now.getTime() + 5 * 60_000) throw new FormatError(`event ${i + 1} is dated in the future`);
    at = d;
  }
  const data: Record<string, unknown> = {};
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    const json = JSON.stringify(r.data);
    if (json.length > 4096) throw new FormatError(`event ${i + 1} carries too much data (4 KB at most)`);
    Object.assign(data, JSON.parse(json));
  }
  const text = str(r.text);
  if (text) data.text = text;
  if (type === 'plate') {
    if (!plate) throw new FormatError(`event ${i + 1} is a plate read with no plate`);
    data.plate = plate;
    if (typeof r.confidence === 'number' && Number.isFinite(r.confidence)) data.confidence = Math.min(1, Math.max(0, r.confidence));
  }
  // Without an id of its own, the id is made from what the event says, so a sender that retries after a timeout does not make a second event.
  const id = str(r.id, 120) ?? createHash('sha1').update(JSON.stringify([cameraId, type, at.toISOString(), plate ?? '', text ?? ''])).digest('hex').slice(0, 24);
  return { id, cameraId, at, kind: type as VmsEventKind, vendorCode: str(r.code, 60) ?? 'webhook', data };
}

const generic = (body: string, ctx: FormatContext): ParsedBatch => {
  let json: unknown;
  try { json = JSON.parse(body); } catch { throw new FormatError('the body is not valid JSON'); }
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { events?: unknown }).events) ? (json as { events: unknown[] }).events : json && typeof json === 'object' ? [json] : null;
  if (!list) throw new FormatError('expected an event, a list of events, or { "events": [...] }');
  if (list.length === 0) throw new FormatError('no events in the body');
  if (list.length > MAX_EVENTS_PER_REQUEST) throw new FormatError(`at most ${MAX_EVENTS_PER_REQUEST} events per request`);
  const out: ParsedBatch = { events: [], names: new Map(), ignored: [] };
  list.forEach((raw, i) => {
    try { out.events.push(genericEvent(raw, i, ctx, out.names)); } catch (e) { out.ignored.push(e instanceof Error ? e.message : String(e)); }
  });
  return out;
};

const hikvisionXml = (body: string, ctx: FormatContext): ParsedBatch => {
  const docs = body.match(/<EventNotificationAlert\b[\s\S]*?<\/EventNotificationAlert>/g) ?? [];
  if (docs.length === 0) throw new FormatError('no EventNotificationAlert document in the body');
  if (docs.length > MAX_EVENTS_PER_REQUEST) throw new FormatError(`at most ${MAX_EVENTS_PER_REQUEST} events per request`);
  const out: ParsedBatch = { events: [], names: new Map(), ignored: [] };
  for (const d of docs) {
    const ev = parseHikvisionAlert(d, { timezoneOffsetMinutes: ctx.timezoneOffsetMinutes, now: ctx.now });
    if (ev) out.events.push(ev); else out.ignored.push('a heartbeat, an ended event or an unreadable notice');
  }
  return out;
};

export function parseWebhookBody(format: WebhookFormat, body: string, ctx: FormatContext): ParsedBatch {
  return format === 'hikvision-xml' ? hikvisionXml(body, ctx) : generic(body, ctx);
}
