/**
 * Dahua cameras, NVRs and XVRs: the live event stream (`GET /cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5`, Digest or Basic
 * login). The device holds the connection open and writes a multipart body; each part is one line-oriented record:
 *
 *     Code=VideoMotion;action=Start;index=0
 *     Code=CrossLineDetection;action=Pulse;index=1;data={ "UTC" : 1760090000, "Object" : { ... } }
 *     Heartbeat
 *
 * Read-only: the one request is a GET. A record is taken out of the stream when its part is complete (by Content-Length when the device
 * gives one, else when the next boundary arrives), however the network cut the bytes into chunks.
 *
 * NOT VERIFIED against a real device. The record layout and event codes are from Dahua's public HTTP API documentation and field reports,
 * not from a recorder; firmware varies, and events carry no time zone of their own (the device's UTC stamp is used when present, else the
 * moment the event arrived). `tests/lab/fakeEventDevice.ts` is the only thing this has been run against.
 */
import { createDahuaAdapter } from '../../adapters/vendorNvr';
import type { CameraRef } from '../../adapters/types';
import { createEventStreamConnector } from './eventStream';
import { openEventStream } from './streamHttp';
import type { VmsConnectorType, VmsEvent, VmsEventKind, VmsSystemConfig } from './types';

const KIND: Array<[RegExp, VmsEventKind]> = [
  [/^(video|smart)?motion|^smartmotion/i, 'motion'],
  [/^crossline/i, 'line_crossing'],
  [/^crossregion|^regionintrusion|^wander|^rioter|^leftdetection|^takenaway/i, 'intrusion'],
  [/^videoblind|^videoabnormal|^scenechange|^videotamper|^defocus/i, 'tamper'],
  [/^traffic|^anpr|^platerecognition|^lpr/i, 'plate'],
];

export function kindOfDahua(code: string): VmsEventKind {
  for (const [re, k] of KIND) if (re.test(code)) return k;
  return 'alarm';
}

