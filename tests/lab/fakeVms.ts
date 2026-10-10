/**
 * Two reference department systems with deliberately different APIs, for building and testing the VMS connectors without a vendor
 * (federation plan A3). They also count every request that is not a plain read, so tests can prove the platform never writes to a
 * department's system.
 *
 *  JSON system ("Acme")   token login (POST /api/login) that expires; paged camera list; events by increasing sequence number with a
 *                         `next` cursor; times in epoch milliseconds; RTSP address per camera from a stream endpoint.
 *  XML system ("Beta")    HTTP Basic on every call; device list as XML; alarms by *local time with no zone* at one-second resolution,
 *                         newest first, paged by page number, so a naive poller re-reads (or misses) alarms at the boundary.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSystem {
  url: string;
  port: number;
  /** Requests received, by "METHOD path". */
  requests: string[];
  /** Anything that was not a GET, other than the sign-in call. Must stay empty. */
  writes: string[];
  failNext(count: number, status?: number): void;
  delay(ms: number): void;
  close(): Promise<void>;
}

export interface FakeCam { id: string; name: string; group?: string; online?: boolean; lat?: number; lng?: number }

// ---- JSON system ----------------------------------------------------------------------------------------------------

export interface JsonEventInput { camera: string; type: 'MOTION' | 'ANPR' | 'TAMPER' | 'LINE' | 'INTRUSION' | 'OTHER'; plate?: string; conf?: number; at?: number; text?: string }
export interface FakeJson extends FakeSystem {
  cameras: FakeCam[];
  emit(e: JsonEventInput): number;
  expireTokens(): void;
  logins: number;
  readonly user: string;
  readonly pass: string;
}

export async function startFakeJsonVms(o: { user?: string; pass?: string; pageSize?: number; rtspBase?: string; cameras?: FakeCam[] } = {}): Promise<FakeJson> {
  const user = o.user ?? 'central', pass = o.pass ?? 'S3cret!pass';
  const pageSize = o.pageSize ?? 2;
  const rtspBase = o.rtspBase ?? 'rtsp://127.0.0.1:8554/live';
  let tokenGen = 1;
  const state = {
    cameras: o.cameras ?? [{ id: 'A1', name: 'Gate North', group: 'Traffic', online: true, lat: 23.03, lng: 72.58 }, { id: 'A2', name: 'Gate South', group: 'Traffic', online: true }, { id: 'A3', name: 'Yard', group: 'Depot', online: false }],
    events: [] as Array<{ seq: number; camera: string; type: string; time: number; plate?: string; conf?: number; text?: string }>,
    seq: 100, fail: 0, failStatus: 503, delayMs: 0,
  };
  const sys = { url: '', port: 0, requests: [] as string[], writes: [] as string[] } as FakeJson;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    sys.requests.push(`${req.method} ${u.pathname}`);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const chunks: Buffer[] = [];
    try { for await (const c of req) chunks.push(c as Buffer); } catch { return; }
    if (req.method === 'POST' && u.pathname === '/api/login') {
      sys.logins++;
      let b: { user?: string; pass?: string } = {};
      try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* bad */ }
      if (b.user !== user || b.pass !== pass) return send(401, { error: 'bad credentials' });
      return send(200, { token: `tok-${tokenGen}-${sys.logins}`, expiresIn: 300 });
    }
    if (req.method !== 'GET') { sys.writes.push(`${req.method} ${u.pathname}`); return send(405, { error: 'read only in tests' }); }
    if (state.fail > 0) { state.fail--; return send(state.failStatus, { error: 'injected' }); }
    const tok = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!tok.startsWith(`tok-${tokenGen}-`)) return send(401, { error: 'token expired or missing' });

    if (u.pathname === '/api/v1/cameras') {
      const page = Math.max(1, Number(u.searchParams.get('page') ?? 1));
      const items = state.cameras.slice((page - 1) * pageSize, page * pageSize).map((c) => ({ uid: c.id, title: c.name, site: c.group, status: c.online === false ? 'OFFLINE' : 'ONLINE', geo: c.lat !== undefined ? { lat: c.lat, lon: c.lng } : undefined }));
      return send(200, { items, page, pages: Math.max(1, Math.ceil(state.cameras.length / pageSize)) });
    }
    if (u.pathname === '/api/v1/events') {
      const after = u.searchParams.get('after');
      const limit = Math.min(500, Number(u.searchParams.get('limit') ?? 100));
      if (after === 'latest') return send(200, { events: [], next: state.seq, more: false });
      const list = state.events.filter((e) => e.seq > Number(after ?? 0)).slice(0, limit);
      const next = list.length ? list[list.length - 1].seq : Number(after ?? 0);
      return send(200, { events: list, next, more: state.events.some((e) => e.seq > next) });
    }
    const m = u.pathname.match(/^\/api\/v1\/cameras\/([^/]+)\/stream$/);
    if (m) return state.cameras.some((c) => c.id === m[1]) ? send(200, { rtsp: `${rtspBase}/${m[1]}`, auth: 'camera-login' }) : send(404, { error: 'no such camera' });
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  sys.port = (server.address() as AddressInfo).port;
  sys.url = `http://127.0.0.1:${sys.port}`;
  sys.logins = 0;
  Object.defineProperty(sys, 'cameras', { get: () => state.cameras, set: (v: FakeCam[]) => { state.cameras = v; }, enumerable: true });
  Object.assign(sys, {
    user, pass,
    emit(e: JsonEventInput) { const seq = ++state.seq; state.events.push({ seq, camera: e.camera, type: e.type, time: e.at ?? Date.now(), plate: e.plate, conf: e.conf, text: e.text }); return seq; },
    expireTokens() { tokenGen++; },
    failNext(n: number, status = 503) { state.fail = n; state.failStatus = status; },
    delay(ms: number) { state.delayMs = ms; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  });
  return sys;
}

