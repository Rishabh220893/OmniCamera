/**
 * A background run of the onboarding probe over a list of cameras, started from the Registry screen.
 * One run at a time. Two cameras are probed at once (the streams are real time and the grid limits an account),
 * a 401 that follows good probes is retried once after a pause (the grid limiting the account, not a wrong password),
 * and the run stops if the source keeps refusing.
 */
import type { ProbeReport } from './cameraProfile';
import type { ProbeJobStatus } from '../src/lib/cameraProfileView';

export interface ProbeJobDeps {
  probe: (cameraId: string) => Promise<ProbeReport>;
  /** Called with each finished report (the server stores it). A failure here is recorded, not fatal. */
  save: (report: ProbeReport) => Promise<void>;
  concurrency?: number;
  /** How long to wait before retrying a camera the source refused after earlier ones were accepted. */
  rejectionPauseMs?: number;
  /** Stop after this many refusals that a retry did not fix. */
  maxRejections?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface ProbeJob {
  start(cameraIds: string[]): boolean;
  stop(): void;
  status(): ProbeJobStatus;
  /** Resolves when the current run ends (for tests). */
  settled(): Promise<void>;
}

export function createProbeJob(d: ProbeJobDeps): ProbeJob {
  const concurrency = Math.max(1, d.concurrency ?? 2);
  const pauseMs = d.rejectionPauseMs ?? 60_000;
  const maxRejections = d.maxRejections ?? 3;
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let st: ProbeJobStatus = { state: 'idle', startedAt: null, finishedAt: null, total: 0, done: 0, ok: 0, failed: 0, current: [], message: null };
  let stopRequested = false;
  let running: Promise<void> = Promise.resolve();

  async function run(ids: string[]) {
    let next = 0, rejected = 0, pauseUntil = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < ids.length && rejected < maxRejections && !stopRequested) {
        const id = ids[next++];
        while (Date.now() < pauseUntil && !stopRequested) await sleep(Math.min(1000, pauseMs || 1));
        st.current.push(id);
        let report: ProbeReport;
        try {
          report = await d.probe(id);
          if (report.failure === 'bad_credentials' && st.ok > 0) {
            pauseUntil = Math.max(pauseUntil, Date.now() + pauseMs);
            await sleep(pauseMs);
            report = await d.probe(id);
            report.notes = [...(report.notes ?? []), 'first attempt was rejected with 401 although earlier cameras in this run were accepted'];
          }
        } catch (e) {
          st.failed++; st.done++; st.current = st.current.filter((c) => c !== id);
          st.message = `${id}: ${e instanceof Error ? e.message : String(e)}`;
          continue;
        }
        if (report.failure === 'bad_credentials') rejected++;
        try { await d.save(report); } catch (e) { st.message = `Could not save ${id}: ${e instanceof Error ? e.message : String(e)}`; }
        if (report.failure) st.failed++; else st.ok++;
        st.done++;
        st.current = st.current.filter((c) => c !== id);
      }
    }));
    st.finishedAt = now().toISOString();
    if (stopRequested) { st.state = 'stopped'; st.message = 'Stopped. Cameras already probed are saved.'; }
    else if (rejected >= maxRejections) {
      st.state = 'stopped';
      st.message = st.ok === 0
        ? 'The source rejected the login 3 times, so the run stopped. Check the camera login (GRID_EMAIL / GRID_PASSWORD).'
        : `The source started refusing this account after ${st.ok} good probes, even after a pause. That is a limit on its side, not a wrong password. Wait a while, make sure nothing else is watching, and probe the rest.`;
    } else st.state = 'finished';
  }

  return {
    start(ids) {
      if (st.state === 'running') return false;
      const unique = [...new Set(ids)];
      stopRequested = false;
      st = { state: 'running', startedAt: now().toISOString(), finishedAt: null, total: unique.length, done: 0, ok: 0, failed: 0, current: [], message: null };
      running = run(unique).catch((e) => { st.state = 'stopped'; st.finishedAt = now().toISOString(); st.message = e instanceof Error ? e.message : String(e); });
      return true;
    },
    stop() { stopRequested = true; },
    status: () => ({ ...st, current: [...st.current] }),
    settled: () => running,
  };
}
