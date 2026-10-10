/** ONVIF cameras and recorders: find them on the network, ask them for their streams, then probe like any other RTSP source. */
import dgram from 'node:dgram';
import {
  DISCOVERY_ADDRESS, DISCOVERY_PORT, OnvifFault, assertNoFault, authorizationFor, dedupeDevices, discoveryProbe, envelope, fixStreamHost, parseAuthChallenge,
  parseClockOffset, parseDeviceInformation, parseMediaXAddr, parseProbeMatch, parseProfiles, parseStreamUri, rankProfiles, requests, securityHeader, withAuthority, withHost,
} from './onvifProtocol';
import { probeUrl, withCredentials } from './probeUrl';
import { PROBE_VERSION, type ProbeReport } from '../cameraProfile';
import { AdapterError, type CameraRef, type Credentials, type DeviceInfo, type DiscoveredDevice, type DiscoverOptions, type SourceAdapter, type StreamEndpoint } from './types';

export interface SoapReply { status: number; body: string; /** The WWW-Authenticate header of a 401, if any. */ wwwAuthenticate?: string }
export type SoapPost = (url: string, xml: string, headers?: Record<string, string>) => Promise<SoapReply>;

/** Sends one datagram to the discovery group and returns every reply that arrives within the time limit. */
export type DiscoveryTransport = (message: string, o: { timeoutMs: number; iface?: string; target?: { address: string; port: number } }) => Promise<Array<{ address: string; body: string }>>;

export function makeFetchSoap(timeoutMs = 8000): SoapPost {
  return async (url, xml, headers) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', ...headers }, body: xml, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.text(), wwwAuthenticate: r.headers.get('www-authenticate') ?? undefined };
  };
}
export const fetchSoap = makeFetchSoap();

export const udpDiscovery: DiscoveryTransport = (message, o) => new Promise((resolve, reject) => {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const replies: Array<{ address: string; body: string }> = [];
  let timer: NodeJS.Timeout | undefined;
  const finish = () => { clearTimeout(timer); try { sock.close(); } catch { /* already closed */ } resolve(replies); };
  sock.on('message', (buf, rinfo) => replies.push({ address: rinfo.address, body: buf.toString('utf8') }));
  sock.on('error', (e) => { clearTimeout(timer); try { sock.close(); } catch { /* ignore */ } reject(e); });
  sock.bind(0, o.iface, () => {
    sock.send(message, o.target?.port ?? DISCOVERY_PORT, o.target?.address ?? DISCOVERY_ADDRESS, (err) => { if (err) { clearTimeout(timer); try { sock.close(); } catch { /* ignore */ } reject(err); } });
    timer = setTimeout(finish, o.timeoutMs);
  });
});

export interface OnvifDeps {
  post?: SoapPost;
  discoveryTransport?: DiscoveryTransport;
  now?: () => Date;
  /** Per-request time limit of the default HTTP client. */
  requestTimeoutMs?: number;
  /** Where discovery probes go instead of the multicast group (tests). */
  discoveryTarget?: { address: string; port: number };
}

