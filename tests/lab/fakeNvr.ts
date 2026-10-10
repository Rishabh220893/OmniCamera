/**
 * A fake Hikvision or Dahua recorder's HTTP side, for testing server/adapters/vendorNvr.ts without hardware. It answers
 * only the calls the adapter makes, in the shape each vendor's documentation shows, and checks the login the way a device
 * does: it recomputes the HTTP Digest response (or checks Basic) and counts the requests it refused.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { authorizationFor, parseAuthChallenge } from '../../server/adapters/onvifProtocol.ts';

export interface FakeNvrChannel { channel: number; name: string; online?: boolean; ip?: string }
export interface FakeNvrOptions {
  vendor: 'hikvision' | 'dahua';
  user?: string;
  pass?: string;
  auth?: 'digest' | 'basic' | 'none';
  channels?: FakeNvrChannel[];
  /** Hikvision: answer 404 for the IP-camera list, like a plain DVR, and serve the physical video inputs instead. */
  dvr?: boolean;
  /** Leave the optional extra calls (status, vendor, software version) unanswered, like older firmware. */
  oldFirmware?: boolean;
  delayMs?: number;
}
/** The live event stream the device holds open (Hikvision alertStream, Dahua eventManager attach). */
export interface FakeEventFeed {
  /** Connections open right now, and how many were ever opened. */
  open(): number;
  total: number;
  /** Writes raw text to every open connection, exactly as given (to test events cut across network chunks). */
  write(raw: string): void;
  /** Writes one complete multipart part carrying `body` (an EventNotificationAlert document, or a Dahua record), with Content-Length. */
  part(body: string, o?: { contentLength?: boolean }): void;
  /** Cuts every open connection, like a device reboot or a network break. */
  drop(): void;
  /** Stops answering the stream with 200 (a device that allows no more event connections). */
  refuse(status: number | null): void;
}

export interface FakeNvr { port: number; host: string; paths: string[]; methods: string[]; refused: number; events: FakeEventFeed; close(): Promise<void> }

