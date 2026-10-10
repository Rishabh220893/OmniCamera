/**
 * Hikvision cameras, NVRs and DVRs: the live event stream (`GET /ISAPI/Event/notification/alertStream`, Digest or Basic login). The device
 * holds the connection open and writes one `EventNotificationAlert` XML document per event (and a heartbeat now and then), inside a multipart
 * body. Read-only: the one request is a GET.
 *
 * The parser does not depend on the multipart framing (boundaries, Content-Length): it takes complete `<EventNotificationAlert ...>...</...>`
 * documents out of the text as they arrive, however the network cut it into chunks.
 *
 * NOT VERIFIED against a real device. The element names and event codes are from Hikvision's public ISAPI documentation and field reports,
 * not from a recorder; firmware varies. `tests/lab/fakeEventDevice.ts` is the only thing it has been run against.
 */
import { createHikvisionAdapter } from '../../adapters/vendorNvr';
import type { CameraRef } from '../../adapters/types';
import { textOf } from '../../adapters/onvifProtocol';
import { createEventStreamConnector } from './eventStream';
import { openEventStream } from './streamHttp';
import { VmsError, type VmsConnectorType, type VmsEvent, type VmsEventKind, type VmsSystemConfig } from './types';

const KIND: Array<[RegExp, VmsEventKind]> = [
  [/^vmd$|^motion/i, 'motion'],
  [/^linedetection$|^linedetect|^crossline/i, 'line_crossing'],
  [/^fielddetection$|^regionentrance$|^regionexiting$|^intrusion|^loitering|^parking/i, 'intrusion'],
  [/^shelteralarm$|^tamper|^videotamper/i, 'tamper'],
  [/^anpr$|^platerecognition|^vehicledetection$/i, 'plate'],
];

export function kindOfHikvision(eventType: string): VmsEventKind {
  for (const [re, k] of KIND) if (re.test(eventType)) return k;
  return 'alarm';
}

const ALERT = /<EventNotificationAlert\b[\s\S]*?<\/EventNotificationAlert>/g;

/** Turns one `EventNotificationAlert` document into an event, or null for a heartbeat, an "inactive" (event ended) notice or something unreadable. */
export function parseHikvisionAlert(xml: string, o: { timezoneOffsetMinutes?: number; now?: Date } = {}): VmsEvent | null {
  const t = (n: string) => textOf(xml, n);
  const eventType = t('eventType');
  if (!eventType) return null;
  const state = (t('eventState') ?? 'active').toLowerCase();
  // A heartbeat is sent as a notice with eventType "videoloss" and state "inactive" (some firmware says "heartBeat"); an inactive notice means the event ended.
  if (/^heart/i.test(eventType) || state === 'inactive') return null;
  const channel = t('dynChannelID') ?? t('channelID') ?? '0';
  const dateTime = t('dateTime');
  const post = t('activePostCount') ?? '';
  let at = o.now ?? new Date();
  if (dateTime) {
    // "2026-10-10T10:00:00+05:30" carries its zone; one without (some firmware) is in the device's local time.
    const hasZone = /(Z|[+-]\d\d:?\d\d)$/.test(dateTime);
    const parsed = new Date(hasZone ? dateTime : `${dateTime}Z`);
    if (!Number.isNaN(parsed.getTime())) at = hasZone ? parsed : new Date(parsed.getTime() - (o.timezoneOffsetMinutes ?? 0) * 60_000);
  }
  const kind = kindOfHikvision(eventType);
  const data: Record<string, unknown> = { eventType };
  const desc = t('eventDescription');
  if (desc) data.text = desc;
  if (kind === 'plate') {
    const plate = t('licensePlate') ?? t('plateNumber');
    if (!plate) return null; // an ANPR notice with no plate is not a plate read
    data.plate = plate;
    const conf = Number(t('confidenceLevel') ?? t('confidence'));
    if (Number.isFinite(conf)) data.confidence = conf > 1 ? Math.min(1, conf / 100) : conf;
  } else if (kind === 'alarm' && !data.text) data.text = `Hikvision event ${eventType}`;
  return { id: `${channel}:${eventType}:${dateTime ?? at.toISOString()}:${post}`, cameraId: channel, at, kind, vendorCode: eventType, data };
}

/** A parser for the stream: feed it text as it arrives, get the events completed so far. */
export function createHikvisionParser(o: { timezoneOffsetMinutes?: number; now?: () => Date } = {}): (chunk: string) => VmsEvent[] {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    const out: VmsEvent[] = [];
    let consumed = 0;
    for (const m of pending.matchAll(ALERT)) {
      consumed = (m.index ?? 0) + m[0].length;
      const ev = parseHikvisionAlert(m[0], { timezoneOffsetMinutes: o.timezoneOffsetMinutes, now: o.now?.() });
      if (ev) out.push(ev);
    }
    // Keep only what could still be the start of a document; never let a stream with no documents grow without bound.
    const rest = pending.slice(consumed);
    const start = rest.lastIndexOf('<EventNotificationAlert');
    pending = start >= 0 ? rest.slice(start) : rest.slice(-64);
    if (pending.length > 256 * 1024) pending = '';
    return out;
  };
}

function refOf(cfg: VmsSystemConfig): CameraRef {
  const u = new URL(cfg.baseUrl);
  return {
    id: cfg.id, adapter: 'hikvision', host: u.hostname, port: u.port ? Number(u.port) : undefined, credentials: cfg.credentials,
    options: { ...(u.protocol === 'https:' ? { https: true } : {}), ...(typeof cfg.options?.rtspPort === 'number' ? { rtspPort: cfg.options.rtspPort } : {}) },
  };
}

export const hikvisionEventsConnector: VmsConnectorType = {
  kind: 'hikvision-events',
  label: 'Hikvision recorder or camera (live events)',
  description: 'Reads a Hikvision NVR, DVR or camera\'s live event stream (motion, line crossing, intrusion, tamper, plates its ANPR read) and its channel list, with a read-only account. Events missed while disconnected are not recoverable.',
  create(cfg, deps) {
    const adapter = createHikvisionAdapter();
    const ref = refOf(cfg);
    const url = `${cfg.baseUrl}/ISAPI/Event/notification/alertStream`;
    const opt = (k: string): number | undefined => (typeof cfg.options?.[k] === 'number' ? (cfg.options[k] as number) : undefined);
    return createEventStreamConnector({
      label: cfg.id,
      protocol: {
        open: (signal) => openEventStream({ url, credentials: cfg.credentials, fetch: deps?.fetch, signal, connectTimeoutMs: deps?.timeoutMs ?? opt('connectTimeoutMs') }),
        createParser: () => createHikvisionParser({ timezoneOffsetMinutes: cfg.timezoneOffsetMinutes, now: deps?.now }),
      },
      cameras: async () => (await adapter.channels!(ref)).map((c) => ({ id: String(c.channel), name: c.name ?? `Channel ${c.channel}`, online: c.online })),
      streams: async (id) => (await adapter.endpoints({ ...ref, options: { ...ref.options, channel: Number(id) } })).filter((e) => e.protocol === 'rtsp'),
      ping: async () => { await adapter.deviceInfo!(ref); },
      idleTimeoutMs: opt('idleTimeoutMs'), backoffBaseMs: opt('backoffBaseMs'), backoffMaxMs: opt('backoffMaxMs'), firstConnectWaitMs: opt('firstConnectWaitMs'),
      now: deps?.now,
    });
  },
};
export { VmsError };
