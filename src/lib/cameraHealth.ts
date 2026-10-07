/**
 * Demo-grid cameras from most to least reliable, so the first page of the feed shows the ones that actually
 * stream. Two kinds of evidence:
 *  - time to first frame straight from the grid over RTSP (`node scripts/probe-grid.mjs`, 2026-10-07; saved in
 *    .demo-logs/probe-*), and
 *  - packet loss / muxer crashes through the media server (`node scripts/check-media-health.mjs`, earlier runs).
 * Tiers:
 *  1. cam03 02 28 05 01: H.264, first frame in 3-6 s, little or no packet loss.
 *  2. cam30 27 14 24 09 13: H.264, first frame in 12-25 s, low packet loss (cam14 crashed the muxer 4 times).
 *  3. cam23 25: first frame fast (3-8 s) but lost 94k / most packets in the earlier media-server runs.
 *  4. cam20 21 29 19 04 16 15 11: H.264 but slow (13-40 s) and/or lossy (tens of thousands of packets).
 *  5. cam06 26 12 17 22: H.265. WebRTC has no HEVC, and MediaMTX's HLS never starts for them (no playlist in 60 s).
 *     The local demo re-encodes cam06 12 17 26 to H.264 with Quick Sync (MEDIA_TRANSCODE_IDS, media-server/entrypoint.sh):
 *     playlist in 15-45 s. cam22 sends no decodable frames, so it stays unsupported.
 *  6. cam10 08 07 18: no frame in 60 s when pulled alone (cam18 closes the stream after ~9 s). Grid-side.
 * cam09 14 24 28 are H.264 but carry B-frames: MediaMTX's HLS muxer died on each ("too many reordered frames",
 * 2026-10-08, cam28 never loaded in the browser), so the demo re-encodes them too (MEDIA_TRANSCODE_IDS, ':h264').
 * Pulling several cameras at once slows the grid further (cam25 failed at 4 in parallel, took 3.2 s alone).
 * Re-measure with the two scripts above and update this list.
 */
export const GRID_HEALTH_ORDER: readonly string[] = [
  'cam03', 'cam02', 'cam28', 'cam05', 'cam01',
  'cam30', 'cam27', 'cam14', 'cam24', 'cam09', 'cam13',
  'cam23', 'cam25',
  'cam20', 'cam21', 'cam29', 'cam19', 'cam04', 'cam16', 'cam15', 'cam11',
  'cam06', 'cam26', 'cam12', 'cam17', 'cam22',
  'cam10', 'cam08', 'cam07', 'cam18',
];

const camIdOf = (streamUrl: string): string | null => streamUrl.match(/\/(cam\d{1,3})\//i)?.[1]?.toLowerCase() ?? null;

const RANK = new Map(GRID_HEALTH_ORDER.map((id, i) => [id, i]));

/**
 * Stable sort: cameras that are not on the demo grid keep their place at the front, grid cameras follow in
 * health order, and grid cameras this list does not know about go after the known ones.
 */
export function sortByGridHealth<T extends { remoteStreamUrl?: string | null }>(cameras: readonly T[]): T[] {
  const rank = (c: T): number => {
    const id = c.remoteStreamUrl ? camIdOf(c.remoteStreamUrl) : null;
    if (!id) return -1;
    return RANK.get(id) ?? GRID_HEALTH_ORDER.length;
  };
  return cameras.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}
