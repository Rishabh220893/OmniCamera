/**
 * ONVIF cameras and recorders: live events through a PullPoint subscription (ONVIF Event Service, WS-BaseNotification). The connector asks
 * the device for its Events service, creates a subscription, then repeatedly asks "what happened?" (PullMessages, a long poll), renewing
 * the subscription as it goes. It is presented to the shared stream engine as a stream, so reconnecting, the idle watchdog, status, the buffer
 * and the runner are the same as for Hikvision and Dahua.
 *
 * Unlike Hikvision and Dahua (plain GETs) this needs SOAP POSTs, including one that creates the subscription and one that ends it. They
 * change nothing in the device's configuration, only the subscription this connector owns; the lab device counts every other operation.
 *
 * NOT VERIFIED against a real device. Topic names and message shapes are from the ONVIF specifications and typical device output; devices
 * differ a lot here (which topics they offer, whether the notification carries a state flag, how they name the video source).
 * `tests/lab/fakeOnvif.ts` is the only thing this has been run against.
 */
import { createOnvifAdapter, createSoapCaller, makeFetchSoap } from '../../adapters/onvif';
import { OnvifFault, blocks, escapeXml, fixStreamHost, parseMediaXAddr, textOf, withAuthority } from '../../adapters/onvifProtocol';
import type { Credentials } from '../../adapters/types';
import { createEventStreamConnector } from './eventStream';
import { VmsError, type VmsCamera, type VmsConnectorType, type VmsEvent, type VmsEventKind, type VmsSystemConfig } from './types';

const TEV = 'xmlns:tev="http://www.onvif.org/ver10/events/wsdl"';
const WSNT = 'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"';
const WSA = 'xmlns:wsa="http://www.w3.org/2005/08/addressing"';

export const onvifEventRequests = {
  capabilities: () => '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
  profiles: () => '<trt:GetProfiles/>',
  createPullPoint: (ttl = 'PT60S') => `<tev:CreatePullPointSubscription ${TEV}><tev:InitialTerminationTime>${ttl}</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`,
  pull: (timeoutS: number, limit: number) => `<tev:PullMessages ${TEV}><tev:Timeout>PT${Math.max(1, Math.round(timeoutS))}S</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>`,
  renew: (ttl = 'PT60S') => `<wsnt:Renew ${WSNT}><wsnt:TerminationTime>${ttl}</wsnt:TerminationTime></wsnt:Renew>`,
  unsubscribe: () => `<wsnt:Unsubscribe ${WSNT}/>`,
};

const ACTION = {
  create: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest',
  pull: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
  renew: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
  unsubscribe: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
};

/** WS-Addressing headers some devices insist on for a subscription call. */
const addressing = (to: string, action: string) => `<wsa:Action ${WSA} s:mustUnderstand="1">${action}</wsa:Action><wsa:To ${WSA} s:mustUnderstand="1">${escapeXml(to)}</wsa:To>`;

/** The Events service address from a GetCapabilities reply. */
export function parseEventsXAddr(xml: string): string | null {
  const b = blocks(xml, 'Events')[0];
  return b ? textOf(b, 'XAddr') : null;
}

/** Where to send PullMessages, from a CreatePullPointSubscription reply. */
export function parseSubscriptionAddress(xml: string): string | null {
  const ref = blocks(xml, 'SubscriptionReference')[0];
  return ref ? textOf(ref, 'Address') : null;
}

/** The video sources behind the profiles: the id events are reported against, with the configuration tokens that point to each. */
export function parseVideoSources(profilesXml: string): { cameras: VmsCamera[]; byConfigToken: Map<string, string> } {
  const cameras = new Map<string, VmsCamera>();
  const byConfigToken = new Map<string, string>();
  for (const m of profilesXml.matchAll(/<(?:[\w.-]+:)?VideoSourceConfiguration(\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?VideoSourceConfiguration>/g)) {
    const configToken = (m[1] ?? '').match(/\btoken\s*=\s*"([^"]*)"/)?.[1];
    const source = textOf(m[2], 'SourceToken');
    if (!source) continue;
    if (configToken) byConfigToken.set(configToken, source);
    if (!cameras.has(source)) cameras.set(source, { id: source, name: textOf(m[2], 'Name') ?? source, online: null });
  }
  return { cameras: [...cameras.values()], byConfigToken };
}

