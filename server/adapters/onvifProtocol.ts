/**
 * ONVIF message building and parsing, with no network code so it can be tested against recorded replies.
 * Covers what onboarding needs: WS-Discovery, the WS-Security login, and the Device and Media calls that lead to an
 * RTSP address (GetSystemDateAndTime, GetDeviceInformation, GetCapabilities, GetProfiles, GetStreamUri).
 * XML is read by local name with small regular expressions: replies from different vendors use different prefixes.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DeviceInfo, DiscoveredDevice } from './types';

export const DISCOVERY_ADDRESS = '239.255.255.250';
export const DISCOVERY_PORT = 3702;

// ---- XML helpers --------------------------------------------------------------------------------------------------

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const tagRe = (local: string, flags = 'g') => new RegExp(`<(?:[\\w.-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}>`, flags);

/** Inner XML of every element with this local name. */
export function blocks(xml: string, local: string): string[] {
  return [...xml.matchAll(tagRe(local))].map((m) => m[1]);
}

/** Text of the first element with this local name, or null. */
export function textOf(xml: string, local: string): string | null {
  const m = xml.match(tagRe(local, ''));
  if (!m) return null;
  return unescapeXml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
}

// ---- Envelopes and login ------------------------------------------------------------------------------------------

const NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"';

/** WS-Security UsernameToken with a password digest. `clockOffsetMs` is camera time minus our time. */
export function securityHeader(user: string, pass: string, o: { now?: Date; nonce?: Buffer; clockOffsetMs?: number } = {}): string {
  const nonce = o.nonce ?? randomBytes(16);
  const created = new Date((o.now ?? new Date()).getTime() + (o.clockOffsetMs ?? 0)).toISOString().replace(/\.\d+Z$/, 'Z');
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass)])).digest('base64');
  return `<Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" s:mustUnderstand="1"><UsernameToken>`
    + `<Username>${escapeXml(user)}</Username>`
    + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
    + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
    + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
    + `</UsernameToken></Security>`;
}

