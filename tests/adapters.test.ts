import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAdapterRegistry, AdapterError, redactUrl, createDefaultAdapters } from '../server/adapters/index.ts';
import { createOnvifAdapter, type SoapPost } from '../server/adapters/onvif.ts';
import { directRtspAdapter } from '../server/adapters/directRtsp.ts';
import { httpStreamAdapter, httpProtocol } from '../server/adapters/httpStream.ts';
import { withCredentials } from '../server/adapters/probeUrl.ts';
import {
  assertNoFault, dedupeDevices, discoveryProbe, fixStreamHost, parseClockOffset, parseProbeMatch, parseProfiles, parseStreamUri, rankProfiles,
  securityHeader, OnvifFault,
} from '../server/adapters/onvifProtocol.ts';

const probeMatch = (xaddrs: string, scopes: string) => `<?xml version="1.0"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch>
<wsa:EndpointReference xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"><wsa:Address>urn:uuid:1</wsa:Address></wsa:EndpointReference>
<d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>${scopes}</d:Scopes><d:XAddrs>${xaddrs}</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion>
</d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const PROFILES = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body><trt:GetProfilesResponse xmlns:trt="x" xmlns:tt="y">
<trt:Profiles token="sub" fixed="true"><tt:Name>SubStream</tt:Name><tt:VideoEncoderConfiguration token="v2"><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>
<trt:Profiles token="main" fixed="true"><tt:Name>MainStream</tt:Name><tt:VideoEncoderConfiguration token="v1"><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>
<trt:Profiles token="mj"><tt:Name>Mjpeg</tt:Name><tt:VideoEncoderConfiguration token="v3"><tt:Encoding>JPEG</tt:Encoding><tt:Resolution><tt:Width>3840</tt:Width><tt:Height>2160</tt:Height></tt:Resolution></tt:VideoEncoderConfiguration></trt:Profiles>
</trt:GetProfilesResponse></env:Body></env:Envelope>`;

const uriReply = (uri: string) => `<s:Envelope xmlns:s="x"><s:Body><trt:GetStreamUriResponse xmlns:trt="x" xmlns:tt="y"><trt:MediaUri><tt:Uri>${uri}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect></trt:MediaUri></trt:GetStreamUriResponse></s:Body></s:Envelope>`;

