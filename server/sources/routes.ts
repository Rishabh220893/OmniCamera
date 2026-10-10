/**
 * HTTP side of onboarding cameras through adapters (federation plan A4). Admin only: these routes reach out to devices from the server
 * and put cameras into the Registry.
 *
 *   GET    /api/sources                          the onboarded cameras, with their recipe and whether a login can be stored
 *   POST   /api/sources/onboard                  { camera, name?, departmentId?, sampleSec?, force?, location? }   one camera
 *   POST   /api/sources/onboard-channels         { camera, channels?, namePrefix?, departmentId?, sampleSec?, force? }   a whole recorder (a job)
 *   GET    /api/sources/jobs/:id                 progress and results of a recorder job
 *   POST   /api/sources/:id/reprobe              { sampleSec? }  measure it again from its stored address
 *   DELETE /api/sources/:id                      take it out of the Registry, the sources and the profiles (and, on apply, the media server)
 *   POST   /api/sources/apply-media              { dryRun? }  put the sources' paths on the running media server (default: show what would change)
 *
 * `camera` is a CameraRef as in /api/adapters (docs/adapters.md). A login in the request is used for the call and stored sealed, never
 * returned. Addresses on private networks are refused unless ADAPTERS_ALLOW_PRIVATE=true.
 */
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { AdapterError, type CameraRef } from '../adapters';
import { parseCameraRef } from '../adapterRoutes';
import { DEPARTMENT_NAME_RE } from '../events/rules';
import { isSafeCameraUrl } from '../../src/lib/cameraUrl';
import { SecretKeyError } from './secretBox';
import { channelCamera, type OnboardResult, type Onboarding } from './onboard';
import { SOURCES_SITE, type SourceStore } from './store';

export interface SourceView {
  cameraId: string; name: string; adapter: string; host: string | null; port: number | null; departmentId: string | null;
  registryId: string | null; ownerUid: string; createdAt: string;
  recipe: string | null; pathKind: string | null; failure: string | null; probedAt: string | null;
}

export interface SourceRoutesContext {
  onboarding: Onboarding;
  sources: SourceStore;
  /** Current recipe and last probe of each onboarded camera, from the profile store. */
  profileViews(): Promise<Array<{ cameraId: string; recipe: string; pathKind: string; failure: string | null; probedAt: string }>>;
  /** The caller's user id when they may use these routes; null after replying 401/403. */
  requireAdmin(req: Request, res: Response): Promise<string | null>;
  /** Why onboarding cannot work on this server (e.g. no database), or null when it can. Checked after the caller is known to be an admin. */
  unavailable?(): Promise<string | null>;
  allowPrivate: boolean;
  /** Puts the sources' paths on the running media server. Absent when this server cannot reach the media server's control API. */
  applyMedia?(dryRun: boolean): Promise<unknown>;
  /** True when logins can be stored (SOURCE_SECRET_KEY is set). */
  keyConfigured: boolean;
  maxConcurrentProbes?: number;
  maxChannelsPerJob?: number;
}

interface Job {
  id: string; state: 'running' | 'done'; total: number; done: number; startedAt: string; finishedAt?: string;
  results: Array<{ channel: number; name: string; result: OnboardResult }>; error?: string;
}

const ID_RE = /^fed-[a-f0-9]{6,32}$/;
const targetOf = (ref: CameraRef) => ref.url ?? (ref.host ? `http://${ref.host}${ref.port ? `:${ref.port}` : ''}/` : null);

