import type { QueueStats } from './analysisQueue';
import { AnalysisJob, JobBackend, JobOutcome, createLocalBackend } from './jobBackend';
import type { FrameGate } from './frameGate';
import { AnalysisResult, buildLogDocument } from './logEntry';
import { buildSightings, LatLng, PlateSighting } from '../src/lib/plateTracking';
import { eventsFromLog, makeEvent, EventError, type EventDraft, type PlatformEvent } from './events/schema';
import type { ClaimResult } from './leaseStore';

/**
 * Server-side capture + analysis scheduler.
 *
 * Replaces the browser-tab loop in App.tsx for cameras flagged
 * `serverAnalysis: true`: cameras are watched through a Firestore
 * subscription, each is scheduled on its own `interval`, due cameras go
 * through a bounded-concurrency queue, and results are written to the same
 * `logs` collection the UI already reads. All I/O is injected, so the
 * scheduling, backoff and error handling can be tested without Firestore,
 * ffmpeg or Gemini.
 */
export interface WorkerCamera {
  id: string;
  userId: string;
  name: string;
  remoteStreamUrl: string;
  interval: number;
  sensitivity: number;
  peopleThreshold: number;
  vehicleThreshold: number;
  suspiciousRules: string;
  webhookUrl: string;
  department?: string;
  /** Set on a camera onboarded through an adapter: its frames are grabbed from the stored source address, not from `remoteStreamUrl` (which is only its media-server path). */
  sourceId?: string;
  /** The department an administrator gave this camera to (a real allotment, unlike the free-text `department`). Its faces and watchlist apply, and its logs carry it. */
  departmentId?: string;
  location?: LatLng;
}

export interface UserContext {
  knownFaces: Array<{ name: string; imageData: string }>;
  watchlist: string[];
}

