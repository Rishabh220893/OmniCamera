/**
 * Recording settings from the environment, readable synchronously because the media-path builder is (server/mediaPlan.ts).
 *   RECORDINGS_DIR          where MediaMTX writes segments (hot tier). Recording is off everywhere when this is unset.
 *   RECORDINGS_WARM_DIR     optional second tier for older segments
 *   RECORDINGS_HOT_DAYS     days before a segment moves to the warm tier (needs the warm dir)
 *   RECORDINGS_COLD_DAYS    days before a segment moves to object storage (needs RECORDINGS_S3_*)
 *   RECORDINGS_S3_ENDPOINT / _BUCKET / _ACCESS_KEY / _SECRET_KEY / _REGION / _PREFIX / _PATH_STYLE   the S3-compatible store (Ceph RGW, MinIO, AWS)
 *   RECORDING_POLICY_FILE   per-camera policy (default <RECORDINGS_DIR>/policy.json); written by PUT /api/recording-policy/:cameraId
 *   RECORDINGS_NAME_TIME    `local` (default) or `utc`: the clock in segment file names (see store.ts)
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parsePolicy, type RecordingPolicy } from './policy';

export interface RecordingEnv {
  dir: string;
  warmDir?: string;
  hotDays?: number;
  coldDays?: number;
  s3?: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; pathStyle: boolean; prefix: string };
  policyFile: string;
  holdsFile: string;
  exportsDir: string;
  nameTime: 'local' | 'utc';
}

export function recordingEnv(env: Record<string, string | undefined>): RecordingEnv | null {
  const dir = (env.RECORDINGS_DIR || '').trim();
  if (!dir) return null;
  const hot = Number(env.RECORDINGS_HOT_DAYS);
  return {
    dir,
    warmDir: env.RECORDINGS_WARM_DIR?.trim() || undefined,
    hotDays: Number.isFinite(hot) && hot > 0 ? hot : undefined,
    coldDays: Number(env.RECORDINGS_COLD_DAYS) > 0 ? Number(env.RECORDINGS_COLD_DAYS) : undefined,
    s3: env.RECORDINGS_S3_ENDPOINT && env.RECORDINGS_S3_BUCKET && env.RECORDINGS_S3_ACCESS_KEY && env.RECORDINGS_S3_SECRET_KEY
      ? { endpoint: env.RECORDINGS_S3_ENDPOINT, region: env.RECORDINGS_S3_REGION || 'us-east-1', bucket: env.RECORDINGS_S3_BUCKET, accessKeyId: env.RECORDINGS_S3_ACCESS_KEY, secretAccessKey: env.RECORDINGS_S3_SECRET_KEY, pathStyle: env.RECORDINGS_S3_PATH_STYLE !== 'false', prefix: env.RECORDINGS_S3_PREFIX || '' }
      : undefined,
    policyFile: env.RECORDING_POLICY_FILE?.trim() || path.join(dir, 'policy.json'),
    holdsFile: path.join(dir, 'holds.json'),
    exportsDir: path.join(dir, 'exports'),
    nameTime: env.RECORDINGS_NAME_TIME === 'utc' ? 'utc' : 'local',
  };
}

const OFF: RecordingPolicy = { mode: 'off', keepDays: 7 };

/** A synchronous policy lookup that re-reads the file when it changes. A missing or unreadable file means "record nothing". */
export function policyReader(file: string): (cameraId: string) => RecordingPolicy {
  let mtime = -1, def = OFF, cams: Record<string, RecordingPolicy> = {};
  return (cameraId) => {
    try {
      const m = statSync(file).mtimeMs;
      if (m !== mtime) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { default?: unknown; cameras?: Record<string, unknown> };
        def = raw.default ? parsePolicy(raw.default) : OFF;
        cams = Object.fromEntries(Object.entries(raw.cameras ?? {}).map(([id, p]) => [id, parsePolicy(p)]));
        mtime = m;
      }
    } catch { mtime = -1; def = OFF; cams = {}; }
    return cams[cameraId] ?? def;
  };
}
