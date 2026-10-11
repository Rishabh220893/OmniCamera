/**
 * Recording at the edge, with a central clip fetch (gap A16, docs/regional-gateway.md "Recorded video").
 *
 * The cameras of a far site are recorded by the gateway next to them (its own MediaMTX writes segments; the gateway's recording store reads them).
 * Nothing is streamed to the centre. When someone at the centre needs a stretch of video, they ask for a **clip**:
 *
 *   1. `POST /api/gateways/:id/clips {cameraId, from, to, reason}` makes a request (permission `recording.export` on that camera).
 *   2. The gateway, which polls over its signed channel, finds the request, places a **hold** at the edge so the footage cannot be deleted while
 *      the case is open, cuts the clip from its own segments (no re-encoding) and sends its details (`/meta`) and then the file (`/file`).
 *   3. The centre checks the file against the SHA-256 the gateway declared, files it as an ordinary evidence export (manifest, signature if a key
 *      is set, chain of custody) and says so in the request. It is then downloaded through `/api/recording-exports/:id/file` like any export.
 *
 * A gateway cannot be called from the centre (it is behind a firewall), so the request is *pulled*: it waits until the gateway asks, and goes
 * back to waiting if the gateway took it and never answered (`leaseMs`). A gateway that is offline simply leaves the request pending.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { HEADER, createNonceCache, verifyRequest, type NonceCache } from './protocol';
import { appendCustody, signManifest, type SigningKey } from '../recording/evidence';
import { CAMERA_RE } from '../recording/store';

export type ClipState = 'pending' | 'working' | 'ready' | 'failed';

export interface ClipRequest {
  id: string;
  gatewayId: string;
  cameraId: string;
  from: string;
  to: string;
  reason: string;
  requestedBy: string;
  state: ClipState;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  error?: string;
  /** Declared by the gateway before the file arrives. */
  meta?: ClipMeta;
}

export interface ClipMeta {
  sha256: string;
  bytes: number;
  actualFrom: string;
  durationSec: number;
  segments: Array<{ name: string; start: string; end: string | null; sha256?: string }>;
  gaps: Array<{ from: string; to: string }>;
  /** The id of the hold the gateway placed at the edge. */
  holdId?: string;
}

// ---- the store -------------------------------------------------------------------------------------------------------------------------

export interface ClipRequestStore {
  create(r: { gatewayId: string; cameraId: string; from: Date; to: Date; reason: string; requestedBy: string }): Promise<ClipRequest>;
  get(id: string): Promise<ClipRequest | null>;
  list(o?: { gatewayId?: string; cameraId?: string; limit?: number }): Promise<ClipRequest[]>;
  /** Hands pending requests (and ones taken too long ago) to the gateway, marking them as being worked on. */
  claim(gatewayId: string, limit: number): Promise<ClipRequest[]>;
  setMeta(id: string, gatewayId: string, meta: ClipMeta): Promise<ClipRequest | null>;
  finish(id: string, state: 'ready' | 'failed', error?: string): Promise<ClipRequest | null>;
  pendingCount(gatewayId: string): Promise<number>;
}

