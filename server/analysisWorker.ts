import { createAnalysisQueue, QueueStats } from './analysisQueue';
import { AnalysisResult, buildLogDocument } from './logEntry';

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
  updateCamera(cameraId: string, patch: { lastAnalysisTime?: Date; lastAnalysisError?: string | null }): Promise<void>;
  sendWebhook(url: string, payload: unknown): Promise<void>;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface WorkerOptions {
  concurrency: number;
  tickMs: number;
  maxBackoffMs: number;
  userContextTtlMs: number;
}

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  concurrency: 4,
  tickMs: 1000,
  maxBackoffMs: 5 * 60_000,
  userContextTtlMs: 60_000,
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
  queue: QueueStats;
  cameras: Array<{
    id: string; name: string; failures: number;
    lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; nextDueAt: string;
  }>;
}

const MIN_INTERVAL_S = 5;

/** Stable spread so cameras added together don't all fire in the same second. */
function startupJitterMs(id: string, intervalMs: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % intervalMs;
}

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

  const intervalMsOf = (c: WorkerCamera) => Math.max(MIN_INTERVAL_S, c.interval || 60) * 1000;

  function applyCameras(cameras: WorkerCamera[]) {
    const seen = new Set<string>();
    for (const camera of cameras) {
      seen.add(camera.id);
      const existing = states.get(camera.id);
      if (existing) {
        existing.camera = camera; // pick up edited thresholds/URL/interval without losing schedule state
      } else {
        const ms = intervalMsOf(camera);
        states.set(camera.id, {
          camera, nextDueAt: deps.now() + startupJitterMs(camera.id, ms),
          failures: 0, lastRunAt: null, lastSuccessAt: null, lastError: null,
        });
      }
    }
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
    const { camera } = state;
    state.lastRunAt = deps.now();
    try {
      const [frame, ctx] = await Promise.all([deps.grabFrame(camera), getUserContext(camera.userId)]);
      const data = await deps.analyze({ imageBase64: frame.toString('base64'), camera, ...ctx });
      const doc = buildLogDocument({ id: camera.id, name: camera.name, sensitivity: camera.sensitivity, userId: camera.userId }, data, new Date(deps.now()));
      await deps.writeLog(doc);

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
      // Re-arm from completion time, so a slow capture never causes back-to-back runs.
      state.nextDueAt = deps.now() + backoffDelayMs(intervalMsOf(state.camera), state.failures, opts.maxBackoffMs);
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
      return {
        running: timer !== null,
        queue: queue.stats(),
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
