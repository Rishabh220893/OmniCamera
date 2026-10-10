/**
 * Turns decisions (server/cameraRecipe.ts) into MediaMTX paths: the replacement for the hand-kept MEDIA_TRANSCODE_IDS list
 * (docs/camera-onboarding-plan.md section 6). The same path objects are rendered as the YAML the media server starts from
 * and sent to MediaMTX's control API to change a running server, so the file and the live state cannot drift apart.
 *
 *   A       a plain RTSP pull, re-served as HLS
 *   B, C, D an ffmpeg re-encode (Intel Quick Sync) published back over a localhost-only RTSP port
 *   F, G    no path: there is no live video to serve, so a request fails at once instead of hanging for a minute
 *
 * Pure functions. Credentials arrive through a callback (a per-site secret with an optional per-camera override, decision 4)
 * and only ever appear in the generated text, never in a profile.
 */
import type { Decision } from './cameraRecipe';
import { recordFields, type RecordingPolicy } from './recording/policy';

export interface SiteSource {
  host: string;
  rtspPort: number;
  /** The path before the camera id: rtsp://host:port/<pathPrefix>/<id>. */
  pathPrefix: string;
}

export interface Credentials { user: string; pass: string }

export interface TranscodeSettings {
  ffmpeg: string;
  bitrate: string;
  /** The localhost-only RTSP port ffmpeg publishes the H.264 back to. */
  publishPort: number;
  /**
   * An ffmpeg -vf filter for recipe D, e.g. `vpp_qsv=w=1920:h=1080`. Empty by default: scale_qsv failed on the demo PC, and no
   * replacement has been validated yet, so D currently re-encodes at the source size until one is set.
   */
  scaleFilter?: string | null;
}

export interface PathBuildOptions {
  site: SiteSource;
  credentials: (cameraId: string) => Credentials;
  /**
   * The address of a camera that is not on `site` (a camera onboarded through an adapter: ONVIF, a recorder, a plain RTSP URL), with its
   * login inside. When it returns a URL that is the source; when it returns null the camera is on `site`, as before.
   */
  sourceUrlFor?: (cameraId: string) => string | null;
  /** With `sourceUrlFor`: a camera it knows nothing about is skipped, not looked up on `site` (which would be the wrong place). */
  requireSource?: boolean;
  transcode: TranscodeSettings;
  /** How long MediaMTX waits for the first picture, and how long it keeps a source after the last viewer leaves. */
  startTimeout: string;
  /**
   * Start timeout for a re-encode, which has more to do before the first picture: connect, wait for the camera's first frame (46 s on
   * cam21 on 2026-10-10), decode, encode and publish. Defaults to `startTimeout`. Too short and MediaMTX kills ffmpeg and starts it
   * again, which only opens more sessions on the grid.
   */
  encodeStartTimeout?: string;
  closeAfter: string;
  /**
   * Cameras that are recorded, and where. A recorded camera is pulled all the time (not on demand). Only plain pulls (recipe A) can be
   * recorded; a re-encode runs only while someone watches, so it is reported in `PathPlan.notRecorded` instead.
   */
  recording?: { dir: string; policy: (cameraId: string) => RecordingPolicy | null };
}

/** The fields of a MediaMTX path that this module sets (the names the YAML file and the control API share). */
export interface PathConf {
  source?: string;
  rtspTransport?: string;
  sourceOnDemand?: boolean;
  sourceOnDemandStartTimeout?: string;
  sourceOnDemandCloseAfter?: string;
  runOnDemand?: string;
  runOnDemandStartTimeout?: string;
  runOnDemandCloseAfter?: string;
  runOnDemandRestart?: boolean;
  record?: boolean;
  recordPath?: string;
  recordFormat?: string;
  recordPartDuration?: string;
  recordSegmentDuration?: string;
  recordDeleteAfter?: string;
}