export function createClipRequestStore(o: { file: string; now?: () => Date; leaseMs?: number; keep?: number }): ClipRequestStore {
  const now = o.now ?? (() => new Date());
  const leaseMs = o.leaseMs ?? 5 * 60_000, keep = o.keep ?? 500;
  let cache: ClipRequest[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<ClipRequest[]> => {
    if (cache) return cache;
    try { cache = JSON.parse(await fs.readFile(o.file, 'utf8')) as ClipRequest[]; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; cache = []; }
    return cache;
  };
  const change = <T>(fn: (all: ClipRequest[]) => T): Promise<T> => {
    const run = chain.then(async () => {
      const all = await load();
      const r = fn(all);
      if (all.length > keep) all.splice(0, all.length - keep);
      await fs.mkdir(path.dirname(o.file), { recursive: true });
      const tmp = `${o.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
      await fs.rename(tmp, o.file);
      return r;
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const stamp = () => now().toISOString();
  return {
    create: (r) => change((all) => {
      const at = stamp();
      const req: ClipRequest = { id: randomUUID(), gatewayId: r.gatewayId, cameraId: r.cameraId, from: r.from.toISOString(), to: r.to.toISOString(), reason: r.reason.slice(0, 300), requestedBy: r.requestedBy, state: 'pending', createdAt: at, updatedAt: at };
      all.push(req);
      return { ...req };
    }),
    async get(id) { const r = (await load()).find((x) => x.id === id); return r ? { ...r } : null; },
    async list(f = {}) { return (await load()).filter((r) => (!f.gatewayId || r.gatewayId === f.gatewayId) && (!f.cameraId || r.cameraId === f.cameraId)).slice(-(f.limit ?? 100)).reverse().map((r) => ({ ...r })); },
    claim: (gatewayId, limit) => change((all) => {
      const t = now().getTime();
      const out: ClipRequest[] = [];
      for (const r of all) {
        if (out.length >= limit) break;
        if (r.gatewayId !== gatewayId) continue;
        if (r.state === 'pending' || (r.state === 'working' && t - Date.parse(r.claimedAt ?? r.updatedAt) > leaseMs)) { r.state = 'working'; r.claimedAt = stamp(); r.updatedAt = stamp(); out.push({ ...r }); }
      }
      return out;
    }),
    setMeta: (id, gatewayId, meta) => change((all) => { const r = all.find((x) => x.id === id && x.gatewayId === gatewayId); if (!r || r.state !== 'working') return null; r.meta = meta; r.updatedAt = stamp(); return { ...r }; }),
    finish: (id, state, error) => change((all) => { const r = all.find((x) => x.id === id); if (!r) return null; r.state = state; r.updatedAt = stamp(); if (error) r.error = error.slice(0, 300); else delete r.error; return { ...r }; }),
    async pendingCount(gatewayId) { return (await load()).filter((r) => r.gatewayId === gatewayId && (r.state === 'pending' || r.state === 'working')).length; },
  };
}

// ---- the routes ------------------------------------------------------------------------------------------------------------------------

export interface ClipRoutesContext {
  store: ClipRequestStore;
  /** Where evidence exports live: a fetched clip is filed here as an ordinary export (same folder layout as `recording/routes.ts`). */
  exportsDir: string;
  signing?: SigningKey | null;
  /** The signed-in user allowed `permission` on this camera, or null after replying 401/403/404 (the recording routes' access check). */
  access(req: Request, res: Response, permission: 'recording.export' | 'recording.manage', cameraId?: string): Promise<{ uid: string } | null>;
  gateways: {
    exists(id: string): Promise<boolean>;
    /** The gateway's secret for verifying signed requests (null when there is none, `disabled` when it was switched off). */
    lookup(id: string): { secret: string; disabled?: boolean } | null;
    refresh(): Promise<void>;
  };
  nonces?: NonceCache;
  now?: () => Date;
  maxClipSeconds?: number;
  /** The most bytes one uploaded clip may have. Default 2 GB. */
  maxBytes?: number;
  maxPendingPerGateway?: number;
  /** What a hold at the edge is told in the reason, and how many requests a gateway gets at once. */
  claimLimit?: number;
}

const GATEWAY_ID_RE = /^gw-[0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f-]{36}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const time = (v: unknown): Date | null => { if (typeof v !== 'string' || !v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

/** What the centre says about a request (everything but internals). */
export function clipView(r: ClipRequest) {
  const { meta, ...rest } = r;
  return { ...rest, exportId: r.state === 'ready' ? r.id : null, bytes: meta?.bytes ?? null, sha256: meta?.sha256 ?? null };
}

/**
 * Registers the routes that need no body parser: the upload. Mount it BEFORE the app's global JSON parser. `getCtx` is read per request so the
 * route can exist before the gateway service does (503 until then).
 */
export function registerClipUpload(app: Express, getCtx: () => ClipRoutesContext | null): void {
  const nonces = createNonceCache();
  app.put('/api/gateway/clip-requests/:id/file', async (req: Request, res: Response) => {
    const ctx = getCtx();
    if (!ctx) { res.status(503).json({ error: 'Not ready.' }); return; }
    const id = String(req.params.id);
    try {
      const declared = String(req.header('x-clip-sha256') ?? '').toLowerCase();
      // The signature covers the declared hash (the body is far too big to hold); the hash is then checked against the bytes that arrive.
      await ctx.gateways.refresh();
      const v = verifyRequest({ headers: req.headers, method: 'PUT', path: req.originalUrl, body: Buffer.from(declared), lookup: (g) => ctx.gateways.lookup(g), nonces: ctx.nonces ?? nonces, now: ctx.now?.().getTime() });
      if (v.ok !== true) { res.status(401).json({ error: 'Request refused.' }); return; }
      const r = UUID_RE.test(id) ? await ctx.store.get(id) : null;
      if (!r || r.gatewayId !== v.gatewayId) { res.status(404).json({ error: 'No such request.' }); return; }
      if (r.state !== 'working' || !r.meta) { res.status(409).json({ error: 'Send the clip details first, and only for a request that is being worked on.' }); return; }
      if (!SHA_RE.test(declared) || declared !== r.meta.sha256) { res.status(422).json({ error: 'The declared hash is not the one in the clip details.' }); return; }
      const max = ctx.maxBytes ?? 2 * 1024 ** 3;
      const len = Number(req.header('content-length'));
      if (!Number.isFinite(len) || len <= 0 || len > max || len !== r.meta.bytes) { res.status(413).json({ error: `The file must be ${r.meta.bytes} bytes and at most ${max}.` }); return; }

      const dir = path.join(ctx.exportsDir, id);
      await fs.mkdir(dir, { recursive: true });
      const part = path.join(dir, `${r.cameraId}.mp4.part`);
      const hash = createHash('sha256');
      let got = 0, over = false;
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(part, { flags: 'w' });
        req.on('data', (c: Buffer) => { got += c.length; hash.update(c); if (got > len) { over = true; req.unpipe(out); out.destroy(); reject(new Error('more bytes than declared')); } });
        req.on('error', reject);
        req.on('aborted', () => reject(new Error('the upload was cut off')));
        out.on('error', reject); out.on('finish', resolve);
        req.pipe(out);
      }).catch(async (e) => { await fs.unlink(part).catch(() => undefined); throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { over }); });
      const actual = hash.digest('hex');
      if (got !== len || actual !== declared || !timingSafeEqual(Buffer.from(actual), Buffer.from(declared))) {
        await fs.unlink(part).catch(() => undefined);
        await ctx.store.finish(id, 'failed', 'The file that arrived did not match its hash (damaged in transit).');
        res.status(422).json({ error: 'The file did not match its hash. It was discarded.' });
        return;
      }
      await fs.rename(part, path.join(dir, `${r.cameraId}.mp4`));
      const m = r.meta;
      const at = (ctx.now?.() ?? new Date());
      const manifest = {
        id, cameraId: r.cameraId, reason: r.reason, exportedBy: r.requestedBy, exportedAt: at.toISOString(), holdId: m.holdId ?? null, source: `gateway:${r.gatewayId}`,
        requestedFrom: r.from, requestedTo: r.to, actualFrom: m.actualFrom, durationSec: Math.round(m.durationSec * 10) / 10, bytes: m.bytes, sha256: m.sha256, segments: m.segments, gaps: m.gaps,
        note: `Cut from the recordings kept by gateway ${r.gatewayId} next to the camera, without re-encoding, and sent to the centre. The hold that keeps the originals is at the gateway.`,
      };
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const sig = ctx.signing ? signManifest(manifest, ctx.signing, at) : null;
      if (sig) await fs.writeFile(path.join(dir, 'manifest.sig.json'), JSON.stringify(sig, null, 2));
      await appendCustody(dir, { by: r.requestedBy, action: 'exported', detail: `requested from gateway ${r.gatewayId}; ${sig ? `signed by key ${sig.keyId}` : 'unsigned'}`, at });
      await appendCustody(dir, { by: `gateway:${r.gatewayId}`, action: 'fetched', detail: `${m.bytes} bytes, sha256 ${m.sha256.slice(0, 16)}..., hold at the edge ${m.holdId ?? 'none'}`, at });
      await ctx.store.finish(id, 'ready');
      res.status(201).json({ status: 'ready', exportId: id });
    } catch (e) {
      console.error('[CLIPS]', e instanceof Error ? e.message : e);
      if (!res.headersSent) res.status(500).json({ error: 'The upload failed.' });
    }
  });
}

/** The routes with a JSON body: asking for a clip, and the gateway's side (polling, details, failure). Mount after the global parser. */
export function registerClipRoutes(app: Express, ctx: ClipRoutesContext): void {
  const nonces = ctx.nonces ?? createNonceCache();
  const now = ctx.now ?? (() => new Date());
  const maxSeconds = ctx.maxClipSeconds ?? 60 * 60;

  // ---- people at the centre
  app.post('/api/gateways/:id/clips', async (req, res) => {
    const gw = String(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cameraId = typeof b.cameraId === 'string' ? b.cameraId : '';
    if (!GATEWAY_ID_RE.test(gw)) { res.status(404).json({ error: 'No such gateway.' }); return; }
    if (!CAMERA_RE.test(cameraId)) { res.status(400).json({ error: "'cameraId' is required." }); return; }
    const who = await ctx.access(req, res, 'recording.export', cameraId);
    if (!who) return;
    const from = time(b.from), to = time(b.to);
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!from || !to || to <= from) { res.status(400).json({ error: "'from' and 'to' must be times, 'to' after 'from'." }); return; }
    if ((to.getTime() - from.getTime()) / 1000 > maxSeconds) { res.status(400).json({ error: `A clip can be at most ${Math.round(maxSeconds / 60)} minutes.` }); return; }
    if (to.getTime() > now().getTime() + 60_000) { res.status(400).json({ error: "'to' is in the future." }); return; }
    if (reason.length < 3) { res.status(400).json({ error: "'reason' is required (for example the case or FIR number)." }); return; }
    if (!(await ctx.gateways.exists(gw))) { res.status(404).json({ error: 'No such gateway.' }); return; }
    if ((await ctx.store.pendingCount(gw)) >= (ctx.maxPendingPerGateway ?? 20)) { res.status(429).json({ error: 'That gateway already has many clip requests waiting. Try again when it has caught up.' }); return; }
    const r = await ctx.store.create({ gatewayId: gw, cameraId, from, to, reason, requestedBy: who.uid });
    res.status(202).json({ request: clipView(r), note: 'The gateway picks this up the next time it asks (usually within seconds, but only while it is online).' });
  });

  app.get('/api/gateway-clips/:id', async (req, res) => {
    const id = String(req.params.id);
    const r = UUID_RE.test(id) ? await ctx.store.get(id) : null;
    if (!r) { res.status(404).json({ error: 'No such request.' }); return; }
    if (!(await ctx.access(req, res, 'recording.export', r.cameraId))) return;
    res.json({ request: clipView(r) });
  });

  app.get('/api/gateway-clips', async (req, res) => {
    if (!(await ctx.access(req, res, 'recording.manage'))) return;
    const gw = typeof req.query.gatewayId === 'string' && GATEWAY_ID_RE.test(req.query.gatewayId) ? req.query.gatewayId : undefined;
    res.json({ requests: (await ctx.store.list({ gatewayId: gw })).map(clipView) });
  });

  // ---- gateways (signed)
  async function gateway(req: Request, res: Response): Promise<string | null> {
    try { await ctx.gateways.refresh(); } catch { res.status(503).json({ error: 'Not ready.' }); return null; }
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const v = verifyRequest({ headers: req.headers, method: req.method, path: req.originalUrl, body: raw, lookup: (g) => ctx.gateways.lookup(g), nonces, now: ctx.now?.().getTime() });
    if (v.ok === true) return v.gatewayId;
    const failure = v as Extract<typeof v, { ok: false }>;
    const reason = failure.reason === 'unknown_gateway' ? 'bad_signature' : failure.reason;
    res.status(401).json({ error: `Request refused: ${reason}.`, reason, ...(failure.reason === 'clock' ? { serverTime: failure.serverTime } : {}) });
    return null;
  }

  app.get('/api/gateway/clip-requests', async (req, res) => {
    const gw = await gateway(req, res);
    if (!gw) return;
    const claimed = await ctx.store.claim(gw, ctx.claimLimit ?? 2);
    res.json({ requests: claimed.map((r) => ({ id: r.id, cameraId: r.cameraId, from: r.from, to: r.to, reason: r.reason, maxSeconds })) });
  });

  app.post('/api/gateway/clip-requests/:id/meta', async (req, res) => {
    const gw = await gateway(req, res);
    if (!gw) return;
    const b = (req.body ?? {}) as Partial<ClipMeta>;
    const ok = typeof b.sha256 === 'string' && SHA_RE.test(b.sha256) && Number.isInteger(b.bytes) && (b.bytes as number) > 0 && typeof b.actualFrom === 'string' && Number.isFinite(Number(b.durationSec))
      && Array.isArray(b.segments) && b.segments.length <= 5000 && Array.isArray(b.gaps) && b.gaps.length <= 5000;
    if (!ok) { res.status(400).json({ error: 'Malformed clip details.' }); return; }
    const id = String(req.params.id);
    const r = UUID_RE.test(id) ? await ctx.store.setMeta(id, gw, {
      sha256: b.sha256!, bytes: b.bytes!, actualFrom: b.actualFrom!, durationSec: Number(b.durationSec), segments: b.segments as ClipMeta['segments'], gaps: b.gaps as ClipMeta['gaps'], holdId: typeof b.holdId === 'string' ? b.holdId.slice(0, 80) : undefined,
    }) : null;
    if (!r) { res.status(404).json({ error: 'No such request being worked on.' }); return; }
    res.json({ status: 'ok' });
  });

  app.post('/api/gateway/clip-requests/:id/failed', async (req, res) => {
    const gw = await gateway(req, res);
    if (!gw) return;
    const id = String(req.params.id);
    const r = UUID_RE.test(id) ? await ctx.store.get(id) : null;
    if (!r || r.gatewayId !== gw) { res.status(404).json({ error: 'No such request.' }); return; }
    await ctx.store.finish(id, 'failed', typeof (req.body as { error?: unknown })?.error === 'string' ? (req.body as { error: string }).error : 'The gateway could not make the clip.');
    res.json({ status: 'ok' });
  });
}

export { HEADER };
