import { createAnalysisQueue, QueueStats } from './analysisQueue';
import type { WorkerCamera } from './analysisWorker';

/**
 * Where analysis jobs travel between the scheduler (decides which cameras are due) and the
 * executors (grab a frame, call the model, write results).
 *
 * - `local`: both halves in one process, bounded in-memory queue. Zero setup; the default.
 * - `bull` (bullBackend.ts): Redis-backed, so the scheduler and any number of worker processes
 *   can run on different machines and be scaled, restarted and deployed independently.
 *
 * A job carries everything an executor needs (the camera record plus the scheduler's view of its
 * failure history), so executors keep no per-camera schedule state and can be added or lost freely.
 */
export interface AnalysisJob {
  camera: WorkerCamera;
  /** Consecutive failures so far, for back-off. */
  failures: number;
  /** Last error text, so the executor only persists an error when it changes. */
  lastError: string | null;
}

/** What an executor reports back so the scheduler can plan the camera's next run. */
export interface JobOutcome {
  cameraId: string;
  /** Epoch ms the run started; null if it never got that far (lease held elsewhere). */
  startedAt: number | null;
  ok: boolean;
  /** 'unchanged': frame gate skipped the model call. 'held': another instance owns the camera. */
  skipped?: 'unchanged' | 'held';
  error: string | null;
  failures: number;
  nextDueAt: number;
}

export type OutcomeListener = (cameraId: string, outcome: JobOutcome | { crashed: string }) => void;

export interface JobBackend {
  readonly kind: 'local' | 'bull';
  /** Queue the job. Resolves false if that camera is already queued/running or the queue is full. */
  enqueue(job: AnalysisJob): Promise<boolean>;
  /** Executor side: process jobs with `handler`. Not called on a scheduler-only instance. */
  startConsuming(handler: (job: AnalysisJob) => Promise<JobOutcome>): void;
  /** Scheduler side: be told how each job ended. */
  onOutcome(listener: OutcomeListener): void;
  /** Synchronous for the in-process backend, a Redis round trip for the shared one. */
  stats(): QueueStats | Promise<QueueStats>;
  /** Resolves once nothing is queued or running (as far as this backend can tell). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export function createLocalBackend(opts: { concurrency: number; maxQueued?: number }): JobBackend {
  const queue = createAnalysisQueue(opts);
  let handler: ((job: AnalysisJob) => Promise<JobOutcome>) | null = null;
  const listeners: OutcomeListener[] = [];
  const emit = (id: string, o: JobOutcome | { crashed: string }) => listeners.forEach((l) => l(id, o));
  return {
    kind: 'local',
    async enqueue(job) {
      return queue.enqueue(job.camera.id, async () => {
        if (!handler) { emit(job.camera.id, { crashed: 'no executor attached' }); return; }
        try { emit(job.camera.id, await handler(job)); }
        catch (err) { emit(job.camera.id, { crashed: err instanceof Error ? err.message : String(err) }); }
      });
    },
    startConsuming(h) { handler = h; },
    onOutcome(l) { listeners.push(l); },
    stats: () => queue.stats(),
    idle: () => queue.idle(),
    close: async () => {},
  };
}