export interface PathPlan {
  paths: Record<string, PathConf>;
  /** Cameras that have a live recipe but cannot be served, with the reason. */
  skipped: Array<{ cameraId: string; why: string }>;
  /** Cameras whose policy asks for recording but whose recipe cannot be recorded, with the reason. They are still served live. */
  notRecorded: Array<{ cameraId: string; why: string }>;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** Source codecs the Quick Sync decoder handles. Others would need software decoding, which is not used. */
const QSV_DECODE = new Set(['h264', 'hevc', 'mjpeg', 'vp9']);

/** Percent-encodes for the user:password part of a URL, exactly like media-server/entrypoint.sh (keeps only A-Za-z0-9 . ~ _ -). */
export function urlEncode(s: string): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9.~_-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function sourceUrl(site: SiteSource, id: string, cred: Credentials): string {
  return `rtsp://${urlEncode(cred.user)}:${urlEncode(cred.pass)}@${site.host}:${site.rtspPort}/${site.pathPrefix}/${id}`;
}

/** Where a camera is pulled from: its own stored address, or else its place on the site. null = unknown and `requireSource`. */
export function sourceOf(id: string, o: PathBuildOptions): string | null {
  const own = o.sourceUrlFor?.(id) ?? null;
  if (own) return own;
  if (o.requireSource) return null;
  return sourceUrl(o.site, id, o.credentials(id));
}

export function ffmpegCommand(id: string, codec: string, maxHeight: number | null, gopFrames: number, o: PathBuildOptions): string {
  const t = o.transcode;
  const vf = maxHeight && t.scaleFilter ? ` -vf ${t.scaleFilter}` : '';
  // No -use_wallclock_as_timestamps: on cam06 it makes ffmpeg see 90000 fps and h264_qsv then refuses to open.
  return `${t.ffmpeg} -hide_banner -loglevel warning -hwaccel qsv -c:v ${codec}_qsv -rtsp_transport tcp -i ${sourceOf(id, o) ?? ''} -an${vf} -c:v h264_qsv -b:v ${t.bitrate} -g ${gopFrames} -bf 0 -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:${t.publishPort}/${id}`;
}

export function buildPaths(items: Array<{ cameraId: string; decision: Decision }>, o: PathBuildOptions): PathPlan {
  const paths: Record<string, PathConf> = {};
  const skipped: PathPlan['skipped'] = [];
  const notRecorded: PathPlan['notRecorded'] = [];
  for (const { cameraId: id, decision: d } of items) {
    if (d.recipe === 'F' || d.recipe === 'G' || d.recipe === 'E') continue;
    if (!SAFE_ID.test(id)) { skipped.push({ cameraId: id, why: 'camera id may only use letters, digits, - and _' }); continue; }
    const src = sourceOf(id, o);
    if (src === null) { skipped.push({ cameraId: id, why: 'no stored address for this camera' }); continue; }
    if (!d.transcode || !d.encode) {
      const rec = o.recording?.policy(id);
      paths[id] = rec && rec.mode === 'continuous'
        ? { source: src, rtspTransport: 'tcp', ...recordFields(o.recording!.dir) }
        : {
          source: src, rtspTransport: 'tcp', sourceOnDemand: true,
          sourceOnDemandStartTimeout: o.startTimeout, sourceOnDemandCloseAfter: o.closeAfter,
        };
      continue;
    }
    if (o.recording?.policy(id)?.mode === 'continuous') notRecorded.push({ cameraId: id, why: 'this camera is re-encoded for playback, which runs only while someone watches, so it cannot be recorded' });
    if (!QSV_DECODE.has(d.encode.inputCodec)) { skipped.push({ cameraId: id, why: `no hardware decoder for ${d.encode.inputCodec}; software decoding is not used` }); continue; }
    paths[id] = {
      runOnDemand: ffmpegCommand(id, d.encode.inputCodec, d.encode.maxHeight, d.encode.gopFrames, o),
      runOnDemandStartTimeout: o.encodeStartTimeout ?? o.startTimeout, runOnDemandCloseAfter: o.closeAfter, runOnDemandRestart: true,
    };
  }
  return { paths, skipped, notRecorded };
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

/** A YAML single-quoted scalar ('' is an escaped quote), like `yq` in entrypoint.sh. */
export const yamlQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** True when a YAML plain scalar is safe as written: the characters a URL normally has, and nothing that starts a comment, a quote or a mapping. */
const plainYaml = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._~:/?=&%@+,;!*()$-]*$/.test(s);

/** The `paths:` entries (two-space indented), in camera order, as media-server/entrypoint.sh reads them via MEDIA_PATHS_FILE. */
export function renderPathsYaml(paths: Record<string, PathConf>): string {
  const lines: string[] = [];
  for (const id of Object.keys(paths).sort()) {
    const p = paths[id];
    lines.push(`  ${id}:`);
    if (p.runOnDemand !== undefined) {
      lines.push(`    runOnDemand: ${yamlQuote(p.runOnDemand)}`);
      if (p.runOnDemandStartTimeout) lines.push(`    runOnDemandStartTimeout: ${p.runOnDemandStartTimeout}`);
      if (p.runOnDemandCloseAfter) lines.push(`    runOnDemandCloseAfter: ${p.runOnDemandCloseAfter}`);
      if (p.runOnDemandRestart) lines.push('    runOnDemandRestart: yes');
    } else {
      lines.push(`    source: ${plainYaml(p.source!) ? p.source : yamlQuote(p.source!)}`);
      if (p.rtspTransport) lines.push(`    rtspTransport: ${p.rtspTransport}`);
      if (p.sourceOnDemand) lines.push('    sourceOnDemand: yes');
      if (p.sourceOnDemandStartTimeout) lines.push(`    sourceOnDemandStartTimeout: ${p.sourceOnDemandStartTimeout}`);
      if (p.sourceOnDemandCloseAfter) lines.push(`    sourceOnDemandCloseAfter: ${p.sourceOnDemandCloseAfter}`);
      if (p.record) {
        lines.push('    record: yes');
        if (p.recordPath) lines.push(`    recordPath: ${yamlQuote(p.recordPath)}`);
        if (p.recordFormat) lines.push(`    recordFormat: ${p.recordFormat}`);
        if (p.recordPartDuration) lines.push(`    recordPartDuration: ${p.recordPartDuration}`);
        if (p.recordSegmentDuration) lines.push(`    recordSegmentDuration: ${p.recordSegmentDuration}`);
        if (p.recordDeleteAfter) lines.push(`    recordDeleteAfter: ${p.recordDeleteAfter}`);
      }
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// ---------------------------------------------------------------------------
// Diff against a running server
// ---------------------------------------------------------------------------

/** Go-style durations as MediaMTX prints them ("60s", "1m0s", "500ms") in milliseconds, or null. */
export function durationMs(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  let total = 0, rest = v;
  const re = /^(\d+(?:\.\d+)?)(h|ms|m|s)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) return null;
    total += Number(m[1]) * { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }[m[2] as 'h' | 'm' | 's' | 'ms'];
    rest = rest.slice(m[0].length);
  }
  return total;
}

const DURATION_KEYS: Array<keyof PathConf> = ['sourceOnDemandStartTimeout', 'sourceOnDemandCloseAfter', 'runOnDemandStartTimeout', 'runOnDemandCloseAfter', 'recordPartDuration', 'recordSegmentDuration', 'recordDeleteAfter'];
/** What decides whether a path pulls or re-encodes. If any differs from its default the path is not what we want. */
const MODE_KEYS: Array<keyof PathConf> = ['source', 'runOnDemand', 'sourceOnDemand', 'runOnDemandRestart', 'record'];

/** True if a path as the control API reports it already matches what we want. Unlisted fields (defaults the API adds) are ignored. */
export function pathMatches(current: Record<string, unknown>, want: PathConf): boolean {
  for (const k of Object.keys(want) as Array<keyof PathConf>) {
    const w = want[k], c = current[k];
    if (DURATION_KEYS.includes(k)) { if (durationMs(w) !== durationMs(c)) return false; }
    else if (k === 'rtspTransport') { if ((c ?? '') !== w) return false; }
    else if (c !== w) return false;
  }
  for (const k of MODE_KEYS) {
    if (k in want) continue;
    const c = current[k];
    // MediaMTX reports a path that nothing pulls as source "publisher"; that is its default, not a leftover pull.
    if (c !== undefined && c !== null && c !== '' && c !== false && !(k === 'source' && c === 'publisher')) return false;
  }
  return true;
}

export interface PathDiff { add: string[]; replace: string[]; remove: string[]; unchanged: string[] }

/**
 * What to change on a running server. `managed` is every camera id this tool is responsible for (all profiled cameras):
 * a managed path that is no longer wanted is removed, an unmanaged one (e.g. MediaMTX's own `all_others`) is never touched.
 */
export function diffPaths(current: Array<Record<string, unknown>>, want: Record<string, PathConf>, managed: Iterable<string>): PathDiff {
  const have = new Map(current.map((p) => [String(p.name), p]));
  const out: PathDiff = { add: [], replace: [], remove: [], unchanged: [] };
  for (const id of Object.keys(want).sort()) {
    const c = have.get(id);
    if (!c) out.add.push(id);
    else if (pathMatches(c, want[id])) out.unchanged.push(id);
    else out.replace.push(id);
  }
  for (const id of [...new Set(managed)].sort()) if (have.has(id) && !(id in want)) out.remove.push(id);
  return out;
}
