/**
 * HTTP side of the source adapters (server/adapters). Admin only: these routes reach out to devices from the server.
 *
 *   GET  /api/adapters                       the registered adapters and what each can do
 *   POST /api/adapters/discover  { adapter?, timeoutMs? }       find devices on this server's network (ONVIF WS-Discovery)
 *   POST /api/adapters/device    { camera }                      make, model, firmware
 *   POST /api/adapters/channels  { camera }                      the cameras behind a recorder (NVR/DVR), each as a ready-to-register camera
 *   POST /api/adapters/endpoints { camera }                      the streams the camera offers (logins removed)
 *   POST /api/adapters/probe     { camera, sampleSec? }          probe it, and save the profile when a store is attached
 *
 * `camera` is a CameraRef: { id, url | host + port, adapter?, credentials?, site?, options? }. A login in the request is
 * used for that call only and is never returned. Addresses on private networks are refused unless ADAPTERS_ALLOW_PRIVATE=true,
 * because the server would otherwise be a way into its own network; discovery only ever looks at the server's own segment.
 */
import type { Express, Request, Response } from 'express';
import { AdapterError, redactUrl, type AdapterRegistry, type CameraRef } from './adapters';
import type { ProbeReport } from './cameraProfile';
import { isSafeCameraUrl } from '../src/lib/cameraUrl';

export interface AdapterRoutesContext {
  adapters: AdapterRegistry;
  /** Answers false (and has already replied) when the caller may not use these routes. */
  requireAdmin(req: Request, res: Response): Promise<boolean>;
  allowPrivate: boolean;
  /** Stores a finished probe (as the Registry's probe does). Optional. */
  save?(report: ProbeReport): Promise<void>;
  /** Only one probe per camera at a time, and a few overall; sample time is real time. */
  maxConcurrentProbes?: number;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseCameraRef(raw: unknown): CameraRef {
  if (!raw || typeof raw !== 'object') throw new AdapterError("'camera' is required.", 'bad_ref');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) throw new AdapterError("'camera.id' must be 1-64 letters, digits, _ or -.", 'bad_ref');
  const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const ref: CameraRef = { id: r.id };
  ref.name = str(r.name, 120);
  ref.adapter = str(r.adapter, 40);
  ref.url = str(r.url, 1000);
  ref.host = str(r.host, 255);
  ref.site = str(r.site, 40);
  if (ref.site && !/^[A-Za-z0-9_-]+$/.test(ref.site)) throw new AdapterError("'camera.site' may only use letters, digits, _ and -.", 'bad_ref');
  if (r.port !== undefined) {
    const p = Number(r.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new AdapterError("'camera.port' must be a port number.", 'bad_ref');
    ref.port = p;
  }
  const c = r.credentials as { user?: unknown; pass?: unknown } | undefined;
  if (c && typeof c.user === 'string' && typeof c.pass === 'string') ref.credentials = { user: c.user.slice(0, 200), pass: c.pass.slice(0, 200) };
  if (r.options && typeof r.options === 'object' && !Array.isArray(r.options)) ref.options = r.options as Record<string, unknown>;
  if (!ref.url && !ref.host && !ref.adapter) throw new AdapterError("'camera' needs a url or a host.", 'bad_ref');
  return ref;
}

/** The address the server would connect to, for the private-network check. */
function targetOf(ref: CameraRef): string | null {
  if (ref.url) return ref.url;
  if (ref.host) return `http://${ref.host}${ref.port ? `:${ref.port}` : ''}/`;
  return null;
}

export function registerAdapterRoutes(app: Express, ctx: AdapterRoutesContext): void {
  let probing = 0;
  const limit = ctx.maxConcurrentProbes ?? 3;

  const fail = (res: Response, e: unknown) => {
    if (e instanceof AdapterError) {
      const status = e.code === 'bad_ref' ? 400 : e.code === 'no_adapter' ? 404 : e.code === 'unsupported' ? 501 : 502;
      res.status(status).json({ error: e.message });
      return;
    }
    console.error('[ADAPTERS]', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'The adapter failed.' });
  };

