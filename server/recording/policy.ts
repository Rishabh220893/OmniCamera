/**
 * What gets recorded and for how long (gap G10). A policy is per camera; the media server does the recording itself (MediaMTX writes
 * fragmented-MP4 segments), so this module only decides the settings and where the files are expected.
 *
 * `continuous` keeps the camera's stream always on, which is a real cost: the grid counts every pulled stream against an account's
 * watch time, and each stream holds a connection and bandwidth all day (docs/recording.md). Event-triggered recording is not built.
 */
export type RecordingMode = 'off' | 'continuous';

export interface RecordingPolicy {
  mode: RecordingMode;
  /** Days the segments are kept in the hot tier before retention deletes (or, if a warm tier is set, moves) them. */
  keepDays: number;
}

export const MAX_KEEP_DAYS = 3650;
export const SEGMENT_SECONDS = 600;

export class PolicyError extends Error {}

export function parsePolicy(raw: unknown): RecordingPolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.mode !== 'off' && r.mode !== 'continuous') throw new PolicyError("'mode' must be 'off' or 'continuous'.");
  const keepDays = r.keepDays === undefined ? 7 : Number(r.keepDays);
  if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > MAX_KEEP_DAYS) throw new PolicyError(`'keepDays' must be a whole number from 1 to ${MAX_KEEP_DAYS}.`);
  return { mode: r.mode, keepDays };
}

/** The MediaMTX path fields that make a path record. Retention is ours (`recordDeleteAfter` 0s) so tiering and the index stay in one place. */
export function recordFields(recordingsDir: string): { record: true; recordPath: string; recordFormat: 'fmp4'; recordPartDuration: string; recordSegmentDuration: string; recordDeleteAfter: string } {
  const dir = recordingsDir.replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    record: true,
    // %path is the camera id; the stamp is what the index reads back, so this layout is part of the contract.
    recordPath: `${dir}/%path/%Y-%m-%d_%H-%M-%S-%f`,
    recordFormat: 'fmp4',
    recordPartDuration: '1s',
    recordSegmentDuration: `${SEGMENT_SECONDS}s`,
    recordDeleteAfter: '0s',
  };
}
