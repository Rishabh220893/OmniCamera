/**
 * Recorder and camera adapters for vendors that publish a fixed stream-address scheme and a small HTTP API (G3).
 * One factory, one small spec per vendor: the spec says how a channel number becomes an RTSP/snapshot address and how to
 * read the device's own answers. Shipped: Hikvision (ISAPI) and Dahua (CGI). Both also cover the OEM brands built on the
 * same firmware, and analog cameras behind a DVR or encoder (an analog input is just a channel number).
 *
 * `ref.host` / `ref.port` are the device's HTTP address (port default 80, or 443 with `options.https`); the RTSP port is
 * `options.rtspPort` (default 554). `options.channel` (default 1) is the number the recorder itself uses, `options.stream`
 * is `main` or `sub` (default `main`, used by `probe`). Or pass a vendor `rtsp://` URL and these are read from it.
 */
import { authorizationFor, blocks, parseAuthChallenge, textOf } from './onvifProtocol';
import { probeUrl, withCredentials } from './probeUrl';
import {
  AdapterError, type CameraRef, type Credentials, type DeviceInfo, type NvrChannel, type SourceAdapter, type StreamEndpoint,
} from './types';

export type VendorStream = 'main' | 'sub';
export interface VendorReply { status: number; body: string }
/** A GET that follows the device's Digest or Basic challenge. Injectable so tests can run without a network. */
export type VendorHttp = (url: string, creds?: Credentials) => Promise<VendorReply>;

export function makeVendorHttp(timeoutMs = 8000): VendorHttp {
  return async (url, creds) => {
    const get = async (authorization?: string) => {
      const r = await fetch(url, { headers: authorization ? { Authorization: authorization } : {}, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      return { status: r.status, body: await r.text(), challenge: r.headers.get('www-authenticate') };
    };
    let r = await get();
    if (r.status === 401 && creds?.user && r.challenge) {
      const ch = parseAuthChallenge(r.challenge);
      const u = new URL(url);
      const auth = ch && authorizationFor(ch, { method: 'GET', uri: u.pathname + u.search, user: creds.user, pass: creds.pass });
      if (auth) r = await get(auth);
    }
    return { status: r.status, body: r.body };
  };
}

export interface VendorSpec {
  kind: string;
  label: string;
  description: string;
  /** True for an rtsp:// URL in this vendor's scheme. */
  matchesRtspUrl(url: URL): boolean;
  /** Channel and stream out of a vendor rtsp:// URL (only called after `matchesRtspUrl`). */
  parseRtspUrl(url: URL): { channel: number; stream: VendorStream } | null;
  rtspPath(channel: number, stream: VendorStream): string;
  snapshotPath(channel: number, stream: VendorStream): string;
  maxChannel: number;
  deviceInfo(get: (path: string) => Promise<VendorReply>): Promise<DeviceInfo>;
  channels(get: (path: string) => Promise<VendorReply>): Promise<NvrChannel[]>;
}

const asInt = (v: unknown, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AdapterError(`'options.${name}' must be a whole number from ${min} to ${max}.`, 'bad_ref');
  return n;
};

// ---- Hikvision (ISAPI) --------------------------------------------------------------------------------------------
// rtsp://host:554/Streaming/Channels/<channel><NN>  NN = 01 main, 02 sub.  Channel 3 sub = 302; an IP channel 33 main = 3301.

export const hikvisionSpec: VendorSpec = {
  kind: 'hikvision',
  label: 'Hikvision recorder or camera',
  description: 'Hikvision cameras, NVRs and DVRs (and OEM brands on the same firmware). Stream addresses from the channel number; make, model and the channel list from the device\'s ISAPI. Analog cameras on a DVR are channels like any other.',
  matchesRtspUrl: (u) => /^\/Streaming\/Channels\/\d+/i.test(u.pathname),
  parseRtspUrl(u) {
    const n = Number(u.pathname.match(/\/Streaming\/Channels\/(\d+)/i)?.[1]);
    if (!Number.isInteger(n) || n < 101) return null;
    const channel = Math.floor(n / 100), nn = n % 100;
    return channel >= 1 && (nn === 1 || nn === 2) ? { channel, stream: nn === 1 ? 'main' : 'sub' } : null;
  },
  rtspPath: (c, s) => `/Streaming/Channels/${c * 100 + (s === 'main' ? 1 : 2)}`,
  snapshotPath: (c, s) => `/ISAPI/Streaming/channels/${c * 100 + (s === 'main' ? 1 : 2)}/picture`,
  maxChannel: 512,
  async deviceInfo(get) {
    const r = await get('/ISAPI/System/deviceInfo');
    if (r.status !== 200) throw httpFailure('Hikvision device information', r);
    const t = (n: string) => textOf(r.body, n);
    return { manufacturer: t('manufacturer'), model: t('model'), firmware: t('firmwareVersion'), serial: t('serialNumber'), hardwareId: t('hardwareVersion') ?? t('deviceID') };
  },
  async channels(get) {
    let list: NvrChannel[] = [];
    const proxy = await get('/ISAPI/ContentMgmt/InputProxy/channels');
    if (proxy.status === 200) {
      list = blocks(proxy.body, 'InputProxyChannel').map((b) => ({
        channel: Number(textOf(b, 'id')), name: textOf(b, 'name'), online: null as boolean | null, address: textOf(b, 'ipAddress') ?? textOf(b, 'hostName'),
      }));
      const st = await get('/ISAPI/ContentMgmt/InputProxy/channels/status').catch(() => null);
      if (st?.status === 200) {
        const online = new Map(blocks(st.body, 'InputProxyChannelStatus').map((b) => [Number(textOf(b, 'id')), (textOf(b, 'online') ?? '').toLowerCase() === 'true']));
        for (const c of list) if (online.has(c.channel)) c.online = online.get(c.channel)!;
      }
    } else if (proxy.status === 401) {
      throw httpFailure('Hikvision channel list', proxy);
    }
    if (!list.length) {
      // A DVR or encoder with no IP-camera proxy list: its channels are the physical video inputs.
      const vi = await get('/ISAPI/System/Video/inputs/channels');
      if (vi.status === 401) throw httpFailure('Hikvision channel list', vi);
      if (vi.status === 200) list = blocks(vi.body, 'VideoInputChannel').map((b) => ({ channel: Number(textOf(b, 'id')), name: textOf(b, 'name'), online: null, address: null }));
    }
    return list.filter((c) => Number.isInteger(c.channel) && c.channel >= 1).sort((a, b) => a.channel - b.channel);
  },
};

// ---- Dahua (CGI) --------------------------------------------------------------------------------------------------
// rtsp://host:554/cam/realmonitor?channel=<n>&subtype=<0 main | 1 sub>

const kv = (body: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) m.set(line.slice(0, i).trim(), line.slice(i + 1).trim()); }
  return m;
};

