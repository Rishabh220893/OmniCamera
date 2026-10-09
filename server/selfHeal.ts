/**
 * Self-healing (docs/camera-onboarding-plan.md section 7): when the media server keeps failing on a camera, move the camera one
 * rung down the ladder instead of leaving viewers on a broken tile, and bring it back up only through clean re-probes.
 *
 *   A (direct) -> floor B (re-encode) -> floor F (snapshots).      C and D go straight to floor F.
 *
 * The floor is stored beside the measurements, never in place of them (server/cameraRecipe.ts `heal`), so a manual override
 * still wins and "reset to measured" simply clears it. Self-healing never produces G: only a probe can say a camera has no video.
 *
 * Hysteresis, so a flaky camera does not flip between recipes:
 *   - demote after `failures` failures of one class inside `windowMs`, then nothing more for `cooldownMs`;
 *   - promote one rung only after `promoteProbes` clean probes in a row AND `promoteAfterMs` since the demotion, and the
 *     clock restarts at each rung.
 *
 * Mode (MEDIA_SELF_HEAL): `dry` (the default) records what it WOULD do and changes nothing; `on` acts and applies the change to the
 * running media server; `off` ignores events. Every decision is a row in recipe_changes with its evidence.
 */
import { FAILURE_KINDS, type MediaEvent, type MediaEventKind } from './mediaEvents';
import { decide, type EncoderKind, type Recipe } from './cameraRecipe';
import type { HealFloor, ProbeReport, ProfileRow, ProfileStore, RecipeChange } from './cameraProfile';

export type HealMode = 'off' | 'dry' | 'on';

export interface HealConfig {
  /** Failures of one class inside the window that move a camera down. */
  failures: number;
  windowMs: number;
  /** No further automatic change to a camera for this long after one. */
  cooldownMs: number;
  /** Clean probes in a row needed to move a camera back up. */
  promoteProbes: number;
  /** Minimum time since the demotion before it can be undone. */
  promoteAfterMs: number;
}

export const DEFAULT_HEAL_CONFIG: HealConfig = {
  failures: 3, windowMs: 10 * 60_000, cooldownMs: 30 * 60_000, promoteProbes: 2, promoteAfterMs: 24 * 3_600_000,
};

export function healModeFromEnv(env: Record<string, string | undefined>): HealMode {
  const v = (env.MEDIA_SELF_HEAL ?? '').trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : 'dry';
}

/** Settings from the environment; anything missing or not a positive number keeps the default. */
export function healConfigFromEnv(env: Record<string, string | undefined>): HealConfig {
  const num = (k: string, scale: number, d: number) => { const n = Number(env[k]); return Number.isFinite(n) && n > 0 ? n * scale : d; };
  const d = DEFAULT_HEAL_CONFIG;
  return {
    failures: Math.round(num('MEDIA_HEAL_FAILURES', 1, d.failures)),
    windowMs: num('MEDIA_HEAL_WINDOW_MIN', 60_000, d.windowMs),
    cooldownMs: num('MEDIA_HEAL_COOLDOWN_MIN', 60_000, d.cooldownMs),
    promoteProbes: Math.round(num('MEDIA_HEAL_PROMOTE_PROBES', 1, d.promoteProbes)),
    promoteAfterMs: num('MEDIA_HEAL_PROMOTE_HOURS', 3_600_000, d.promoteAfterMs),
  };
}

// ---------------------------------------------------------------------------
// The ladder (pure)
// ---------------------------------------------------------------------------

type FailureClass = 'muxer' | 'source' | 'ffmpeg' | 'start';
const CLASS_OF: Partial<Record<MediaEventKind, FailureClass>> = {
  dts_error: 'muxer', muxer_error: 'muxer', source_error: 'source', ffmpeg_exit: 'ffmpeg', start_timeout: 'start',
};
const CLASS_LABEL: Record<FailureClass, [string, string]> = {
  muxer: ['muxer crash', 'muxer crashes'], source: ['source error', 'source errors'], ffmpeg: ['re-encode exit', 're-encode exits'], start: ['start timeout', 'start timeouts'],
};

