/**
 * A fake ONVIF device for tests: a real HTTP server that answers the calls the adapter makes, checks the login the way a
 * camera does, and can be told to behave like the awkward devices found in the field (HTTP Digest instead of WS-Security,
 * a clock hours off, unusual XML prefixes, a media address on an internal network, faults, empty profile lists...).
 * Every request is recorded so tests can assert what was sent.
 */
import http from 'node:http';
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { authorizationFor, parseAuthChallenge } from '../../server/adapters/onvifProtocol.ts';

export interface FakeProfile {
  token: string; name: string; codec?: string | null; width?: number; height?: number;
  /** With `events`: the video source this profile reads (SourceToken); its configuration token is `vsc_<source>`. */
  source?: string;
  /** The RTSP address GetStreamUri returns. `null` returns an empty MediaUri, `'fault'` a SOAP fault. */
  uri?: string | null | 'fault';
}

export interface FakeOnvifOptions {
  /** How the device wants to be logged in to. `wsse` and `either` take the WS-Security header; `http-*` insist on an HTTP challenge. */
  auth?: 'none' | 'wsse' | 'http-digest' | 'http-basic' | 'either';
  user?: string;
  pass?: string;
  /** Device clock minus real time. WS-Security logins older or newer than 5 minutes by the device's clock are refused. */
  clockSkewMs?: number;
  prefixes?: 'standard' | 'odd' | 'none';
  /** `ok`: announces its own address. `fault`: GetCapabilities is not supported. `internal`: announces an unreachable address. `empty`: no media entry. */
  capabilities?: 'ok' | 'fault' | 'internal' | 'empty';
  /** HTTP status used for SOAP faults (devices differ: 400, 500, or 200). */
  faultStatus?: number;
  profiles?: FakeProfile[];
  /** Delay before every answer, to test timeouts. */
  delayMs?: number;
  /** Answer with garbage instead of XML. */
  garbage?: boolean;
  /** Host in the generated RTSP addresses when a profile gives no `uri`. */
  streamHost?: string;
  /** Offer the ONVIF Event Service (PullPoint subscriptions), and list video sources in the profiles. */
  events?: boolean;
}

/** The events side of the device: queue notifications for subscribers, and see what the connector asked for. */
export interface FakeOnvifEvents {
  /** Queues a notification for every live subscription. */
  push(topic: string, source: Record<string, string>, data: Record<string, string>, o?: { operation?: string; utc?: string }): void;
  /** Subscriptions created, and how many are alive now. */
  created: number;
  alive(): number;
  pulls: number;
  renews: number;
  unsubscribed: number;
  /** Forget every subscription, like a device that restarted: the next pull is a fault. */
  killAll(): void;
  /** Refuse to create subscriptions (a device that supports none, or has reached its limit). */
  refuseCreate(refuse: boolean): void;
}

export interface FakeOnvif {
  url: string;
  host: string;
  port: number;
  /** Operation names in the order they arrived (GetProfiles, ...), including those refused. */
  calls: string[];
  /** For each request: whether it carried a WS-Security header and/or an HTTP Authorization header. */
  seen: Array<{ op: string; wsse: boolean; httpAuth: string | null; path: string }>;
  events: FakeOnvifEvents;
  close(): Promise<void>;
}

const SOAP_ENV = 'http://www.w3.org/2003/05/soap-envelope';

