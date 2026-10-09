/**
 * Background tracking across every camera (Feed > Full Panel). One job at a time looks for one thing in all the cameras it was given,
 * whether or not anyone has a camera open:
 *
 *   plate   a licence plate. The ANPR service reads the plates in each frame; the typed plate is compared with every read,
 *           ignoring spaces and case, and a read that is one OCR-confusable edit away is reported as a *possible* match.
 *   face    a person. A reference photo and the camera frame go to Gemini, which says whether it is the same person.
 *   rules   free-text suspicious-activity rules (the same idea as a camera's "Suspicious Rules"), applied to every camera at once.
 *
 * Every camera is checked on its own cycle (10 s by default), measured from when its last check STARTED, with the cycles of different
 * cameras spread across the interval and a bounded number of checks in flight. Cameras that cannot be captured back off, so one dead
 * camera does not eat the budget. A scene that has not changed since the last check is not sent to the model again (the frame gate).
 * A hit becomes an alert with the frame as evidence; the same camera is not alerted again for the cooldown (hits are still counted).
 *
 * All I/O is injected, so the scheduling and matching are tested without ffmpeg, ANPR or Gemini.
 */
import { normalizePlate, plateDistance } from '../src/lib/plateTracking';
import type { FrameGate } from './frameGate';

export type TrackMode = 'plate' | 'face' | 'rules';

export type TrackSpec =
  | { mode: 'plate'; plate: string }
  | { mode: 'face'; label: string; image: Buffer; mimeType: string }
  | { mode: 'rules'; rules: string };

export interface TrackCamera { id: string; name: string; url: string }

export interface PlateRead {
  text: string;
  confidence: number;
  /** What the plate reader saw before it corrected look-alike characters by position, when it did. */
  rawText?: string;
}

export interface TrackDeps {
  now(): number;
  grabFrame(camera: TrackCamera): Promise<Buffer>;
  /** ANPR first; `gemini-fallback` when the plate reader is not configured or failed. */
  readPlates(frame: Buffer): Promise<{ plates: PlateRead[]; source: 'anpr' | 'gemini-fallback' }>;
  matchFace(frame: Buffer, reference: { image: Buffer; mimeType: string; label: string }): Promise<{ match: boolean; confidence: number; reason: string }>;
  checkRules(frame: Buffer, rules: string, cameraName: string): Promise<{ violated: boolean; confidence: number; reason: string }>;
  /** Optional: scenes that did not change since the last check are not analysed again. */
  gate?: FrameGate;
  log?: Pick<Console, 'info' | 'warn'>;
}

export interface TrackOptions {
  intervalMs: number;
  /** Checks in flight at once (each is a capture from the camera, then a model call). */
  concurrency: number;
  tickMs: number;
  maxBackoffMs: number;
  /** The same camera is not alerted again inside this window. */
  alertCooldownMs: number;
  /** Gemini must be at least this sure for a face or rule hit to count. */
  minConfidence: number;
  maxAlerts: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  intervalMs: 10_000, concurrency: 4, tickMs: 500, maxBackoffMs: 60_000, alertCooldownMs: 30_000, minConfidence: 0.7, maxAlerts: 100,
};

export interface TrackAlert {
  id: number;
  at: string;
  cameraId: string;
  cameraName: string;
  kind: 'plate' | 'face' | 'rule';
  /** `possible`: a plate one OCR-confusable edit away from the typed one. */
  certainty: 'match' | 'possible';
  title: string;
  detail: string;
  confidence: number | null;
  /** Where the answer came from: anpr, gemini or gemini-fallback (an unverified plate read). */
  source: string;
  hasFrame: boolean;
}

export type CameraState = 'waiting' | 'checking' | 'ok' | 'unchanged' | 'error';

export interface CameraStatus {
  id: string;
  name: string;
  state: CameraState;
  lastCheckedAt: string | null;
  lastError: string | null;
  checks: number;
  hits: number;
  lastNote: string | null;
}

