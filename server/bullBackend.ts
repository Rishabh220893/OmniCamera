import type { AnalysisJob, JobBackend, JobOutcome, OutcomeListener } from './jobBackend';

/**
 * Redis-backed job backend (BullMQ). Lets the scheduler and the analysis executors run as separate
 * processes: `ANALYSIS_ROLE=scheduler` on one instance, `ANALYSIS_ROLE=worker` on as many others as
 * the camera count needs.
 *
 * One job per camera at a time: the job id is the camera id, so a camera that is already queued or
 * running is never queued twice, even if two schedulers briefly overlap. Jobs are removed when they
 * finish; the scheduler learns the result through the queue's event stream.
 *
 * bullmq is loaded lazily so deployments that don't use Redis never touch it.
 */
export interface BullOptions {
  redisUrl: string;
  queueName?: string;
  concurrency: number;
  /** Enqueue jobs and receive outcomes. */
  produce: boolean;
  /** Execute jobs. */
  consume: boolean;
  log?: Pick<Console, 'warn' | 'info'>;
}

export function redisConnectionFromUrl(raw: string) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) || 0 : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export async function createBullBackend(opts: BullOptions): Promise<JobBackend> {
  const { Queue, Worker, QueueEvents } = await import('bullmq');
  const name = opts.queueName ?? 'omnisee-analysis';
  const connection = redisConnectionFromUrl(opts.redisUrl);
  const log = opts.log ?? console;
  const queue = new Queue<AnalysisJob>(name, { connection });
  queue.on('error', (err) => log.warn('[QUEUE] Redis error:', err.message));
  const listeners: OutcomeListener[] = [];
  const emit = (id: string, o: JobOutcome | { crashed: string }) => listeners.forEach((l) => l(id, o));
  let worker: InstanceType<typeof Worker<AnalysisJob, JobOutcome>> | null = null;
  let events: InstanceType<typeof QueueEvents> | null = null;

  if (opts.produce) {
    events = new QueueEvents(name, { connection });
    events.on('error', (err) => log.warn('[QUEUE] Redis event stream error:', err.message));
    events.on('completed', ({ jobId, returnvalue }) => {
      const value = typeof returnvalue === 'string' ? safeParse(returnvalue) : returnvalue;
      if (value && typeof value === 'object') emit(jobId, value as unknown as JobOutcome);
      else emit(jobId, { crashed: 'executor returned no result' });
    });
    events.on('failed', ({ jobId, failedReason }) => emit(jobId, { crashed: failedReason || 'job failed' }));
    await events.waitUntilReady();
  }

  return {
    kind: 'bull',
    async enqueue(job) {
      // Job id = camera id → Redis itself refuses a duplicate of a job that still exists.
      if (await queue.getJob(job.camera.id)) return false;
      await queue.add('analyze', job, { jobId: job.camera.id, removeOnComplete: true, removeOnFail: true, attempts: 1 });
      return true;
    },
    startConsuming(handler) {
      if (!opts.consume || worker) return;
      // The job carries its own outcome back as its return value.
      worker = new Worker<AnalysisJob, JobOutcome>(name, (job) => handler(job.data), {
        connection, concurrency: Math.max(1, opts.concurrency),
        // A capture + model call can take tens of seconds; the lock is renewed automatically while it runs.
        lockDuration: 60_000,
      });
      worker.on('error', (err) => log.warn('[QUEUE] Worker error:', err.message));
    },
    onOutcome(l) { listeners.push(l); },
    async stats() {
      const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
      return { queued: (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0), active: c.active ?? 0, concurrency: opts.concurrency };
    },
    async idle() {
      for (;;) {
        const s = await this.stats();
        if (s.queued === 0 && s.active === 0) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    async close() {
      await worker?.close();
      await events?.close();
      await queue.close();
    },
  };
}
