/**
 * The decision table of docs/camera-onboarding-plan.md section 4: a probe report in, one playback recipe out.
 * Pure functions, no I/O, nothing keyed on a camera id. Each camera lands on the cheapest recipe that works.
 *
 *   A pass-through HLS      clean H.264: no B-frames, keyframes close enough together, little decoder damage
 *   B H.264 re-encode       H.264 with B-frames, keyframes too far apart, or damaged video (see below)
 *   C H.265 -> H.264        H.265 or any other codec the browser path cannot use
 *   D downscale re-encode   a re-encode (B or C) of a stream above 1080p, so the cost is cut before the transcode budget
 *   E direct WebRTC         a focus-time option (`focusRecipe`), not a grid recipe
 *   F snapshot only         video is unusable here: no capacity, no encoder, or the stream closed early
 *   G unsupported           unreachable, login rejected, or no frames; always with the reason
 *
 * Damaged video (decoder errors from loss upstream of us) needs the re-encode too: on 2026-10-08, five damaged but otherwise
 * ordinary H.264 cameras crashed MediaMTX's HLS muxer in pass-through, while the clean ones played.
 *
 * A clean stream above 1080p stays on A: it plays without a re-encode, which is cheaper than D.
 * Re-encodes use the Intel Quick Sync encoder (decision 2); with no hardware encoder they become F, never software.
 */
import { THRESHOLDS, type ProbeReport } from './cameraProfile';

export type Recipe = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export type EncoderKind = 'qsv' | 'none';
export type Speed = 'fast' | 'normal' | 'slow' | 'unknown';

/** What the media server should run for a re-encode. Step 3 turns this into MediaMTX config. */
export interface EncodeSpec {
  /** Keep the source codec for decoding (hardware decode for H.265). */
  inputCodec: string;
  bframes: 0;
  /** A keyframe at least this often, so HLS segments stay short whatever the camera sends. */
  keyframeEverySec: number;
  /** Downscale to at most this height; null leaves the size alone. */
  maxHeight: number | null;
}

export interface Decision {
  recipe: Recipe;
  /** One sentence naming the measurement that decided it. */
  reason: string;
  /** Needs one of the machine's transcode slots while it is live. */
  transcode: boolean;
  encode: EncodeSpec | null;
  /** False when the first picture is too slow for a grid tile: snapshots there, live only when focused. */
  gridLive: boolean;
  speed: Speed;
  /** Direct WebRTC can serve this camera when it is the focused one. */
  focusRecipe: 'E' | null;
  /** 0-100, higher is better. Provisional; replaces the hand-kept GRID_HEALTH_ORDER. */
  health: number;
  /** The recipe this camera wanted before a capacity or encoder limit moved it to F. */
  wanted?: Recipe;
}

export interface DecideOptions {
  encoder?: EncoderKind;
  /** How many probes in a row saw the stream close early; two or more make it unsupported. */
  closedEarlyRuns?: number;
}

const sec = (ms: number | null | undefined) => (ms == null ? null : ms / 1000);

export function speedOf(r: ProbeReport): Speed {
  const ms = r.sample?.timeToFirstFrameMs;
  if (ms == null) return 'unknown';
  return ms < THRESHOLDS.fastFirstFrameMs ? 'fast' : ms <= THRESHOLDS.maxStartMs ? 'normal' : 'slow';
}

/** 0-100. Failures score 0; slow start, damaged video and instability cost points; needing a re-encode costs a little. */
export function healthScore(r: ProbeReport): number {
  if (r.failure || !r.sample || r.sample.frames === 0) return 0;
  const s = r.sample, flags = new Set(r.flags);
  let score = 100;
  score -= Math.min(40, (sec(s.timeToFirstFrameMs) ?? 20) * 1.5);
  score -= Math.min(30, (s.corruptErrors / Math.max(s.frames, 1)) * 100 / 3);
  if (flags.has('closed_early')) score -= 20;
  if (flags.has('packet_loss')) score -= 20;
  if (flags.has('timestamp_problems')) score -= 10;
  if (flags.has('h265') || flags.has('other_codec') || flags.has('bframes') || flags.has('sparse_keyframes')) score -= 10;
  return Math.max(0, Math.round(score));
}

