/**
 * Turns MediaMTX's log into typed events about one camera each, for self-healing (server/selfHeal.ts).
 * Pure: a line in, an event or nothing out. The formats were read from a real MediaMTX v1.21.1 log
 * (`2026/10/09 17:53:24 ERR [path cam03] [RTSP source] bad status code: 401 (Unauthorized)`) and from the lines
 * scripts/check-media-health.mjs matches. Log timestamps are local time.
 *
 * What counts as a failure of the PATH (and so can move a camera down a recipe), and what does not:
 *
 *   dts_error / muxer_error  the HLS muxer died ("unable to extract DTS: too many reordered frames (11)")     counts
 *   source_error             the pull from the camera stopped with an error                                    counts
 *   ffmpeg_exit              the re-encode command exited with an error                                        counts
 *   start_timeout            the path did not start in time                                                    counts
 *   packet_loss              "N RTP packets lost": evidence for the cause of a later crash, but not a failure  recorded only
 *   auth_rejected            a 401 from the camera host. The grid limits an account when too many streams are  ignored
 *                            open at once, and the same login works a minute later (seen on 2026-10-09), so this
 *                            says nothing about the camera and must never demote it.
 */

export type MediaEventKind = 'dts_error' | 'muxer_error' | 'source_error' | 'ffmpeg_exit' | 'start_timeout' | 'packet_loss' | 'auth_rejected';

export interface MediaEvent {
  cameraId: string;
  kind: MediaEventKind;
  /** Epoch ms from the log line's own timestamp. */
  at: number;
  /** The log text without the timestamp (credentials removed), kept as evidence. */
  message: string;
  /** For packet_loss: how many packets. For ffmpeg_exit: the exit code. */
  value?: number;
}

/** The kinds that count towards a demotion. */
export const FAILURE_KINDS: ReadonlySet<MediaEventKind> = new Set(['dts_error', 'muxer_error', 'source_error', 'ffmpeg_exit', 'start_timeout']);

const LINE = /^(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d) (\w{3}) (.*)$/;
const CAMERA = /\[(?:path|muxer) ([A-Za-z0-9_-]+)\]/;
/** ffmpeg's own output ends up in the log without a timestamp; this is how a 401 shows in it. */
const FFMPEG_401 = /401 Unauthorized|method DESCRIBE failed: 401/;
/** How long after ffmpeg printed a 401 a "command exited" line still belongs to it. */
const AUTH_LINK_MS = 15_000;

export const redact = (s: string) => s.replace(/rtsp:\/\/[^@\s"']*@/g, 'rtsp://***@');

export interface MediaLogParser {
  /** One line of the log. `now` stamps lines that carry no timestamp of their own (ffmpeg's output). */
  feed(line: string, now?: number): MediaEvent | null;
}

/**
 * Stateful only in one respect: an ffmpeg 401 is printed on its own line before MediaMTX logs that the command exited, so the
 * exit that follows is linked back to it (and ignored) rather than counted as a failure of the camera.
 */
export function createMediaLogParser(): MediaLogParser {
  let authAt = -Infinity;
  return {
    feed(raw, now = Date.now()) {
      const line = raw.replace(/\r$/, '');
      const m = line.match(LINE);
      if (!m) {
        if (FFMPEG_401.test(line)) authAt = now;
        return null;
      }
      const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      const level = m[7], text = m[8];
      const cam = text.match(CAMERA);
      if (!cam) return null;
      const cameraId = cam[1];
      const ev = (kind: MediaEventKind, value?: number): MediaEvent => ({ cameraId, kind, at, message: redact(text).slice(0, 300), ...(value !== undefined ? { value } : {}) });

      if (/\b401\b|Unauthorized|authentication failed/i.test(text) && level !== 'INF') return ev('auth_rejected');
      const lost = text.match(/(\d+) RTP packets? lost/);
      if (lost) return ev('packet_loss', Number(lost[1]));
      if (/unable to extract DTS|too many reordered frames/.test(text)) return ev('dts_error');
      if (/muxer error|destroyed: muxer/.test(text)) return ev('muxer_error');
      const exit = text.match(/runOnDemand command exited: (.*)$/);
      if (exit) {
        if (now - authAt <= AUTH_LINK_MS) return ev('auth_rejected');
        const code = exit[1].match(/code (\d+)/);
        return ev('ffmpeg_exit', code ? Number(code[1]) : undefined);
      }
      if (/\[RTSP source\]/.test(text) && (level === 'ERR' || /stopped: an error/.test(text))) return ev('source_error');
      if (level === 'ERR' && /timed out|timeout/i.test(text)) return ev('start_timeout');
      return null;
    },
  };
}