// ---- notifications ------------------------------------------------------------------------------------------------------------------

export interface OnvifNotification { topic: string; utcTime: string | null; operation: string | null; source: Record<string, string>; data: Record<string, string> }

const attrs = (s: string) => { const o: Record<string, string> = {}; for (const m of s.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2]; return o; };
const items = (xml: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?SimpleItem\b([^>]*?)\/?>/g)) { const a = attrs(m[1]); if (a.Name) out[a.Name] = a.Value ?? ''; }
  return out;
};

/** Every notification in a PullMessages reply. */
export function parseNotifications(xml: string): OnvifNotification[] {
  const out: OnvifNotification[] = [];
  for (const nm of blocks(xml, 'NotificationMessage')) {
    const topic = (textOf(nm, 'Topic') ?? '').trim();
    const open = nm.match(/<(?:[\w.-]+:)?Message\b([^>]*UtcTime[^>]*)>/);
    if (!topic || !open) continue;
    const a = attrs(open[1]);
    const source = blocks(nm, 'Source')[0] ?? '', data = blocks(nm, 'Data')[0] ?? '';
    out.push({ topic, utcTime: a.UtcTime ?? null, operation: a.PropertyOperation ?? null, source: items(source), data: items(data) });
  }
  return out;
}

const KIND: Array<[RegExp, VmsEventKind]> = [
  [/CellMotionDetector\/Motion|VideoSource\/MotionAlarm|MotionDetector|\/Motion$/i, 'motion'],
  [/LineDetector\/Crossed|LineDetector/i, 'line_crossing'],
  [/FieldDetector\/ObjectsInside|FieldDetector|Intrusion/i, 'intrusion'],
  [/TamperDetector|GlobalSceneChange|Tamper/i, 'tamper'],
];
export function kindOfOnvifTopic(topic: string): VmsEventKind {
  for (const [re, k] of KIND) if (re.test(topic)) return k;
  return 'alarm';
}

const STATE_ITEMS = ['IsMotion', 'State', 'IsInside', 'IsTamper', 'LogicalState', 'IsActive'];

/** One notification as an event, or null when it only says something ended, is the initial state sent when subscribing, or has no source we can name. */
export function eventFromNotification(n: OnvifNotification, byConfigToken: Map<string, string>): VmsEvent | null {
  // "Initialized" is the state as it was when the subscription started, not something that happened: after every reconnect it would repeat.
  if (/^initialized$/i.test(n.operation ?? '')) return null;
  const flag = STATE_ITEMS.find((k) => k in n.data);
  if (flag && !/^(true|1)$/i.test(n.data[flag])) return null; // the event ended
  const raw = n.source.VideoSourceConfigurationToken ?? n.source.VideoSourceToken ?? n.source.Source ?? Object.values(n.source)[0];
  if (!raw) return null;
  const cameraId = byConfigToken.get(raw) ?? raw;
  const t = n.utcTime ? new Date(n.utcTime) : new Date();
  const at = Number.isNaN(t.getTime()) ? new Date() : t;
  const kind = kindOfOnvifTopic(n.topic);
  const short = n.topic.replace(/^[\w.-]+:/, '');
  const sig = [...Object.entries(n.source), ...Object.entries(n.data)].map(([k, v]) => `${k}=${v}`).join(',');
  const data: Record<string, unknown> = { topic: short };
  if (kind === 'alarm') data.text = `ONVIF event ${short}`;
  return { id: `${short}|${sig}|${n.utcTime ?? at.toISOString()}`.slice(0, 300), cameraId, at, kind, vendorCode: short, data };
}

