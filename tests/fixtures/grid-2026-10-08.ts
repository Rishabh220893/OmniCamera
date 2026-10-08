/**
 * The grid as measured on 2026-10-08 (scripts/probe-report.ts --all), one row per camera, for replaying through the
 * decision engine. Columns: camera, codec, height, first frame (s), longest keyframe gap (s), reorder (s),
 * decoder errors per 100 frames, timestamp errors. `null` = not measured; failures are listed separately.
 * Rows from the older probe (cam10, cam11) have no keyframe or reorder numbers, only the decoder's B-frame hint.
 */
import { deriveFlags, PROBE_VERSION, type ProbeReport } from '../../server/cameraProfile.ts';

type Row = [id: string, codec: string, width: number, height: number, first: number, gap: number | null, reorder: number | null, bad: number, ts: number];

export const GRID_ROWS: Row[] = [
  ['cam01', 'h264', 1920, 1080, 4.9, 2.0, 0, 0, 0], ['cam02', 'h264', 1920, 1080, 4.3, 3.0, 0, 1, 82], ['cam03', 'h264', 1280, 720, 3.1, 1.2, 0, 0, 0],
  ['cam04', 'h264', 1920, 1080, 19.2, 26.0, 0, 40, 0], ['cam05', 'h264', 1920, 1080, 5.0, 6.0, 0, 3, 75], ['cam06', 'hevc', 1920, 1080, 3.4, 6.2, 0, 88, 0],
  ['cam07', 'h264', 1920, 1080, 40.7, 29.7, 5.16, 152, 1], ['cam08', 'h264', 1920, 1080, 26.2, 28.5, 3.44, 367, 1], ['cam09', 'h264', 1920, 1080, 12.2, 18.7, 5.04, 12, 2],
  ['cam10', 'h264', 1920, 1080, 26.5, null, null, 172, 1], ['cam11', 'h264', 1920, 1080, 34.2, null, null, 600, 3], ['cam12', 'hevc', 1280, 720, 7.2, 2.0, 0, 62, 0],
  ['cam13', 'h264', 1920, 1080, 10.7, 9.5, 0, 21, 0], ['cam14', 'h264', 1920, 1080, 8.8, 4.9, 0, 25, 0], ['cam15', 'h264', 1920, 1080, 17.5, 6.9, 0, 18, 3],
  ['cam16', 'h264', 1920, 1080, 18.4, 22.4, 0, 53, 0], ['cam17', 'hevc', 1920, 1080, 9.4, 10.0, 0, 96, 0], ['cam18', 'hevc', 1920, 1080, 14.5, 4.0, 0, 250, 0],
  ['cam19', 'h264', 1280, 720, 26.3, 20.4, 0, 166, 0], ['cam20', 'h264', 1280, 720, 17.0, 8.4, 0, 90, 0], ['cam23', 'h264', 1280, 720, 8.9, 8.4, 0, 111, 0],
  ['cam24', 'h264', 960, 576, 19.9, 20.8, 0.42, 0, 0], ['cam25', 'h264', 1280, 960, 7.0, 20.0, 8.52, 17, 2], ['cam26', 'hevc', 2560, 1440, 10.9, 4.6, 0, 330, 0],
  ['cam27', 'h264', 1280, 960, 19.3, 19.8, 4.0, 13, 2], ['cam28', 'h264', 1280, 960, 22.6, 16.9, 2.0, 34, 2], ['cam29', 'h264', 1280, 960, 30.2, 29.9, 4.0, 26, 1],
  ['cam30', 'h264', 1920, 1080, 30.2, 22.8, 0, 22, 0],
];

const FRAMES = 300;

export function gridReport(row: Row): ProbeReport {
  const [id, codec, width, height, first, gap, reorder, bad, ts] = row;
  const measuredPackets = gap !== null;
  const describe = { codec, profile: null, width, height, fps: 25, bitrate: null, hasBFramesHint: !measuredPackets && (id === 'cam10' || id === 'cam11'), hasAudio: false };
  const sample = {
    requestedSec: 30, elapsedSec: 30, frames: FRAMES, timeToFirstFrameMs: Math.round(first * 1000),
    keyframeIntervalSec: gap === null ? null : { min: gap, median: gap, max: gap },
    bFrames: 0, reorderedPackets: reorder ? 100 : 0, maxReorderSec: reorder ?? 0, keyframeCount: gap === null ? 0 : 2, spanSec: 29,
    sinceLastKeyframeSec: gap ?? 0, problemSamples: [], missedPackets: 0, corruptErrors: Math.round((bad / 100) * FRAMES),
    timestampErrors: ts, exitedEarly: false,
  };
  return {
    cameraId: id, site: 'grid', transport: 'tcp', probedAt: '2026-10-08T20:00:00.000Z', probeVersion: PROBE_VERSION, reachable: true,
    failure: null, failureDetail: null, describe, sample, whep: { ok: true, status: 200, ms: 200 }, flags: deriveFlags(describe, sample),
  };
}

const failed = (id: string, failure: 'no_describe' | 'no_frame', detail: string, codec: string | null): ProbeReport => ({
  cameraId: id, site: 'grid', transport: 'tcp', probedAt: '2026-10-08T20:00:00.000Z', probeVersion: PROBE_VERSION, reachable: true,
  failure, failureDetail: detail, describe: codec ? { codec, profile: null, width: 1920, height: 1080, fps: 25, bitrate: null, hasBFramesHint: false, hasAudio: false } : null,
  sample: null, whep: { ok: true, status: 200, ms: 200 }, flags: codec === 'hevc' ? ['h265'] : [],
});

export const GRID_REPORTS: ProbeReport[] = [
  ...GRID_ROWS.map(gridReport),
  failed('cam21', 'no_describe', 'ffprobe timed out after 20s', 'h264'),
  failed('cam22', 'no_frame', 'no frame within 60s', 'hevc'),
].sort((a, b) => a.cameraId.localeCompare(b.cameraId));
