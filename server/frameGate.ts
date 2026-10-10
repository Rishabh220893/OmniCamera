import { spawn } from 'child_process';

/**
 * Cheap pre-filter in front of the (expensive, rate-limited) Gemini call.
 *
 * Most frames from a fixed camera are the same as the last one. Each frame is reduced to a tiny
 * greyscale fingerprint; if almost nothing changed since the last frame that WAS analysed, the
 * model call is skipped. A heartbeat still forces an analysis every `maxSkipMs`, so a quiet scene
 * is not silent forever.
 *
 * The gate is deliberately a plain interface (`FrameGate`): a local object detector (YOLO etc.)
 * can replace the pixel-difference one without touching the worker.
 */
export const FINGERPRINT_W = 64;
export const FINGERPRINT_H = 36;
const FINGERPRINT_BYTES = FINGERPRINT_W * FINGERPRINT_H;

export type Fingerprint = Uint8Array;

/** The ffmpeg arguments that reduce an image on stdin to the fingerprint on stdout. */
export const FINGERPRINT_ARGS = ['-loglevel', 'error', '-i', 'pipe:0', '-vf', `scale=${FINGERPRINT_W}:${FINGERPRINT_H}:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'];

/** Reduces a JPEG/PNG to a 64x36 greyscale fingerprint with ffmpeg. Null if it can't be decoded. */
export function ffmpegFingerprint(frame: Buffer, timeoutMs = 5_000): Promise<Fingerprint | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffmpeg', FINGERPRINT_ARGS, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: Fingerprint | null) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeoutMs);
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => finish(null));
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      finish(out.length === FINGERPRINT_BYTES ? new Uint8Array(out) : null);
    });
    child.stdin.on('error', () => { /* ffmpeg exited early; 'close' reports it */ });
    child.stdin.end(frame);
  });
}

export interface FingerprintDiff {
  /** Share of pixels whose brightness moved by more than `pixelDelta` (0..1). */
  changedFraction: number;
  /** Mean absolute brightness difference (0..255). */
  meanDelta: number;
}

export function diffFingerprints(a: Fingerprint, b: Fingerprint, pixelDelta = 24): FingerprintDiff {
  const n = Math.min(a.length, b.length);
  if (n === 0 || a.length !== b.length) return { changedFraction: 1, meanDelta: 255 };
  let changed = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > pixelDelta) changed++;
  }
  return { changedFraction: changed / n, meanDelta: sum / n };
}

export type GateDecision =
  | { analyze: true; reason: 'first-frame' | 'changed' | 'heartbeat' | 'unreadable' }
  | { analyze: false; reason: 'unchanged' };

export interface FrameGate {
  /**
   * Decide whether this frame is worth a model call. `commit` must be called once the frame has
   * really been analysed, so a failed analysis does not become the new baseline.
   */
  check(cameraId: string, frame: Buffer, now: number): Promise<GateDecision & { commit(): void }>;
  forget(cameraId: string): void;
  stats(): { skipped: number; analysed: number };
}

export interface MotionGateOptions {
  /** Pixels that changed by more than this count as "moved" (0..255). */
  pixelDelta: number;
  /** Analyse when at least this share of pixels moved. 0.02 ≈ a person entering a wide scene. */
  changedFraction: number;
  /** Analyse at least this often even if nothing changed. */
  maxSkipMs: number;
  fingerprint: (frame: Buffer) => Promise<Fingerprint | null>;
}

export const DEFAULT_GATE_OPTIONS: Omit<MotionGateOptions, 'fingerprint'> = {
  pixelDelta: 24,
  changedFraction: 0.02,
  maxSkipMs: 10 * 60_000,
};

export function createMotionGate(overrides: Partial<MotionGateOptions> = {}): FrameGate {
  const opts: MotionGateOptions = { ...DEFAULT_GATE_OPTIONS, fingerprint: ffmpegFingerprint, ...overrides };
  // Baseline = the last frame that was actually sent to the model, not merely the last one seen.
  // Comparing to the last *seen* frame would let a slow change (dusk, a car creeping in) never trigger.
  const baseline = new Map<string, { fp: Fingerprint; analysedAt: number }>();
  let skipped = 0, analysed = 0;

  return {
    async check(cameraId, frame, now) {
      const fp = await opts.fingerprint(frame);
      const base = baseline.get(cameraId);
      const commitWith = (value: Fingerprint | null) => () => {
        analysed++;
        if (value) baseline.set(cameraId, { fp: value, analysedAt: now });
        else baseline.delete(cameraId);
      };
      // Fail open: if the frame can't be fingerprinted, analysing is always safe, skipping is not.
      if (!fp) return { analyze: true, reason: 'unreadable', commit: commitWith(null) };
      if (!base) return { analyze: true, reason: 'first-frame', commit: commitWith(fp) };
      if (now - base.analysedAt >= opts.maxSkipMs) return { analyze: true, reason: 'heartbeat', commit: commitWith(fp) };
      const diff = diffFingerprints(base.fp, fp, opts.pixelDelta);
      if (diff.changedFraction >= opts.changedFraction) return { analyze: true, reason: 'changed', commit: commitWith(fp) };
      skipped++;
      return { analyze: false, reason: 'unchanged', commit: () => {} };
    },
    forget: (cameraId) => { baseline.delete(cameraId); },
    stats: () => ({ skipped, analysed }),
  };
}