export function registerSourceRoutes(app: Express, ctx: SourceRoutesContext): void {
  let probing = 0;
  const limit = ctx.maxConcurrentProbes ?? 3;
  const maxChannels = ctx.maxChannelsPerJob ?? 64;
  const jobs = new Map<string, Job>();
  let running: string | null = null;

  const fail = (res: Response, e: unknown) => {
    if (e instanceof AdapterError) { res.status(e.code === 'bad_ref' ? 400 : e.code === 'no_adapter' ? 404 : e.code === 'unsupported' ? 501 : 502).json({ error: e.message }); return; }
    if (e instanceof SecretKeyError) { res.status(500).json({ error: e.message }); return; }
    console.error('[SOURCES]', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'The request failed.' });
  };

  /** The camera and the options common to every onboarding request, or null after replying 400. */
  function parseCommon(body: Record<string, unknown>, res: Response): { camera: CameraRef; departmentId: string | null; sampleSec: number; force: boolean } | null {
    try {
      const camera = parseCameraRef(body.camera);
      const target = targetOf(camera);
      if (target && !ctx.allowPrivate && !isSafeCameraUrl(target)) {
        res.status(400).json({ error: 'That address is on a private network, which this server will not contact (set ADAPTERS_ALLOW_PRIVATE=true to allow it).' });
        return null;
      }
      const dept = body.departmentId;
      if (dept !== undefined && dept !== null && dept !== '' && (typeof dept !== 'string' || !DEPARTMENT_NAME_RE.test(dept))) { res.status(400).json({ error: "'departmentId' must be a department name." }); return null; }
      return { camera, departmentId: typeof dept === 'string' && dept ? dept : null, sampleSec: Math.min(120, Math.max(5, Number(body.sampleSec) || 20)), force: body.force === true };
    } catch (e) { fail(res, e); return null; }
  }

  /** The admin's user id, or null after replying (401/403 for the wrong caller, 501 when this server cannot do it). */
  async function guard(req: Request, res: Response): Promise<string | null> {
    const uid = await ctx.requireAdmin(req, res);
    if (!uid) return null;
    const why = await ctx.unavailable?.();
    if (why) { res.status(501).json({ error: why }); return null; }
    return uid;
  }

  const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const point = (v: unknown) => {
    const o = v as { lat?: unknown; lng?: unknown } | undefined;
    return o && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lng)) && Math.abs(Number(o.lat)) <= 90 && Math.abs(Number(o.lng)) <= 180 ? { lat: Number(o.lat), lng: Number(o.lng) } : undefined;
  };

  app.get('/api/sources', async (req, res) => {
    if (!(await guard(req, res))) return;
    try {
      const [recs, views] = await Promise.all([ctx.sources.list(SOURCES_SITE), ctx.profileViews()]);
      const byId = new Map(views.map((v) => [v.cameraId, v]));
      const sources: SourceView[] = recs.map((r) => {
        const v = byId.get(r.cameraId);
        return {
          cameraId: r.cameraId, name: r.name, adapter: r.adapter, host: r.ref.host ?? null, port: r.ref.port ?? null, departmentId: r.departmentId,
          registryId: r.registryId, ownerUid: r.ownerUid, createdAt: r.createdAt,
          recipe: v?.recipe ?? null, pathKind: v?.pathKind ?? null, failure: v?.failure ?? null, probedAt: v?.probedAt ?? null,
        };
      });
      res.json({ sources, keyConfigured: ctx.keyConfigured, canApplyMedia: !!ctx.applyMedia });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/sources/onboard', async (req, res) => {
    const uid = await guard(req, res);
    if (!uid) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const c = parseCommon(body, res);
    if (!c) return;
    if (probing >= limit) { res.status(429).json({ error: `${limit} probes are already running. Try again when one finishes.` }); return; }
    probing++;
    try {
      const result = await ctx.onboarding.onboardOne({ camera: c.camera, name: clean(body.name, 120), departmentId: c.departmentId, ownerUid: uid, sampleSec: c.sampleSec, force: c.force, location: point(body.location) });
      res.status(result.ok === true ? 201 : result.code === 'bad_ref' ? 400 : result.code === 'unsupported' ? 501 : result.code === 'no_key' ? 409 : result.code === 'store' ? 500 : 422).json(result);
    } catch (e) { fail(res, e); }
    finally { probing--; }
  });

  app.post('/api/sources/onboard-channels', async (req, res) => {
    const uid = await guard(req, res);
    if (!uid) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const c = parseCommon(body, res);
    if (!c) return;
    if (running) { res.status(409).json({ error: 'A recorder is already being onboarded. Wait for it to finish.', jobId: running }); return; }
    try {
      const { channels } = await ctx.onboarding.channelsOf(c.camera);
      const wanted = Array.isArray(body.channels) ? new Set((body.channels as unknown[]).map(Number).filter((n) => Number.isInteger(n))) : null;
      // Without a list: every channel the recorder says is connected (or does not say).
      const chosen = channels.filter((ch) => (wanted ? wanted.has(ch.channel) : ch.online !== false)).slice(0, maxChannels);
      if (chosen.length === 0) { res.status(404).json({ error: wanted ? 'None of those channels exist on the recorder.' : 'The recorder lists no connected channels.' }); return; }
      const job: Job = { id: randomUUID(), state: 'running', total: chosen.length, done: 0, startedAt: new Date().toISOString(), results: [] };
      jobs.set(job.id, job);
      while (jobs.size > 20) jobs.delete(jobs.keys().next().value as string);
      running = job.id;
      const prefix = clean(body.namePrefix, 100);
      void (async () => {
        try {
          for (const ch of chosen) {
            const { camera, name } = channelCamera(c.camera, ch, prefix);
            const result = await ctx.onboarding.onboardOne({ camera, name, departmentId: c.departmentId, ownerUid: uid, sampleSec: Math.min(c.sampleSec, 20), force: c.force });
            job.results.push({ channel: ch.channel, name, result });
            job.done++;
          }
        } catch (e) { job.error = e instanceof Error ? e.message : String(e); }
        job.state = 'done';
        job.finishedAt = new Date().toISOString();
        running = null;
      })();
      res.status(202).json({ jobId: job.id, total: job.total });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/sources/jobs/:id', async (req, res) => {
    if (!(await guard(req, res))) return;
    const job = jobs.get(String(req.params.id));
    if (!job) { res.status(404).json({ error: 'No such job (jobs are kept in memory and lost when the server restarts).' }); return; }
    res.json({ job });
  });

  app.post('/api/sources/:id/reprobe', async (req, res) => {
    if (!(await guard(req, res))) return;
    if (!ID_RE.test(req.params.id)) { res.status(404).json({ error: 'No such source.' }); return; }
    if (probing >= limit) { res.status(429).json({ error: `${limit} probes are already running. Try again when one finishes.` }); return; }
    probing++;
    try {
      const out = await ctx.onboarding.reprobe(req.params.id, Math.min(120, Math.max(5, Number((req.body as { sampleSec?: unknown })?.sampleSec) || 20)));
      res.status(out.ok ? 200 : 404).json(out);
    } catch (e) { fail(res, e); }
    finally { probing--; }
  });

  app.delete('/api/sources/:id', async (req, res) => {
    if (!(await guard(req, res))) return;
    if (!ID_RE.test(req.params.id)) { res.status(404).json({ error: 'No such source.' }); return; }
    try {
      if (!(await ctx.onboarding.remove(req.params.id))) { res.status(404).json({ error: 'No such source.' }); return; }
      res.json({ status: 'ok', note: 'Its media-server path is removed the next time the media config is applied.' });
    } catch (e) { fail(res, e); }
  });

  app.post('/api/sources/apply-media', async (req, res) => {
    if (!(await guard(req, res))) return;
    if (!ctx.applyMedia) { res.status(501).json({ error: "The media server's control API is not reachable from this server (it only listens on its own machine)." }); return; }
    try { res.json(await ctx.applyMedia((req.body as { dryRun?: unknown })?.dryRun !== false)); } catch (e) { fail(res, e); }
  });
}