export interface TrackStatus {
  active: boolean;
  mode: TrackMode | null;
  /** What is being looked for, for display: the plate, the reference label, or the rules. Never the image. */
  target: string | null;
  startedAt: string | null;
  intervalSec: number;
  cameras: CameraStatus[];
  counters: { checks: number; skippedUnchanged: number; geminiCalls: number; anprCalls: number; failures: number; alerts: number };
  queue: { active: number; concurrency: number };
  /** Average seconds between two checks of the same camera, so a slow grid shows up as a longer cycle than the 10 s asked for. null until measured. */
  measuredCycleSec: number | null;
  /** Cameras whose next check is overdue by more than one interval. */
  late: number;
  alerts: TrackAlert[];
  lastAlertId: number;
}

interface CamRun {
  camera: TrackCamera;
  nextDueAt: number;
  running: boolean;
  failures: number;
  state: CameraState;
  lastCheckedAt: number | null;
  lastStartedAt: number | null;
  gaps: number[];
  lastError: string | null;
  checks: number;
  hits: number;
  lastNote: string | null;
  lastAlertAt: number;
}

export interface Tracker {
  start(spec: TrackSpec, cameras: TrackCamera[]): void;
  stop(): void;
  /** Starts every camera that is due (up to the concurrency limit) and resolves when those checks finish. For tests; a timer calls it in production. */
  tick(): Promise<void>;
  status(afterAlertId?: number): TrackStatus;
  alertFrame(id: number): Buffer | null;
  shutdown(): void;
}

export function normalizeTrackedPlate(raw: string): string { return normalizePlate(raw); }

/**
 * The read is the wanted plate misread by the plate reader: the same length, and every difference is a swap between characters OCR
 * confuses (0/O, 1/I, 8/B, 5/S, 2/Z, 6/G, U/V), at most two. Any other one-character difference is a different plate: in a city, plates
 * that differ by one digit are common, and each would raise a false alarm.
 */
export function isLookAlike(wanted: string, seen: string): boolean {
  if (wanted.length !== seen.length) return false;
  const { edits } = plateDistance(wanted, seen);
  return edits.length > 0 && edits.length <= 2 && edits.every((e) => e.type === 'confusable');
}

/** A plate is worth comparing only if it is long enough to be a plate at all. */
const MIN_PLATE_LEN = 5;

