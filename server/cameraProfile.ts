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
  /**
   * Keyframes further apart than this are "sparse". Through MediaMTX pass-through a clean stream with a 6.0 s gap played
   * (cam05: first segment after 7.8 s, no errors); nothing cleaner was available above that, so 7 s is a cautious limit.
   */
  sparseKeyframeSec: 7,
  /** Above this height (px) a camera is "very high resolution". */
  highResHeight: 1080,
  /** Time to first frame at or under this is "fast"; over `slowFirstFrameMs` is "slow". */
  fastFirstFrameMs: 10_000,
  slowFirstFrameMs: 10_000,
  /** Over this the camera is snapshot-only until focused (decision 5). */
  maxStartMs: 30_000,
  /** Decoder error lines per decoded frame above this (and at least `corruptMinErrors`) mean visibly damaged video. */
  corruptPerFrame: 0.1,
  corruptMinErrors: 5,
  /** One or two odd timestamps at start-up are normal; a camera needs this many to count as having timestamp problems. */
  timestampMinErrors: 5,
  /** Fewer decoded frames than this in a sample is not a live video stream (random bytes can decode as one text frame). */
  minFrames: 3,
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
  /** Packet level (from the copy output): how many packets carry a presentation time later than their decode time. */
  reorderedPackets: number;
  /** Largest pts - dts, in seconds: how far the camera reorders frames. */
  maxReorderSec: number;
  keyframeCount: number;
  /** Stream time from the first decoded frame to the last. */
  spanSec: number;
  /** Stream time from the last keyframe to the last frame; a lower bound on the gap that follows it. */
  sinceLastKeyframeSec: number;
  /** A few distinct problem lines from the log (credentials removed), so a flag can be explained. */
  problemSamples: string[];
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
  /** Things worth knowing that are not faults, e.g. that ffprobe timed out and ffmpeg's own description was used. */
  notes?: string[];
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

const TIMESTAMP_RE = /non[- ]monotonic|Non-monotonous|Invalid DTS|Invalid PTS|DTS .* < .*PTS|too many reordered frames/i;
const CORRUPT_RE = /error while decoding|corrupt|concealing|Invalid data|no frame!|Missing reference|Could not find ref|decode_slice_header error/i;

/** Counts of the problem lines ffmpeg logs while decoding a live stream, plus a few distinct examples. */
export function countLogProblems(stderr: string): { missedPackets: number; corruptErrors: number; timestampErrors: number; samples: string[] } {
  let missedPackets = 0, corruptErrors = 0, timestampErrors = 0;
  const samples: string[] = [];
  const note = (line: string) => {
    const clean = line.replace(/\[[^\]]*@ 0x[0-9a-f]+\]\s*/gi, '').replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@').replace(/\d+/g, 'N').trim().slice(0, 100);
    if (clean && samples.length < 4 && !samples.includes(clean)) samples.push(clean);
  };
  for (const line of stderr.replace(/\r/g, '').split('\n')) {
    const missed = line.match(/RTP: missed (\d+) packets?/i);
    if (missed) { missedPackets += Number(missed[1]); continue; }
    if (TIMESTAMP_RE.test(line)) { timestampErrors++; note(line); }
    else if (CORRUPT_RE.test(line)) { corruptErrors++; note(line); }
  }
  return { missedPackets, corruptErrors, timestampErrors, samples };
}

export interface PacketStats { packets: number; reorderedPackets: number; maxReorderSec: number; dtsBackwards: number }

