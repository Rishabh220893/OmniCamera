/**
 * Keeps one department system synchronised: its cameras, its events, and a picture of its health (federation plan A2).
 *
 *   - Events are read page by page, mapped to platform events, handed to `emit`, and only THEN is the position saved. A crash between
 *     the two repeats the last page, which is harmless because event ids come from the vendor's own id.
 *   - Camera state changes (offline/online) become events; the first sync only learns the baseline.
 *   - Failures back off exponentially (capped) and are classified: a refused login is `auth` (stop retrying fast and say so), an
 *     unreachable or struggling system is `degraded`/`down`. One broken department never affects another: each system has its own runner.
 *   - A minimum gap between calls (`minGapMs`) protects the department's system from us.
 */
import type { PlatformEvent } from '../../events/schema';
import { cameraStateEvent, platformEventFromVms } from './mapping';
import { VmsError, type VmsCamera, type VmsConnector, type VmsSystemConfig } from './types';

export interface CursorStore {
  get(systemId: string): Promise<string | null>;
  set(systemId: string, cursor: string): Promise<void>;
}

export function createMemoryCursorStore(): CursorStore {
  const m = new Map<string, string>();
  return { get: async (id) => m.get(id) ?? null, set: async (id, c) => { m.set(id, c); } };
}

export type RunnerState = 'new' | 'ok' | 'degraded' | 'down' | 'auth_failed';

export interface RunnerStatus {
  systemId: string;
  state: RunnerState;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextTryInMs: number;
  cameras: number;
  eventsForwarded: number;
  pollsOk: number;
  cursor: string | null;
}

export interface RunnerOptions {
  system: VmsSystemConfig;
  connector: VmsConnector;
  cursors: CursorStore;
  emit(events: PlatformEvent[]): Promise<unknown>;
  now?: () => Date;
  pageSize?: number;
  /** Pages read per poll before yielding, so one noisy system cannot monopolise the loop. */
  maxPagesPerPoll?: number;
  /** Least time between two calls to the system. Default 200 ms. */
  minGapMs?: number;
  pollIntervalMs?: number;
  cameraSyncIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Called when the set of cameras changes (added, removed, renamed). */
  onCameras?: (cameras: VmsCamera[]) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  log?: Pick<Console, 'warn'>;
}

export function createVmsRunner(o: RunnerOptions) {
  const now = o.now ?? (() => new Date());
  const pageSize = o.pageSize ?? 100, maxPages = o.maxPagesPerPoll ?? 10, minGap = o.minGapMs ?? 200;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = o.log ?? console;
  const status: RunnerStatus = { systemId: o.system.id, state: 'new', lastOkAt: null, lastError: null, consecutiveFailures: 0, nextTryInMs: 0, cameras: 0, eventsForwarded: 0, pollsOk: 0, cursor: null };
  let known = new Map<string, VmsCamera>();
  let baselined = false;
  let lastCall = 0;
  let stopped = true;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;

  async function paced<T>(fn: () => Promise<T>): Promise<T> {
    const wait = lastCall + minGap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  }

  const ok = () => { status.state = 'ok'; status.consecutiveFailures = 0; status.lastError = null; status.lastOkAt = now().toISOString(); status.nextTryInMs = 0; };
  function failed(e: unknown) {
    const err = e instanceof VmsError ? e : new VmsError(e instanceof Error ? e.message : String(e), 'upstream');
    status.consecutiveFailures++;
    status.lastError = err.message;
    status.state = err.code === 'auth' ? 'auth_failed' : status.consecutiveFailures >= 3 ? 'down' : 'degraded';
    const base = o.backoffBaseMs ?? 1000, max = o.backoffMaxMs ?? 5 * 60_000;
    // A refused login will not fix itself in seconds: wait at least a minute so a wrong password is not hammered.
    status.nextTryInMs = Math.min(max, Math.max(err.code === 'auth' ? 60_000 : 0, base * 2 ** Math.min(status.consecutiveFailures - 1, 16)));
    return err;
  }

  /** Reads the camera list, emits offline/online changes, reports additions and removals. */
  async function syncCameras(): Promise<VmsCamera[]> {
    const cams = await paced(() => o.connector.cameras());
    const next = new Map(cams.map((c) => [c.id, c]));
    const changes: PlatformEvent[] = [];
    if (baselined) {
      for (const c of cams) {
        const before = known.get(c.id);
        if (before && before.online !== null && c.online !== null && before.online !== c.online) changes.push(cameraStateEvent(o.system, c, c.online, now()));
      }
    }
    const structural = !baselined || cams.length !== known.size || cams.some((c) => { const b = known.get(c.id); return !b || b.name !== c.name || b.group !== c.group; });
    known = next; baselined = true; status.cameras = cams.length;
    if (changes.length) { await o.emit(changes); status.eventsForwarded += changes.length; }
    if (structural) await o.onCameras?.(cams);
    return cams;
  }

  /** One poll of the event feed; returns how many events were forwarded. */
  async function pollEvents(): Promise<number> {
    let cursor = await o.cursors.get(o.system.id);
    let forwarded = 0;
    for (let i = 0; i < maxPages; i++) {
      const page = await paced(() => o.connector.events(cursor, pageSize));
      if (page.events.length) {
        const events = page.events.map((e) => platformEventFromVms(o.system, known.get(e.cameraId), e));
        await o.emit(events);
        forwarded += events.length;
        status.eventsForwarded += events.length;
      }
      // Saved only after emit returned: at-least-once, and the ids make a repeat harmless.
      if (page.cursor !== cursor) { await o.cursors.set(o.system.id, page.cursor); cursor = page.cursor; }
      status.cursor = cursor;
      if (!page.more) break;
    }
    return forwarded;
  }

  /** One full round (camera sync when due, then events). Never throws; the outcome is in `status()`. */
  let lastCameraSync = 0;
  async function tick(): Promise<void> {
    try {
      const t = Date.now();
      if (!baselined || t - lastCameraSync >= (o.cameraSyncIntervalMs ?? 60_000)) { await syncCameras(); lastCameraSync = t; }
      await pollEvents();
      status.pollsOk++;
      ok();
    } catch (e) {
      const err = failed(e);
      if (status.consecutiveFailures === 1 || status.consecutiveFailures % 10 === 0) log.warn(`[VMS ${o.system.id}] ${err.code}: ${err.message}`);
    }
  }

  return {
    tick,
    syncCameras,
    pollEvents,
    status: (): RunnerStatus => ({ ...status }),
    get running() { return !stopped; },
    start() {
      if (!stopped) return;
      stopped = false;
      loop = (async () => {
        while (!stopped) {
          await tick();
          const wait = status.state === 'ok' ? o.pollIntervalMs ?? 5000 : status.nextTryInMs;
          await new Promise<void>((resolve) => { const t = setTimeout(resolve, wait); wake = () => { clearTimeout(t); resolve(); }; t.unref?.(); });
          wake = null;
        }
      })();
    },
    async stop() { stopped = true; wake?.(); await loop; loop = null; },
  };
}
export type VmsRunner = ReturnType<typeof createVmsRunner>;