// ---- XML system -----------------------------------------------------------------------------------------------------

export interface XmlAlarmInput { device: string; code: 'MOT' | 'PLATE' | 'COVER' | 'CROSS' | 'INTR' | 'MISC'; plate?: string; at: Date; text?: string }
export interface FakeXml extends FakeSystem {
  devices: FakeCam[];
  emit(a: XmlAlarmInput): number;
  readonly user: string;
  readonly pass: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

export async function startFakeXmlVms(o: { user?: string; pass?: string; pageSize?: number; tzOffsetMinutes?: number; devices?: FakeCam[]; rtspBase?: string } = {}): Promise<FakeXml> {
  const user = o.user ?? 'viewer', pass = o.pass ?? 'p@ss:word/1';
  const pageSize = o.pageSize ?? 3;
  const tz = o.tzOffsetMinutes ?? 330;
  const rtspBase = o.rtspBase ?? 'rtsp://127.0.0.1:8554/beta';
  const state = {
    devices: o.devices ?? [{ id: 'C-1', name: 'Main Chowk', online: true, lat: 22.3, lng: 73.19 }, { id: 'C-2', name: 'Bridge', online: true }, { id: 'C-9', name: 'Old Market', online: false }],
    alarms: [] as Array<{ no: number; device: string; code: string; at: Date; plate?: string; text?: string }>,
    no: 5000, fail: 0, failStatus: 502, delayMs: 0,
  };
  const local = (d: Date) => { const t = new Date(d.getTime() + tz * 60_000); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`; };
  const parseLocal = (s: string): Date | null => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - tz * 60_000) : null; };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const sys = { url: '', port: 0, requests: [] as string[], writes: [] as string[] } as FakeXml;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    sys.requests.push(`${req.method} ${u.pathname}`);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const send = (status: number, body: string, type = 'text/xml; charset=utf-8', h: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': type, ...h }); res.end(body); };
    try { for await (const _ of req) { /* drain */ } } catch { return; }
    if (req.method !== 'GET') { sys.writes.push(`${req.method} ${u.pathname}`); return send(405, '<error>read only in tests</error>'); }
    if (req.headers.authorization !== `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`) return send(401, '<error>unauthorised</error>', 'text/xml', { 'WWW-Authenticate': 'Basic realm="beta"' });
    if (state.fail > 0) { state.fail--; return send(state.failStatus, '<error>injected</error>'); }

    if (u.pathname === '/sight/devices.xml') {
      return send(200, `<?xml version="1.0" encoding="UTF-8"?><devices>${state.devices.map((d) => `<device id="${esc(d.id)}" name="${esc(d.name)}" state="${d.online === false ? 'down' : 'up'}"${d.lat !== undefined ? ` lat="${d.lat}" lon="${d.lng}"` : ''}/>`).join('')}</devices>`);
    }
    if (u.pathname === '/sight/alarms') {
      const since = u.searchParams.get('since');
      const page = Math.max(1, Number(u.searchParams.get('page') ?? 1));
      if (since === null) return send(400, '<error>since is required</error>');
      const from = parseLocal(since);
      if (!from) return send(400, '<error>bad time</error>');
      // Inclusive of the second, at one-second resolution, newest first: the awkward shape real systems have.
      const all = state.alarms.filter((a) => Math.floor(a.at.getTime() / 1000) >= Math.floor(from.getTime() / 1000)).sort((a, b) => b.no - a.no);
      const pages = Math.max(1, Math.ceil(all.length / pageSize));
      const items = all.slice((page - 1) * pageSize, page * pageSize);
      return send(200, `<?xml version="1.0"?><alarms page="${page}" pages="${pages}">${items.map((a) => `<alarm no="${a.no}" device="${esc(a.device)}" code="${a.code}" at="${local(a.at)}"${a.plate ? ` plate="${esc(a.plate)}"` : ''}${a.text ? ` text="${esc(a.text)}"` : ''}/>`).join('')}</alarms>`);
    }
    const m = u.pathname.match(/^\/sight\/devices\/([^/]+)\/url$/);
    if (m) return state.devices.some((d) => d.id === decodeURIComponent(m[1])) ? send(200, `${rtspBase}/${decodeURIComponent(m[1])}`, 'text/plain') : send(404, 'no such device', 'text/plain');
    return send(404, '<error>not found</error>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  sys.port = (server.address() as AddressInfo).port;
  sys.url = `http://127.0.0.1:${sys.port}`;
  Object.defineProperty(sys, 'devices', { get: () => state.devices, set: (v: FakeCam[]) => { state.devices = v; }, enumerable: true });
  Object.assign(sys, {
    user, pass,
    emit(a: XmlAlarmInput) { const no = ++state.no; state.alarms.push({ no, device: a.device, code: a.code, at: a.at, plate: a.plate, text: a.text }); return no; },
    failNext(n: number, status = 502) { state.fail = n; state.failStatus = status; },
    delay(ms: number) { state.delayMs = ms; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  });
  return sys;
}
