/**
 * Runs the configured department systems (federation plan A2/A6): keeps the list of systems in a file, one runner per system, saves
 * each system's event position in a file, and publishes what the runners find to the event bus, from where alerting (and later
 * search and correlation) pick it up. One department's failure never stops another's runner.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../bus/types';
import { isSafeCameraUrl } from '../../frameSource';
import type { PlatformEvent } from '../../events/schema';
import { createVmsRunner, type CursorStore, type RunnerStatus, type VmsRunner } from './runner';
import { VmsError, validateSystemConfig, type VmsCamera, type VmsConnector, type VmsSystemConfig } from './types';
import type { createVmsConnectorTypes } from './index';

import { EVENT_TOPIC } from '../../bus/topics';
export { EVENT_TOPIC };

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw e; }
}
async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

export function createFileCursorStore(file: string): CursorStore {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    get: async (id) => (await readJson<Record<string, string>>(file, {}))[id] ?? null,
    set: (id, cursor) => {
      const run = chain.then(async () => { const all = await readJson<Record<string, string>>(file, {}); all[id] = cursor; await writeJson(file, all); });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** What the API shows about a system: everything except the login. */
export interface SystemView {
  id: string; label?: string; kind: string; baseUrl: string; department?: string; ownerUserId: string; timezoneOffsetMinutes?: number;
  hasCredentials: boolean;
  status: RunnerStatus | null;
}

export interface VmsServiceOptions {
  types: ReturnType<typeof createVmsConnectorTypes>;
  systemsFile: string;
  cursors: CursorStore;
  bus: EventBus;
  /** Allow systems on private networks (departmental VMSs usually are). Default false. */
  allowPrivate?: boolean;
  pollIntervalMs?: number;
  minGapMs?: number;
  /** Replaces the real connector, for tests. */
  connectorFor?: (cfg: VmsSystemConfig) => VmsConnector;
  onCameras?: (system: VmsSystemConfig, cameras: VmsCamera[]) => void | Promise<void>;
  log?: Pick<Console, 'warn' | 'info'>;
}

export function createVmsService(o: VmsServiceOptions) {
  const log = o.log ?? console;
  const systems = new Map<string, VmsSystemConfig>();
  const runners = new Map<string, VmsRunner>();
  const connectors = new Map<string, VmsConnector>();
  let loaded = false;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => undefined); return r; };

  const connectorOf = (cfg: VmsSystemConfig): VmsConnector => {
    let c = connectors.get(cfg.id);
    if (!c) { c = o.connectorFor ? o.connectorFor(cfg) : o.types.get(cfg.kind).create(cfg); connectors.set(cfg.id, c); }
    return c;
  };
  const persist = () => writeJson(o.systemsFile, [...systems.values()]);

  function startRunner(cfg: VmsSystemConfig) {
    const runner = createVmsRunner({
      system: cfg, connector: connectorOf(cfg), cursors: o.cursors, pollIntervalMs: o.pollIntervalMs, minGapMs: o.minGapMs, log,
      emit: async (events: PlatformEvent[]) => { await o.bus.publish(EVENT_TOPIC, events.map((e) => ({ key: e.cameraId, value: e }))); },
      onCameras: (cams) => o.onCameras?.(cfg, cams),
    });
    runners.set(cfg.id, runner);
    runner.start();
  }

  function checkAddress(cfg: VmsSystemConfig) {
    if (!o.allowPrivate && !isSafeCameraUrl(cfg.baseUrl)) throw new VmsError('That address is on a private network, which this server will not contact (set VMS_ALLOW_PRIVATE=true to allow it).', 'protocol');
  }

  const view = (cfg: VmsSystemConfig): SystemView => ({
    id: cfg.id, label: cfg.label, kind: cfg.kind, baseUrl: cfg.baseUrl, department: cfg.department, ownerUserId: cfg.ownerUserId,
    timezoneOffsetMinutes: cfg.timezoneOffsetMinutes, hasCredentials: !!cfg.credentials, status: runners.get(cfg.id)?.status() ?? null,
  });

  return {
    /** Reads the saved systems and starts a runner for each. */
    load: () => serial(async () => {
      if (loaded) return;
      for (const raw of await readJson<unknown[]>(o.systemsFile, [])) {
        try { const cfg = validateSystemConfig(raw); o.types.get(cfg.kind); systems.set(cfg.id, cfg); }
        catch (e) { log.warn(`[VMS] skipped a saved system: ${e instanceof Error ? e.message : e}`); }
      }
      loaded = true;
      for (const cfg of systems.values()) startRunner(cfg);
    }),

    add: (raw: unknown) => serial(async () => {
      const cfg = validateSystemConfig(raw);
      o.types.get(cfg.kind);
      checkAddress(cfg);
      if (systems.has(cfg.id)) throw new VmsError(`A system named '${cfg.id}' already exists.`, 'protocol');
      systems.set(cfg.id, cfg);
      await persist();
      startRunner(cfg);
      return view(cfg);
    }),

    remove: (id: string) => serial(async () => {
      if (!systems.delete(id)) return false;
      await runners.get(id)?.stop();
      await connectors.get(id)?.close?.();
      runners.delete(id); connectors.delete(id);
      await persist();
      return true;
    }),

    list: (): SystemView[] => [...systems.values()].map(view),
    get: (id: string) => { const c = systems.get(id); return c ? view(c) : null; },
    config: (id: string) => systems.get(id) ?? null,
    types: () => o.types.list(),

    /** One immediate round for a system (used by the "sync now" button and tests). */
    async syncNow(id: string): Promise<SystemView | null> {
      const r = runners.get(id), cfg = systems.get(id);
      if (!r || !cfg) return null;
      await r.tick();
      return view(cfg);
    },

    async health(id: string) {
      const cfg = systems.get(id);
      return cfg ? connectorOf(cfg).health() : null;
    },
    async cameras(id: string) {
      const cfg = systems.get(id);
      return cfg ? connectorOf(cfg).cameras() : null;
    },

    async stop() {
      await Promise.all([...runners.values()].map((r) => r.stop()));
      await Promise.all([...connectors.values()].map((c) => c.close?.()));
      runners.clear(); connectors.clear();
    },
  };
}
export type VmsService = ReturnType<typeof createVmsService>;
