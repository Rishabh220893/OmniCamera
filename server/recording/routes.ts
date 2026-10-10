/**
 * HTTP side of recording and playback (docs/recording.md).
 *
 *   GET    /api/recordings/usage                          disk use per camera, free space              (recording.manage)
 *   GET    /api/recordings/:cameraId?from=&to=            what exists in a time range: segments, gaps (recording.view)
 *   GET    /api/recordings/:cameraId/clip?from=&to=       an MP4 of that range, at most 15 minutes     (recording.view)
 *   POST   /api/recordings/:cameraId/export               { from, to, reason }: an evidence export with hashes and a hold (recording.export)
 *   GET    /api/recording-exports/:id          .../file   the manifest, and the exported file         (recording.export)
 *   GET    /api/recording-holds[?cameraId=]     POST /api/recording-holds/:id/release                  (recording.manage)
 *   GET    /api/recording-policy                PUT|DELETE /api/recording-policy/:cameraId   PUT /api/recording-policy {default}  (recording.manage)
 *   POST   /api/recordings/retention?dryRun=1                                                          (recording.manage)
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { PolicyError, parsePolicy } from './policy';
import { CAMERA_RE, type RecordingStore } from './store';
import { ClipError, makeClip, type ClipResult } from './clip';
import { overlapsHold, runRetention, type HoldStore, type PolicyStore } from './retention';

export type RecordingPermission = 'recording.view' | 'recording.export' | 'recording.manage';

export interface RecordingRoutesContext {
  store: RecordingStore;
  policies: PolicyStore;
  holds: HoldStore;
  exportsDir: string;
  hotDays?: number;
  coldDays?: number;
  /**
   * Checks the caller may use `permission` (on this camera, when one is named: ownership or department) and returns who they are,
   * or null after replying 401/403/404.
   */
  access(req: Request, res: Response, permission: RecordingPermission, cameraId?: string): Promise<{ uid: string } | null>;
  now?: () => Date;
  maxClipSeconds?: number;
  maxExportSeconds?: number;
  /** At most this many clips are being cut at once (each is an ffmpeg process). */
  maxConcurrent?: number;
}

