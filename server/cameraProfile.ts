/**
 * Camera profiles: what a probe measured about one camera, and the fault classes derived from it.
 * See docs/camera-onboarding-plan.md (sections 1-3). Nothing here is keyed on a camera id; the decision
 * table that turns flags into a playback recipe is step 2 and is not part of this file.
 *
 * The parsing and classification are pure functions (tested without a camera); the Postgres store takes a
 * `PgLike` so tests can pass a fake. Secrets are never part of a profile: a profile names its site, and
 * credentials are looked up by that name where the probe runs.
 */
import type { PgLike } from './eventStore';

export const PROBE_VERSION = 1;

/** Thresholds, in one place so the plan's numbers are easy to find and change. */
export const THRESHOLDS = {
  /** Keyframes further apart than this make HLS segments grow (plan: "4-5 s"). */
  sparseKeyframeSec: 5,
  /** Above this height (px) a camera is "very high resolution". */
  highResHeight: 1080,
  /** Time to first frame at or under this is "fast"; over `slowFirstFrameMs` is "slow". */
  fastFirstFrameMs: 10_000,
  slowFirstFrameMs: 10_000,
  /** Over this the camera is snapshot-only until focused (decision 5). */
  maxStartMs: 30_000,
  /** missed / (missed + decoded) above this is "heavy packet loss". */
  lossRatio: 0.02,
  /** A sample that ends before this fraction of the requested time, after frames arrived, "closed early". */
  earlyCloseFraction: 0.8,
} as const;

export type FailureStage = 'unreachable' | 'bad_credentials' | 'no_describe' | 'no_frame';

export type FaultFlag =
  | 'h265' | 'other_codec' | 'bframes' | 'sparse_keyframes' | 'high_resolution'
  | 'packet_loss' | 'corrupt_frames' | 'timestamp_problems'
  | 'slow_first_frame' | 'closed_early';

export interface DescribeResult {
  codec: string | null;
  profile: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  hasBFramesHint: boolean;
  hasAudio: boolean;
}

export interface SampleMeasurement {
  requestedSec: number;
  elapsedSec: number;
  frames: number;
  timeToFirstFrameMs: number | null;
  /** Gaps between keyframes, in stream time. */
  keyframeIntervalSec: { min: number; median: number; max: number } | null;
  bFrames: number;
  missedPackets: number;
  corruptErrors: number;
  timestampErrors: number;
  exitedEarly: boolean;
}