/** Reads `-f framecrc` output: `stream, dts, pts, duration, size, crc` per packet, with `#tb 0: n/d` giving the time base. */
export function parseFramecrc(text: string): PacketStats {
  let tb = 1 / 90000;
  const rows: Array<{ dts: number; pts: number; dur: number }> = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const t = line.match(/^#tb\s+0:\s*(\d+)\/(\d+)/);
    if (t && Number(t[2]) > 0) { tb = Number(t[1]) / Number(t[2]); continue; }
    if (line.startsWith('#')) continue;
    const c = line.split(',').map((x) => x.trim());
    if (c.length < 5 || c[0] !== '0') continue;
    const dts = Number(c[1]), pts = Number(c[2]), dur = Number(c[3]);
    if (Number.isFinite(dts) && Number.isFinite(pts)) rows.push({ dts, pts, dur: Number.isFinite(dur) ? dur : 0 });
  }
  if (rows.length === 0) return { packets: 0, reorderedPackets: 0, maxReorderSec: 0, dtsBackwards: 0 };
  const durs = rows.map((r) => r.dur).filter((d) => d > 0);
  // Without durations fall back to the median step between decode times.
  const step = durs.length ? median(durs) : median(rows.slice(1).map((r, i) => r.dts - rows[i].dts).filter((d) => d > 0).concat([1]));
  const tolerance = step * 0.5;
  let reorderedPackets = 0, maxLag = 0, dtsBackwards = 0;
  rows.forEach((r, i) => {
    const lag = r.pts - r.dts;
    if (lag > tolerance) reorderedPackets++;
    if (lag > maxLag) maxLag = lag;
    if (i > 0 && r.dts < rows[i - 1].dts) dtsBackwards++;
  });
  return { packets: rows.length, reorderedPackets, maxReorderSec: Math.round(maxLag * tb * 1000) / 1000, dtsBackwards };
}

/** The input description ffmpeg prints, used when ffprobe could not describe the stream in time. */
export function parseFfmpegInput(stderr: string): DescribeResult | null {
  const m = stderr.match(/Stream #\d+:\d+[^\n]*?: Video: (\w+)(?: \(([^)]*)\))?[^\n]*?[ ,](\d{2,5})x(\d{2,5})[^\n]*/);
  if (!m) return null;
  const line = m[0];
  const fps = line.match(/([\d.]+) fps/);
  const kbps = line.match(/(\d+) kb\/s/);
  return {
    codec: m[1], profile: m[2] ?? null, width: Number(m[3]), height: Number(m[4]),
    fps: fps ? Number(fps[1]) : null, bitrate: kbps ? Number(kbps[1]) * 1000 : null,
    hasBFramesHint: false, hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(stderr),
  };
}

/** The ffmpeg arguments for the stage 3 sample: decode for measurements, and copy packets to stdout for timestamps. */
export function buildSampleArgs(url: string, transport: 'tcp' | 'udp', sampleSec: number, rtsp = true, realtime = false): string[] {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'info', ...(rtsp ? ['-rtsp_transport', transport] : []), ...(realtime ? ['-re'] : []), '-t', String(sampleSec), '-i', url,
    '-map', '0:v:0', '-an', '-vf', 'showinfo', '-progress', 'pipe:2', '-nostats', '-f', 'null', '-',
    '-map', '0:v:0', '-an', '-c', 'copy', '-f', 'framecrc', 'pipe:1',
  ];
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
  requestedSec: number; elapsedSec: number; timeToFirstFrameMs: number | null; stderr: string; packets?: string;
}): SampleMeasurement {
  const frames = parseShowInfo(args.stderr);
  const problems = countLogProblems(args.stderr);
  const pk = parseFramecrc(args.packets ?? '');
  const keys = frames.filter((f) => f.key).map((f) => f.ptsTime);
  const times = frames.map((f) => f.ptsTime);
  const first = times.length ? Math.min(...times) : 0, last = times.length ? Math.max(...times) : 0;
  return {
    requestedSec: args.requestedSec,
    elapsedSec: Math.round(args.elapsedSec * 10) / 10,
    frames: frames.length,
    timeToFirstFrameMs: args.timeToFirstFrameMs,
    keyframeIntervalSec: keyframeIntervals(frames),
    bFrames: frames.filter((f) => f.type === 'B').length,
    reorderedPackets: pk.reorderedPackets,
    maxReorderSec: pk.maxReorderSec,
    keyframeCount: keys.length,
    spanSec: Math.round((last - first) * 100) / 100,
    sinceLastKeyframeSec: keys.length ? Math.round((last - Math.max(...keys)) * 100) / 100 : 0,
    problemSamples: problems.samples,
    missedPackets: problems.missedPackets,
    corruptErrors: problems.corruptErrors,
    // Packet decode times going backwards is a camera fault; decoded frames are always in order, so they say nothing.
    timestampErrors: problems.timestampErrors + pk.dtsBackwards,
    exitedEarly: frames.length > 0 && args.elapsedSec < args.requestedSec * THRESHOLDS.earlyCloseFraction,
  };
}