const LIVE: Recipe[] = ['A', 'B', 'C', 'D'];

/** The recipe a camera is played with right now: measurements, then any floor, then any manual override. */
export function effectiveRecipe(row: ProfileRow, encoder: EncoderKind): Recipe {
  return decide(row.report, { encoder, force: (row.override as Recipe | null) ?? undefined, heal: row.healFloor ?? null }).recipe;
}

/** The recipe the measurements alone give (no floor, no override). */
export function measuredRecipe(row: ProfileRow, encoder: EncoderKind): Recipe {
  return decide(row.report, { encoder }).recipe;
}

export interface Step { floor: 'B' | 'F'; from: Recipe; to: Recipe }

/** One rung down, or null when there is nowhere to go (already F or G, or a manual override is in charge). */
export function nextRungDown(row: ProfileRow, encoder: EncoderKind): Step | null {
  if (row.override) return null;
  if (row.report.failure) return null;
  const from = effectiveRecipe(row, encoder);
  if (!LIVE.includes(from)) return null;
  const floor: 'B' | 'F' = from === 'A' ? 'B' : 'F';
  const to = decide(row.report, { encoder, heal: { recipe: floor, reason: '' } }).recipe;
  return to === from ? null : { floor, from, to };
}

/**
 * True for a probe that says the camera is fine at the level it was demoted from: it gave video, did not close early, shows no
 * damage or packet loss (the faults that took the media server down), and the table would play it at the wanted level.
 * A camera that is damaged by nature therefore stays where self-healing put it until a person resets it.
 */
function cleanProbe(r: ProbeReport, target: 'A' | 'live', encoder: EncoderKind): boolean {
  if (r.failure || r.flags.includes('closed_early') || r.flags.includes('corrupt_frames') || r.flags.includes('packet_loss')) return false;
  const rec = decide(r, { encoder }).recipe;
  return target === 'A' ? rec === 'A' : LIVE.includes(rec);
}

export interface Promotion { floor: 'B' | null; probes: number }

/**
 * Whether a demoted camera may move one rung up. `history` is newest first. The clock for the next rung restarts at each step,
 * so F -> B and B -> measured need their own 24 h and their own clean probes.
 */
export function promotion(row: ProfileRow, history: ProbeReport[], now: number, cfg: HealConfig, encoder: EncoderKind): Promotion | null {
  const fl = row.healFloor;
  if (!fl || row.override) return null;
  const since = Date.parse(fl.at);
  if (!Number.isFinite(since) || now - since < cfg.promoteAfterMs) return null;
  const after = history.filter((h) => Date.parse(h.probedAt) > since).slice(0, cfg.promoteProbes);
  if (after.length < cfg.promoteProbes) return null;
  // Floor F (snapshots): the camera must look usable again. Floor B (forced re-encode): it must look clean enough for direct playing.
  if (!after.every((h) => cleanProbe(h, fl.recipe === 'B' ? 'A' : 'live', encoder))) return null;
  const natural = measuredRecipe(row, encoder);
  return { floor: fl.recipe === 'F' && natural === 'A' ? 'B' : null, probes: after.length };
}

// ---------------------------------------------------------------------------
// The healer
// ---------------------------------------------------------------------------

export interface HealStatus {
  mode: HealMode;
  config: HealConfig;
  /** Whether MediaMTX's log is being followed (self-healing needs it); false means only re-probing runs. */
  listening: boolean;
  listenError: string | null;
  counters: { failureEvents: number; ignoredAuth: number; demotions: number; wouldDemote: number; promotions: number; reprobeChanges: number; skippedOverride: number; applyErrors: number };
  lastError: string | null;
}