/** The plate text inside an event's JSON, wherever this firmware puts it. */
function plateOf(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, any>;
  const v = d.TrafficCar?.PlateNumber ?? d.PlateNumber ?? d.Plate ?? d.LicensePlate ?? (d.Object && /plate/i.test(String(d.Object.ObjectType ?? '')) ? d.Object.Text : null) ?? d.Object?.PlateNumber ?? null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const RECORD = /^Code=([^;\r\n]+);action=([^;\r\n]+);index=(\d+)(?:;data=([\s\S]*))?$/;

/** One record (the text of a part) into an event, or null for a heartbeat, a "Stop" notice or something unreadable. */
export function parseDahuaRecord(text: string, o: { now?: Date; seq?: number } = {}): VmsEvent | null {
  const t = text.slice(Math.max(0, text.search(/Code=/))).trim();
  const m = t.match(RECORD);
  if (!m) return null;
  const [, code, action, index, raw] = m;
  if (/^stop$/i.test(action)) return null;
  let data: Record<string, unknown> = {};
  if (raw) { try { const j = JSON.parse(raw.trim()); if (j && typeof j === 'object') data = j as Record<string, unknown>; } catch { /* data is optional detail */ } }
  const kind = kindOfDahua(code);
  const out: Record<string, unknown> = { code };
  const utc = Number(data.UTC);
  const at = Number.isFinite(utc) && utc > 1e9 ? new Date(utc * 1000) : (o.now ?? new Date());
  if (kind === 'plate') {
    const plate = plateOf(data);
    if (!plate) return null; // a traffic event without a readable plate is not a plate read
    out.plate = plate;
  } else if (kind === 'alarm') out.text = `Dahua event ${code}`;
  // A record with neither an event id nor a stamp is told apart by arrival time and a per-connection counter, so two identical ones in the same millisecond are not mistaken for one.
  const eventId = data.EventID ?? data.UTC ?? `${at.getTime()}-${o.seq ?? 0}`;
  return { id: `${code}:${index}:${action}:${String(eventId)}`, cameraId: String(Number(index) + 1), at, kind, vendorCode: code, data: out };
}

const BOUNDARY = /(?:^|\r?\n)--[^\r\n]+\r?\n/;

/** Takes the first `n` bytes (UTF-8) off a string; null until that many have arrived. */
function takeBytes(s: string, n: number): { taken: string; rest: string } | null {
  let bytes = 0, i = 0;
  while (i < s.length && bytes < n) { const cp = s.codePointAt(i)!; bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; i += cp > 0xffff ? 2 : 1; }
  return bytes >= n ? { taken: s.slice(0, i), rest: s.slice(i) } : null;
}

/** A parser for the stream: feed it text as it arrives, get the events completed so far. */
export function createDahuaParser(o: { now?: () => Date } = {}): (chunk: string) => VmsEvent[] {
  let buf = '';
  let seq = 0;
  return (chunk) => {
    buf += chunk;
    const out: VmsEvent[] = [];
    const push = (body: string) => { const ev = parseDahuaRecord(body, { now: o.now?.(), seq: seq++ }); if (ev) out.push(ev); };
    for (;;) {
      const b = buf.match(BOUNDARY);
      if (!b || b.index === undefined) break;
      const afterBoundary = buf.slice(b.index + b[0].length);
      // Headers end at a blank line; until it arrives the part is incomplete.
      const h = afterBoundary.match(/\r?\n\r?\n/);
      const headerEnd = h && h.index !== undefined ? h.index + h[0].length : -1;
      const headers = headerEnd >= 0 ? afterBoundary.slice(0, headerEnd) : '';
      const lenMatch = headers.match(/content-length:\s*(\d+)/i);
      if (headerEnd >= 0 && lenMatch) {
        const body = takeBytes(afterBoundary.slice(headerEnd), Number(lenMatch[1]));
        if (!body) break;
        push(body.taken);
        buf = body.rest;
        continue;
      }
      // No Content-Length: the part ends where the next boundary starts.
      const next = afterBoundary.match(BOUNDARY);
      if (!next || next.index === undefined) break;
      push(afterBoundary.slice(headerEnd >= 0 ? headerEnd : 0, next.index));
      buf = afterBoundary.slice(next.index);
    }
    if (buf.length > 256 * 1024) buf = buf.slice(-64 * 1024);
    return out;
  };
}

function refOf(cfg: VmsSystemConfig): CameraRef {
  const u = new URL(cfg.baseUrl);
  return {
    id: cfg.id, adapter: 'dahua', host: u.hostname, port: u.port ? Number(u.port) : undefined, credentials: cfg.credentials,
    options: { ...(u.protocol === 'https:' ? { https: true } : {}), ...(typeof cfg.options?.rtspPort === 'number' ? { rtspPort: cfg.options.rtspPort } : {}) },
  };
}

export const dahuaEventsConnector: VmsConnectorType = {
  kind: 'dahua-events',
  label: 'Dahua recorder or camera (live events)',
  description: 'Reads a Dahua NVR, XVR or camera\'s live event stream (motion, line crossing, intrusion, tamper, plates its traffic analytics read) and its channel list, with a read-only account. Events missed while disconnected are not recoverable.',
  create(cfg, deps) {
    const adapter = createDahuaAdapter();
    const ref = refOf(cfg);
    const url = `${cfg.baseUrl}/cgi-bin/eventManager.cgi?action=attach&codes=%5BAll%5D&heartbeat=5`;
    const opt = (k: string): number | undefined => (typeof cfg.options?.[k] === 'number' ? (cfg.options[k] as number) : undefined);
    return createEventStreamConnector({
      label: cfg.id,
      protocol: {
        open: (signal) => openEventStream({ url, credentials: cfg.credentials, fetch: deps?.fetch, signal, connectTimeoutMs: deps?.timeoutMs ?? opt('connectTimeoutMs') }),
        createParser: () => createDahuaParser({ now: deps?.now }),
      },
      cameras: async () => (await adapter.channels!(ref)).map((c) => ({ id: String(c.channel), name: c.name ?? `Channel ${c.channel}`, online: c.online })),
      streams: async (id) => (await adapter.endpoints({ ...ref, options: { ...ref.options, channel: Number(id) } })).filter((e) => e.protocol === 'rtsp'),
      ping: async () => { await adapter.deviceInfo!(ref); },
      idleTimeoutMs: opt('idleTimeoutMs'), backoffBaseMs: opt('backoffBaseMs'), backoffMaxMs: opt('backoffMaxMs'), firstConnectWaitMs: opt('firstConnectWaitMs'),
      now: deps?.now,
    });
  },
};