export async function startFakeOnvif(o: FakeOnvifOptions = {}): Promise<FakeOnvif> {
  const auth = o.auth ?? 'none', user = o.user ?? 'admin', pass = o.pass ?? 'secret';
  const profiles: FakeProfile[] = o.profiles ?? [
    { token: 'main', name: 'MainStream', codec: 'H264', width: 1920, height: 1080 },
    { token: 'sub', name: 'SubStream', codec: 'H264', width: 640, height: 360 },
  ];
  const p = o.prefixes === 'odd' ? { s: 'SOAP-ENV', tds: 'ns2', trt: 'ns3', tt: 'ns4' } : o.prefixes === 'none' ? { s: '', tds: '', trt: '', tt: '' } : { s: 's', tds: 'tds', trt: 'trt', tt: 'tt' };
  const tag = (pre: string, name: string) => (pre ? `${pre}:${name}` : name);
  const nonce = 'abcdef0123456789';
  const subs = new Map<number, { queue: string[]; alive: boolean }>();
  let nextSub = 1, refuseCreate = false;
  const events: FakeOnvifEvents = {
    created: 0, pulls: 0, renews: 0, unsubscribed: 0,
    alive: () => [...subs.values()].filter((s) => s.alive).length,
    push(topic, source, data, po) {
      const items = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `<tt:SimpleItem Name="${k}" Value="${v}"/>`).join('');
      const xml = `<wsnt:NotificationMessage><wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${topic}</wsnt:Topic><wsnt:Message><tt:Message UtcTime="${po?.utc ?? new Date().toISOString()}" PropertyOperation="${po?.operation ?? 'Changed'}"><tt:Source>${items(source)}</tt:Source><tt:Data>${items(data)}</tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
      for (const s of subs.values()) if (s.alive) s.queue.push(xml);
    },
    killAll: () => { subs.clear(); },
    refuseCreate: (r) => { refuseCreate = r; },
  };
  const log: FakeOnvif = { url: '', host: '127.0.0.1', port: 0, calls: [], seen: [], events, close: async () => {} };

  const envelope = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<${tag(p.s, 'Envelope')} xmlns:${p.s || 'e'}="${SOAP_ENV}"${o.prefixes === 'none' ? ` xmlns="${SOAP_ENV}"` : ''}>\n  <${tag(p.s, 'Body')}>\n${body}\n  </${tag(p.s, 'Body')}>\n</${tag(p.s, 'Envelope')}>`;
  const fault = (sub: string, text: string) => envelope(`<${tag(p.s, 'Fault')}><${tag(p.s, 'Code')}><${tag(p.s, 'Value')}>${tag(p.s, 'Sender')}</${tag(p.s, 'Value')}><${tag(p.s, 'Subcode')}><${tag(p.s, 'Value')}>${sub}</${tag(p.s, 'Value')}></${tag(p.s, 'Subcode')}></${tag(p.s, 'Code')}><${tag(p.s, 'Reason')}><${tag(p.s, 'Text')} xml:lang="en">${text}</${tag(p.s, 'Text')}></${tag(p.s, 'Reason')}></${tag(p.s, 'Fault')}>`);

  /** Checks the WS-Security header the way a device does: recompute the digest, and refuse a login stamped far from its own clock. */
  function wsseOk(xml: string): boolean {
    const m = (name: string) => xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}(?=[\\s>])[^>]*>([^<]*)<`))?.[1];
    const u = m('Username'), digest = m('Password'), n = m('Nonce'), created = m('Created');
    if (!u || !digest || !n || !created) return false;
    if (u !== user) return false;
    const deviceNow = Date.now() + (o.clockSkewMs ?? 0);
    if (Math.abs(new Date(created).getTime() - deviceNow) > 5 * 60_000) return false;
    const expect = createHash('sha1').update(Buffer.concat([Buffer.from(n, 'base64'), Buffer.from(created), Buffer.from(pass)])).digest('base64');
    return expect === digest;
  }

  function httpAuthOk(header: string | undefined, path: string): boolean {
    if (!header) return false;
    if (/^basic /i.test(header)) return auth === 'http-basic' && header.slice(6).trim() === Buffer.from(`${user}:${pass}`).toString('base64');
    if (auth !== 'http-digest') return false;
    const given = parseAuthChallenge(header);
    if (!given || given.scheme !== 'digest') return false;
    const g = given.params;
    if (g.username !== user || g.nonce !== nonce || g.uri !== path || !g.cnonce) return false;
    const want = authorizationFor({ scheme: 'digest', params: { realm: 'fakecam', nonce, qop: 'auth', algorithm: 'MD5' } }, { method: 'POST', uri: path, user, pass, cnonce: g.cnonce, nc: parseInt(g.nc, 16) });
    return parseAuthChallenge(want!)?.params.response === g.response;
  }

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const xml = Buffer.concat(chunks).toString('utf8');
    const op = xml.match(/<(?:[\w.-]+:)?(Get\w+|CreatePullPointSubscription|PullMessages|Renew|Unsubscribe)[\s/>]/)?.[1] ?? 'Unknown';
    const hasWsse = /UsernameToken/.test(xml);
    log.calls.push(op);
    log.seen.push({ op, wsse: hasWsse, httpAuth: req.headers.authorization ?? null, path: req.url ?? '' });
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    const send = (status: number, body: string, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/soap+xml; charset=utf-8', ...headers }); res.end(body); };
    if (o.garbage) { send(200, '<html><body>not onvif</body></html>'); return; }

    if (op === 'GetSystemDateAndTime') { // allowed without a login, by the specification
      const d = new Date(Date.now() + (o.clockSkewMs ?? 0));
      send(200, envelope(`<${tag(p.tds, 'GetSystemDateAndTimeResponse')}><${tag(p.tds, 'SystemDateAndTime')}><${tag(p.tt, 'UTCDateTime')}><${tag(p.tt, 'Time')}><${tag(p.tt, 'Hour')}>${d.getUTCHours()}</${tag(p.tt, 'Hour')}><${tag(p.tt, 'Minute')}>${d.getUTCMinutes()}</${tag(p.tt, 'Minute')}><${tag(p.tt, 'Second')}>${d.getUTCSeconds()}</${tag(p.tt, 'Second')}></${tag(p.tt, 'Time')}><${tag(p.tt, 'Date')}><${tag(p.tt, 'Year')}>${d.getUTCFullYear()}</${tag(p.tt, 'Year')}><${tag(p.tt, 'Month')}>${d.getUTCMonth() + 1}</${tag(p.tt, 'Month')}><${tag(p.tt, 'Day')}>${d.getUTCDate()}</${tag(p.tt, 'Day')}></${tag(p.tt, 'Date')}></${tag(p.tt, 'UTCDateTime')}></${tag(p.tds, 'SystemDateAndTime')}></${tag(p.tds, 'GetSystemDateAndTimeResponse')}>`));
      return;
    }

    if (auth !== 'none') {
      const wsseAllowed = auth === 'wsse' || auth === 'either';
      const ok = (wsseAllowed && hasWsse && wsseOk(xml)) || httpAuthOk(req.headers.authorization, req.url ?? '');
      if (!ok) {
        if (auth === 'http-digest' || auth === 'either') return send(401, '', { 'WWW-Authenticate': `Digest realm="fakecam", nonce="${nonce}", qop="auth", algorithm=MD5` });
        if (auth === 'http-basic') return send(401, '', { 'WWW-Authenticate': 'Basic realm="fakecam"' });
        return send(o.faultStatus ?? 400, fault('ter:NotAuthorized', 'Sender not authorized'));
      }
    }

    const hostHeader = req.headers.host ?? `127.0.0.1:${log.port}`;
    if (op === 'GetDeviceInformation') {
      send(200, envelope(`<${tag(p.tds, 'GetDeviceInformationResponse')}><${tag(p.tds, 'Manufacturer')}>Acme &amp; Sons</${tag(p.tds, 'Manufacturer')}><${tag(p.tds, 'Model')}>X1</${tag(p.tds, 'Model')}><${tag(p.tds, 'FirmwareVersion')}>2.3</${tag(p.tds, 'FirmwareVersion')}><${tag(p.tds, 'SerialNumber')}><![CDATA[S-9]]></${tag(p.tds, 'SerialNumber')}><${tag(p.tds, 'HardwareId')}>H1</${tag(p.tds, 'HardwareId')}></${tag(p.tds, 'GetDeviceInformationResponse')}>`));
    } else if (op === 'GetCapabilities') {
      if (o.capabilities === 'fault') return send(o.faultStatus ?? 400, fault('ter:ActionNotSupported', 'Optional Action Not Implemented'));
      const addr = o.capabilities === 'internal' ? 'http://10.255.255.1/onvif/media_service' : `http://${hostHeader}/onvif/media_service`;
      const media = o.capabilities === 'empty' ? '' : `<${tag(p.tt, 'Media')}><${tag(p.tt, 'XAddr')}>${addr}</${tag(p.tt, 'XAddr')}></${tag(p.tt, 'Media')}>`;
      const ev = o.events ? `<${tag(p.tt, 'Events')}><${tag(p.tt, 'XAddr')}>http://${hostHeader}/onvif/event_service</${tag(p.tt, 'XAddr')}></${tag(p.tt, 'Events')}>` : '';
      send(200, envelope(`<${tag(p.tds, 'GetCapabilitiesResponse')}><${tag(p.tds, 'Capabilities')}>${media}${ev}</${tag(p.tds, 'Capabilities')}></${tag(p.tds, 'GetCapabilitiesResponse')}>`));
    } else if (op === 'GetProfiles') {
      const items = profiles.map((pr) => {
        const enc = pr.codec === null ? '' : `<${tag(p.tt, 'VideoEncoderConfiguration')} token="vec_${pr.token}"><${tag(p.tt, 'Name')}>enc</${tag(p.tt, 'Name')}><${tag(p.tt, 'Encoding')}>${pr.codec ?? 'H264'}</${tag(p.tt, 'Encoding')}><${tag(p.tt, 'Resolution')}><${tag(p.tt, 'Width')}>${pr.width ?? 1280}</${tag(p.tt, 'Width')}><${tag(p.tt, 'Height')}>${pr.height ?? 720}</${tag(p.tt, 'Height')}></${tag(p.tt, 'Resolution')}></${tag(p.tt, 'VideoEncoderConfiguration')}>`;
        const src = pr.source ?? 'VideoSource_1';
        const vsc = o.events ? `<${tag(p.tt, 'VideoSourceConfiguration')} token="vsc_${src}"><${tag(p.tt, 'Name')}>Source ${src}</${tag(p.tt, 'Name')}><${tag(p.tt, 'SourceToken')}>${src}</${tag(p.tt, 'SourceToken')}></${tag(p.tt, 'VideoSourceConfiguration')}>` : '';
        return `<${tag(p.trt, 'Profiles')} token="${pr.token}" fixed="true"><${tag(p.tt, 'Name')}>${pr.name}</${tag(p.tt, 'Name')}>${vsc}${enc}</${tag(p.trt, 'Profiles')}>`;
      }).join('\n');
      send(200, envelope(`<${tag(p.trt, 'GetProfilesResponse')}>${items}</${tag(p.trt, 'GetProfilesResponse')}>`));
    } else if (op === 'GetStreamUri') {
      const token = xml.match(/ProfileToken>([^<]*)</)?.[1] ?? '';
      const pr = profiles.find((x) => x.token === token);
      if (!pr) return send(o.faultStatus ?? 400, fault('ter:NoProfile', 'The requested profile token does not exist'));
      if (pr.uri === 'fault') return send(o.faultStatus ?? 400, fault('ter:Action', 'Stream not available'));
      const uri = pr.uri === null ? '' : pr.uri ?? `rtsp://${o.streamHost ?? '0.0.0.0'}:554/stream/${token}`;
      send(200, envelope(`<${tag(p.trt, 'GetStreamUriResponse')}><${tag(p.trt, 'MediaUri')}><${tag(p.tt, 'Uri')}>${uri.replace(/&/g, '&amp;')}</${tag(p.tt, 'Uri')}><${tag(p.tt, 'InvalidAfterConnect')}>false</${tag(p.tt, 'InvalidAfterConnect')}></${tag(p.trt, 'MediaUri')}></${tag(p.trt, 'GetStreamUriResponse')}>`));
    } else if (o.events && op === 'CreatePullPointSubscription') {
      if (refuseCreate) return send(o.faultStatus ?? 400, fault('ter:ActionNotSupported', 'No more subscriptions'));
      const n = nextSub++;
      subs.set(n, { queue: [], alive: true });
      events.created++;
      const ns = 'xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa="http://www.w3.org/2005/08/addressing"';
      send(200, envelope(`<tev:CreatePullPointSubscriptionResponse ${ns}><tev:SubscriptionReference><wsa:Address>http://${hostHeader}/onvif/subscription/${n}</wsa:Address></tev:SubscriptionReference><wsnt:CurrentTime>${new Date().toISOString()}</wsnt:CurrentTime><wsnt:TerminationTime>${new Date(Date.now() + 60_000).toISOString()}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`));
    } else if (o.events && (op === 'PullMessages' || op === 'Renew' || op === 'Unsubscribe')) {
      const n = Number((req.url ?? '').match(/\/onvif\/subscription\/(\d+)/)?.[1]);
      const sub = subs.get(n);
      if (!sub || !sub.alive) return send(o.faultStatus ?? 400, fault('wsrf-rw:ResourceUnknownFault', 'Resource unknown'));
      if (op === 'Renew') { events.renews++; send(200, envelope('<wsnt:RenewResponse xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"><wsnt:TerminationTime>' + new Date(Date.now() + 60_000).toISOString() + '</wsnt:TerminationTime></wsnt:RenewResponse>')); return; }
      if (op === 'Unsubscribe') { events.unsubscribed++; sub.alive = false; send(200, envelope('<wsnt:UnsubscribeResponse xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"/>')); return; }
      events.pulls++;
      // A long poll: wait a little (not the full timeout, to keep tests fast) for something to arrive.
      for (let i = 0; i < 12 && sub.queue.length === 0 && sub.alive; i++) await new Promise((r) => setTimeout(r, 20));
      const out = sub.queue.splice(0, 100).join('');
      send(200, envelope(`<tev:PullMessagesResponse xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tt="http://www.onvif.org/ver10/schema"><tev:CurrentTime>${new Date().toISOString()}</tev:CurrentTime><tev:TerminationTime>${new Date(Date.now() + 60_000).toISOString()}</tev:TerminationTime>${out}</tev:PullMessagesResponse>`));
    } else {
      send(o.faultStatus ?? 400, fault('ter:ActionNotSupported', `Unknown action ${op}`));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  log.port = (server.address() as AddressInfo).port;
  log.url = `http://127.0.0.1:${log.port}/onvif/device_service`;
  log.close = () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return log;
}

/** A WS-Discovery responder on a unicast UDP port. `replies` are sent back for every datagram that looks like a Probe. */
export async function startFakeDiscovery(replies: string[]): Promise<{ port: number; received: string[]; close(): Promise<void> }> {
  const sock = dgram.createSocket('udp4');
  const received: string[] = [];
  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    received.push(text);
    if (!text.includes('Probe')) return;
    for (const r of replies) sock.send(r, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, received, close: () => new Promise<void>((r) => sock.close(() => r())) };
}