export interface ProbeReport {
  cameraId: string;
  site: string;
  transport: 'tcp' | 'udp';
  probedAt: string;
  probeVersion: number;
  reachable: boolean;
  failure: FailureStage | null;
  failureDetail: string | null;
  describe: DescribeResult | null;
  sample: SampleMeasurement | null;
  whep: { ok: boolean; status: number; ms: number; error?: string } | null;
  flags: FaultFlag[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ratio = (s: unknown): number | null => {
  const m = String(s ?? '').match(/^(\d+)\/(\d+)$/);
  if (!m || Number(m[2]) === 0) return null;
  const v = Number(m[1]) / Number(m[2]);
  return v > 0 && v < 1000 ? Math.round(v * 100) / 100 : null;
};

/** Reads `ffprobe -show_streams -of json` output. */
export function parseFfprobeStreams(json: string): DescribeResult | null {
  let data: { streams?: Array<Record<string, unknown>> };
  try { data = JSON.parse(json); } catch { return null; }
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) return null;
  const num = (x: unknown) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
  return {
    codec: (v.codec_name as string) ?? null,
    profile: (v.profile as string) ?? null,
    width: num(v.width),
    height: num(v.height),
    fps: ratio(v.avg_frame_rate) ?? ratio(v.r_frame_rate),
    bitrate: num(v.bit_rate),
    hasBFramesHint: Number(v.has_b_frames ?? 0) > 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

export interface ShowInfoFrame { ptsTime: number; key: boolean; type: string }

/** Reads the `showinfo` filter lines ffmpeg prints to stderr, one per decoded frame. */
export function parseShowInfo(stderr: string): ShowInfoFrame[] {
  const out: ShowInfoFrame[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue;
    const pts = line.match(/pts_time:\s*(-?[\d.]+)/);
    const key = line.match(/iskey:\s*(\d)/);
    const type = line.match(/type:\s*([A-Z])/);
    if (!pts || !key) continue;
    out.push({ ptsTime: Number(pts[1]), key: key[1] === '1', type: type?.[1] ?? '?' });
  }
  return out;
}

/** Counts of the problem lines ffmpeg logs while decoding a live stream. */
export function countLogProblems(stderr: string): { missedPackets: number; corruptErrors: number; timestampErrors: number } {
  let missedPackets = 0, corruptErrors = 0, timestampErrors = 0;
  for (const line of stderr.split('\n')) {
    const missed = line.match(/RTP: missed (\d+) packets?/i);
    if (missed) { missedPackets += Number(missed[1]); continue; }
    if (/non[- ]monotonic|Non-monotonous|Invalid DTS|Invalid PTS|DTS .* < .*PTS|too many reordered frames/i.test(line)) timestampErrors++;
    else if (/error while decoding|corrupt|concealing|Invalid data|no frame!|Missing reference|Could not find ref|decode_slice_header error/i.test(line)) corruptErrors++;
  }
  return { missedPackets, corruptErrors, timestampErrors };
}

const median = (a: number[]): number => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** Keyframe spacing in stream time. Needs at least two keyframes, else null. */
export function keyframeIntervals(frames: ShowInfoFrame[]): SampleMeasurement['keyframeIntervalSec'] {
  const keys = frames.filter((f) => f.key).map((f) => f.ptsTime).sort((a, b) => a - b);
  if (keys.length < 2) return null;
  const gaps = keys.slice(1).map((t, i) => Math.round((t - keys[i]) * 100) / 100);
  return { min: Math.min(...gaps), median: median(gaps), max: Math.max(...gaps) };
}

export function buildSample(args: {
  requestedSec: number; elapsedSec: number; timeToFirstFrameMs: number | null; stderr: string;
}): SampleMeasurement {
  const frames = parseShowInfo(args.stderr);
  const problems = countLogProblems(args.stderr);
  // Frames come out in presentation order, so a backwards step here means the camera's timestamps jumped.
  let backwards = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i].ptsTime < frames[i - 1].ptsTime) backwards++;
  return {
    requestedSec: args.requestedSec,
    elapsedSec: Math.round(args.elapsedSec * 10) / 10,
    frames: frames.length,
    timeToFirstFrameMs: args.timeToFirstFrameMs,
    keyframeIntervalSec: keyframeIntervals(frames),
    bFrames: frames.filter((f) => f.type === 'B').length,
    missedPackets: problems.missedPackets,
    corruptErrors: problems.corruptErrors,
    timestampErrors: problems.timestampErrors + backwards,
    exitedEarly: frames.length > 0 && args.elapsedSec < args.requestedSec * THRESHOLDS.earlyCloseFraction,
  };
}

/** Maps ffprobe/ffmpeg's error text for a failed connect to a named stage. */
export function classifyConnectError(text: string): { stage: FailureStage; detail: string } {
  const t = text.replace(/\r/g, '').replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@');
  const detail = t.trim().split('\n').slice(-2).join(' | ').slice(0, 220);
  if (/401|403|Unauthorized|Forbidden|authorization/i.test(t)) return { stage: 'bad_credentials', detail };
  if (/Connection refused|timed out|No route|Network is unreachable|Name or service not known|Temporary failure in name resolution|Connection reset/i.test(t)) return { stage: 'unreachable', detail };
  return { stage: 'no_describe', detail };
}

// ---------------------------------------------------------------------------
// Fault classes
// ---------------------------------------------------------------------------

/** The fault classes of plan section 3 that a profile shows. A failure stage is reported separately. */
export function deriveFlags(d: DescribeResult | null, s: SampleMeasurement | null): FaultFlag[] {
  const flags: FaultFlag[] = [];
  if (d?.codec) {
    if (d.codec === 'hevc') flags.push('h265');
    else if (d.codec !== 'h264') flags.push('other_codec');
  }
  if (d?.codec === 'h264' && (d.hasBFramesHint || (s?.bFrames ?? 0) > 0)) flags.push('bframes');
  if ((d?.height ?? 0) > THRESHOLDS.highResHeight) flags.push('high_resolution');
  if (s) {
    if ((s.keyframeIntervalSec?.max ?? 0) > THRESHOLDS.sparseKeyframeSec) flags.push('sparse_keyframes');
    const lossBase = s.missedPackets + s.frames;
    if (lossBase > 0 && s.missedPackets / lossBase > THRESHOLDS.lossRatio) flags.push('packet_loss');
    if (s.corruptErrors > 0) flags.push('corrupt_frames');
    if (s.timestampErrors > 0) flags.push('timestamp_problems');
    if ((s.timeToFirstFrameMs ?? 0) > THRESHOLDS.slowFirstFrameMs) flags.push('slow_first_frame');
    if (s.exitedEarly) flags.push('closed_early');
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export const PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS probe_runs (
  id            BIGSERIAL PRIMARY KEY,
  camera_id     TEXT        NOT NULL,
  site          TEXT        NOT NULL,
  probed_at     TIMESTAMPTZ NOT NULL,
  probe_version INTEGER     NOT NULL,
  failure       TEXT,
  report        JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS probe_runs_camera_ts ON probe_runs (site, camera_id, probed_at DESC);
CREATE TABLE IF NOT EXISTS camera_profiles (
  site            TEXT        NOT NULL,
  camera_id       TEXT        NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  probe_version   INTEGER     NOT NULL,
  failure         TEXT,
  codec           TEXT,
  width           INTEGER,
  height          INTEGER,
  fps             REAL,
  time_to_first_frame_ms INTEGER,
  flags           TEXT[]      NOT NULL,
  profile         JSONB       NOT NULL,
  recipe          TEXT,
  recipe_reason   TEXT,
  recipe_override TEXT,
  override_reason TEXT,
  PRIMARY KEY (site, camera_id)
);
`;

export interface ProfileStore {
  ensureSchema(): Promise<void>;
  /** Appends the run to history and refreshes the current profile. Recipe columns are left alone (step 2). */
  saveProbe(report: ProbeReport): Promise<void>;
  history(site: string, cameraId: string, limit?: number): Promise<ProbeReport[]>;
}

export function createProfileStore(pg: PgLike): ProfileStore {
  return {
    ensureSchema: async () => { await pg.query(PROFILE_SCHEMA); },

    async saveProbe(r) {
      await pg.query(
        `INSERT INTO probe_runs (camera_id, site, probed_at, probe_version, failure, report) VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.cameraId, r.site, r.probedAt, r.probeVersion, r.failure, JSON.stringify(r)],
      );
      await pg.query(
        `INSERT INTO camera_profiles (site, camera_id, updated_at, probe_version, failure, codec, width, height, fps, time_to_first_frame_ms, flags, profile)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (site, camera_id) DO UPDATE SET
           updated_at = EXCLUDED.updated_at, probe_version = EXCLUDED.probe_version, failure = EXCLUDED.failure,
           codec = EXCLUDED.codec, width = EXCLUDED.width, height = EXCLUDED.height, fps = EXCLUDED.fps,
           time_to_first_frame_ms = EXCLUDED.time_to_first_frame_ms, flags = EXCLUDED.flags, profile = EXCLUDED.profile`,
        [r.site, r.cameraId, r.probedAt, r.probeVersion, r.failure, r.describe?.codec ?? null, r.describe?.width ?? null,
          r.describe?.height ?? null, r.describe?.fps ?? null, r.sample?.timeToFirstFrameMs ?? null, r.flags, JSON.stringify(r)],
      );
    },

    async history(site, cameraId, limit = 20) {
      const res = await pg.query(
        `SELECT report FROM probe_runs WHERE site = $1 AND camera_id = $2 ORDER BY probed_at DESC LIMIT $3`,
        [site, cameraId, Math.min(Math.max(limit, 1), 200)],
      );
      return res.rows.map((row) => row.report as ProbeReport);
    },
  };
}
