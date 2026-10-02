/**
 * Bounded-concurrency job queue with per-key de-duplication.
 *
 * Server-side analysis has to cope with many cameras whose capture + Gemini
 * round-trip can take tens of seconds, so jobs are not fired the instant a
 * camera is due: they queue, at most `concurrency` run at once, and a camera
 * that already has a job queued or running is never queued a second time
 * (it simply runs late rather than piling up work).
 */
export interface QueueStats {
  queued: number;
  active: number;
  concurrency: number;
}

export interface AnalysisQueue {
  /** Returns false (and does nothing) if `key` is already queued/running or the queue is full. */
  enqueue(key: string, job: () => Promise<void>): boolean;
  has(key: string): boolean;
  stats(): QueueStats;
  /** Resolves once nothing is queued or running. */
  idle(): Promise<void>;
}

export function createAnalysisQueue(opts: { concurrency: number; maxQueued?: number }): AnalysisQueue {
  const concurrency = Math.max(1, opts.concurrency);
  const maxQueued = opts.maxQueued ?? 1000;
  const pending: Array<{ key: string; job: () => Promise<void> }> = [];
  const keys = new Set<string>();
  let active = 0;
  let idleWaiters: Array<() => void> = [];

  const notifyIdle = () => {
    if (active === 0 && pending.length === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((w) => w());
    }
  };

  const pump = () => {
    while (active < concurrency && pending.length > 0) {
      const next = pending.shift()!;
      active++;
      next.job()
        .catch(() => { /* jobs own their error handling; the queue must never die */ })
        .finally(() => {
          active--;
          keys.delete(next.key);
          pump();
          notifyIdle();
        });
    }
  };

  return {
    enqueue(key, job) {
      if (keys.has(key) || pending.length >= maxQueued) return false;
      keys.add(key);
      pending.push({ key, job });
      pump();
      return true;
    },
    has: (key) => keys.has(key),
    stats: () => ({ queued: pending.length, active, concurrency }),
    idle: () => (active === 0 && pending.length === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
  };
}