/** JSON lines in (what the pull loop writes), events out. */
export function createOnvifLineParser(): (chunk: string) => VmsEvent[] {
  let pending = '';
  return (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    const out: VmsEvent[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { for (const e of JSON.parse(l) as Array<Omit<VmsEvent, 'at'> & { at: string }>) out.push({ ...e, at: new Date(e.at) }); } catch { /* a damaged line loses its events, not the stream */ }
    }
    return out;
  };
}

// ---- the subscription ---------------------------------------------------------------------------------------------------------------

type Call = (url: string, body: string, cred: Credentials | undefined, header?: string) => Promise<string>;

interface Session { pull(timeoutS: number): Promise<OnvifNotification[]>; renew(): Promise<void>; unsubscribe(): Promise<void>; byConfigToken: Map<string, string>; cameras: VmsCamera[] }

/** Finds the device's Events and Media services and learns its video sources. No subscription is made. */
async function findServices(device: string, cred: Credentials | undefined, call: Call) {
  const reached = new URL(device).hostname;
  let caps: string;
  try { caps = await call(device, onvifEventRequests.capabilities(), cred); }
  catch (e) { if (e instanceof OnvifFault && e.kind === 'auth') throw new VmsError('The device rejected the login.', 'auth'); caps = ''; }
  const eventsAnnounced = parseEventsXAddr(caps);
  const mediaAnnounced = parseMediaXAddr(caps);
  const events = eventsAnnounced ? fixStreamHost(eventsAnnounced, reached) : new URL('/onvif/event_service', device).toString();
  const media = mediaAnnounced ? fixStreamHost(mediaAnnounced, reached) : new URL('/onvif/media_service', device).toString();

  // Addresses a device announces are often its own LAN ones: use the announced one, and the one we reached it on if that fails to connect.
  const tryBoth = async <T>(url: string, fn: (u: string) => Promise<T>): Promise<{ value: T; url: string }> => {
    try { return { value: await fn(url), url }; }
    catch (e) {
      if (e instanceof OnvifFault || new URL(url).host === new URL(device).host) throw e;
      const alt = withAuthority(url, new URL(device).host);
      return { value: await fn(alt), url: alt };
    }
  };

  let profilesXml = '';
  try { profilesXml = (await tryBoth(media, (u) => call(u, onvifEventRequests.profiles(), cred))).value; } catch { /* sources stay unknown: events are reported by their own token */ }
  return { events, tryBoth, sources: parseVideoSources(profilesXml) };
}

/** Finds the services and opens a subscription. */
async function openSession(device: string, cred: Credentials | undefined, call: Call): Promise<Session> {
  const { events, tryBoth, sources } = await findServices(device, cred, call);
  const created = await tryBoth(events, (u) => call(u, onvifEventRequests.createPullPoint(), cred, addressing(u, ACTION.create)));
  const announcedSub = parseSubscriptionAddress(created.value);
  if (!announcedSub) throw new VmsError('The device did not create an event subscription.', 'protocol');
  // The subscription address is on the host the events service answered from, whatever the device calls itself.
  const sub = new URL(created.url).host !== new URL(events).host ? withAuthority(announcedSub, new URL(created.url).host) : announcedSub;

  const at = (action: string) => addressing(sub, action);
  return {
    byConfigToken: sources.byConfigToken, cameras: sources.cameras,
    async pull(timeoutS) { return parseNotifications(await call(sub, onvifEventRequests.pull(timeoutS, 100), cred, at(ACTION.pull))); },
    async renew() { await call(sub, onvifEventRequests.renew(), cred, at(ACTION.renew)); },
    async unsubscribe() { await call(sub, onvifEventRequests.unsubscribe(), cred, at(ACTION.unsubscribe)); },
  };
}

function toFault(e: unknown): VmsError {
  if (e instanceof VmsError) return e;
  if (e instanceof OnvifFault) return new VmsError(e.kind === 'auth' ? 'The device rejected the login.' : `The device answered with an error: ${e.message}`, e.kind === 'auth' ? 'auth' : 'upstream');
  const err = e as { cause?: { code?: string }; message?: string };
  return new VmsError(`The device cannot be reached: ${err.cause?.code ?? err.message ?? String(e)}`, 'unreachable');
}