/** Maps ffprobe/ffmpeg's error text for a failed connect to a named stage. */
export function classifyConnectError(text: string): { stage: FailureStage; detail: string } {
  const t = text.replace(/\r/g, '').replace(/rtsp:\/\/[^@\s]*@/g, 'rtsp://***@');
  const detail = t.trim().split('\n').slice(-2).join(' | ').slice(0, 220);
  if (/Unauthorized|Forbidden|authorization failed/i.test(t)) return { stage: 'bad_credentials', detail };
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
  if (d?.codec === 'h264' && (d.hasBFramesHint || (s?.bFrames ?? 0) > 0 || (s?.reorderedPackets ?? 0) > 0)) flags.push('bframes');
  if ((d?.height ?? 0) > THRESHOLDS.highResHeight) flags.push('high_resolution');
  if (s) {
    // The gap after the last keyframe is cut off by the end of the sample, but it is still at least that long.
    const longestGap = Math.max(s.keyframeIntervalSec?.max ?? 0, s.sinceLastKeyframeSec);
    if (s.frames > 0 && longestGap > THRESHOLDS.sparseKeyframeSec) flags.push('sparse_keyframes');
    const lossBase = s.missedPackets + s.frames;
    if (lossBase > 0 && s.missedPackets / lossBase > THRESHOLDS.lossRatio) flags.push('packet_loss');
    if (s.corruptErrors >= THRESHOLDS.corruptMinErrors && s.corruptErrors / Math.max(s.frames, 1) > THRESHOLDS.corruptPerFrame) flags.push('corrupt_frames');
    if (s.timestampErrors >= THRESHOLDS.timestampMinErrors) flags.push('timestamp_problems');
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
  decision        JSONB,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  latest_failure  JSONB,
  PRIMARY KEY (site, camera_id)
);
ALTER TABLE camera_profiles ADD COLUMN IF NOT EXISTS decision JSONB;
ALTER TABLE camera_profiles ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE camera_profiles ADD COLUMN IF NOT EXISTS latest_failure JSONB;
ALTER TABLE camera_profiles ADD COLUMN IF NOT EXISTS heal_floor  TEXT;
ALTER TABLE camera_profiles ADD COLUMN IF NOT EXISTS heal_reason TEXT;
ALTER TABLE camera_profiles ADD COLUMN IF NOT EXISTS heal_at     TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS recipe_changes (
  id          BIGSERIAL PRIMARY KEY,
  site        TEXT        NOT NULL,
  camera_id   TEXT        NOT NULL,
  at          TIMESTAMPTZ NOT NULL,
  from_recipe TEXT        NOT NULL,
  to_recipe   TEXT        NOT NULL,
  source      TEXT        NOT NULL,
  trigger     TEXT        NOT NULL,
  evidence    JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS recipe_changes_camera_at ON recipe_changes (site, camera_id, at DESC);
CREATE INDEX IF NOT EXISTS recipe_changes_site_at ON recipe_changes (site, at DESC);
`;

/**
 * A camera that gave video before keeps its profile through a failed probe (a timeout, a 401 while the grid limits the account,
 * a camera that is slow some minutes): the failure is recorded in the history and shown, but the stored profile only becomes
 * "no video" after this many failed probes in a row.
 */
export const FAILURES_BEFORE_REPLACING_PROFILE = 3;

/** The most recent failed probe of a camera whose stored profile is an earlier, good one. */
export interface LastFailure { probedAt: string; failure: string; detail: string | null; inARow: number }

/** The lowest-cost recipe a camera may use at runtime, set by self-healing after the media server failed on it (see server/selfHeal.ts). */
export interface HealFloor { recipe: 'B' | 'F'; reason: string; at: string }

/** One change of how a camera is played, with who made it and why. `dry` = self-heal is in dry-run mode and only said what it would do. */
export interface RecipeChange {
  site: string;
  cameraId: string;
  at: string;
  from: string;
  to: string;
  source: 'auto' | 'dry' | 'reprobe' | 'manual';
  trigger: string;
  evidence: Record<string, unknown>;
}

export interface ProfileRow {
  report: ProbeReport;
  /** Self-heal floor, or null/absent. */
  healFloor?: HealFloor | null;
  override: string | null;
  overrideReason: string | null;
  /** Set when the latest probe failed but the stored profile is still the earlier good one. */
  lastFailure?: LastFailure | null;
}

export interface SaveProbeResult {
  /** True when the probe failed and the camera's earlier good profile was kept. */
  kept: boolean;
  consecutiveFailures: number;
}

export const RECIPES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;

export interface ProfileStore {
  ensureSchema(): Promise<void>;
  /** The current profile of every camera on a site, with any manual override. */
  listProfiles(site: string): Promise<ProfileRow[]>;
  /** Records what the decision table chose (the probe columns are left alone). */
  saveDecision(site: string, cameraId: string, decision: { recipe: string; reason: string } & Record<string, unknown>): Promise<void>;
  /** Forces a recipe for one camera, or clears it with null. Every change needs a reason. */
  setOverride(site: string, cameraId: string, recipe: string | null, reason: string | null): Promise<void>;
  /**
   * Appends the run to history and refreshes the current profile, except that a failed probe does not replace an earlier good
   * profile until it has failed FAILURES_BEFORE_REPLACING_PROFILE times in a row. Recipe columns are left alone.
   */
  saveProbe(report: ProbeReport): Promise<SaveProbeResult>;
  history(site: string, cameraId: string, limit?: number): Promise<ProbeReport[]>;
  /** One camera's current profile, or null. */
  getProfile(site: string, cameraId: string): Promise<ProfileRow | null>;
  /** Sets or clears (null) the self-heal floor. The change itself is recorded separately with recordChange. */
  setHealFloor(site: string, cameraId: string, floor: HealFloor | null): Promise<void>;
  recordChange(change: RecipeChange): Promise<void>;
  /** Newest first. One camera, or the whole site when cameraId is null. */
  changes(site: string, cameraId: string | null, limit?: number): Promise<RecipeChange[]>;
}

const PROFILE_COLUMNS = 'profile, recipe_override, override_reason, failure, consecutive_failures, latest_failure, heal_floor, heal_reason, heal_at';

function rowToProfile(row: Record<string, unknown>): ProfileRow {
  const lf = row.latest_failure as { probedAt: string; failure: string; detail: string | null } | null | undefined;
  // Only when the stored profile is a good one: a stored failure already is the latest news.
  const lastFailure: LastFailure | null = lf && row.failure === null ? { probedAt: lf.probedAt, failure: lf.failure, detail: lf.detail ?? null, inARow: Number(row.consecutive_failures) || 1 } : null;
  const healFloor: HealFloor | null = row.heal_floor === 'B' || row.heal_floor === 'F'
    ? { recipe: row.heal_floor, reason: String(row.heal_reason ?? ''), at: row.heal_at ? new Date(row.heal_at as string).toISOString() : '' }
    : null;
  return { report: row.profile as ProbeReport, override: (row.recipe_override as string | null) ?? null, overrideReason: (row.override_reason as string | null) ?? null, lastFailure, healFloor };
}

export function createProfileStore(pg: PgLike): ProfileStore {
  return {
    ensureSchema: async () => { await pg.query(PROFILE_SCHEMA); },

    async saveProbe(r) {
      await pg.query(
        `INSERT INTO probe_runs (camera_id, site, probed_at, probe_version, failure, report) VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.cameraId, r.site, r.probedAt, r.probeVersion, r.failure, JSON.stringify(r)],
      );
      // One statement, so two probes finishing together cannot interleave. `keep` = this probe failed, the stored profile is a good
      // one, and this is not yet the Nth failure in a row: then every profile column keeps its stored value.
      const keep = `(EXCLUDED.failure IS NOT NULL AND camera_profiles.failure IS NULL AND camera_profiles.consecutive_failures + 1 < $14)`;
      const col = (c: string) => `${c} = CASE WHEN ${keep} THEN camera_profiles.${c} ELSE EXCLUDED.${c} END`;
      const res = await pg.query(
        `INSERT INTO camera_profiles (site, camera_id, updated_at, probe_version, failure, codec, width, height, fps, time_to_first_frame_ms, flags, profile, consecutive_failures, latest_failure)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,
           CASE WHEN $5::text IS NULL THEN NULL ELSE jsonb_build_object('probedAt', $15::text, 'failure', $5::text, 'detail', $13::text) END)
         ON CONFLICT (site, camera_id) DO UPDATE SET
           ${['updated_at', 'probe_version', 'failure', 'codec', 'width', 'height', 'fps', 'time_to_first_frame_ms', 'flags', 'profile'].map(col).join(',\n           ')},
           consecutive_failures = CASE WHEN EXCLUDED.failure IS NULL THEN 0 ELSE camera_profiles.consecutive_failures + 1 END,
           latest_failure = EXCLUDED.latest_failure
         RETURNING (failure IS NULL) AS stored_good, consecutive_failures`,
        [r.site, r.cameraId, r.probedAt, r.probeVersion, r.failure, r.describe?.codec ?? null, r.describe?.width ?? null,
          r.describe?.height ?? null, r.describe?.fps ?? null, r.sample?.timeToFirstFrameMs ?? null, r.flags, JSON.stringify(r),
          r.failureDetail, FAILURES_BEFORE_REPLACING_PROFILE, r.probedAt],
      );
      const row = res.rows[0] as { stored_good?: boolean; consecutive_failures?: number } | undefined;
      return { kept: r.failure !== null && row?.stored_good === true, consecutiveFailures: row?.consecutive_failures ?? (r.failure ? 1 : 0) };
    },

    async listProfiles(site) {
      const res = await pg.query(`SELECT ${PROFILE_COLUMNS} FROM camera_profiles WHERE site = $1 ORDER BY camera_id`, [site]);
      return res.rows.map(rowToProfile);
    },

    async getProfile(site, cameraId) {
      const res = await pg.query(`SELECT ${PROFILE_COLUMNS} FROM camera_profiles WHERE site = $1 AND camera_id = $2`, [site, cameraId]);
      return res.rows[0] ? rowToProfile(res.rows[0]) : null;
    },

    async setHealFloor(site, cameraId, floor) {
      await pg.query(`UPDATE camera_profiles SET heal_floor = $3, heal_reason = $4, heal_at = $5 WHERE site = $1 AND camera_id = $2`,
        [site, cameraId, floor?.recipe ?? null, floor?.reason ?? null, floor?.at ?? null]);
    },

    async recordChange(c) {
      await pg.query(`INSERT INTO recipe_changes (site, camera_id, at, from_recipe, to_recipe, source, trigger, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [c.site, c.cameraId, c.at, c.from, c.to, c.source, c.trigger, JSON.stringify(c.evidence ?? {})]);
    },

    async changes(site, cameraId, limit = 50) {
      const n = Math.min(Math.max(limit, 1), 500);
      const res = cameraId === null
        ? await pg.query(`SELECT * FROM recipe_changes WHERE site = $1 ORDER BY at DESC, id DESC LIMIT $2`, [site, n])
        : await pg.query(`SELECT * FROM recipe_changes WHERE site = $1 AND camera_id = $2 ORDER BY at DESC, id DESC LIMIT $3`, [site, cameraId, n]);
      return res.rows.map((r) => ({
        site: r.site, cameraId: r.camera_id, at: new Date(r.at).toISOString(), from: r.from_recipe, to: r.to_recipe,
        source: r.source, trigger: r.trigger, evidence: r.evidence ?? {},
      }));
    },

    async saveDecision(site, cameraId, decision) {
      await pg.query(
        `UPDATE camera_profiles SET recipe = $3, recipe_reason = $4, decision = $5 WHERE site = $1 AND camera_id = $2`,
        [site, cameraId, decision.recipe, decision.reason, JSON.stringify(decision)],
      );
    },

    async setOverride(site, cameraId, recipe, reason) {
      if (recipe !== null && !(RECIPES as readonly string[]).includes(recipe)) throw new Error(`Unknown recipe '${recipe}'; use one of ${RECIPES.join(', ')}`);
      if (recipe !== null && !reason?.trim()) throw new Error('An override needs a reason');
      await pg.query(
        `UPDATE camera_profiles SET recipe_override = $3, override_reason = $4 WHERE site = $1 AND camera_id = $2`,
        [site, cameraId, recipe, recipe === null ? null : reason],
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