export function envelope(body: string, header = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}>${header ? `<s:Header>${header}</s:Header>` : ''}<s:Body>${body}</s:Body></s:Envelope>`;
}

export const requests = {
  systemDateAndTime: () => envelope('<tds:GetSystemDateAndTime/>'),
  deviceInformation: () => '<tds:GetDeviceInformation/>',
  capabilities: () => '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>',
  profiles: () => '<trt:GetProfiles/>',
  streamUri: (token: string) =>
    `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${escapeXml(token)}</trt:ProfileToken></trt:GetStreamUri>`,
};

// ---- Replies ------------------------------------------------------------------------------------------------------

export class OnvifFault extends Error {
  constructor(message: string, readonly kind: 'auth' | 'other') { super(message); this.name = 'OnvifFault'; }
}

/** Throws OnvifFault when a SOAP reply is a fault. */
export function assertNoFault(xml: string): void {
  if (!/<(?:[\w.-]+:)?Fault[\s>]/.test(xml)) return;
  const reason = textOf(xml, 'Text') ?? textOf(xml, 'faultstring') ?? 'SOAP fault';
  const auth = /NotAuthorized|Sender not authorized|AuthFailed|FailedAuthentication/i.test(xml.slice(0, 4000));
  throw new OnvifFault(reason, auth ? 'auth' : 'other');
}

/** Camera clock minus ours, in ms, from a GetSystemDateAndTime reply (UTC). Null when the reply has no usable time. */
export function parseClockOffset(xml: string, now = new Date()): number | null {
  const utc = blocks(xml, 'UTCDateTime')[0];
  if (!utc) return null;
  const n = (name: string) => Number(textOf(utc, name));
  const t = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
  return Number.isFinite(t) ? t - now.getTime() : null;
}

export function parseDeviceInformation(xml: string): DeviceInfo {
  return {
    manufacturer: textOf(xml, 'Manufacturer'), model: textOf(xml, 'Model'), firmware: textOf(xml, 'FirmwareVersion'),
    serial: textOf(xml, 'SerialNumber'), hardwareId: textOf(xml, 'HardwareId'),
  };
}

/** The Media service address from a GetCapabilities reply. */
export function parseMediaXAddr(xml: string): string | null {
  const media = blocks(xml, 'Media')[0];
  return media ? textOf(media, 'XAddr') : null;
}

export interface OnvifProfile { token: string; name: string | null; codec: string | null; width: number | null; height: number | null }

export function parseProfiles(xml: string): OnvifProfile[] {
  const out: OnvifProfile[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?Profiles(\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?Profiles>/g)) {
    const token = (m[1] ?? '').match(/\btoken\s*=\s*"([^"]*)"/)?.[1];
    if (!token) continue;
    const body = m[2];
    const enc = blocks(body, 'VideoEncoderConfiguration')[0] ?? '';
    const res = blocks(enc, 'Resolution')[0] ?? '';
    const w = Number(textOf(res, 'Width')), h = Number(textOf(res, 'Height'));
    const codec = textOf(enc, 'Encoding');
    out.push({ token, name: textOf(body, 'Name'), codec: codec ? codec.toLowerCase() : null, width: w > 0 ? w : null, height: h > 0 ? h : null });
  }
  return out;
}

export function parseStreamUri(xml: string): string | null {
  const b = blocks(xml, 'MediaUri')[0];
  return b ? textOf(b, 'Uri') : null;
}

/** Best profile first: a video profile before one without, MJPEG last among video, then the most pixels. */
export function rankProfiles(ps: OnvifProfile[]): OnvifProfile[] {
  const px = (p: OnvifProfile) => (p.width ?? 0) * (p.height ?? 0);
  const mjpeg = (p: OnvifProfile) => (p.codec === 'jpeg' ? 1 : 0);
  return [...ps].sort((a, b) => (b.codec ? 1 : 0) - (a.codec ? 1 : 0) || mjpeg(a) - mjpeg(b) || px(b) - px(a));
}

/** Some cameras answer with their own idea of their address (0.0.0.0, loopback). Use the one we reached them on. */
export function fixStreamHost(uri: string, reachedHost: string): string {
  try {
    const u = new URL(uri);
    if (u.hostname === '0.0.0.0' || u.hostname === '127.0.0.1' || u.hostname === 'localhost') u.hostname = reachedHost;
    return u.toString();
  } catch { return uri; }
}

// ---- WS-Discovery -------------------------------------------------------------------------------------------------

export function discoveryProbe(messageId = `uuid:${randomUUID()}`): string {
  return `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">`
    + `<e:Header><w:MessageID>${messageId}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>`
    + `<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
}

const scopeValue = (scopes: string[], key: string) => {
  const marker = `onvif.org/${key}/`;
  const hit = scopes.find((s) => s.toLowerCase().includes(marker));
  if (!hit) return undefined;
  const v = hit.slice(hit.toLowerCase().indexOf(marker) + marker.length);
  try { return decodeURIComponent(v); } catch { return v; }
};

/** One discovery reply, or null when it is not a device announcement. */
export function parseProbeMatch(xml: string, fromAddress: string): DiscoveredDevice | null {
  const match = blocks(xml, 'ProbeMatch')[0];
  if (!match) return null;
  const serviceUrls = (textOf(match, 'XAddrs') ?? '').split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
  if (serviceUrls.length === 0) return null;
  const scopes = (textOf(match, 'Scopes') ?? '').split(/\s+/).filter(Boolean);
  return {
    adapter: 'onvif', address: fromAddress, serviceUrls, scopes,
    name: scopeValue(scopes, 'name'), hardware: scopeValue(scopes, 'hardware'), manufacturer: scopeValue(scopes, 'manufacturer') ?? scopeValue(scopes, 'mfr'),
  };
}

/** Collapses repeated answers from one device (several addresses, repeated replies). */
export function dedupeDevices(ds: DiscoveredDevice[]): DiscoveredDevice[] {
  const byKey = new Map<string, DiscoveredDevice>();
  for (const d of ds) {
    const key = `${d.address}|${[...d.serviceUrls].sort()[0]}`;
    if (!byKey.has(key)) byKey.set(key, d);
  }
  return [...byKey.values()];
}

// ---- HTTP authentication ------------------------------------------------------------------------------------------
// Many devices ignore the WS-Security header and ask for HTTP Digest (or Basic) instead, answering 401 with a challenge.

export function parseAuthChallenge(header: string): { scheme: 'digest' | 'basic'; params: Record<string, string> } | null {
  const m = header.match(/^\s*(digest|basic)\s*(.*)$/i);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[2].matchAll(/([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^\s,]*))/gi)) params[p[1].toLowerCase()] = p[2] ?? p[3];
  return { scheme: m[1].toLowerCase() as 'digest' | 'basic', params };
}

/** The Authorization header for a challenge (RFC 2617 / 7616: MD5 or SHA-256, with or without qop=auth). */
export function authorizationFor(ch: { scheme: 'digest' | 'basic'; params: Record<string, string> }, o: { method: string; uri: string; user: string; pass: string; cnonce?: string; nc?: number }): string | null {
  if (ch.scheme === 'basic') return `Basic ${Buffer.from(`${o.user}:${o.pass}`).toString('base64')}`;
  const p = ch.params;
  if (!p.realm || !p.nonce) return null;
  const algo = (p.algorithm ?? 'MD5').toUpperCase().replace(/-SESS$/, '');
  const hashName = algo === 'SHA-256' ? 'sha256' : algo === 'MD5' ? 'md5' : null;
  if (!hashName) return null;
  const H = (s: string) => createHash(hashName).update(s).digest('hex');
  const qops = (p.qop ?? '').split(',').map((s) => s.trim());
  const qop = qops.includes('auth') ? 'auth' : null;
  const cnonce = o.cnonce ?? randomBytes(8).toString('hex');
  const nc = (o.nc ?? 1).toString(16).padStart(8, '0');
  let ha1 = H(`${o.user}:${p.realm}:${o.pass}`);
  if ((p.algorithm ?? '').toLowerCase().endsWith('-sess')) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = H(`${o.method}:${o.uri}`);
  const response = qop ? H(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${p.nonce}:${ha2}`);
  const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
  const parts = [`username=${q(o.user)}`, `realm=${q(p.realm)}`, `nonce=${q(p.nonce)}`, `uri=${q(o.uri)}`, `response=${q(response)}`];
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${q(cnonce)}`);
  if (p.opaque) parts.push(`opaque=${q(p.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

/** The same URL on another host and port (`authority` is `host` or `host:port`; keeps path and login). */
export function withAuthority(url: string, authority: string): string {
  try { const u = new URL(url); u.host = authority; return u.toString(); } catch { return url; }
}

/** The same URL with another host (keeps port, path, login). */
export function withHost(url: string, host: string): string {
  try { const u = new URL(url); u.hostname = host; return u.toString(); } catch { return url; }
}
