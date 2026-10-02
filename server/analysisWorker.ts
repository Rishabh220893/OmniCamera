import { createAnalysisQueue, QueueStats } from './analysisQueue';
import { AnalysisResult, buildLogDocument } from './logEntry';
import { buildSightings, LatLng, PlateSighting } from '../src/lib/plateTracking';
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
  loadUserContext(userId: string): Promise<UserContext>;
  grabFrame(camera: WorkerCamera): Promise<Buffer>;
  analyze(input: { imageBase64: string; camera: WorkerCamera } & UserContext): Promise<AnalysisResult>;
  writeLog(doc: ReturnType<typeof buildLogDocument>): Promise<void>;
  writeSightings(userId: string, sightings: PlateSighting[]): Promise<void>;
  updateCamera(cameraId: string, patch: { lastAnalysisTime?: Date; lastAnalysisError?: string | null }): Promise<void>;
  sendWebhook(url: string, payload: unknown): Promise<void>;
  /**
   * Optional shared lease (see leaseStore.ts) for running several instances.
   * When absent the worker assumes it is the only instance.
   */
  claim?(cameraId: string, now: number, leaseMs: number): Promise<ClaimResult>;
  release?(cameraId: string, nextDueAt: number): Promise<void>;
  instanceId?: string;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface WorkerOptions {
  concurrency: number;
  tickMs: number;
  maxBackoffMs: number;
  userContextTtlMs: number;
  /** How long a claimed camera stays reserved; must exceed the slowest capture + analysis. */
  leaseMs: number;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  concurrency: 4,
  tickMs: 1000,
  maxBackoffMs: 5 * 60_000,
  userContextTtlMs: 60_000,
  leaseMs: 120_000,
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
  const queue = createAnalysisQueue({ concurrency: opts.concurrency });
  const states = new Map<string, CameraState>();
  const contextCache = new Map<string, { at: number; value: Promise<UserContext> }>();
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let skippedClaims = 0;
  const running = new Set<string>();

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

  function getUserContext(userId: string): Promise<UserContext> {
    const cached = contextCache.get(userId);
    if (cached && deps.now() - cached.at < opts.userContextTtlMs) return cached.value;
    const value = deps.loadUserContext(userId);
    contextCache.set(userId, { at: deps.now(), value });
    // A failed load must not be cached for the whole TTL.
    value.catch(() => { if (contextCache.get(userId)?.value === value) contextCache.delete(userId); });
    return value;
  }

  async function runCamera(state: CameraState) {
    running.add(state.camera.id);
    try {
      await runCameraJob(state);
    } finally {
      running.delete(state.camera.id);
    }
  }

  async function runCameraJob(state: CameraState) {
    const { camera } = state;

    // With several instances, only the one that wins the shared lease analyses this camera.
    if (deps.claim) {
      let claim: ClaimResult;
      try {
        claim = await deps.claim(camera.id, deps.now(), opts.leaseMs);
      } catch (err) {
        // Can't coordinate → don't analyse (risking a duplicate); try again shortly.
        deps.log.warn(`[ANALYSIS] Could not claim ${camera.name}:`, err);
        state.nextDueAt = deps.now() + 5_000;
        return;
      }
      if (claim.claimed === false) {
        skippedClaims++;
        state.nextDueAt = Math.max(deps.now() + 1_000, claim.retryAt);
        return;
      }
    }

    const startedAt = deps.now();
    state.lastRunAt = startedAt;
    try {
      const [frame, ctx] = await Promise.all([deps.grabFrame(camera), getUserContext(camera.userId)]);
      const data = await deps.analyze({ imageBase64: frame.toString('base64'), camera, ...ctx });
      const doc = buildLogDocument({ id: camera.id, name: camera.name, sensitivity: camera.sensitivity, userId: camera.userId }, data, new Date(deps.now()));
      await deps.writeLog(doc);

      // Plate sightings feed vehicle search and route reconstruction. A failure here
      // must not discard the analysis that was just logged.
      const sightings = buildSightings(
        { id: camera.id, name: camera.name, department: camera.department, location: camera.location },
        doc.timestamp, doc.detectedPlates, doc.plateReads, doc.plateSource as PlateSighting['source'],
      );
      await deps.writeSightings(camera.userId, sightings).catch((err) => deps.log.warn(`[ANALYSIS] Could not record plate sightings for ${camera.name}:`, err));

      const recovered = state.lastError !== null;
      state.failures = 0;
      state.lastError = null;
      state.lastSuccessAt = deps.now();
      await deps.updateCamera(camera.id, { lastAnalysisTime: new Date(deps.now()), ...(recovered ? { lastAnalysisError: null } : {}) })
        .catch((err) => deps.log.warn(`[ANALYSIS] Could not update camera ${camera.id}:`, err));

      if (camera.webhookUrl) {
        const payload = { camera_id: camera.id, camera_name: camera.name, alert: doc.summary, timestamp: doc.timestamp, data: doc };
        deps.sendWebhook(camera.webhookUrl, payload).catch((err) => deps.log.warn(`[ANALYSIS] Webhook failed for ${camera.name}:`, err));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const changed = state.lastError !== message;
      state.failures++;
      state.lastError = message;
      deps.log.warn(`[ANALYSIS] "${camera.name}" failed (attempt ${state.failures}): ${message}`);
      // Only persist when the error text changes — a camera that stays down
      // must not write to Firestore every retry.
      if (changed) await deps.updateCamera(camera.id, { lastAnalysisError: message }).catch(() => { /* best effort */ });
    } finally {
      // Keep the configured cadence: the next run is due one interval after this one *started*, not
      // after it finished (otherwise a 60 s camera whose run takes 15 s would only run every 75 s).
      // The floor stops a run that outlasts its interval from being followed by an instant re-run.
      state.nextDueAt = Math.max(
        startedAt + backoffDelayMs(intervalMsOf(state.camera), state.failures, opts.maxBackoffMs),
        deps.now() + MIN_GAP_AFTER_RUN_MS,
      );
      await deps.release?.(camera.id, state.nextDueAt).catch((err) => deps.log.warn(`[ANALYSIS] Could not release lease on ${camera.name}:`, err));
    }
  }

  /** One scheduling pass: queue every due camera that isn't already queued/running. */
  function tick() {
    const now = deps.now();
    for (const state of states.values()) {
      if (now < state.nextDueAt || queue.has(state.camera.id)) continue;
      queue.enqueue(state.camera.id, () => runCamera(state));
    }
  }

  return {
    start() {
      if (timer) return;
      unsubscribe = deps.subscribeCameras(applyCameras, (err) => deps.log.error('[ANALYSIS] Camera subscription error:', err));
      timer = setInterval(tick, opts.tickMs);
      deps.log.info(`[ANALYSIS] Server-side analysis worker started (concurrency ${opts.concurrency}).`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    status(): WorkerStatus {
      const now = deps.now();
      // Backlog: due, but not started. (A running camera keeps its old due time until it finishes.)
      const waiting = [...states.values()].filter((st) => st.nextDueAt <= now && !running.has(st.camera.id));
      const lags = waiting.map((st) => now - st.nextDueAt);
      return {
        running: timer !== null,
        instanceId: deps.instanceId ?? null,
        distributed: Boolean(deps.claim),
        queue: queue.stats(),
        overdue: waiting.length,
        maxLagSeconds: lags.length ? Math.round(Math.max(...lags) / 1000) : 0,
        skippedClaims,
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
    _idle: () => queue.idle(),
  };
}

export type AnalysisWorker = ReturnType<typeof createAnalysisWorker>;
