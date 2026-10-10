/**
 * Reference connector 1: a REST/JSON VMS with token login, paged cameras and a sequence-numbered event feed (the shape most modern
 * VMS APIs have). It is written against `tests/lab/fakeVms.ts` and doubles as the template for a real vendor's connector: copy it,
 * change the paths and field names, register it in `index.ts`.
 *
 *   POST /api/login {user, pass}                     -> { token, expiresIn }       (the only non-GET call; sign-in only)
 *   GET  /api/v1/cameras?page=N                      -> { items: [{uid, title, site, status, geo}], page, pages }
 *   GET  /api/v1/events?after=<seq|latest>&limit=N   -> { events: [{seq, camera, type, time, plate?, conf?, text?}], next, more }
 *   GET  /api/v1/cameras/<uid>/stream                -> { rtsp }
 */
import { createReadClient, parseJson, type ReadClient } from './http';
import { VmsError, type EventPage, type VmsCamera, type VmsConnector, type VmsConnectorType, type VmsEvent, type VmsEventKind, type VmsSystemConfig, type VmsDeps } from './types';

const KINDS: Record<string, VmsEventKind> = { MOTION: 'motion', ANPR: 'plate', TAMPER: 'tamper', LINE: 'line_crossing', INTRUSION: 'intrusion' };

interface Token { value: string; until: number }

function create(cfg: VmsSystemConfig, deps: VmsDeps = {}): VmsConnector {
  const now = deps.now ?? (() => new Date());
  let token: Token | null = null;
  let signingIn: Promise<Token> | null = null;
  const client: ReadClient = createReadClient({ baseUrl: cfg.baseUrl, fetch: deps.fetch, timeoutMs: deps.timeoutMs, headers: () => (token ? { Authorization: `Bearer ${token.value}` } : {}) });

  async function signIn(): Promise<Token> {
    if (!cfg.credentials) throw new VmsError('This system needs a login and none is configured.', 'auth');
    // Several calls arriving together share one sign-in.
    signingIn ??= (async () => {
      const r = await client.login('/api/login', { user: cfg.credentials!.user, pass: cfg.credentials!.pass });
      const b = parseJson<{ token?: string; expiresIn?: number }>(r.body, 'login answer');
      if (!b.token) throw new VmsError('The login answer had no token.', 'protocol');
      return (token = { value: b.token, until: now().getTime() + Math.max(30, Number(b.expiresIn) || 300) * 1000 });
    })().finally(() => { signingIn = null; });
    return signingIn;
  }

  /** A read that signs in first when it has no usable token, and once more if the system says the token is no longer good. */
  async function read(path: string) {
    if (cfg.credentials && (!token || token.until - 15_000 < now().getTime())) await signIn();
    try { return await client.get(path); }
    catch (e) {
      if (e instanceof VmsError && e.code === 'auth' && cfg.credentials) { token = null; await signIn(); return client.get(path); }
      throw e;
    }
  }

  return {
    async cameras() {
      const out: VmsCamera[] = [];
      for (let page = 1; page <= 2000; page++) {
        const b = parseJson<{ items?: Array<{ uid: string; title?: string; site?: string; status?: string; geo?: { lat?: number; lon?: number } }>; pages?: number }>((await read(`/api/v1/cameras?page=${page}`)).body, 'camera list');
        if (!Array.isArray(b.items)) throw new VmsError('The camera list had no items.', 'protocol');
        for (const c of b.items) {
          if (typeof c.uid !== 'string' || !c.uid) continue;
          const cam: VmsCamera = { id: c.uid, name: c.title || c.uid, online: c.status === 'ONLINE' ? true : c.status === 'OFFLINE' ? false : null };
          if (c.site) cam.group = c.site;
          if (typeof c.geo?.lat === 'number' && typeof c.geo?.lon === 'number') cam.location = { lat: c.geo.lat, lng: c.geo.lon };
          out.push(cam);
        }
        if (page >= (b.pages ?? 1)) break;
      }
      return out;
    },

    async events(cursor, limit): Promise<EventPage> {
      const b = parseJson<{ events?: Array<{ seq: number; camera: string; type: string; time: number; plate?: string; conf?: number; text?: string }>; next?: number; more?: boolean }>(
        (await read(`/api/v1/events?after=${cursor === null ? 'latest' : encodeURIComponent(cursor)}&limit=${Math.min(500, Math.max(1, limit))}`)).body, 'event feed');
      if (!Array.isArray(b.events) || typeof b.next !== 'number') throw new VmsError('The event feed was not in the expected shape.', 'protocol');
      const events: VmsEvent[] = [];
      for (const e of b.events) {
        if (!Number.isFinite(e.seq) || typeof e.camera !== 'string' || !Number.isFinite(e.time)) continue;
        const kind = KINDS[e.type] ?? 'alarm';
        const data: Record<string, unknown> = {};
        if (e.plate) data.plate = e.plate;
        if (typeof e.conf === 'number') data.confidence = e.conf;
        if (e.text) data.text = e.text;
        events.push({ id: String(e.seq), cameraId: e.camera, at: new Date(e.time), kind, vendorCode: e.type, data });
      }
      return { events, cursor: String(b.next), more: b.more === true };
    },

    async streams(cameraId) {
      const b = parseJson<{ rtsp?: string }>((await read(`/api/v1/cameras/${encodeURIComponent(cameraId)}/stream`)).body, 'stream answer');
      if (!b.rtsp) throw new VmsError('The system returned no stream address for that camera.', 'protocol');
      return [{ protocol: 'rtsp', role: 'analysis', url: b.rtsp, label: 'Main' }];
    },

    async health() {
      const t0 = Date.now();
      try { await read('/api/v1/cameras?page=1'); return { ok: true, latencyMs: Date.now() - t0 }; }
      catch (e) { return { ok: false, latencyMs: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) }; }
    },
  };
}

export const referenceJsonConnector: VmsConnectorType = {
  kind: 'reference-json',
  label: 'Reference REST/JSON VMS',
  description: 'Token login, paged camera list, sequence-numbered event feed. A template for vendors with a REST API; run against the lab system in tests/lab/fakeVms.ts.',
  create,
};