export interface WorkerDeps {
  now(): number;
  /** Calls onChange with the full current list of server-analysed cameras on every change. */
  subscribeCameras(onChange: (cameras: WorkerCamera[]) => void, onError: (err: unknown) => void): () => void;
  /** The owner's faces and watchlist, plus the ones shared with `departmentId` when the camera has one. */
  loadUserContext(userId: string, departmentId?: string): Promise<UserContext>;
  grabFrame(camera: WorkerCamera): Promise<Buffer>;
  analyze(input: { imageBase64: string; camera: WorkerCamera } & UserContext): Promise<AnalysisResult>;
  writeLog(doc: ReturnType<typeof buildLogDocument>): Promise<void>;
  writeSightings(userId: string, sightings: PlateSighting[]): Promise<void>;
  /**
   * Optional. Receives the typed events of every analysed frame (plate reads, watchlist hits, unusual scenes, and whatever the
   * analyzers reported) for storage and alerting. Called without waiting, so a slow receiver never delays the next capture.
   */
  emitEvents?(events: PlatformEvent[]): Promise<void>;
  updateCamera(cameraId: string, patch: { lastAnalysisTime?: Date; lastAnalysisError?: string | null }): Promise<void>;
  sendWebhook(url: string, payload: unknown): Promise<void>;
  /**
   * Optional shared lease (see leaseStore.ts) for running several instances.
   * When absent the worker assumes it is the only instance.
   */
  claim?(cameraId: string, now: number, leaseMs: number): Promise<ClaimResult>;
  release?(cameraId: string, nextDueAt: number): Promise<void>;
  instanceId?: string;
  /**
   * Optional pre-filter run on every captured frame: unchanged scenes skip the model call (see
   * frameGate.ts). Absent = every frame is analysed.
   */
  gate?: FrameGate;
  /** Where jobs travel between scheduler and executors. Default: in-process queue. */
  backend?: JobBackend;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface WorkerOptions {
  concurrency: number;
  tickMs: number;
  maxBackoffMs: number;
  userContextTtlMs: number;
  /** How long a claimed camera stays reserved; must exceed the slowest capture + analysis. */
  leaseMs: number;
  /**
   * all (default): schedule and execute here. scheduler: only decide what is due and queue it.
   * worker: only execute queued jobs. The split needs a shared backend (Redis).
   */
  role: 'all' | 'scheduler' | 'worker';
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  concurrency: 4,
  tickMs: 1000,
  maxBackoffMs: 5 * 60_000,
  userContextTtlMs: 60_000,
  leaseMs: 120_000,
  role: 'all',
};

interface CameraState {
  camera: WorkerCamera;
  nextDueAt: number;
  failures: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface WorkerStatus {
  running: boolean;
  instanceId: string | null;
  /** True when a shared lease coordinates this instance with others. */
  distributed: boolean;
  queue: QueueStats;
  /** Cameras whose scheduled time has passed but which haven't started — the backlog. */
  overdue: number;
  /** How late the most-overdue camera is, in seconds. Growing means capacity is too low for the camera count. */
  maxLagSeconds: number;
  role: WorkerOptions['role'];
  backend: JobBackend['kind'];
  /** Runs the frame gate judged unchanged, so no model call and no log row were produced. */
  skippedUnchanged: number;
  /** Times another instance already held / had just analysed a camera this instance tried to run. */
  skippedClaims: number;
  cameras: Array<{
    id: string; name: string; failures: number;
    lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; nextDueAt: string;
  }>;
}

const MIN_INTERVAL_S = 5;
/** A camera is never re-run sooner than this after a run finishes, even if its run took longer than its interval. */
const MIN_GAP_AFTER_RUN_MS = 2_000;

export function backoffDelayMs(intervalMs: number, failures: number, maxMs: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(Math.max(intervalMs, intervalMs * 2 ** failures), Math.max(maxMs, intervalMs));
}

export function createAnalysisWorker(deps: WorkerDeps, overrides: Partial<WorkerOptions> = {}) {
  const opts = { ...DEFAULT_WORKER_OPTIONS, ...overrides };
  const backend = deps.backend ?? createLocalBackend({ concurrency: opts.concurrency });
  const states = new Map<string, CameraState>();
  const contextCache = new Map<string, { at: number; value: Promise<UserContext> }>();
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let skippedClaims = 0;
  let skippedUnchanged = 0;
  // Cameras queued or running somewhere, with when they were queued.
  const inflight = new Map<string, number>();
  // Cameras this process is actually executing right now.
  const executing = new Set<string>();

  const intervalMsOf = (c: WorkerCamera) => Math.max(MIN_INTERVAL_S, c.interval || 60) * 1000;

  function applyCameras(cameras: WorkerCamera[]) {
    const seen = new Set<string>();
    const added: WorkerCamera[] = [];
    for (const camera of cameras) {
      seen.add(camera.id);
      const existing = states.get(camera.id);
      if (existing) existing.camera = camera; // pick up edited thresholds/URL/interval without losing schedule state
      else added.push(camera);
    }
    // Cameras that appear together (e.g. a whole catalogue onboarded at once) are spread evenly
    // across their interval, in id order so every instance agrees, instead of all firing in the
    // same second. The first starts immediately.
    added.sort((a, b) => a.id.localeCompare(b.id));
    added.forEach((camera, k) => {
      states.set(camera.id, {
        camera, nextDueAt: deps.now() + Math.floor((k / added.length) * intervalMsOf(camera)),
        failures: 0, lastRunAt: null, lastSuccessAt: null, lastError: null,
      });
    });
    for (const id of [...states.keys()]) if (!seen.has(id)) states.delete(id);
  }

  function getUserContext(userId: string, departmentId?: string): Promise<UserContext> {
    const key = `${userId}|${departmentId ?? ''}`;
    const cached = contextCache.get(key);
    if (cached && deps.now() - cached.at < opts.userContextTtlMs) return cached.value;
    const value = deps.loadUserContext(userId, departmentId);
    contextCache.set(key, { at: deps.now(), value });
    // A failed load must not be cached for the whole TTL.
    value.catch(() => { if (contextCache.get(key)?.value === value) contextCache.delete(key); });
    return value;
  }

  /**
   * The executor half: claim, capture, gate, analyse, record. Stateless between calls (everything it
   * needs rides in the job), so it can run in this process or in any number of separate workers.
   */
  async function execute(job: AnalysisJob): Promise<JobOutcome> {
    executing.add(job.camera.id);
    try { return await executeInner(job); } finally { executing.delete(job.camera.id); }
  }

  async function executeInner(job: AnalysisJob): Promise<JobOutcome> {
    const { camera } = job;

    // With several instances, only the one that wins the shared lease analyses this camera.
    if (deps.claim) {
      let claim: ClaimResult;
      try {
        claim = await deps.claim(camera.id, deps.now(), opts.leaseMs);
      } catch (err) {
        // Can't coordinate → don't analyse (risking a duplicate); try again shortly.
        deps.log.warn(`[ANALYSIS] Could not claim ${camera.name}:`, err);
        return { cameraId: camera.id, startedAt: null, ok: true, error: job.lastError, failures: job.failures, nextDueAt: deps.now() + 5_000 };
      }
      if (claim.claimed === false) {
        return { cameraId: camera.id, startedAt: null, ok: true, skipped: 'held', error: job.lastError, failures: job.failures, nextDueAt: Math.max(deps.now() + 1_000, claim.retryAt) };
      }
    }

    const startedAt = deps.now();
    let failures = job.failures;
    let lastError = job.lastError;
    let skipped: JobOutcome['skipped'];
    let ok = false;
    try {
      const [frame, ctx] = await Promise.all([deps.grabFrame(camera), getUserContext(camera.userId, camera.departmentId)]);

      // Cheap pre-filter: an unchanged scene is not worth a model call (or a log row).
      const decision = deps.gate ? await deps.gate.check(camera.id, frame, deps.now()) : null;
      let doc: ReturnType<typeof buildLogDocument> | null = null;
      if (decision && !decision.analyze) {
        skipped = 'unchanged';
      } else {
        const data = await deps.analyze({ imageBase64: frame.toString('base64'), camera, ...ctx });
        doc = buildLogDocument({ id: camera.id, name: camera.name, sensitivity: camera.sensitivity, userId: camera.userId, departmentId: camera.departmentId }, data, new Date(deps.now()));
        await deps.writeLog(doc);
        // Only now does this frame become the gate's baseline — a failed analysis must not.
        decision?.commit();

        // Plate sightings feed vehicle search and route reconstruction. A failure here
        // must not discard the analysis that was just logged.
        const sightings = buildSightings(
          { id: camera.id, name: camera.name, department: camera.department, location: camera.location },
          doc.timestamp, doc.detectedPlates, doc.plateReads, doc.plateSource as PlateSighting['source'],
        );
        await deps.writeSightings(camera.userId, sightings).catch((err) => deps.log.warn(`[ANALYSIS] Could not record plate sightings for ${camera.name}:`, err));

        if (deps.emitEvents) {
          const drafts: EventDraft[] = [...eventsFromLog(doc, ctx.watchlist), ...(data.events ?? [])];
          const events: PlatformEvent[] = [];
          for (const d of drafts) {
            try { events.push(makeEvent(d, { source: 'platform', camera: { id: camera.id, name: camera.name, userId: camera.userId, department: camera.department, location: camera.location }, ts: doc.timestamp })); }
            catch (err) { if (err instanceof EventError) deps.log.warn(`[ANALYSIS] Dropped an event from ${d.source ?? 'an analyzer'} for ${camera.name}: ${err.message}`); else throw err; }
          }
          if (events.length) deps.emitEvents(events).catch((err) => deps.log.warn(`[ANALYSIS] Could not record events for ${camera.name}:`, err));
        }
      }

      const recovered = lastError !== null;
      failures = 0;
      lastError = null;
      ok = true;
      // A skipped run writes nothing unless it just cleared an error: that is the point of skipping.
      if (doc || recovered) {
        await deps.updateCamera(camera.id, { ...(doc ? { lastAnalysisTime: new Date(deps.now()) } : {}), ...(recovered ? { lastAnalysisError: null } : {}) })
          .catch((err) => deps.log.warn(`[ANALYSIS] Could not update camera ${camera.id}:`, err));
      }

      if (doc && camera.webhookUrl) {
        const payload = { camera_id: camera.id, camera_name: camera.name, alert: doc.summary, timestamp: doc.timestamp, data: doc };
        deps.sendWebhook(camera.webhookUrl, payload).catch((err) => deps.log.warn(`[ANALYSIS] Webhook failed for ${camera.name}:`, err));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const changed = lastError !== message;
      failures++;
      lastError = message;
      deps.log.warn(`[ANALYSIS] "${camera.name}" failed (attempt ${failures}): ${message}`);
      // Only persist when the error text changes — a camera that stays down
      // must not write to Firestore every retry.
      if (changed) await deps.updateCamera(camera.id, { lastAnalysisError: message }).catch(() => { /* best effort */ });
    }

    // Keep the configured cadence: the next run is due one interval after this one *started*, not
    // after it finished (otherwise a 60 s camera whose run takes 15 s would only run every 75 s).
    // The floor stops a run that outlasts its interval from being followed by an instant re-run.
    const nextDueAt = Math.max(
      startedAt + backoffDelayMs(intervalMsOf(camera), failures, opts.maxBackoffMs),
      deps.now() + MIN_GAP_AFTER_RUN_MS,
    );
    await deps.release?.(camera.id, nextDueAt).catch((err) => deps.log.warn(`[ANALYSIS] Could not release lease on ${camera.name}:`, err));
    return { cameraId: camera.id, startedAt, ok, skipped, error: lastError, failures, nextDueAt };
  }

  /** The scheduler half: fold an executor's report into the camera's schedule. */
  function applyOutcome(cameraId: string, outcome: JobOutcome | { crashed: string }) {
    inflight.delete(cameraId);
    const state = states.get(cameraId);
    if (!state) return; // camera was removed while its job ran
    if ('crashed' in outcome) {
      // The job died without reporting (worker lost, Redis error): treat it as a failed attempt.
      state.failures++;
      state.lastError = outcome.crashed;
      state.nextDueAt = deps.now() + backoffDelayMs(intervalMsOf(state.camera), state.failures, opts.maxBackoffMs);
      return;
    }
    if (outcome.skipped === 'held') skippedClaims++;
    if (outcome.skipped === 'unchanged') skippedUnchanged++;
    if (outcome.startedAt !== null) state.lastRunAt = outcome.startedAt;
    if (outcome.ok && outcome.startedAt !== null) state.lastSuccessAt = deps.now();
    state.failures = outcome.failures;
    state.lastError = outcome.error;
    state.nextDueAt = outcome.nextDueAt;
  }

  let wired = false;
  /** Attach this process to the queue: execute jobs (unless scheduler-only) and hear their outcomes (unless worker-only). */
  function wire() {
    if (wired) return;
    wired = true;
    if (opts.role !== 'scheduler') backend.startConsuming(execute);
    if (opts.role !== 'worker') backend.onOutcome(applyOutcome);
  }

  /** One scheduling pass: queue every due camera that isn't already queued/running. */
  function tick() {
    wire();
    const now = deps.now();
    for (const [id, since] of inflight) {
      // A job whose report never came back (executor killed, Redis flushed) must not park the camera forever.
      if (now - since > opts.leaseMs * 2) inflight.delete(id);
    }
    for (const state of states.values()) {
      const id = state.camera.id;
      if (now < state.nextDueAt || inflight.has(id)) continue;
      inflight.set(id, now);
      backend.enqueue({ camera: state.camera, failures: state.failures, lastError: state.lastError })
        .then((accepted) => {
          // Refused by a shared queue = a job for this camera already exists (e.g. queued before a
          // scheduler restart). Stay in-flight; its outcome will arrive. A full local queue just retries.
          if (!accepted && backend.kind === 'local') inflight.delete(id);
        })
        .catch((err) => {
          inflight.delete(id);
          deps.log.warn(`[ANALYSIS] Could not queue ${state.camera.name}:`, err);
          state.nextDueAt = deps.now() + 5_000;
        });
    }
  }

  let cachedQueue: QueueStats = { queued: 0, active: 0, concurrency: opts.concurrency };
  function queueStats(): QueueStats {
    const s = backend.stats();
    if (s instanceof Promise) { s.then((v) => { cachedQueue = v; }, () => { /* keep the last known value */ }); return cachedQueue; }
    cachedQueue = s;
    return s;
  }

  return {
    start() {
      if (started) return;
      started = true;
      wire();
      if (opts.role !== 'worker') {
        unsubscribe = deps.subscribeCameras(applyCameras, (err) => deps.log.error('[ANALYSIS] Camera subscription error:', err));
        timer = setInterval(tick, opts.tickMs);
      }
      deps.log.info(`[ANALYSIS] Server-side analysis started: role=${opts.role}, queue=${backend.kind}, concurrency ${opts.concurrency}.`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      started = false;
    },
    /** Stop and release the queue connection (Redis). */
    async close() {
      this.stop();
      await backend.close();
    },
    status(): WorkerStatus {
      const now = deps.now();
      // Backlog: due, but not started. (A running camera keeps its old due time until it finishes.)
      const waiting = [...states.values()].filter((st) => st.nextDueAt <= now && !executing.has(st.camera.id));
      const lags = waiting.map((st) => now - st.nextDueAt);
      return {
        running: started,
        role: opts.role,
        backend: backend.kind,
        instanceId: deps.instanceId ?? null,
        distributed: Boolean(deps.claim),
        queue: queueStats(),
        overdue: waiting.length,
        maxLagSeconds: lags.length ? Math.round(Math.max(...lags) / 1000) : 0,
        skippedClaims,
        skippedUnchanged,
        cameras: [...states.values()].map((s) => ({
          id: s.camera.id, name: s.camera.name, failures: s.failures,
          lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
          lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
          lastError: s.lastError, nextDueAt: new Date(s.nextDueAt).toISOString(),
        })),
      };
    },
    // Exposed for tests / manual driving.
    _applyCameras: applyCameras,
    _tick: tick,
    _idle: () => backend.idle(),
  };
}

export type AnalysisWorker = ReturnType<typeof createAnalysisWorker>;
