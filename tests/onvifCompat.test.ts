/**
 * ONVIF compatibility without a camera: the adapter is run against a fake device (tests/lab/fakeOnvif.ts) over real HTTP and
 * UDP, across the combinations of login method, XML style, capability behaviour, clock error and fault style found in the field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnvifAdapter, udpDiscovery, type SoapPost, makeFetchSoap } from '../server/adapters/onvif.ts';
import { AdapterError } from '../server/adapters/index.ts';
import { withCredentials } from '../server/adapters/probeUrl.ts';
import { authorizationFor, discoveryProbe, fixStreamHost, parseAuthChallenge, securityHeader, withHost } from '../server/adapters/onvifProtocol.ts';
import { startFakeDiscovery, startFakeOnvif, type FakeOnvifOptions } from './lab/fakeOnvif.ts';

const CRED = { user: 'admin', pass: 'p@ss:w/rd #1' };
const HOUR = 3_600_000;

async function withDevice(o: FakeOnvifOptions, run: (url: string, dev: Awaited<ReturnType<typeof startFakeOnvif>>) => Promise<void>) {
  const dev = await startFakeOnvif({ user: CRED.user, pass: CRED.pass, ...o });
  try { await run(dev.url, dev); } finally { await dev.close(); }
}

// ---- the matrix ---------------------------------------------------------------------------------------------------

const auths = ['none', 'wsse', 'http-digest', 'http-basic', 'either'] as const;
const prefixes = ['standard', 'odd', 'none'] as const;
const caps = ['ok', 'fault', 'empty'] as const;
const skews = [0, 2 * HOUR, -3 * HOUR];

test('matrix: every login method x XML style x capability behaviour x clock error gives the same streams', async () => {
  let combos = 0;
  for (const auth of auths) for (const prefix of prefixes) for (const capabilities of caps) for (const clockSkewMs of skews) {
    const label = `auth=${auth} prefixes=${prefix} caps=${capabilities} skew=${clockSkewMs / HOUR}h`;
    await withDevice({ auth, prefixes: prefix, capabilities, clockSkewMs, faultStatus: combos % 3 === 0 ? 500 : combos % 3 === 1 ? 400 : 200 }, async (url, dev) => {
      const a = createOnvifAdapter({ requestTimeoutMs: 3000 });
      const eps = await a.endpoints({ id: 'c', url, credentials: CRED });
      assert.deepEqual(eps.map((e) => e.label), ['MainStream', 'SubStream'], label);
      assert.equal(eps[0].width, 1920, label);
      const u = new URL(eps[0].url);
      assert.equal(u.hostname, '127.0.0.1', `${label}: 0.0.0.0 is replaced by the address the device was reached on`);
      assert.equal(decodeURIComponent(u.password), CRED.pass, label);
      assert.equal(u.username, 'admin', label);
      if (auth === 'http-digest' || auth === 'http-basic') assert.ok(dev.seen.some((s) => s.httpAuth), `${label}: the HTTP challenge was answered`);
      if (auth === 'none') assert.ok(dev.seen.every((s) => !s.httpAuth), label);
    });
    combos++;
  }
  assert.equal(combos, 135);
});

test('matrix: a media address on an unreachable internal network falls back to the address the device was reached on', async () => {
  for (const auth of ['none', 'wsse', 'http-digest'] as const) {
    await withDevice({ auth, capabilities: 'internal' }, async (url) => {
      const a = createOnvifAdapter({ requestTimeoutMs: 800 });
      const eps = await a.endpoints({ id: 'c', url, credentials: CRED });
      assert.equal(eps.length, 2, auth);
    });
  }
});

// ---- logins -------------------------------------------------------------------------------------------------------

test('logins: wrong password, no password and a wrong user are credential problems under every method', async () => {
  for (const auth of ['wsse', 'http-digest', 'http-basic', 'either'] as const) {
    await withDevice({ auth }, async (url) => {
      const a = createOnvifAdapter({ requestTimeoutMs: 3000 });
      for (const [what, credentials] of [['wrong password', { user: CRED.user, pass: 'nope' }], ['wrong user', { user: 'root', pass: CRED.pass }], ['no login', undefined]] as const) {
        const r = await a.probe({ id: 'c', url, credentials });
        assert.equal(r.failure, 'bad_credentials', `${auth}: ${what}`);
        assert.equal(r.reachable, true);
        assert.ok(!JSON.stringify(r).includes(CRED.pass));
      }
    });
  }
});

test('logins: the camera clock is what makes WS-Security work when it is hours off', async () => {
  await withDevice({ auth: 'wsse', clockSkewMs: 2 * HOUR }, async (url) => {
    // control: if the clock cannot be read, the login is refused
    const blind: SoapPost = async (u, xml, h) => (xml.includes('GetSystemDateAndTime') ? Promise.reject(new Error('blocked')) : makeFetchSoap(3000)(u, xml, h));
    const bad = await createOnvifAdapter({ post: blind }).probe({ id: 'c', url, credentials: CRED });
    assert.equal(bad.failure, 'bad_credentials');
    // with the clock read, it works
    const eps = await createOnvifAdapter({ requestTimeoutMs: 3000 }).endpoints({ id: 'c', url, credentials: CRED });
    assert.equal(eps.length, 2);
  });
});

test('logins: the clock is read once per device, not once per call', async () => {
  await withDevice({ auth: 'wsse' }, async (url, dev) => {
    await createOnvifAdapter({ requestTimeoutMs: 3000 }).endpoints({ id: 'c', url, credentials: CRED });
    assert.equal(dev.calls.filter((c) => c === 'GetSystemDateAndTime').length, 1);
    assert.equal(dev.calls.filter((c) => c === 'GetStreamUri').length, 2);
  });
});

test('HTTP Digest: the RFC 2617 example, SHA-256, basic, and refusals', () => {
  const ch = parseAuthChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
  assert.equal(ch.scheme, 'digest');
  const h = authorizationFor(ch, { method: 'GET', uri: '/dir/index.html', user: 'Mufasa', pass: 'Circle Of Life', cnonce: '0a4f113b', nc: 1 })!;
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  assert.match(authorizationFor(parseAuthChallenge('Digest realm="r", nonce="n", algorithm=SHA-256, qop="auth"')!, { method: 'POST', uri: '/x', user: 'u', pass: 'p', cnonce: 'c' })!, /algorithm=SHA-256/);
  assert.equal(authorizationFor(parseAuthChallenge('Basic realm="r"')!, { method: 'POST', uri: '/', user: 'u', pass: 'p' }), 'Basic dTpw');
  assert.equal(authorizationFor(parseAuthChallenge('Digest realm="r", nonce="n", algorithm=WEIRD')!, { method: 'POST', uri: '/', user: 'u', pass: 'p' }), null);
  assert.equal(authorizationFor(parseAuthChallenge('Digest realm="r"')!, { method: 'POST', uri: '/', user: 'u', pass: 'p' }), null);
  assert.equal(parseAuthChallenge('Negotiate abc'), null);
});

test('login text is escaped in XML so a password or user with markup cannot break the request', () => {
  const h = securityHeader('a<b>&"x', 'p', { now: new Date('2026-01-01T00:00:00Z'), nonce: Buffer.alloc(4) });
  assert.match(h, /<Username>a&lt;b&gt;&amp;&quot;x<\/Username>/);
});

// ---- what the device lists ----------------------------------------------------------------------------------------

test('profiles: ordering, missing video config, empty and fault answers', async () => {
  await withDevice({ profiles: [
    { token: 'a', name: 'Audio only', codec: null },
    { token: 'm', name: 'Mjpeg 4K', codec: 'JPEG', width: 3840, height: 2160 },
    { token: 'h', name: 'H265 1440p', codec: 'H265', width: 2560, height: 1440 },
    { token: 's', name: 'Sub', codec: 'H264', width: 640, height: 360 },
  ] }, async (url) => {
    const eps = await createOnvifAdapter().endpoints({ id: 'c', url });
    assert.deepEqual(eps.map((e) => e.label), ['H265 1440p', 'Sub', 'Mjpeg 4K', 'Audio only']);
    const only = await createOnvifAdapter().endpoints({ id: 'c', url, options: { profile: 's' } });
    assert.deepEqual(only.map((e) => e.label), ['Sub']);
    await assert.rejects(createOnvifAdapter().endpoints({ id: 'c', url, options: { profile: 'zzz' } }), (e) => e instanceof AdapterError && e.code === 'bad_ref' && /offers: h, s, m, a/.test(e.message));
  });
  await withDevice({ profiles: [] }, async (url) => {
    const r = await createOnvifAdapter().probe({ id: 'c', url });
    assert.equal(r.failure, 'no_describe');
    assert.match(r.failureDetail!, /no media profiles/);
  });
});

test('stream addresses: a bad profile does not hide the good ones; none at all is explained', async () => {
  await withDevice({ profiles: [
    { token: 'a', name: 'broken', uri: 'fault' }, { token: 'b', name: 'empty', uri: null },
    { token: 'c', name: 'http', uri: 'http://x/y' }, { token: 'd', name: 'good', uri: 'rtsp://10.1.1.1:8554/s?x=1&y=2' }, { token: 'e', name: 'tls', uri: 'rtsps://cam.local/s' },
  ] }, async (url) => {
    const eps = await createOnvifAdapter().endpoints({ id: 'c', url });
    assert.deepEqual(eps.map((e) => e.label).sort(), ['good', 'tls']);
    assert.equal(eps.find((e) => e.label === 'good')!.url, 'rtsp://10.1.1.1:8554/s?x=1&y=2', 'XML entities in the address are decoded');
  });
  await withDevice({ profiles: [{ token: 'a', name: 'broken', uri: 'fault' }] }, async (url) => {
    const r = await createOnvifAdapter().probe({ id: 'c', url });
    assert.equal(r.failure, 'no_describe');
    assert.match(r.failureDetail!, /would not give a stream address: Stream not available/);
  });
  await withDevice({ profiles: [{ token: 'a', name: 'empty', uri: null }] }, async (url) => {
    assert.match((await createOnvifAdapter().probe({ id: 'c', url })).failureDetail!, /no stream address for any profile/);
  });
});

test('stream addresses: a login already in the address is kept; the camera login is added otherwise; odd passwords survive', async () => {
  await withDevice({ profiles: [{ token: 'a', name: 'has login', uri: 'rtsp://u:q@h/s' }, { token: 'b', name: 'none', uri: 'rtsp://h/s' }] }, async (url) => {
    const eps = await createOnvifAdapter().endpoints({ id: 'c', url, credentials: CRED });
    assert.equal(eps.find((e) => e.label === 'has login')!.url, 'rtsp://u:q@h/s');
    const u = new URL(eps.find((e) => e.label === 'none')!.url);
    assert.equal(decodeURIComponent(u.password), CRED.pass);
  });
  for (const pass of ['p@ss', 'a:b', 'x/y', 'sp ace', 'ünï©ode', '100%', 'q?x#y', '"quoted"', "it's"]) {
    const u = new URL(withCredentials('rtsp://cam.local:554/s', { user: 'us er', pass }));
    assert.equal(decodeURIComponent(u.username), 'us er');
    assert.equal(decodeURIComponent(u.password), pass, pass);
    assert.equal(u.hostname, 'cam.local');
    assert.equal(u.pathname, '/s');
  }
});

test('host handling: 0.0.0.0 and loopback are replaced, IPv6 and ports survive', () => {
  assert.equal(fixStreamHost('rtsp://0.0.0.0:8554/a', '10.0.0.5'), 'rtsp://10.0.0.5:8554/a');
  assert.equal(fixStreamHost('rtsp://127.0.0.1/a', '10.0.0.5'), 'rtsp://10.0.0.5/a');
  assert.equal(fixStreamHost('rtsp://0.0.0.0/a', '[fe80::1]'), 'rtsp://[fe80::1]/a');
  assert.equal(withHost('rtsp://u:p@192.168.0.9:8554/s?q=1', '203.0.113.7'), 'rtsp://u:p@203.0.113.7:8554/s?q=1');
  assert.equal(withHost('not a url', 'h'), 'not a url');
});

// ---- bad devices --------------------------------------------------------------------------------------------------

test('bad devices: connection refused, silence, and non-ONVIF answers are reported, not thrown', async () => {
  const dead = await startFakeOnvif();
  const deadUrl = dead.url;
  await dead.close();
  const r1 = await createOnvifAdapter({ requestTimeoutMs: 1000 }).probe({ id: 'c', url: deadUrl });
  assert.equal(r1.failure, 'unreachable');
  assert.equal(r1.reachable, false);

  await withDevice({ delayMs: 2500 }, async (url) => {
    const t0 = Date.now();
    const r = await createOnvifAdapter({ requestTimeoutMs: 300 }).probe({ id: 'c', url });
    assert.equal(r.failure, 'unreachable');
    assert.ok(Date.now() - t0 < 2500, 'gave up at the time limit instead of waiting for the device');
  });

  await withDevice({ garbage: true }, async (url) => {
    const r = await createOnvifAdapter({ requestTimeoutMs: 2000 }).probe({ id: 'c', url });
    assert.equal(r.failure, 'no_describe');
    assert.equal(r.reachable, true);
  });
});

test('bad devices: asking about device details against a device that is not ONVIF gives an error, not a hang', async () => {
  await withDevice({ garbage: true }, async (url) => {
    const info = await createOnvifAdapter({ requestTimeoutMs: 2000 }).deviceInfo!({ id: 'c', url });
    assert.deepEqual(info, { manufacturer: null, model: null, firmware: null, serial: null, hardwareId: null });
  });
  await withDevice({ auth: 'wsse' }, async (url) => {
    const a = createOnvifAdapter({ requestTimeoutMs: 2000 });
    assert.deepEqual(await a.deviceInfo!({ id: 'c', url, credentials: CRED }), { manufacturer: 'Acme & Sons', model: 'X1', firmware: '2.3', serial: 'S-9', hardwareId: 'H1' });
    await assert.rejects(a.deviceInfo!({ id: 'c', url, credentials: { user: 'admin', pass: 'x' } }), (e) => e instanceof AdapterError && /rejected the login/.test(e.message));
    await assert.rejects(a.endpoints({ id: "c", url, credentials: { user: "admin", pass: "x" } }), (e) => e instanceof AdapterError && e.code === "device");
  });
});

test('concurrency: many cameras at once do not mix up their answers', async () => {
  const devs = await Promise.all(Array.from({ length: 8 }, (_, i) => startFakeOnvif({ auth: i % 2 ? 'wsse' : 'http-digest', user: CRED.user, pass: CRED.pass, profiles: [{ token: `t${i}`, name: `cam${i}`, codec: 'H264', width: 100 + i, height: 100, uri: `rtsp://0.0.0.0:554/c${i}` }] })));
  try {
    const a = createOnvifAdapter({ requestTimeoutMs: 3000 });
    const results = await Promise.all(Array.from({ length: 40 }, (_, k) => a.endpoints({ id: `c${k % 8}`, url: devs[k % 8].url, credentials: CRED })));
    results.forEach((eps, k) => {
      assert.equal(eps.length, 1);
      assert.equal(eps[0].label, `cam${k % 8}`);
      assert.ok(eps[0].url.endsWith(`/c${k % 8}`));
    });
  } finally { await Promise.all(devs.map((d) => d.close())); }
});

// ---- discovery over real UDP --------------------------------------------------------------------------------------

const match = (ip: string, name: string) => `<?xml version="1.0"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><e:Body><d:ProbeMatches><d:ProbeMatch><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/name/${name} onvif://www.onvif.org/hardware/HW1</d:Scopes><d:XAddrs>http://${ip}/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>`;

test('discovery over UDP: the probe is sent, several devices answer, repeats and noise are ignored', async () => {
  const responder = await startFakeDiscovery([match('10.0.0.5', 'Gate'), match('10.0.0.5', 'Gate'), 'garbage', match('10.0.0.6', 'Yard')]);
  try {
    const a = createOnvifAdapter({ discoveryTarget: { address: '127.0.0.1', port: responder.port } });
    const found = await a.discover!({ timeoutMs: 600 });
    assert.deepEqual(found.map((d) => d.name).sort(), ['Gate', 'Yard']);
    assert.ok(responder.received[0].includes('NetworkVideoTransmitter'), 'a WS-Discovery Probe for video transmitters was sent');
    assert.ok(found.every((d) => d.address === '127.0.0.1'), 'the address is where the answer came from');
  } finally { await responder.close(); }
});

test('discovery over UDP: nobody answering gives an empty list after the time limit; a bad interface is an error', async () => {
  const silent = await startFakeDiscovery([]);
  try {
    const t0 = Date.now();
    assert.deepEqual(await createOnvifAdapter({ discoveryTarget: { address: '127.0.0.1', port: silent.port } }).discover!({ timeoutMs: 400 }), []);
    const took = Date.now() - t0;
    assert.ok(took >= 350 && took < 2000, `took ${took} ms`);
  } finally { await silent.close(); }
  await assert.rejects(udpDiscovery(discoveryProbe(), { timeoutMs: 200, iface: '203.0.113.99' }));
});

test('discovery: devices that answer from the same address with different service URLs are both kept', async () => {
  const responder = await startFakeDiscovery([match('10.0.0.5', 'A'), match('10.0.0.5:8080', 'B')]);
  try {
    const found = await createOnvifAdapter({ discoveryTarget: { address: '127.0.0.1', port: responder.port } }).discover!({ timeoutMs: 500 });
    assert.equal(found.length, 2);
  } finally { await responder.close(); }
});
