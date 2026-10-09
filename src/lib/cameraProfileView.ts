/**
 * What the Registry's "Playback profiles" panel shows for one camera: what the probe measured, the recipe chosen for it
 * and why. Built on the server (server/profileService.ts) and sent as JSON, so the screen never re-derives a decision.
 * Types and labels only: it is imported by both the server and the browser.
 */
export type RecipeCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface ProfileView {
  cameraId: string;
  site: string;
  probedAt: string | null;
  /** Why the probe could not get video, or null. */
  failure: string | null;
  failureDetail: string | null;
  notes: string[];
  // What was measured
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  firstFrameSec: number | null;
  /** Longest stretch without a keyframe, in seconds. */
  keyframeGapSec: number | null;
  reorderSec: number;
  /** Decoder error lines per 100 frames: a stand-in for packet loss upstream. */
  damagePer100: number | null;
  flags: string[];
  // What was decided
  recipe: RecipeCode;
  /** The recipe the measurements chose, before any manual override. */
  naturalRecipe: RecipeCode;
  reason: string;
  /** The reason in a few words, for the list. */
  cause: string;
  override: RecipeCode | null;
  overrideReason: string | null;
  transcode: boolean;
  gridLive: boolean;
  speed: 'fast' | 'normal' | 'slow' | 'unknown';
  webrtcFocus: boolean;
  health: number;
  pathKind: 'pull' | 're-encode' | 'none';
  /** Set when the latest probe failed but the measurements above are from an earlier, good one. */
  lastFailure: { at: string; failure: string; detail: string | null; inARow: number; limit: number } | null;
}

export interface ProfileSummary {
  counts: Record<RecipeCode, number>;
  total: number;
  /** Cameras that need a transcode slot while live. */
  needSlots: number;
  /** How many transcodes fit at once on this machine. */
  slots: number;
  /** How many of those could be live together. */
  liveTogether: number;
  overrides: number;
}

export interface ProbeJobStatus {
  state: 'idle' | 'running' | 'finished' | 'stopped';
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  ok: number;
  failed: number;
  current: string[];
  /** Why a run stopped early, or a note about it. */
  message: string | null;
}

export interface ProfilesResponse {
  views: ProfileView[];
  summary: ProfileSummary;
  probe: ProbeJobStatus;
  /** Whether the server can change the media server (a MediaMTX control API is configured). */
  canApplyMedia: boolean;
  encoder: 'qsv' | 'none';
}

export interface MediaApplyResponse {
  dryRun: boolean;
  add: string[];
  replace: string[];
  remove: string[];
  unchanged: string[];
  errors: string[];
  skipped: Array<{ cameraId: string; why: string }>;
  fileWritten: string | null;
}

export const RECIPE_LABEL: Record<RecipeCode, { short: string; long: string }> = {
  A: { short: 'Direct', long: 'plays as it is' },
  B: { short: 'Re-encode', long: 'rebuilt as clean H.264' },
  C: { short: 'H.265 → H.264', long: 'converted from H.265 or another codec' },
  D: { short: 'Re-encode, smaller', long: 'rebuilt as clean H.264 at 1080p' },
  E: { short: 'WebRTC', long: 'direct WebRTC for the focused camera' },
  F: { short: 'Snapshots only', long: 'no live video, snapshots' },
  G: { short: 'Unsupported', long: 'no usable video from this camera' },
};

export const RECIPE_CODES: RecipeCode[] = ['A', 'B', 'C', 'D', 'F', 'G'];

export const FLAG_LABEL: Record<string, string> = {
  h265: 'H.265', other_codec: 'Other codec', bframes: 'B-frames', sparse_keyframes: 'Sparse keyframes', high_resolution: 'Above 1080p',
  packet_loss: 'Packet loss', corrupt_frames: 'Damaged video', timestamp_problems: 'Timestamp problems', slow_first_frame: 'Slow start', closed_early: 'Closed early',
};

/** One line of what was measured, e.g. "H.265 · 1920×1080 · first picture 3.4 s · keyframes every 6.2 s". */
export function measuredLine(v: ProfileView): string {
  if (v.failure && v.codec === null) return 'Nothing measured';
  const parts: string[] = [];
  if (v.codec) parts.push(v.codec === 'hevc' ? 'H.265' : v.codec === 'h264' ? 'H.264' : v.codec.toUpperCase());
  if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
  if (v.firstFrameSec !== null) parts.push(`first picture ${v.firstFrameSec} s`);
  if (v.keyframeGapSec !== null) parts.push(`keyframes up to ${v.keyframeGapSec} s apart`);
  if (v.damagePer100 !== null && v.damagePer100 > 0) parts.push(`${v.damagePer100} decoder errors per 100 frames`);
  return parts.join(' · ') || 'Nothing measured';
}

/** Which badge style a recipe gets: direct is good, a re-encode is a cost, no video is a problem. */
export function recipeTone(recipe: RecipeCode): 'badge-success' | 'badge-accent' | 'badge-warning' | 'badge-critical' | 'badge-neutral' {
  if (recipe === 'A' || recipe === 'E') return 'badge-success';
  if (recipe === 'B' || recipe === 'C' || recipe === 'D') return 'badge-accent';
  return recipe === 'F' ? 'badge-warning' : 'badge-critical';
}

export function filterViews(views: ProfileView[], f: { recipe: RecipeCode | 'all' | 'override'; query: string }): ProfileView[] {
  const q = f.query.trim().toLowerCase();
  return views.filter((v) => {
    if (f.recipe === 'override' ? !v.override : f.recipe !== 'all' && v.recipe !== f.recipe) return false;
    if (!q) return true;
    return `${v.cameraId} ${v.reason} ${v.flags.map((x) => FLAG_LABEL[x] ?? x).join(' ')} ${v.codec ?? ''}`.toLowerCase().includes(q);
  });
}

/** "5 minutes ago"-style age for a timestamp, or "never". */
export function ageLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return 'unknown';
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}