export interface HealDeps {
  store: ProfileStore;
  site: string;
  encoder: EncoderKind;
  mode: HealMode;
  cfg?: HealConfig;
  now?: () => number;
  /** Applies the stored profiles to the running media server; returns the errors, if any. Only called in mode `on`. */
  apply?: () => Promise<string[]>;
  log?: (msg: string) => void;
}

export interface SelfHealer {
  onEvent(ev: MediaEvent): Promise<void>;
  afterProbe(report: ProbeReport, previous: ProfileRow | null): Promise<void>;
  /** Clears a camera's floor ("reset to measured"). */
  reset(cameraId: string): Promise<boolean>;
  status(): HealStatus;
  setListening(listening: boolean, error?: string | null): void;
  /** Resolves when everything queued so far has been handled (for tests and shutdown). */
  idle(): Promise<void>;
}

export function createSelfHealer(d: HealDeps): SelfHealer {
  const cfg = d.cfg ?? DEFAULT_HEAL_CONFIG;
  const now = d.now ?? (() => Date.now());
  const log = d.log ?? (() => {});
  const windows = new Map<string, MediaEvent[]>();
  const loss = new Map<string, number>();
  const lastChange = new Map<string, number>();
  const counters: HealStatus['counters'] = { failureEvents: 0, ignoredAuth: 0, demotions: 0, wouldDemote: 0, promotions: 0, reprobeChanges: 0, skippedOverride: 0, applyErrors: 0 };
  let listening = false, listenError: string | null = null, lastError: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chain = chain.then(fn).catch((e) => { lastError = e instanceof Error ? e.message : String(e); log(`[HEAL] ${lastError}`); });
    return chain;
  };

  async function applyNow() {
    if (!d.apply) return;
    try {
      const errors = await d.apply();
      if (errors.length) { counters.applyErrors += errors.length; lastError = `Applying to the media server: ${errors[0]}`; }
    } catch (e) { counters.applyErrors++; lastError = `Applying to the media server: ${e instanceof Error ? e.message : String(e)}`; }
  }
  const record = (c: Omit<RecipeChange, 'site'>) => d.store.recordChange({ site: d.site, ...c });

  async function demote(cameraId: string, cls: FailureClass, events: MediaEvent[]) {
    const row = await d.store.getProfile(d.site, cameraId);
    if (!row) return;
    if (row.override) { counters.skippedOverride++; return; }
    const step = nextRungDown(row, d.encoder);
    if (!step) return;
    const at = now();
    // Cooldown counts the last change of any kind, including a dry-run one, so a dry run does not repeat every few minutes.
    const prior = lastChange.get(cameraId) ?? Date.parse((await d.store.changes(d.site, cameraId, 1))[0]?.at ?? '');
    if (Number.isFinite(prior) && at - prior < cfg.cooldownMs) return;

    const spanMin = Math.max(1, Math.round((events[events.length - 1].at - events[0].at) / 60_000));
    const label = CLASS_LABEL[cls][events.length === 1 ? 0 : 1];
    const trigger = `${events.length} ${label} in ${spanMin} min while the media server was serving it`;
    const evidence = { class: cls, events: events.map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, message: e.message })), rtpPacketsLost: loss.get(cameraId) ?? 0 };
    const iso = new Date(at).toISOString();
    lastChange.set(cameraId, at);
    windows.delete(cameraId);
    if (d.mode !== 'on') {
      counters.wouldDemote++;
      await record({ cameraId, at: iso, from: step.from, to: step.to, source: 'dry', trigger, evidence });
      log(`[HEAL] dry run: would move ${cameraId} ${step.from} -> ${step.to}: ${trigger}`);
      return;
    }
    const floor: HealFloor = { recipe: step.floor, reason: trigger, at: iso };
    await d.store.setHealFloor(d.site, cameraId, floor);
    await record({ cameraId, at: iso, from: step.from, to: step.to, source: 'auto', trigger, evidence });
    counters.demotions++;
    log(`[HEAL] moved ${cameraId} ${step.from} -> ${step.to}: ${trigger}`);
    await applyNow();
  }

  return {
    onEvent(ev) {
      if (d.mode === 'off') return Promise.resolve();
      if (ev.kind === 'packet_loss') { loss.set(ev.cameraId, (loss.get(ev.cameraId) ?? 0) + (ev.value ?? 0)); return Promise.resolve(); }
      if (ev.kind === 'auth_rejected') { counters.ignoredAuth++; return Promise.resolve(); }
      const cls = CLASS_OF[ev.kind];
      if (!cls || !FAILURE_KINDS.has(ev.kind)) return Promise.resolve();
      counters.failureEvents++;
      const win = (windows.get(ev.cameraId) ?? []).filter((e) => ev.at - e.at <= cfg.windowMs);
      win.push(ev);
      windows.set(ev.cameraId, win);
      const same = win.filter((e) => CLASS_OF[e.kind] === cls);
      if (same.length < cfg.failures) return Promise.resolve();
      return enqueue(() => demote(ev.cameraId, cls, same.slice(-cfg.failures)));
    },

    afterProbe(report, previous) {
      if (d.mode === 'off') return Promise.resolve();
      return enqueue(async () => {
        let row = await d.store.getProfile(d.site, report.cameraId);
        if (!row) return;
        const before = previous ? effectiveRecipe(previous, d.encoder) : null;
        if (row.healFloor && d.mode === 'on') {
          const up = promotion(row, await d.store.history(d.site, report.cameraId, 20), now(), cfg, d.encoder);
          if (up) {
            const iso = new Date(now()).toISOString();
            const from = effectiveRecipe(row, d.encoder);
            const floor: HealFloor | null = up.floor ? { recipe: up.floor, reason: `promoted from snapshots after ${up.probes} clean probes`, at: iso } : null;
            await d.store.setHealFloor(d.site, report.cameraId, floor);
            row = (await d.store.getProfile(d.site, report.cameraId)) ?? row;
            const to = effectiveRecipe(row, d.encoder);
            await record({ cameraId: report.cameraId, at: iso, from, to, source: 'auto', trigger: `${up.probes} clean probes in a row, ${Math.round(cfg.promoteAfterMs / 3_600_000)} h or more after the move down`, evidence: { floor: floor?.recipe ?? null } });
            counters.promotions++;
            log(`[HEAL] moved ${report.cameraId} back up ${from} -> ${to}`);
          }
        }
        const after = effectiveRecipe(row, d.encoder);
        if (before && before !== after) {
          // A probe changed how the camera is played. Record it in every mode, apply it only when self-healing is on.
          await record({ cameraId: report.cameraId, at: new Date(now()).toISOString(), from: before, to: after, source: 'reprobe', trigger: `re-probe: ${decide(report, { encoder: d.encoder }).cause ?? 'measurements changed'}`, evidence: { probedAt: report.probedAt } });
          counters.reprobeChanges++;
        }
        if (d.mode === 'on' && before !== after) await applyNow();
      });
    },

    async reset(cameraId) {
      let did = false;
      await enqueue(async () => {
        const row = await d.store.getProfile(d.site, cameraId);
        if (!row?.healFloor) return;
        const from = effectiveRecipe(row, d.encoder);
        await d.store.setHealFloor(d.site, cameraId, null);
        const to = effectiveRecipe({ ...row, healFloor: null }, d.encoder);
        await record({ cameraId, at: new Date(now()).toISOString(), from, to, source: 'manual', trigger: 'reset to measured', evidence: {} });
        windows.delete(cameraId);
        lastChange.set(cameraId, now());
        did = true;
        if (d.mode === 'on') await applyNow();
      });
      return did;
    },

    status: () => ({ mode: d.mode, config: cfg, listening, listenError, counters: { ...counters }, lastError }),
    setListening(v, error = null) { listening = v; listenError = error; },
    idle: () => chain,
  };
}
