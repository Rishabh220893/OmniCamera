/**
 * Reference connector 2: an XML VMS with HTTP Basic on every call, a device list, and an alarm feed by local time with no zone at
 * one-second resolution, newest first, paged (the shape older enterprise systems have). It is the hard case for the event cursor:
 * the same alarm is returned again at the boundary second, and the system's clock zone is not in the data.
 *
 *   GET /sight/devices.xml                        -> <devices><device id name state lat lon/>...</devices>
 *   GET /sight/alarms?since=YYYY-MM-DD HH:MM:SS&page=N  -> <alarms page pages><alarm no device code at plate? text?/>...</alarms>
 *   GET /sight/devices/<id>/url                   -> plain text rtsp address
 *
 * Cursor: JSON { since: ISO time (UTC) of the last alarm's second, seen: alarm numbers already handled in that second }.
 */
import { createReadClient } from './http';
import { VmsError, type EventPage, type VmsCamera, type VmsConnector, type VmsConnectorType, type VmsDeps, type VmsEvent, type VmsEventKind, type VmsSystemConfig } from './types';

const KINDS: Record<string, VmsEventKind> = { MOT: 'motion', PLATE: 'plate', COVER: 'tamper', CROSS: 'line_crossing', INTR: 'intrusion' };
const pad = (n: number) => String(n).padStart(2, '0');

const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The attributes of every `<tag .../>` element, as plain objects. */
function elements(xml: string, tag: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}\\s+((?:[^>"]|"[^"]*")*?)\\s*/?>`, 'g'))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2]);
    out.push(attrs);
  }
  return out;
}

function create(cfg: VmsSystemConfig, deps: VmsDeps = {}): VmsConnector {
  const now = deps.now ?? (() => new Date());
  const tz = cfg.timezoneOffsetMinutes ?? 0;
  const auth = cfg.credentials ? { Authorization: `Basic ${Buffer.from(`${cfg.credentials.user}:${cfg.credentials.pass}`).toString('base64')}` } : {};
  const client = createReadClient({ baseUrl: cfg.baseUrl, fetch: deps.fetch, timeoutMs: deps.timeoutMs, headers: () => auth });

  const toLocal = (d: Date) => { const t = new Date(d.getTime() + tz * 60_000); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`; };
  const fromLocal = (s: string): Date | null => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - tz * 60_000) : null; };
  const second = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

  return {
    async cameras() {
      const xml = (await client.get('/sight/devices.xml')).body;
      if (!/<devices[\s>]/.test(xml)) throw new VmsError('The device list was not in the expected shape.', 'protocol');
      const out: VmsCamera[] = [];
      for (const d of elements(xml, 'device')) {
        if (!d.id) continue;
        const cam: VmsCamera = { id: d.id, name: d.name || d.id, online: d.state === 'up' ? true : d.state === 'down' ? false : null };
        const lat = Number(d.lat), lng = Number(d.lon);
        if (d.lat !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) cam.location = { lat, lng };
        out.push(cam);
      }
      return out;
    },

    async events(cursor, limit): Promise<EventPage> {
      // No cursor: start from this moment, ask for nothing.
      if (cursor === null) return { events: [], cursor: JSON.stringify({ since: second(now()).toISOString(), seen: [] }), more: false };
      let c: { since: string; seen: string[] };
      try { c = JSON.parse(cursor); if (typeof c.since !== 'string' || !Array.isArray(c.seen)) throw new Error(); }
      catch { throw new VmsError('The saved event position is not valid.', 'protocol'); }
      const since = new Date(c.since);
      if (Number.isNaN(since.getTime())) throw new VmsError('The saved event position is not valid.', 'protocol');
      const seen = new Set(c.seen);

      const found = new Map<string, { no: number; device: string; code: string; at: Date; plate?: string; text?: string }>();
      for (let page = 1; page <= 50; page++) {
        const xml = (await client.get(`/sight/alarms?since=${encodeURIComponent(toLocal(since))}&page=${page}`)).body;
        if (!/<alarms[\s>]/.test(xml)) throw new VmsError('The alarm list was not in the expected shape.', 'protocol');
        for (const a of elements(xml, 'alarm')) {
          const at = fromLocal(a.at ?? ''), no = Number(a.no);
          if (!at || !Number.isFinite(no) || !a.device) continue;
          if (seen.has(a.no)) continue; // returned again because the boundary second is inclusive
          found.set(a.no, { no, device: a.device, code: a.code ?? '', at, plate: a.plate, text: a.text });
        }
        const pages = Number(xml.match(/<alarms[^>]*\spages="(\d+)"/)?.[1] ?? 1);
        if (page >= pages) break;
      }
      const ordered = [...found.values()].sort((x, y) => x.no - y.no);
      const taken = ordered.slice(0, Math.max(1, limit));
      const events: VmsEvent[] = taken.map((a) => {
        const data: Record<string, unknown> = {};
        if (a.plate) data.plate = a.plate;
        if (a.text) data.text = a.text;
        return { id: String(a.no), cameraId: a.device, at: a.at, kind: KINDS[a.code] ?? 'alarm', vendorCode: a.code, data };
      });
      if (!taken.length) return { events, cursor, more: false };
      const lastSecond = second(taken[taken.length - 1].at).getTime();
      const inLast = taken.filter((a) => second(a.at).getTime() === lastSecond).map((a) => String(a.no));
      const carried = lastSecond === since.getTime() ? [...seen] : [];
      return { events, cursor: JSON.stringify({ since: new Date(lastSecond).toISOString(), seen: [...new Set([...carried, ...inLast])] }), more: ordered.length > taken.length };
    },

    async streams(cameraId) {
      const url = (await client.get(`/sight/devices/${encodeURIComponent(cameraId)}/url`)).body.trim();
      if (!/^rtsp:\/\//i.test(url)) throw new VmsError('The system returned no stream address for that camera.', 'protocol');
      return [{ protocol: 'rtsp', role: 'analysis', url, label: 'Main' }];
    },

    async health() {
      const t0 = Date.now();
      try { await client.get('/sight/devices.xml'); return { ok: true, latencyMs: Date.now() - t0 }; }
      catch (e) { return { ok: false, latencyMs: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) }; }
    },
  };
}

export const referenceXmlConnector: VmsConnectorType = {
  kind: 'reference-xml',
  label: 'Reference XML VMS',
  description: 'HTTP Basic, XML device list, alarms by zone-less local time at one-second resolution. A template for older enterprise systems; run against the lab system in tests/lab/fakeVms.ts.',
  create,
};