/** A stream of JSON lines (one per pull) fed by a PullPoint subscription; ends (with an error) when the subscription cannot be kept. */
function pullStream(session: Session, o: { pullTimeoutS: number; renewEveryMs: number; minPullGapMs: number; signal: AbortSignal; sources: { byConfigToken: Map<string, string> } }): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let lastRenew = Date.now();
  let stopped = false;
  const stop = () => { stopped = true; void session.unsubscribe().catch(() => undefined); };
  o.signal.addEventListener('abort', stop, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stopped) { try { controller.close(); } catch { /* already closed */ } return; }
      const started = Date.now();
      try {
        if (Date.now() - lastRenew > o.renewEveryMs) { await session.renew(); lastRenew = Date.now(); }
        const events = (await session.pull(o.pullTimeoutS)).map((n) => eventFromNotification(n, session.byConfigToken)).filter((e): e is VmsEvent => !!e);
        // A (possibly empty) line per pull is the heartbeat the idle watchdog listens for.
        controller.enqueue(enc.encode(`${JSON.stringify(events)}\n`));
      } catch (e) { if (!stopped) controller.error(toFault(e)); return; }
      // A device that answers a long poll at once (or an empty one) would otherwise be asked in a tight loop.
      const spent = Date.now() - started;
      if (spent < o.minPullGapMs) await new Promise((r) => setTimeout(r, o.minPullGapMs - spent));
    },
    cancel() { stop(); },
  });
}

export const onvifEventsConnector: VmsConnectorType = {
  kind: 'onvif-events',
  label: 'ONVIF camera or recorder (live events)',
  description: 'Reads an ONVIF device\'s events (motion, line crossing, intrusion, tamper, and any other topic as an alarm) through a PullPoint subscription, and its video sources, with a read-only account. baseUrl is the device service address (http://host/onvif/device_service). Events missed while disconnected are not recoverable.',
  create(cfg: VmsSystemConfig, deps) {
    const post = makeFetchSoap(deps?.timeoutMs ?? (typeof cfg.options?.requestTimeoutMs === 'number' ? (cfg.options.requestTimeoutMs as number) : 15_000));
    const now = deps?.now ?? (() => new Date());
    const call = createSoapCaller(post, now);
    const adapter = createOnvifAdapter({ post, now });
    const opt = (k: string): number | undefined => (typeof cfg.options?.[k] === 'number' ? (cfg.options[k] as number) : undefined);
    let cams: VmsCamera[] = [];
    const ref = { id: cfg.id, url: cfg.baseUrl, credentials: cfg.credentials };
    return createEventStreamConnector({
      label: cfg.id,
      protocol: {
        async open(signal) {
          let session: Session;
          try { session = await openSession(cfg.baseUrl, cfg.credentials, call); }
          catch (e) { throw toFault(e); }
          if (session.cameras.length) cams = session.cameras;
          return pullStream(session, { pullTimeoutS: opt('pullTimeoutS') ?? 10, renewEveryMs: opt('renewEveryMs') ?? 30_000, minPullGapMs: opt('minPullGapMs') ?? 200, signal, sources: session });
        },
        createParser: createOnvifLineParser,
      },
      cameras: async () => {
        if (cams.length) return cams;
        const found = await findServices(cfg.baseUrl, cfg.credentials, call).catch((e) => { throw toFault(e); });
        cams = found.sources.cameras;
        return cams;
      },
      streams: async () => (await adapter.endpoints(ref)).filter((e) => e.protocol === 'rtsp'),
      ping: async () => { await adapter.deviceInfo!(ref); },
      idleTimeoutMs: opt('idleTimeoutMs'), backoffBaseMs: opt('backoffBaseMs'), backoffMaxMs: opt('backoffMaxMs'), firstConnectWaitMs: opt('firstConnectWaitMs'),
      now: deps?.now,
    });
  },
};