export const dahuaSpec: VendorSpec = {
  kind: 'dahua',
  label: 'Dahua recorder or camera',
  description: 'Dahua cameras, NVRs and XVRs (and OEM brands on the same firmware). Stream addresses from the channel number; make, model and the channel list from the device\'s CGI interface. Analog cameras on an XVR are channels like any other.',
  matchesRtspUrl: (u) => /^\/cam\/realmonitor/i.test(u.pathname),
  parseRtspUrl(u) {
    const channel = Number(u.searchParams.get('channel')), sub = u.searchParams.get('subtype') ?? '0';
    return Number.isInteger(channel) && channel >= 1 ? { channel, stream: sub === '0' ? 'main' : 'sub' } : null;
  },
  rtspPath: (c, s) => `/cam/realmonitor?channel=${c}&subtype=${s === 'main' ? 0 : 1}`,
  snapshotPath: (c) => `/cgi-bin/snapshot.cgi?channel=${c}`,
  maxChannel: 1024,
  async deviceInfo(get) {
    const sys = await get('/cgi-bin/magicBox.cgi?action=getSystemInfo');
    if (sys.status !== 200) throw httpFailure('Dahua device information', sys);
    const s = kv(sys.body);
    const [vendor, ver] = await Promise.all([
      get('/cgi-bin/magicBox.cgi?action=getVendor').then((r) => (r.status === 200 ? kv(r.body).get('vendor') ?? null : null)).catch(() => null),
      get('/cgi-bin/magicBox.cgi?action=getSoftwareVersion').then((r) => (r.status === 200 ? kv(r.body).get('version') ?? null : null)).catch(() => null),
    ]);
    return { manufacturer: vendor, model: s.get('deviceType') ?? null, firmware: ver, serial: s.get('serialNumber') ?? null, hardwareId: s.get('hardwareVersion') ?? null };
  },
  async channels(get) {
    const r = await get('/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle');
    if (r.status !== 200) throw httpFailure('Dahua channel list', r);
    const names = new Map<number, string>();
    for (const [k, v] of kv(r.body)) { const m = k.match(/ChannelTitle\[(\d+)\]\.Name$/); if (m) names.set(Number(m[1]) + 1, v); }
    // Connection state only exists on recorders that front IP cameras; a camera or DVR just won't answer.
    const online = new Map<number, boolean>();
    const st = await get('/cgi-bin/LogicDeviceManager.cgi?action=getCameraState&uuid=Default').catch(() => null);
    if (st?.status === 200) {
      const m = kv(st.body), chan = new Map<string, number>();
      for (const [k, v] of m) { const x = k.match(/^states\[(\d+)\]\.Channel$/); if (x) chan.set(x[1], Number(v) + 1); }
      for (const [i, c] of chan) online.set(c, m.get(`states[${i}].ConnectionState`) === 'Connected');
    }
    return [...names].map(([channel, name]) => ({ channel, name, online: online.get(channel) ?? null, address: null })).sort((a, b) => a.channel - b.channel);
  },
};