export async function startFakeNvr(o: FakeNvrOptions): Promise<FakeNvr> {
  const user = o.user ?? 'admin', pass = o.pass ?? 'P@ss w0rd%1', auth = o.auth ?? 'digest';
  const channels = o.channels ?? [{ channel: 1, name: 'Gate', online: true, ip: '10.1.0.11' }, { channel: 2, name: 'Yard', online: false, ip: '10.1.0.12' }];
  const nonce = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';
  const feeds = new Set<http.ServerResponse>();
  let refuseStatus: number | null = null;
  const boundary = o.vendor === 'hikvision' ? 'boundary' : 'myboundary';
  const events: FakeEventFeed = {
    open: () => feeds.size,
    total: 0,
    write: (raw) => { for (const r of feeds) r.write(raw); },
    part: (body, po) => {
      const head = o.vendor === 'hikvision' ? 'Content-Type: application/xml; charset="UTF-8"' : 'Content-Type: text/plain';
      const len = po?.contentLength === false ? '' : `\r\nContent-Length: ${Buffer.byteLength(body)}`;
      const raw = `--${boundary}\r\n${head}${len}\r\n\r\n${body}\r\n`;
      for (const r of feeds) r.write(raw);
    },
    drop: () => { for (const r of [...feeds]) { r.socket?.destroy(); feeds.delete(r); } },
    refuse: (st) => { refuseStatus = st; },
  };
  const log: FakeNvr = { port: 0, host: '127.0.0.1', paths: [], methods: [], refused: 0, events, close: async () => {} };

  const authorised = (header: string | undefined, uri: string): boolean => {
    if (auth === 'none') return true;
    if (!header) return false;
    if (auth === 'basic') return /^basic /i.test(header) && header.slice(6).trim() === Buffer.from(`${user}:${pass}`).toString('base64');
    const given = parseAuthChallenge(header);
    if (!given || given.scheme !== 'digest') return false;
    const g = given.params;
    if (g.username !== user || g.nonce !== nonce || g.uri !== uri || !g.cnonce) return false;
    const want = authorizationFor({ scheme: 'digest', params: { realm: 'DS-fake', nonce, qop: 'auth', algorithm: 'MD5' } }, { method: 'GET', uri, user, pass, cnonce: g.cnonce, nc: parseInt(g.nc, 16) });
    return parseAuthChallenge(want!)?.params.response === g.response;
  };

  const hik = (path: string): { status: number; body: string } => {
    if (path === '/ISAPI/System/deviceInfo') return { status: 200, body: '<?xml version="1.0"?><DeviceInfo xmlns="http://www.hikvision.com/ver20/XMLSchema"><deviceName>Gate NVR</deviceName><deviceID>48ab</deviceID><model>DS-7608NI-K2</model><serialNumber>DS-7608NI-K20820200101</serialNumber><firmwareVersion>V4.30.085</firmwareVersion><manufacturer>Hikvision</manufacturer></DeviceInfo>' };
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels') {
      if (o.dvr) return { status: 404, body: '' };
      return { status: 200, body: `<InputProxyChannelList xmlns="http://www.hikvision.com/ver20/XMLSchema">${channels.map((c) => `<InputProxyChannel><id>${c.channel}</id><name>${c.name}</name><sourceInputPortDescriptor><proxyProtocol>ONVIF</proxyProtocol><addressingFormatType>ipaddress</addressingFormatType><ipAddress>${c.ip ?? ''}</ipAddress></sourceInputPortDescriptor></InputProxyChannel>`).join('')}</InputProxyChannelList>` };
    }
    if (path === '/ISAPI/ContentMgmt/InputProxy/channels/status') {
      if (o.oldFirmware || o.dvr) return { status: 404, body: '' };
      return { status: 200, body: `<InputProxyChannelStatusList>${channels.map((c) => `<InputProxyChannelStatus><id>${c.channel}</id><online>${c.online ?? true}</online></InputProxyChannelStatus>`).join('')}</InputProxyChannelStatusList>` };
    }
    if (path === '/ISAPI/System/Video/inputs/channels') {
      return { status: 200, body: `<VideoInputChannelList>${channels.map((c) => `<VideoInputChannel><id>${c.channel}</id><inputPort>${c.channel}</inputPort><name>${c.name}</name></VideoInputChannel>`).join('')}</VideoInputChannelList>` };
    }
    return { status: 404, body: '' };
  };

  const dahua = (path: string): { status: number; body: string } => {
    if (path === '/cgi-bin/magicBox.cgi?action=getSystemInfo') return { status: 200, body: 'serialNumber=4K0123ABCD\r\ndeviceType=NVR4216-4KS2\r\nhardwareVersion=1.00\r\nupdateSerial=NVR4216\r\n' };
    if (path === '/cgi-bin/magicBox.cgi?action=getVendor') return o.oldFirmware ? { status: 404, body: '' } : { status: 200, body: 'vendor=Dahua\r\n' };
    if (path === '/cgi-bin/magicBox.cgi?action=getSoftwareVersion') return o.oldFirmware ? { status: 404, body: '' } : { status: 200, body: 'version=4.001.0000000.2,build:2023-05-18\r\n' };
    if (path === '/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle') {
      return { status: 200, body: channels.map((c) => `table.ChannelTitle[${c.channel - 1}].Name=${c.name}`).join('\r\n') + '\r\n' };
    }
    if (path === '/cgi-bin/LogicDeviceManager.cgi?action=getCameraState&uuid=Default') {
      if (o.oldFirmware) return { status: 404, body: '' };
      return { status: 200, body: channels.map((c, i) => `states[${i}].Channel=${c.channel - 1}\r\nstates[${i}].ConnectionState=${c.online === false ? 'Disconnect' : 'Connected'}`).join('\r\n') + '\r\n' };
    }
    return { status: 404, body: '' };
  };

  const server = http.createServer(async (req, res) => {
    const path = req.url ?? '';
    log.paths.push(path);
    log.methods.push(req.method ?? '');
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    if (!authorised(req.headers.authorization, path)) {
      log.refused++;
      const challenge = auth === 'basic' ? 'Basic realm="fake"' : `Digest realm="DS-fake", nonce="${nonce}", qop="auth", algorithm=MD5`;
      res.writeHead(401, { 'WWW-Authenticate': challenge }); res.end('Unauthorized'); return;
    }
    const streamPath = o.vendor === 'hikvision' ? path === '/ISAPI/Event/notification/alertStream' : path.startsWith('/cgi-bin/eventManager.cgi?action=attach');
    if (streamPath) {
      if (refuseStatus !== null) { res.writeHead(refuseStatus); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': o.vendor === 'hikvision' ? `multipart/mixed; boundary=${boundary}` : `multipart/x-mixed-replace; boundary=${boundary}`, Connection: 'keep-alive' });
      res.flushHeaders();
      feeds.add(res); events.total++;
      res.on('close', () => feeds.delete(res));
      return; // held open; the test writes to it
    }
    const r = o.vendor === 'hikvision' ? hik(path) : dahua(path);
    res.writeHead(r.status, { 'Content-Type': 'text/xml' }); res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  log.port = (server.address() as AddressInfo).port;
  log.close = () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return log;
}
