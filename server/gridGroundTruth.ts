/**
 * What is already known about the 30 grid cameras (docs/camera-onboarding-plan.md section 3, evidence of 2026-10-08).
 * Used only to check a probe run, never to decide anything: a real camera is judged on its own measurements.
 * `flags` must all appear in the probe result; `failure` means the probe must name that failure stage.
 * Faults that depend on load or time (slow first frame, closed early, packet loss) are not asserted here
 * because they vary run to run; they show up in the report as notes.
 */
import type { FailureStage, FaultFlag } from './cameraProfile';

export interface Expectation { flags?: FaultFlag[]; failure?: FailureStage }

const cams = (ids: number[], e: Expectation): Record<string, Expectation> =>
  Object.fromEntries(ids.map((n) => [`cam${String(n).padStart(2, '0')}`, e]));

export const GRID_GROUND_TRUTH: Record<string, Expectation> = {
  ...cams([6, 12, 17], { flags: ['h265'] }),
  ...cams([9, 13, 14, 24, 27, 28], { flags: ['bframes'] }),
  ...cams([30], { flags: ['sparse_keyframes'] }),
  ...cams([26], { flags: ['h265', 'high_resolution'] }),
  // No decodable frame: the probe must say so rather than report a profile.
  ...cams([7, 8, 10], { failure: 'no_frame' }),
  ...cams([22], { flags: ['h265'], failure: 'no_frame' }),
};