  /** Parses `camera`, applies the network rule and finds its adapter. Replies and returns null when it cannot go on. */
  function prepare(req: Request, res: Response) {
    try {
      const ref = parseCameraRef((req.body as { camera?: unknown })?.camera);
      const target = targetOf(ref);
      if (target && !ctx.allowPrivate && !isSafeCameraUrl(target)) {
        res.status(400).json({ error: 'That address is on a private network, which this server will not contact (set ADAPTERS_ALLOW_PRIVATE=true to allow it).' });
        return null;
      }
      return { ref, adapter: ctx.adapters.resolve(ref) };
    } catch (e) { fail(res, e); return null; }
  }

  app.get('/api/adapters', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    res.json({
      adapters: ctx.adapters.list().map((a) => ({ kind: a.kind, label: a.label, description: a.description, canDiscover: !!a.discover, canReadDevice: !!a.deviceInfo, canListChannels: !!a.channels })),
      allowPrivate: ctx.allowPrivate,
    });
  });

  app.post('/api/adapters/discover', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    try {
      const body = (req.body ?? {}) as { adapter?: unknown; timeoutMs?: unknown };
      const kind = typeof body.adapter === 'string' ? body.adapter : 'onvif';
      const a = ctx.adapters.get(kind);
      if (!a) { res.status(404).json({ error: `No adapter named '${kind}'.` }); return; }
      if (!a.discover) { res.status(501).json({ error: `'${kind}' cannot discover devices.` }); return; }
      const timeoutMs = Math.min(15_000, Math.max(500, Number(body.timeoutMs) || 3000));
      res.json({ adapter: kind, devices: await a.discover({ timeoutMs }) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/adapters/device', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    const p = prepare(req, res);
    if (!p) return;
    try {
      if (!p.adapter.deviceInfo) { res.status(501).json({ error: `'${p.adapter.kind}' cannot read device details.` }); return; }
      res.json({ adapter: p.adapter.kind, device: await p.adapter.deviceInfo(p.ref) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/adapters/channels', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    const p = prepare(req, res);
    if (!p) return;
    try {
      if (!p.adapter.channels) { res.status(501).json({ error: `'${p.adapter.kind}' is not a recorder adapter and has no channel list.` }); return; }
      const channels = await p.adapter.channels(p.ref);
      // One ready-to-register camera per channel; the login is not echoed back, add it when registering.
      const { credentials: _credentials, ...device } = p.ref;
      res.json({
        adapter: p.adapter.kind,
        channels: channels.map((c) => ({ ...c, camera: { ...device, id: `${p.ref.id}-ch${c.channel}`, name: c.name ?? undefined, adapter: p.adapter.kind, options: { ...p.ref.options, channel: c.channel } } })),
      });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/adapters/endpoints', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    const p = prepare(req, res);
    if (!p) return;
    try {
      const endpoints = await p.adapter.endpoints(p.ref);
      res.json({ adapter: p.adapter.kind, endpoints: endpoints.map((e) => ({ ...e, url: redactUrl(e.url) })) });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/adapters/probe', async (req, res) => {
    if (!(await ctx.requireAdmin(req, res))) return;
    const p = prepare(req, res);
    if (!p) return;
    if (probing >= limit) { res.status(429).json({ error: `${limit} probes are already running. Try again when one finishes.` }); return; }
    probing++;
    try {
      const sampleSec = Math.min(120, Math.max(5, Number((req.body as { sampleSec?: unknown }).sampleSec) || 30));
      const report = await p.adapter.probe(p.ref, { sampleSec });
      let saved = false;
      if (ctx.save) { try { await ctx.save(report); saved = true; } catch (e) { console.warn('[ADAPTERS] could not save the profile:', e instanceof Error ? e.message : e); } }
      res.json({ adapter: p.adapter.kind, saved, report });
    } catch (e) { fail(res, e); }
    finally { probing--; }
  });
}
