/**
 * Recorded snippets (docs/snippets.md): short clips taken from a camera's stream, kept as files with a row of metadata, listed and played in the app.
 *
 *   POST   /api/snippets                  { cameraId, seconds (3-120, default 30), title? }  start recording: 202 with the snippet (status "recording")
 *   GET    /api/snippets?cameraId=        the caller's snippets, newest first (an administrator sees everyone's)
 *   GET    /api/snippets/:id              one snippet (poll it until status is "ready" or "failed")
 *   GET    /api/snippets/:id/file         the video (supports Range, so a player can seek); ?download=1 offers it as a file
 *   GET    /api/snippets/:id/thumb        a small picture
 *   DELETE /api/snippets/:id              removes the files and the row
 *
 * Recording needs the camera's stream address, which is read from the camera's record on the server (never taken from the request), and the
 * stream credentials the app already sends for snapshots (X-Stream-Email / X-Stream-Password) when the camera is on the grid.
 */
import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { gridCameraId } from '../frameSource';
import { recordClip, makeThumbnail, probeSeconds, sha256File, streamCandidates, type RecordResult, type StreamCandidate } from './recorder';
import type { Snippet, SnippetStore } from './store';

export interface SnippetCamera { id: string; name: string; url: string; department: string | null }
export interface SnippetRoutesContext {
  store: SnippetStore;
  /** Where the videos and thumbnails are kept. */
  dir: string;
  /** Checks the caller may `permission` (on this camera when one is named) and says who they are; replies 401/403/404 and returns null otherwise. */
  access(req: Request, res: Response, permission: 'recording.view' | 'recording.export', cameraId?: string): Promise<{ uid: string; admin: boolean } | null>;
  /** The camera's record, read on the server. */
  camera(cameraId: string): Promise<SnippetCamera | null>;
  creds(req: Request): { email: string; password: string };
  gridRtspHost: string;
  localBaseUrl: string;
  /** Whether the server may fetch this address (not an internal host). */
  urlAllowed(url: string): boolean;
  /** A reason to refuse right now (the grid says the account is over its limit), or null. */
  guard?(creds: { email: string; password: string }): string | null;
  maxSeconds?: number;
  maxConcurrent?: number;
  maxPerUser?: number;
  maxTotalBytes?: number;
  now?: () => Date;
  /** Replaces the real recorder (tests). */
  record?: (candidates: StreamCandidate[], seconds: number, outFile: string, o: { secrets: string[] }) => Promise<RecordResult>;
  probe?: typeof probeSeconds;
  thumb?: typeof makeThumbnail;
}

const ID_RE = /^snp_[a-f0-9]{16}$/;