export function createTracker(deps: TrackDeps, overrides: Partial<TrackOptions> = {}): Tracker {
  const opts: TrackOptions = { ...DEFAULT_TRACK_OPTIONS, ...overrides };
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  let spec: TrackSpec | null = null;
  let startedAt: number | null = null;
  let generation = 0;
  let runs = new Map<string, CamRun>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let alerts: Array<TrackAlert & { frame: Buffer | null }> = [];
  let nextAlertId = 1;
  let counters = { checks: 0, skippedUnchanged: 0, geminiCalls: 0, anprCalls: 0, failures: 0, alerts: 0 };
  let inFlight = 0;
  const pending = new Set<Promise<void>>();

  const targetOf = (s: TrackSpec) => (s.mode === 'plate' ? s.plate : s.mode === 'face' ? s.label : s.rules);

  function raise(run: CamRun, a: Omit<TrackAlert, 'id' | 'at' | 'cameraId' | 'cameraName' | 'hasFrame'>, frame: Buffer) {
    const now = deps.now();
    run.hits++;
    // One alert per camera per cooldown: a car parked in view must not raise a new alarm every ten seconds.
    if (now - run.lastAlertAt < opts.alertCooldownMs) return;
    run.lastAlertAt = now;
    counters.alerts++;
    alerts.push({ ...a, id: nextAlertId++, at: new Date(now).toISOString(), cameraId: run.camera.id, cameraName: run.camera.name, hasFrame: true, frame });
    if (alerts.length > opts.maxAlerts) alerts = alerts.slice(-opts.maxAlerts);
    log.warn(`[TRACKING] ${a.kind} ${a.certainty} on ${run.camera.name}: ${a.detail}`);
  }

  async function check(run: CamRun, myGeneration: number) {
    const s = spec!;
    const startedAtMs = deps.now();
    if (run.lastStartedAt !== null) { run.gaps.push(startedAtMs - run.lastStartedAt); if (run.gaps.length > 8) run.gaps.shift(); }
    run.lastStartedAt = startedAtMs;
    run.state = 'checking';
    try {
      const frame = await deps.grabFrame(run.camera);
      if (myGeneration !== generation) return;
      const decision = deps.gate ? await deps.gate.check(run.camera.id, frame, deps.now()) : null;
      if (decision && !decision.analyze) {
        counters.skippedUnchanged++;
        run.state = 'unchanged'; run.lastNote = 'scene unchanged since the last check';
      } else {
        if (s.mode === 'plate') await checkPlate(run, s.plate, frame);
        else if (s.mode === 'face') await checkFace(run, s, frame);
        else await checkRules(run, s.rules, frame);
        decision?.commit();
        if (myGeneration !== generation) return;
        run.state = 'ok';
      }
      run.failures = 0; run.lastError = null;
      run.checks++; counters.checks++;
      run.lastCheckedAt = deps.now();
    } catch (err) {
      if (myGeneration !== generation) return;
      run.failures++; counters.failures++;
      run.state = 'error';
      run.lastError = (err instanceof Error ? err.message : String(err)).replace(/rtsp:\/\/[^@\s"']*@/g, 'rtsp://***@').slice(0, 200);
      run.lastCheckedAt = deps.now();
    } finally {
      if (myGeneration === generation) {
        const wait = run.failures > 0 ? Math.min(opts.maxBackoffMs, Math.max(opts.intervalMs, opts.intervalMs * 2 ** Math.min(run.failures, 6))) : opts.intervalMs;
        // From the START of this check, so a 10 s camera runs every 10 s and not every 10 s plus the capture time, but never straight away.
        run.nextDueAt = Math.max(startedAtMs + wait, deps.now() + 1_000);
        run.running = false;
      }
    }
  }

  async function checkPlate(run: CamRun, wanted: string, frame: Buffer) {
    const { plates, source } = await deps.readPlates(frame);
    if (source === 'anpr') counters.anprCalls++; else counters.geminiCalls++;
    run.lastNote = plates.length ? `read ${plates.map((p) => p.text).join(', ')}` : 'no plate in view';
    for (const p of plates) {
      const seen = normalizePlate(p.text);
      if (seen.length < MIN_PLATE_LEN) continue;
      const unverified = (source === 'gemini-fallback' ? ' (unverified read: the plate reader was not available)' : '')
        + (p.rawText && normalizePlate(p.rawText) !== seen ? ` (the plate reader corrected ${normalizePlate(p.rawText)} by plate format)` : '');
      if (seen === wanted) {
        raise(run, { kind: 'plate', certainty: 'match', title: `Plate ${wanted} found`, detail: `${wanted} read on ${run.camera.name}${unverified}`, confidence: p.confidence, source }, frame);
      } else if (isLookAlike(wanted, seen)) {
        raise(run, { kind: 'plate', certainty: 'possible', title: `Possible match for ${wanted}`, detail: `Read ${seen} on ${run.camera.name}: one look-alike character away from ${wanted}${unverified}`, confidence: p.confidence, source }, frame);
      }
    }
  }

  async function checkFace(run: CamRun, s: Extract<TrackSpec, { mode: 'face' }>, frame: Buffer) {
    counters.geminiCalls++;
    const r = await deps.matchFace(frame, { image: s.image, mimeType: s.mimeType, label: s.label });
    run.lastNote = r.match ? `possible match (${Math.round(r.confidence * 100)}%)` : 'not seen';
    if (r.match && r.confidence >= opts.minConfidence) {
      raise(run, { kind: 'face', certainty: 'match', title: `${s.label} seen`, detail: `${r.reason} (${run.camera.name})`, confidence: r.confidence, source: 'gemini' }, frame);
    }
  }

  async function checkRules(run: CamRun, rules: string, frame: Buffer) {
    counters.geminiCalls++;
    const r = await deps.checkRules(frame, rules, run.camera.name);
    run.lastNote = r.violated ? `rule matched (${Math.round(r.confidence * 100)}%)` : 'nothing matching the rules';
    if (r.violated && r.confidence >= opts.minConfidence) {
      raise(run, { kind: 'rule', certainty: 'match', title: 'Suspicious activity', detail: `${r.reason} (${run.camera.name})`, confidence: r.confidence, source: 'gemini' }, frame);
    }
  }

  async function tick() {
    if (!spec) return;
    const now = deps.now();
    const due = [...runs.values()].filter((r) => !r.running && r.nextDueAt <= now).sort((a, b) => a.nextDueAt - b.nextDueAt);
    const myGeneration = generation;
    for (const run of due) {
      if (inFlight >= opts.concurrency) break;
      run.running = true; inFlight++;
      const p = check(run, myGeneration).finally(() => { inFlight--; pending.delete(p); });
      pending.add(p);
    }
    await Promise.all([...pending]);
  }

  return {
    start(newSpec, cameras) {
      generation++;
      spec = newSpec; startedAt = deps.now(); alerts = []; nextAlertId = 1; inFlight = 0; pending.clear();
      counters = { checks: 0, skippedUnchanged: 0, geminiCalls: 0, anprCalls: 0, failures: 0, alerts: 0 };
      runs = new Map();
      const unique = [...new Map(cameras.map((c) => [c.id, c])).values()];
      // Cameras are spread across the interval, so 30 of them do not all start at the same second.
      unique.forEach((camera, k) => runs.set(camera.id, {
        camera, nextDueAt: startedAt! + Math.floor((k / unique.length) * opts.intervalMs), running: false, failures: 0, state: 'waiting',
        lastCheckedAt: null, lastStartedAt: null, gaps: [], lastError: null, checks: 0, hits: 0, lastNote: null, lastAlertAt: -Infinity,
      }));
      deps.gate && unique.forEach((c) => deps.gate!.forget(c.id));
      if (timer) clearInterval(timer);
      timer = setInterval(() => { void tick(); }, opts.tickMs);
      timer.unref?.();
      log.info(`[TRACKING] started: ${newSpec.mode} across ${unique.length} cameras every ${opts.intervalMs / 1000}s`);
    },

    stop() {
      generation++;
      spec = null; startedAt = null;
      if (timer) clearInterval(timer);
      timer = null;
      for (const r of runs.values()) r.running = false;
      inFlight = 0; pending.clear();
      log.info('[TRACKING] stopped');
    },

    tick,

    status(afterAlertId = 0) {
      const now = deps.now();
      const all = [...runs.values()];
      const gaps = all.flatMap((r) => r.gaps);
      return {
        active: spec !== null,
        mode: spec?.mode ?? null,
        target: spec ? targetOf(spec) : null,
        startedAt: startedAt !== null ? new Date(startedAt).toISOString() : null,
        intervalSec: opts.intervalMs / 1000,
        cameras: all.map((r) => ({
          id: r.camera.id, name: r.camera.name, state: r.state, checks: r.checks, hits: r.hits, lastNote: r.lastNote, lastError: r.lastError,
          lastCheckedAt: r.lastCheckedAt !== null ? new Date(r.lastCheckedAt).toISOString() : null,
        })),
        counters: { ...counters },
        queue: { active: inFlight, concurrency: opts.concurrency },
        measuredCycleSec: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) / 100) / 10 : null,
        late: all.filter((r) => !r.running && now - r.nextDueAt > opts.intervalMs).length,
        alerts: alerts.filter((a) => a.id > afterAlertId).map(({ frame: _frame, ...rest }) => rest),
        lastAlertId: nextAlertId - 1,
      };
    },

    alertFrame: (id) => alerts.find((a) => a.id === id)?.frame ?? null,
    shutdown() { if (timer) clearInterval(timer); timer = null; },
  };
}