const parseTime = (v: unknown): Date | null => { if (typeof v !== 'string' || !v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

export function registerRecordingRoutes(app: Express, ctx: RecordingRoutesContext): void {
  const now = ctx.now ?? (() => new Date());
  const maxClip = ctx.maxClipSeconds ?? 15 * 60, maxExport = ctx.maxExportSeconds ?? 60 * 60, maxConcurrent = ctx.maxConcurrent ?? 2;
  let cutting = 0;

  const fail = (res: Response, e: unknown) => {
    if (e instanceof ClipError) { res.status(e.code === 'no_footage' ? 404 : e.code === 'ffmpeg' ? 502 : 400).json({ error: e.message, code: e.code }); return; }
    if (e instanceof PolicyError) { res.status(400).json({ error: e.message }); return; }
    console.error('[RECORDING]', e);
    res.status(500).json({ error: 'The request failed.' });
  };
  const camera = (req: Request, res: Response): string | null => {
    if (CAMERA_RE.test(String(req.params.cameraId))) return String(req.params.cameraId);
    res.status(404).json({ error: 'No such camera.' });
    return null;
  };
  const range = (req: Request, res: Response, src: Record<string, unknown>): { from: Date; to: Date } | null => {
    const from = parseTime(src.from), to = parseTime(src.to);
    if (!from || !to) { res.status(400).json({ error: "'from' and 'to' must be times like 2026-10-10T10:00:00Z." }); return null; }
    if (to.getTime() <= from.getTime()) { res.status(400).json({ error: "'to' must be after 'from'." }); return null; }
    return { from, to };
  };

  app.get('/api/recordings/usage', async (req, res) => {
    if (!(await ctx.access(req, res, 'recording.manage'))) return;
    try { res.json(await ctx.store.usage()); } catch (e) { fail(res, e); }
  });

  app.post('/api/recordings/retention', async (req, res) => {
    if (!(await ctx.access(req, res, 'recording.manage'))) return;
    try {
      await ctx.policies.load();
      res.json(await runRetention({ store: ctx.store, policyFor: ctx.policies.forCamera, holds: ctx.holds, hotDays: ctx.hotDays, coldDays: ctx.coldDays, now, dryRun: req.query.dryRun === '1' || req.query.dryRun === 'true' }));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/recordings/:cameraId', async (req, res) => {
    const id = camera(req, res);
    if (!id || !(await ctx.access(req, res, 'recording.view', id))) return;
    const r = range(req, res, req.query);
    if (!r) return;
    if (r.to.getTime() - r.from.getTime() > 31 * 86_400_000) { res.status(400).json({ error: 'Ask for at most 31 days at a time.' }); return; }
    try {
      const cov = await ctx.store.coverage(id, r.from, r.to);
      const holds = await ctx.holds.list(id);
      res.json({
        cameraId: id, from: r.from.toISOString(), to: r.to.toISOString(), recordedSec: Math.round(cov.recordedMs / 1000),
        segments: cov.segments.map((s) => ({ start: s.start.toISOString(), end: s.end?.toISOString() ?? null, bytes: s.bytes, tier: s.tier, held: overlapsHold(holds, s) })),
        gaps: cov.gaps.map((g) => ({ from: g.from.toISOString(), to: g.to.toISOString() })),
      });
    } catch (e) { fail(res, e); }
  });

  async function cut(res: Response, o: { cameraId: string; from: Date; to: Date; file: string; max: number; hash: boolean }): Promise<ClipResult | null> {
    if (cutting >= maxConcurrent) { res.status(429).json({ error: 'Other clips are being prepared. Try again in a moment.' }); return null; }
    cutting++;
    try { return await makeClip(ctx.store, { cameraId: o.cameraId, from: o.from, to: o.to, outFile: o.file, maxSeconds: o.max, hash: o.hash }); }
    catch (e) { fail(res, e); return null; }
    finally { cutting--; }
  }

  app.get('/api/recordings/:cameraId/clip', async (req, res) => {
    const id = camera(req, res);
    if (!id || !(await ctx.access(req, res, 'recording.view', id))) return;
    const r = range(req, res, req.query);
    if (!r) return;
    const tmp = path.join(ctx.exportsDir, 'tmp', `${randomUUID()}.mp4`);
    const clip = await cut(res, { cameraId: id, ...r, file: tmp, max: maxClip, hash: false });
    if (!clip) return;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(clip.bytes));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Clip-Actual-From', clip.actualFrom);
    res.setHeader('X-Clip-Gaps', String(clip.gaps.length));
    const stream = createReadStream(tmp);
    const cleanup = () => { stream.destroy(); void fs.unlink(tmp).catch(() => undefined); };
    res.on('close', cleanup);
    stream.on('error', () => { cleanup(); if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    stream.pipe(res);
  });

  app.post('/api/recordings/:cameraId/export', async (req, res) => {
    const id = camera(req, res);
    if (!id) return;
    const who = await ctx.access(req, res, 'recording.export', id);
    if (!who) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = range(req, res, body);
    if (!r) return;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3) { res.status(400).json({ error: "'reason' is required (for example the case or FIR number)." }); return; }
    const exportId = randomUUID();
    const file = path.join(ctx.exportsDir, exportId, `${id}.mp4`);
    const clip = await cut(res, { cameraId: id, ...r, file, max: maxExport, hash: true });
    if (!clip) return;
    try {
      // The exported range is held so the originals outlive routine retention while the case is open.
      const hold = await ctx.holds.add({ cameraId: id, from: r.from, to: r.to, reason, by: who.uid });
      const manifest = { id: exportId, cameraId: id, reason, exportedBy: who.uid, exportedAt: now().toISOString(), holdId: hold.id, ...clipSummary(clip) };
      await fs.writeFile(path.join(ctx.exportsDir, exportId, 'manifest.json'), JSON.stringify(manifest, null, 2));
      res.status(201).json({ export: manifest });
    } catch (e) { fail(res, e); }
  });

  const exportId = (req: Request, res: Response): string | null => {
    if (/^[0-9a-f-]{36}$/.test(String(req.params.id))) return String(req.params.id);
    res.status(404).json({ error: 'No such export.' });
    return null;
  };
  const loadManifest = async (id: string): Promise<{ cameraId: string; [k: string]: unknown } | null> => {
    try { return JSON.parse(await fs.readFile(path.join(ctx.exportsDir, id, 'manifest.json'), 'utf8')); } catch { return null; }
  };

  app.get('/api/recording-exports/:id', async (req, res) => {
    const id = exportId(req, res);
    if (!id) return;
    const m = await loadManifest(id);
    if (!m) { res.status(404).json({ error: 'No such export.' }); return; }
    if (!(await ctx.access(req, res, 'recording.export', m.cameraId))) return;
    res.json({ export: m });
  });

  app.get('/api/recording-exports/:id/file', async (req, res) => {
    const id = exportId(req, res);
    if (!id) return;
    const m = await loadManifest(id);
    if (!m) { res.status(404).json({ error: 'No such export.' }); return; }
    if (!(await ctx.access(req, res, 'recording.export', m.cameraId))) return;
    const file = path.join(ctx.exportsDir, id, `${m.cameraId}.mp4`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${m.cameraId}-${id.slice(0, 8)}.mp4"`);
    res.setHeader('X-Content-SHA256', String(m.sha256 ?? ''));
    createReadStream(file).on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'The exported file is gone.' }); else res.destroy(); }).pipe(res);
  });

  app.get('/api/recording-holds', async (req, res) => {
    if (!(await ctx.access(req, res, 'recording.manage'))) return;
    try { res.json({ holds: await ctx.holds.list(typeof req.query.cameraId === 'string' ? req.query.cameraId : undefined, req.query.all === '1') }); } catch (e) { fail(res, e); }
  });
  app.post('/api/recording-holds/:id/release', async (req, res) => {
    const who = await ctx.access(req, res, 'recording.manage');
    if (!who) return;
    try {
      if (!/^[0-9a-f-]{36}$/.test(String(req.params.id))) { res.status(404).json({ error: 'No such hold.' }); return; }
      const h = await ctx.holds.release(String(req.params.id), who.uid);
      if (!h) { res.status(404).json({ error: 'No such hold, or it was already released.' }); return; }
      res.json({ hold: h });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/recording-policy', async (req, res) => {
    if (!(await ctx.access(req, res, 'recording.manage'))) return;
    try { res.json(await ctx.policies.load()); } catch (e) { fail(res, e); }
  });
  const policyNote = 'Saved. It takes effect when the media server configuration is next applied (the same apply step as any playback profile change).';
  app.put('/api/recording-policy/:cameraId', async (req, res) => {
    const id = camera(req, res);
    if (!id || !(await ctx.access(req, res, 'recording.manage'))) return;
    try { const p = parsePolicy(req.body); await ctx.policies.setCamera(id, p); res.json({ cameraId: id, policy: p, note: policyNote }); } catch (e) { fail(res, e); }
  });
  app.delete('/api/recording-policy/:cameraId', async (req, res) => {
    const id = camera(req, res);
    if (!id || !(await ctx.access(req, res, 'recording.manage'))) return;
    try { await ctx.policies.clearCamera(id); res.json({ status: 'ok', note: policyNote }); } catch (e) { fail(res, e); }
  });
  app.put('/api/recording-policy', async (req, res) => {
    if (!(await ctx.access(req, res, 'recording.manage'))) return;
    try { const p = parsePolicy((req.body as { default?: unknown } | undefined)?.default); await ctx.policies.setDefault(p); res.json({ default: p, note: policyNote }); } catch (e) { fail(res, e); }
  });
}

function clipSummary(c: ClipResult) {
  return {
    requestedFrom: c.requestedFrom, requestedTo: c.requestedTo, actualFrom: c.actualFrom, durationSec: Math.round(c.durationSec * 10) / 10,
    bytes: c.bytes, sha256: c.sha256, segments: c.segments, gaps: c.gaps,
    note: 'Video is copied from the recorded segments without re-encoding. It starts at the keyframe at or before the requested time; gaps are stretches with no recording.',
  };
}