function deviceServiceUrl(ref: CameraRef): string {
  if (ref.url && /^https?:\/\//i.test(ref.url)) return ref.url;
  if (ref.host) return `http://${ref.host}:${ref.port ?? 80}/onvif/device_service`;
  throw new AdapterError(`Camera '${ref.id}' needs an ONVIF address (url, or host and port).`, 'bad_ref');
}

/** What a caller of endpoints() or deviceInfo() should see: a clear AdapterError rather than a protocol or network exception. */
function translate(e: unknown): never {
  if (e instanceof AdapterError) throw e;
  if (e instanceof OnvifFault) throw new AdapterError(e.kind === 'auth' ? 'The device rejected the login' : `The device answered with an error: ${e.message}`, 'device');
  const err = e as { cause?: { code?: string }; message?: string };
  throw new AdapterError(`Could not reach the device: ${err.cause?.code ?? err.message ?? String(e)}`, 'device');
}

/** A failure to reach or talk to the device at all, as opposed to the device answering with a refusal. */
const isNetworkError = (e: unknown) => !(e instanceof OnvifFault) && !(e instanceof AdapterError);

/**
 * One SOAP call to an ONVIF service, shared by the adapter and the events connector. Two logins are supported, because devices differ:
 * the WS-Security header is sent every time (and the camera's clock is followed, since digest logins fail when the clocks differ), and when
 * the device answers 401 with a Digest or Basic challenge the request is repeated with that login. `extraHeader` adds SOAP header
 * elements (WS-Addressing, for a subscription).
 */
export function createSoapCaller(post: SoapPost, now: () => Date) {
  const offsets = new Map<string, number>();
  return async function call(url: string, bodyXml: string, cred: Credentials | undefined, extraHeader = ''): Promise<string> {
    let header = extraHeader;
    if (cred?.user) {
      const host = new URL(url).host;
      if (!offsets.has(host)) {
        let off = 0;
        try { const r = await post(url, requests.systemDateAndTime()); off = parseClockOffset(r.body, now()) ?? 0; } catch { /* use our own clock */ }
        offsets.set(host, off);
      }
      header += securityHeader(cred.user, cred.pass, { now: now(), clockOffsetMs: offsets.get(host) });
    }
    const xml = envelope(bodyXml, header);
    let r = await post(url, xml);
    if (r.status === 401 && cred?.user && r.wwwAuthenticate) {
      const ch = parseAuthChallenge(r.wwwAuthenticate);
      const u = new URL(url);
      const auth = ch ? authorizationFor(ch, { method: 'POST', uri: u.pathname + u.search, user: cred.user, pass: cred.pass }) : null;
      if (auth) r = await post(url, xml, { Authorization: auth });
    }
    if (r.status === 401) throw new OnvifFault('The device rejected the login', 'auth');
    assertNoFault(r.body);
    if (r.status >= 400) throw new OnvifFault(`HTTP ${r.status}`, 'other');
    return r.body;
  };
}

export function createOnvifAdapter(deps: OnvifDeps = {}): SourceAdapter {
  const post = deps.post ?? makeFetchSoap(deps.requestTimeoutMs);
  const now = deps.now ?? (() => new Date());
  const call = createSoapCaller(post, now);

  /** The Media service address the device announces. Falls back to the usual path when it does not say or does not support the call. */
  async function mediaService(device: string, cred: Credentials | undefined): Promise<string> {
    try {
      const x = parseMediaXAddr(await call(device, requests.capabilities(), cred));
      if (x) return fixStreamHost(x, new URL(device).hostname);
    } catch (e) { if (e instanceof OnvifFault && e.kind === 'auth') throw e; if (isNetworkError(e)) throw e; /* a fault or HTTP error: use the usual path */ }
    return new URL('/onvif/media_service', device).toString();
  }

  async function streams(ref: CameraRef, cred: Credentials | undefined): Promise<StreamEndpoint[]> {
    const device = deviceServiceUrl(ref);
    const reached = new URL(device).hostname;
    let media = await mediaService(device, cred);
    let profilesXml: string;
    try { profilesXml = await call(media, requests.profiles(), cred); }
    catch (e) {
      // A device behind NAT or an NVR may announce an internal address for its media service; use the address we reached it on.
      if (isNetworkError(e) && new URL(media).host !== new URL(device).host) { media = withAuthority(media, new URL(device).host); profilesXml = await call(media, requests.profiles(), cred); }
      else throw e;
    }
    const profiles = rankProfiles(parseProfiles(profilesXml));
    if (profiles.length === 0) throw new AdapterError('The device lists no media profiles.', 'device');
    const wanted = typeof ref.options?.profile === 'string' ? profiles.filter((p) => p.token === ref.options!.profile) : profiles;
    if (wanted.length === 0) throw new AdapterError(`The device has no profile '${String(ref.options?.profile)}'. It offers: ${profiles.map((p) => p.token).join(', ')}.`, 'bad_ref');
    const out: StreamEndpoint[] = [];
    let lastFault: OnvifFault | null = null;
    for (const p of wanted) {
      let uri: string | null;
      try { uri = parseStreamUri(await call(media, requests.streamUri(p.token), cred)); }
      catch (e) { if (e instanceof OnvifFault && e.kind === 'other') { lastFault = e; continue; } throw e; } // one bad profile does not hide the others
      if (!uri || !/^rtsps?:\/\//i.test(uri)) continue;
      out.push({ protocol: 'rtsp', role: 'analysis', url: withCredentials(fixStreamHost(uri, reached), cred), label: p.name ?? p.token, width: p.width, height: p.height, codec: p.codec });
    }
    if (out.length === 0) throw new AdapterError(lastFault ? `The device would not give a stream address: ${lastFault.message}` : 'The device gave no stream address for any profile.', 'device');
    return out;
  }

  return {
    kind: 'onvif',
    label: 'ONVIF (Profile S / T)',
    description: 'Cameras and recorders that speak ONVIF. Found by WS-Discovery on the local network; streams are read from the device, then probed over RTSP.',
    accepts: (ref) => /^https?:\/\/.*onvif/i.test(ref.url ?? ''),

    async discover(opts: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
      const transport = deps.discoveryTransport ?? udpDiscovery;
      const replies = await transport(discoveryProbe(), { timeoutMs: opts.timeoutMs ?? 3000, iface: opts.iface, target: deps.discoveryTarget });
      const found: DiscoveredDevice[] = [];
      for (const r of replies) { const d = parseProbeMatch(r.body, r.address); if (d) found.push(d); }
      return dedupeDevices(found);
    },

    async deviceInfo(ref): Promise<DeviceInfo> {
      try { return parseDeviceInformation(await call(deviceServiceUrl(ref), requests.deviceInformation(), ref.credentials)); }
      catch (e) { return translate(e); }
    },

    endpoints: async (ref) => { try { return await streams(ref, ref.credentials); } catch (e) { return translate(e); } },

    async probe(ref, opts): Promise<ProbeReport> {
      const cred = ref.credentials ?? opts?.credentials;
      const site = ref.site ?? 'onvif';
      const failed = (failure: ProbeReport['failure'], detail: string, reachable: boolean): ProbeReport => ({
        cameraId: ref.id, site, transport: 'tcp', probedAt: new Date().toISOString(), probeVersion: PROBE_VERSION,
        reachable, failure, failureDetail: detail, describe: null, sample: null, whep: null, flags: [],
      });
      let eps: StreamEndpoint[];
      try { eps = await streams(ref, cred); }
      catch (e) {
        if (e instanceof OnvifFault && e.kind === 'auth') return failed('bad_credentials', 'The device rejected the ONVIF login', true);
        if (e instanceof AdapterError && e.code === 'bad_ref') throw e;
        if (e instanceof AdapterError || e instanceof OnvifFault) return failed('no_describe', e.message, true);
        const err = e as { cause?: { code?: string }; message?: string };
        return failed('unreachable', `ONVIF service: ${err.cause?.code ?? err.message ?? String(e)}`, false);
      }
      const reached = new URL(deviceServiceUrl(ref)).hostname;
      const secrets = cred ? [cred.pass] : [];
      let used = eps[0];
      let report = await probeUrl(ref, used.url, { rtsp: true, sampleSec: opts?.sampleSec, secrets, site });
      // The camera may name an address only it can use (internal, or behind NAT). Try the address we reached it on.
      const streamHost = new URL(used.url).hostname;
      if (report.failure && report.failure !== 'bad_credentials' && streamHost !== reached) {
        const retry = await probeUrl(ref, withHost(used.url, reached), { rtsp: true, sampleSec: opts?.sampleSec, secrets, site });
        if (!retry.failure) { report = retry; report.notes = [...(report.notes ?? []), `the stream address the camera gave (${streamHost}) was unreachable; ${reached} was used`]; }
      }
      report.notes = [...(report.notes ?? []), `ONVIF profile '${used.label}' (${eps.length} offered)`];
      return report;
    },
  };
}