export function decide(r: ProbeReport, opts: DecideOptions = {}): Decision {
  const encoder = opts.encoder ?? 'qsv';
  const flags = new Set(r.flags);
  const health = healthScore(r);
  const speed = speedOf(r);
  const base = { transcode: false, encode: null, gridLive: false, speed, focusRecipe: null, health } as const;
  const noVideo = (reason: string): Decision => ({ ...base, recipe: 'G', reason });

  // G: nothing usable, and the reason says which stage failed.
  if (r.failure === 'unreachable') return noVideo(`Unreachable: ${r.failureDetail ?? 'no answer'}`);
  if (r.failure === 'bad_credentials') return noVideo(`Login rejected (401). Re-probe before trusting this: the grid also returns 401 when it limits the account`);
  if (r.failure === 'no_describe' || r.failure === 'no_frame') return noVideo(`No usable video: ${r.failureDetail ?? r.failure}`);
  if (!r.sample || !r.describe) return noVideo('Not probed far enough to measure the stream');
  if (r.sample.frames < THRESHOLDS.minFrames) return noVideo(r.sample.frames === 0 ? 'The stream connected but delivered no frames in the sample' : `Only ${r.sample.frames} frame(s) decoded in the sample; not a live video stream`);

  const d = r.describe, s = r.sample;

  if (flags.has('closed_early')) {
    const runs = opts.closedEarlyRuns ?? 1;
    const why = `The stream closed after ${s.elapsedSec}s of a ${s.requestedSec}s sample`;
    return runs >= 2 ? noVideo(`${why}, in ${runs} probes in a row`) : { ...base, recipe: 'F', reason: `${why}; snapshots until a second probe says whether it keeps closing` };
  }

  // What the browser path needs from this stream.
  const codecChange = d.codec !== 'h264';
  const gapProblem = flags.has('sparse_keyframes');
  const damaged = flags.has('corrupt_frames');
  const needsReencode = codecChange || flags.has('bframes') || gapProblem || damaged;
  const tall = (d.height ?? 0) > THRESHOLDS.highResHeight;

  let recipe: Recipe = 'A', reason = 'Clean H.264 with no B-frames and keyframes close enough together; plays as it is';
  if (needsReencode) {
    const causes: string[] = [];
    if (codecChange) causes.push(`${(d.codec ?? 'unknown codec').replace('hevc', 'H.265')}`);
    if (flags.has('bframes')) causes.push(s.maxReorderSec > 0 ? `B-frames (reordering up to ${s.maxReorderSec}s)` : 'B-frames');
    if (gapProblem) causes.push(`keyframes up to ${Math.round(Math.max(s.keyframeIntervalSec?.max ?? 0, s.sinceLastKeyframeSec))}s apart`);
    if (damaged) causes.push(`damaged video (${s.corruptErrors} decoder errors in ${s.frames} frames)`);
    recipe = tall ? 'D' : codecChange ? 'C' : 'B';
    reason = `${causes.join(', ')}${tall ? `, ${d.width}x${d.height}` : ''}: re-encoded to H.264 with a keyframe every 3s and no B-frames${tall ? `, scaled down to ${THRESHOLDS.highResHeight}p` : ''}`;
  }

  if (needsReencode && encoder === 'none') {
    return { ...base, recipe: 'F', reason: `Needs a re-encode (${reason.split(':')[0]}) but this machine has no hardware encoder; software encoding is not used`, wanted: recipe };
  }

  const webrtcOk = !!r.whep?.ok && d.codec === 'h264' && !flags.has('bframes') && !gapProblem && !damaged;
  return {
    recipe, reason,
    transcode: needsReencode,
    encode: needsReencode ? { inputCodec: d.codec ?? 'h264', bframes: 0, keyframeEverySec: 3, maxHeight: recipe === 'D' ? THRESHOLDS.highResHeight : null } : null,
    gridLive: s.timeToFirstFrameMs == null || s.timeToFirstFrameMs <= THRESHOLDS.maxStartMs,
    speed, focusRecipe: webrtcOk ? 'E' : null, health,
  };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface SlotRequest { cameraId: string; decision: Decision; /** Higher is served first: focused > analysis target > visible. */ priority: number }
export interface Allocation { cameraId: string; decision: Decision; live: boolean }

/**
 * Admission control (plan section 5). Cameras that need no transcode are free. The others share `slots`, highest
 * priority first (health breaks ties); the rest fall back to snapshot (F) with the reason, never silently.
 */
export function allocateSlots(requests: SlotRequest[], slots: number): Allocation[] {
  const order = requests.map((q, i) => ({ q, i })).sort((a, b) => b.q.priority - a.q.priority || b.q.decision.health - a.q.decision.health || a.i - b.i);
  let used = 0;
  const out = new Map<string, Allocation>();
  for (const { q } of order) {
    const dec = q.decision;
    if (dec.recipe === 'F' || dec.recipe === 'G') { out.set(q.cameraId, { cameraId: q.cameraId, decision: dec, live: false }); continue; }
    if (!dec.transcode) { out.set(q.cameraId, { cameraId: q.cameraId, decision: dec, live: true }); continue; }
    if (used < slots) { used++; out.set(q.cameraId, { cameraId: q.cameraId, decision: dec, live: true }); continue; }
    out.set(q.cameraId, {
      cameraId: q.cameraId, live: false,
      decision: { ...dec, recipe: 'F', transcode: false, encode: null, wanted: dec.recipe, reason: `No transcode slot free (${slots} in use); wanted ${dec.recipe}: ${dec.reason}` },
    });
  }
  return requests.map((q) => out.get(q.cameraId)!);
}
