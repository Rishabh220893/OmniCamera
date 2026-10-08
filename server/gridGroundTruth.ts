/**
 * What is already known about the 30 grid cameras (docs/camera-onboarding-plan.md section 3, evidence of 2026-10-08).
 * Used only to check a probe run, never to decide anything: a real camera is judged on its own measurements.
 * `flags` must all appear in the probe result; `failure` means the probe must name that failure stage.
 * Faults that depend on load or time (slow first frame, closed early, packet loss, whether a camera delivers at all)
 * are not asserted here because they vary run to run; they show up in the report.
 */
import type { FailureStage, FaultFlag } from './cameraProfile';

export interface Expectation { flags?: FaultFlag[]; failure?: FailureStage }

const cams = (ids: number[], e: Expectation): Record<string, Expectation> =>
  Object.fromEntries(ids.map((n) => [`cam${String(n).padStart(2, '0')}`, e]));

export const GRID_GROUND_TRUTH: Record<string, Expectation> = {
  ...cams([6, 12, 17], { flags: ['h265'] }),
  ...cams([9, 24, 27, 28], { flags: ['bframes'] }),
  // cam13 and cam14 were listed here after MediaMTX's "too many reordered frames" on 2026-10-07, but two probe runs show
  // no B-frames and no packet reordering on either (reorder 0.00 s). The MediaMTX error needs another explanation,
  // so it is not asserted here. Check media-server/bin/mediamtx.log for what it said about them.
  ...cams([30], { flags: ['sparse_keyframes'] }),
  ...cams([26], { flags: ['h265', 'high_resolution'] }),
  cam22: { flags: ['h265'] },
  // cam07, 08, 10, 18, 22 gave no usable video on 2026-10-07, yet cam07, 08 and 10 delivered frames (late) on 2026-10-08.
  // Whether a camera delivers is not stable, so it is not asserted here; the probe report records what it saw each time.
};