export function registerSnippetRoutes(app: Express, ctx: SnippetRoutesContext): { active(): number; idle(): Promise<void> } {
  mkdirSync(ctx.dir, { recursive: true });
  const maxSeconds = ctx.maxSeconds ?? 120, maxConcurrent = ctx.maxConcurrent ?? 2, maxPerUser = ctx.maxPerUser ?? 3, maxTotal = ctx.maxTotalBytes ?? 2_000_000_000;
  const now = ctx.now ?? (() => new Date());
  const record = ctx.record ?? ((c, s, f, o) => recordClip(c, s, f, o));
  const probe = ctx.probe ?? probeSeconds, thumb = ctx.thumb ?? makeThumbnail;
  const running = new Map<string, Promise<void>>();
  const fileOf = (id: string) => path.join(ctx.dir, `${id}.mp4`), thumbOf = (id: string) => path.join(ctx.dir, `${id}.jpg`);
  const view = (s: Snippet) => ({ ...s, fileUrl: s.status === 'ready' ? `/api/snippets/${s.id}/file` : null, thumbUrl: s.hasThumb ? `/api/snippets/${s.id}/thumb` : null });

  async function finish(s: Snippet, cam: SnippetCamera, candidates: StreamCandidate[], secrets: string[]) {
    const out = fileOf(s.id);
    try {
      const r = await record(candidates, s.requestedSeconds, out, { secrets });
      if (!r.ok) { await ctx.store.update(s.id, { status: 'failed', error: (r.failure ?? 'The recording failed.').slice(0, 400), finishedAt: now().toISOString() }); return; }
      const seconds = await probe(out);
      const hasThumb = await thumb(out, thumbOf(s.id), Math.min(1, (seconds ?? 2) / 2)).catch(() => false);
      const sha = await sha256File(out).catch(() => null);
      const bytes = await stat(out).then((x) => x.size, () => r.bytes);
      await ctx.store.update(s.id, { status: 'ready', actualSeconds: seconds, bytes, hasThumb, sha256: sha, error: null, finishedAt: now().toISOString() });
    } catch (e) {
      console.warn(`[SNIPPETS] ${s.id} (${cam.id}):`, e instanceof Error ? e.message : e);
      await ctx.store.update(s.id, { status: 'failed', error: 'The recording failed on the server.', finishedAt: now().toISOString() }).catch(() => undefined);
      await rm(out, { force: true }).catch(() => undefined);
    }
  }

  app.post('/api/snippets', async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const cameraId = typeof body.cameraId === 'string' ? body.cameraId.slice(0, 200) : '';
    const seconds = body.seconds === undefined ? 30 : Number(body.seconds);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    if (!cameraId) { res.status(400).json({ error: "'cameraId' is required." }); return; }
    if (!Number.isInteger(seconds) || seconds < 3 || seconds > maxSeconds) { res.status(400).json({ error: `'seconds' must be a whole number from 3 to ${maxSeconds}.` }); return; }
    const who = await ctx.access(req, res, 'recording.export', cameraId); if (!who) return;
    const cam = await ctx.camera(cameraId);
    if (!cam) { res.status(404).json({ error: 'No such camera.' }); return; }
    if (!cam.url) { res.status(409).json({ error: 'This camera has no stream address, so there is nothing to record.' }); return; }
    if (!ctx.urlAllowed(cam.url)) { res.status(400).json({ error: "This camera's stream address cannot be recorded from the server (internal address)." }); return; }
    const creds = ctx.creds(req);
    if (gridCameraId(cam.url) && (!creds.email || !creds.password)) { res.status(401).json({ error: 'Stream access email and password are not set (Settings > stream access).' }); return; }
    const blocked = ctx.guard?.(creds); if (blocked) { res.status(429).json({ error: blocked }); return; }
    const candidates = streamCandidates({ url: cam.url, creds, gridRtspHost: ctx.gridRtspHost, localBaseUrl: ctx.localBaseUrl });
    if (!candidates.length) { res.status(409).json({ error: 'This camera gives still pictures, which cannot be recorded as video.' }); return; }
    if (running.size >= maxConcurrent) { res.status(429).json({ error: 'The server is already recording as many snippets as it may at once. Try again in a moment.' }); return; }
    const mine = (await ctx.store.list({ userId: who.uid, limit: 500 })).filter((x) => x.status === 'recording').length;
    if (mine >= maxPerUser) { res.status(429).json({ error: `You already have ${mine} snippets recording; wait for one to finish.` }); return; }
    if ((await ctx.store.totalBytes()) + seconds * 1_000_000 > maxTotal) { res.status(507).json({ error: 'The snippet store is full. Delete some snippets first.' }); return; }

    const s: Snippet = {
      id: `snp_${randomBytes(8).toString('hex')}`, userId: who.uid, cameraId: cam.id, cameraName: cam.name, department: cam.department, title: title || `${cam.name} ${now().toISOString().slice(0, 19).replace('T', ' ')} UTC`,
      status: 'recording', requestedSeconds: seconds, actualSeconds: null, bytes: 0, hasThumb: false, error: null, sha256: null, createdAt: now().toISOString(), finishedAt: null,
    };
    await ctx.store.insert(s);
    const secrets = [creds.email, creds.password, encodeURIComponent(creds.email), encodeURIComponent(creds.password)].filter(Boolean);
    const job = finish(s, cam, candidates, secrets).finally(() => { running.delete(s.id); });
    running.set(s.id, job);
    res.status(202).json({ snippet: view(s) });
  });

  app.get('/api/snippets', async (req, res) => {
    const who = await ctx.access(req, res, 'recording.view'); if (!who) return;
    const cameraId = typeof req.query.cameraId === 'string' ? req.query.cameraId.slice(0, 200) : undefined;
    const rows = await ctx.store.list({ ...(who.admin ? {} : { userId: who.uid }), cameraId, limit: 200 });
    res.json({ snippets: rows.map(view) });
  });

  async function own(req: Request, res: Response): Promise<{ s: Snippet; who: { uid: string; admin: boolean } } | null> {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) { res.status(404).json({ error: 'No such snippet.' }); return null; }
    const who = await ctx.access(req, res, 'recording.view'); if (!who) return null;
    const s = await ctx.store.get(id);
    if (!s || (!who.admin && s.userId !== who.uid)) { res.status(404).json({ error: 'No such snippet.' }); return null; }
    return { s, who };
  }

  app.get('/api/snippets/:id', async (req, res) => { const o = await own(req, res); if (o) res.json({ snippet: view(o.s) }); });

  const send = (kind: 'file' | 'thumb') => async (req: Request, res: Response) => {
    const o = await own(req, res); if (!o) return;
    if (kind === 'file' && o.s.status !== 'ready') { res.status(409).json({ error: o.s.status === 'failed' ? `The recording failed: ${o.s.error ?? 'unknown'}` : 'The recording is not finished yet.' }); return; }
    if (kind === 'thumb' && !o.s.hasThumb) { res.status(404).json({ error: 'No picture.' }); return; }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (kind === 'file') res.type('video/mp4');
    if (kind === 'file' && req.query.download === '1') res.attachment(`${o.s.title.replace(/[^\w.-]+/g, '_').slice(0, 80) || o.s.id}.mp4`);
    res.sendFile(path.resolve(kind === 'file' ? fileOf(o.s.id) : thumbOf(o.s.id)), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'The file is gone.' }); });
  };
  app.get('/api/snippets/:id/file', send('file'));
  app.get('/api/snippets/:id/thumb', send('thumb'));

  app.delete('/api/snippets/:id', async (req, res) => {
    const o = await own(req, res); if (!o) return;
    if (o.s.status === 'recording') { res.status(409).json({ error: 'It is still recording.' }); return; }
    await rm(fileOf(o.s.id), { force: true }); await rm(thumbOf(o.s.id), { force: true });
    await ctx.store.remove(o.s.id);
    res.json({ status: 'ok' });
  });

  return { active: () => running.size, idle: async () => { await Promise.allSettled([...running.values()]); } };
}