const CAPS = `<s:Envelope xmlns:s="x"><s:Body><tds:GetCapabilitiesResponse xmlns:tds="x" xmlns:tt="y"><tds:Capabilities><tt:Media><tt:XAddr>http://10.0.0.5/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse></s:Body></s:Envelope>`;
const TIME = `<s:Envelope xmlns:s="x"><s:Body><tds:GetSystemDateAndTimeResponse xmlns:tds="x" xmlns:tt="y"><tds:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>12</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>30</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>10</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse></s:Body></s:Envelope>`;
const AUTH_FAULT = `<s:Envelope xmlns:s="x"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">Sender not authorized</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;

/** A fake camera: answers by the operation named in the request body. */
function fakeCamera(opts: { auth?: boolean; uri?: string } = {}): { post: SoapPost; calls: string[]; bodies: string[] } {
  const calls: string[] = [], bodies: string[] = [];
  const post: SoapPost = async (_url, xml) => {
    bodies.push(xml);
    const op = (xml.match(/<(?:tds|trt):(Get\w+)/) ?? [])[1] ?? '';
    calls.push(op);
    if (op === 'GetSystemDateAndTime') return { status: 200, body: TIME };
    if (opts.auth && !xml.includes('UsernameToken')) return { status: 400, body: AUTH_FAULT };
    if (op === 'GetCapabilities') return { status: 200, body: CAPS };
    if (op === 'GetProfiles') return { status: 200, body: PROFILES };
    if (op === 'GetStreamUri') {
      const token = xml.match(/<trt:ProfileToken>([^<]*)</)![1];
      return { status: 200, body: uriReply((opts.uri ?? 'rtsp://0.0.0.0:554/stream/{t}').replace('{t}', token)) };
    }
    if (op === 'GetDeviceInformation') return { status: 200, body: '<r><tds:Manufacturer>Acme</tds:Manufacturer><tds:Model>X1</tds:Model><tds:FirmwareVersion>2.3</tds:FirmwareVersion><tds:SerialNumber>S9</tds:SerialNumber><tds:HardwareId>H1</tds:HardwareId></r>' };
    return { status: 500, body: '' };
  };
  return { post, calls, bodies };
}

// ---- registry -----------------------------------------------------------------------------------------------------

test('registry resolves by name, then by what an adapter accepts, and rejects duplicates', () => {
  const r = createDefaultAdapters();
  assert.deepEqual(r.list().map((a) => a.kind), ['onvif', 'hikvision', 'dahua', 'rtsp', 'http']);
  assert.equal(r.resolve({ id: 'a', url: 'rtsp://h/x' }).kind, 'rtsp');
  assert.equal(r.resolve({ id: 'a', url: 'http://h/live/index.m3u8' }).kind, 'http');
  assert.equal(r.resolve({ id: 'a', url: 'http://10.0.0.5/onvif/device_service' }).kind, 'onvif');
  assert.equal(r.resolve({ id: 'a', adapter: 'onvif', host: '10.0.0.5' }).kind, 'onvif');
  assert.throws(() => r.resolve({ id: 'a', adapter: 'nope' }), (e) => e instanceof AdapterError && e.code === 'no_adapter');
  assert.throws(() => r.resolve({ id: 'a' }), AdapterError);
  assert.throws(() => createAdapterRegistry([directRtspAdapter, directRtspAdapter]), /already registered/);
});

test('a source type is added by registering one object', async () => {
  const r = createAdapterRegistry();
  r.register({
    kind: 'fake', label: 'Fake', description: 'test', accepts: (ref) => ref.id.startsWith('fake-'),
    endpoints: async () => [{ protocol: 'hls', role: 'browser', url: 'http://x/y.m3u8' }],
    probe: async () => { throw new Error('unused'); },
  });
  assert.equal(r.resolve({ id: 'fake-1' }).kind, 'fake');
  assert.equal((await r.resolve({ id: 'fake-1' }).endpoints({ id: 'fake-1' }))[0].protocol, 'hls');
});

test('urls: credentials are added once and removed for logs', () => {
  assert.equal(withCredentials('rtsp://h:554/s', { user: 'a', pass: 'p w' }), 'rtsp://a:p%20w@h:554/s');
  assert.equal(withCredentials('rtsp://u:q@h/s', { user: 'a', pass: 'p' }), 'rtsp://u:q@h/s');
  assert.equal(withCredentials('rtsp://h/s', undefined), 'rtsp://h/s');
  assert.equal(redactUrl('rtsp://a:secret@h:554/s'), 'rtsp://***@h:554/s');
  assert.equal(httpProtocol('http://h/a/index.m3u8?x=1'), 'hls');
  assert.equal(httpProtocol('http://h/cam/mjpeg'), 'mjpeg');
  assert.equal(httpProtocol('http://h/snap.jpg'), 'snapshot');
  assert.equal(httpProtocol('ftp://h/x'), null);
});

test('direct RTSP and HTTP adapters list one endpoint and refuse the wrong kind of address', async () => {
  const eps = await directRtspAdapter.endpoints({ id: 'c', url: 'rtsp://h/s', credentials: { user: 'u', pass: 'p' } });
  assert.deepEqual(eps.map((e) => [e.protocol, e.role, e.url]), [['rtsp', 'analysis', 'rtsp://u:p@h/s']]);
  await assert.rejects(directRtspAdapter.endpoints({ id: 'c', url: 'http://h' }), AdapterError);
  const h = await httpStreamAdapter.endpoints({ id: 'c', url: 'http://h/i.m3u8' });
  assert.deepEqual(h.map((e) => [e.protocol, e.role]), [['hls', 'browser']]);
});

// ---- ONVIF protocol -----------------------------------------------------------------------------------------------

test('WS-Discovery: probe asks for video transmitters; replies yield service URLs and scope details', () => {
  assert.match(discoveryProbe('uuid:1'), /NetworkVideoTransmitter/);
  const d = parseProbeMatch(probeMatch('http://10.0.0.5/onvif/device_service http://[fe80::1]/onvif/device_service',
    'onvif://www.onvif.org/name/Gate%20Cam onvif://www.onvif.org/hardware/DS-2CD onvif://www.onvif.org/location/country/india'), '10.0.0.5')!;
  assert.equal(d.name, 'Gate Cam');
  assert.equal(d.hardware, 'DS-2CD');
  assert.equal(d.serviceUrls.length, 2);
  assert.equal(parseProbeMatch('<x>no match</x>', '1.1.1.1'), null);
  assert.equal(parseProbeMatch(probeMatch('', ''), '1.1.1.1'), null);
  assert.equal(dedupeDevices([d, d, { ...d, address: '10.0.0.6' }]).length, 2);
});

test('WS-Security digest matches the definition: base64(sha1(nonce + created + password))', () => {
  const nonce = Buffer.from('0123456789abcdef');
  const now = new Date('2026-10-10T12:00:00.000Z');
  const h = securityHeader('admin', 'p&ss', { now, nonce });
  const expected = createHash('sha1').update(Buffer.concat([nonce, Buffer.from('2026-10-10T12:00:00Z'), Buffer.from('p&ss')])).digest('base64');
  assert.ok(h.includes(`>${expected}</Password>`));
  assert.ok(h.includes(nonce.toString('base64')));
  assert.ok(h.includes('<Username>admin</Username>'));
  assert.ok(!h.includes('p&ss'), 'the password is never sent as text');
  // a camera clock 90 s ahead is followed
  assert.ok(securityHeader('a', 'b', { now, nonce, clockOffsetMs: 90_000 }).includes('2026-10-10T12:01:30Z'));
});

test('replies: clock, profiles, stream address, faults', () => {
  assert.equal(parseClockOffset(TIME, new Date('2026-10-10T12:00:00Z')), 30_000);
  assert.equal(parseClockOffset('<x/>'), null);
  const ps = parseProfiles(PROFILES);
  assert.deepEqual(ps.map((p) => [p.token, p.codec, p.width, p.height]), [['sub', 'h264', 640, 360], ['main', 'h265', 2560, 1440], ['mj', 'jpeg', 3840, 2160]]);
  assert.deepEqual(rankProfiles(ps).map((p) => p.token), ['main', 'sub', 'mj'], 'largest real video first, MJPEG last');
  assert.equal(parseStreamUri(uriReply('rtsp://h/a?b=1&amp;c=2')), 'rtsp://h/a?b=1&c=2');
  assert.equal(fixStreamHost('rtsp://0.0.0.0:554/s', '10.0.0.5'), 'rtsp://10.0.0.5:554/s');
  assert.equal(fixStreamHost('rtsp://10.9.9.9:554/s', '10.0.0.5'), 'rtsp://10.9.9.9:554/s');
  assert.throws(() => assertNoFault(AUTH_FAULT), (e) => e instanceof OnvifFault && e.kind === 'auth');
  assert.doesNotThrow(() => assertNoFault(PROFILES));
});

// ---- ONVIF adapter ------------------------------------------------------------------------------------------------

test('ONVIF adapter: reads profiles, asks for each stream address, best profile first, host fixed, login added', async () => {
  const cam = fakeCamera();
  const a = createOnvifAdapter({ post: cam.post });
  const eps = await a.endpoints({ id: 'c1', host: '10.0.0.5', credentials: { user: 'admin', pass: 'pw' } });
  assert.deepEqual(eps.map((e) => [e.label, e.codec, e.width]), [['MainStream', 'h265', 2560], ['SubStream', 'h264', 640], ['Mjpeg', 'jpeg', 3840]]);
  assert.equal(eps[0].url, 'rtsp://admin:pw@10.0.0.5:554/stream/main');
  assert.ok(cam.calls.includes('GetCapabilities') && cam.calls.includes('GetProfiles'));
  assert.equal(cam.calls.filter((c) => c === 'GetSystemDateAndTime').length, 1, 'the clock is read once per device');
  const only = await a.endpoints({ id: 'c1', host: '10.0.0.5', options: { profile: 'sub' } });
  assert.deepEqual(only.map((e) => e.label), ['SubStream']);
  assert.equal(only[0].url, 'rtsp://10.0.0.5:554/stream/sub');
});

test('ONVIF adapter: a device that wants a login and gets none (or a wrong one) is a credentials problem, not a crash', async () => {
  const a = createOnvifAdapter({ post: fakeCamera({ auth: true }).post });
  const r = await a.probe({ id: 'c1', host: '10.0.0.5' });
  assert.equal(r.failure, 'bad_credentials');
  assert.equal(r.reachable, true);
  assert.equal(r.site, 'onvif');
  assert.equal(r.sample, null);
  const info = await a.deviceInfo!({ id: 'c1', host: '10.0.0.5', credentials: { user: 'u', pass: 'p' } });
  assert.deepEqual(info, { manufacturer: 'Acme', model: 'X1', firmware: '2.3', serial: 'S9', hardwareId: 'H1' });
});

test('ONVIF adapter: an unreachable device is reported as unreachable; a missing address is an error for the caller', async () => {
  const a = createOnvifAdapter({ post: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  const r = await a.probe({ id: 'c1', host: '10.0.0.9', site: 'north' });
  assert.equal(r.failure, 'unreachable');
  assert.equal(r.reachable, false);
  assert.equal(r.site, 'north');
  assert.match(r.failureDetail!, /ECONNREFUSED/);
  await assert.rejects(a.probe({ id: 'x' }), (e) => e instanceof AdapterError && e.code === 'bad_ref');
});

test('ONVIF adapter: discovery collapses repeats and ignores noise', async () => {
  const m = probeMatch('http://10.0.0.5/onvif/device_service', 'onvif://www.onvif.org/name/A');
  const a = createOnvifAdapter({ discoveryTransport: async () => [
    { address: '10.0.0.5', body: m }, { address: '10.0.0.5', body: m }, { address: '10.0.0.7', body: 'garbage' },
    { address: '10.0.0.6', body: probeMatch('http://10.0.0.6/onvif/device_service', 'onvif://www.onvif.org/name/B') },
  ] });
  const found = await a.discover!();
  assert.deepEqual(found.map((d) => [d.address, d.name]), [['10.0.0.5', 'A'], ['10.0.0.6', 'B']]);
});