function httpFailure(what: string, r: VendorReply): AdapterError {
  if (r.status === 401 || r.status === 403) return new AdapterError(`${what}: the device refused the login.`, 'device');
  return new AdapterError(`${what}: the device answered HTTP ${r.status}.`, 'device');
}

// ---- the adapter ---------------------------------------------------------------------------------------------------

interface Target { host: string; httpPort: number; https: boolean; rtspPort: number; channel: number; stream: VendorStream; creds?: Credentials }

const parseRtsp = (u?: string): URL | null => { try { return u && /^rtsp:\/\//i.test(u) ? new URL(u) : null; } catch { return null; } };
const bracket = (h: string) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h);

export function createVendorAdapter(spec: VendorSpec, deps: { http?: VendorHttp } = {}): SourceAdapter {
  const http = deps.http ?? makeVendorHttp();

  function target(ref: CameraRef, fallback?: Credentials): Target {
    const o = ref.options ?? {};
    const ru = parseRtsp(ref.url);
    const fromUrl = ru && spec.matchesRtspUrl(ru) ? spec.parseRtspUrl(ru) : null;
    if (ru && !fromUrl) throw new AdapterError(`'${ref.url ? ref.url.replace(/\/\/[^/@]*@/, '//***@') : ''}' is not a ${spec.label} stream address.`, 'bad_ref');
    const host = ru ? ru.hostname : ref.host;
    if (!host) throw new AdapterError(`Camera '${ref.id}' needs a host (or a ${spec.kind} rtsp:// URL).`, 'bad_ref');
    const https = o.https === true;
    const stream = o.stream === undefined ? fromUrl?.stream ?? 'main' : o.stream;
    if (stream !== 'main' && stream !== 'sub') throw new AdapterError("'options.stream' must be 'main' or 'sub'.", 'bad_ref');
    const creds = ref.credentials ?? (ru?.username ? { user: decodeURIComponent(ru.username), pass: decodeURIComponent(ru.password) } : fallback);
    return {
      host,
      httpPort: ref.port ?? (https ? 443 : 80),
      https,
      rtspPort: o.rtspPort !== undefined ? asInt(o.rtspPort, 'rtspPort', 1, 65535) : ru && ru.port ? Number(ru.port) : 554,
      channel: o.channel !== undefined ? asInt(o.channel, 'channel', 1, spec.maxChannel) : fromUrl?.channel ?? 1,
      stream,
      creds,
    };
  }

  const rtspUrl = (t: Target, stream: VendorStream) => withCredentials(`rtsp://${bracket(t.host)}:${t.rtspPort}${spec.rtspPath(t.channel, stream)}`, t.creds);
  const getter = (t: Target) => (path: string) => http(`${t.https ? 'https' : 'http'}://${bracket(t.host)}:${t.httpPort}${path}`, t.creds);

  return {
    kind: spec.kind,
    label: spec.label,
    description: spec.description,
    accepts(ref) {
      const u = parseRtsp(ref.url);
      return !!u && spec.matchesRtspUrl(u) && spec.parseRtspUrl(u) !== null;
    },
    async deviceInfo(ref) { return spec.deviceInfo(getter(target(ref))); },
    async channels(ref) { return spec.channels(getter(target(ref))); },
    async endpoints(ref): Promise<StreamEndpoint[]> {
      const t = target(ref);
      const base = `${t.https ? 'https' : 'http'}://${bracket(t.host)}:${t.httpPort}`;
      return [
        { protocol: 'rtsp', role: 'analysis', url: rtspUrl(t, 'main'), label: 'Main stream' },
        { protocol: 'rtsp', role: 'analysis', url: rtspUrl(t, 'sub'), label: 'Sub stream' },
        // Needs the device login (Digest); deliberately without it in the address so it can be shown and stored.
        { protocol: 'snapshot', role: 'snapshot', url: `${base}${spec.snapshotPath(t.channel, t.stream)}`, label: 'Snapshot (login required)' },
      ];
    },
    async probe(ref, opts) {
      const t = target(ref, opts?.credentials);
      return probeUrl(ref, rtspUrl(t, t.stream), { rtsp: true, sampleSec: opts?.sampleSec, secrets: t.creds ? [t.creds.pass] : [], site: ref.site ?? spec.kind });
    },
  };
}

export const createHikvisionAdapter = (deps?: { http?: VendorHttp }) => createVendorAdapter(hikvisionSpec, deps);
export const createDahuaAdapter = (deps?: { http?: VendorHttp }) => createVendorAdapter(dahuaSpec, deps);
