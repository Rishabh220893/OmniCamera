/**
 * Demo-grid cameras from most to least reliable, so the first page of the feed shows the ones that actually
 * stream. Measured through the media server (two localhost runs, many cameras pulled at once):
 *  1. cam01 02 03 05 13 streamed the whole session with no packet loss (cam13: 758 lost) and no muxer errors;
 *     cam14 streams but lost ~3.8k packets and crashed the muxer 4 times.
 *  2. cam27 30 09 28 lost under ~2k packets in total (cam27 crashed the muxer twice); cam24 and cam15 were
 *     barely measured. Usable, not proven.
 *  3. cam19 20 21 11 04 10 23 08 lose tens of thousands of packets at the grid itself (cam08: 155k, cam23: 94k,
 *     cam10: 74k), and most also crash the media server's HLS muxer ("too many reordered frames").
 *  4. cam12 17 06 18 22 26 are H.265, which most browsers cannot decode from HLS (not seen in the latest run).
 *  5. cam16 29 25 07 lose most of their packets, so no client change fixes them.
 * Re-measure with `node scripts/check-media-health.mjs` (needs the local demo running) and paste its list here.
 */
export const GRID_HEALTH_ORDER: readonly string[] = [
  'cam01', 'cam02', 'cam03', 'cam05', 'cam13', 'cam14',
  'cam27', 'cam30', 'cam09', 'cam28', 'cam24', 'cam15',
  'cam19', 'cam20', 'cam21', 'cam11', 'cam04', 'cam10', 'cam23', 'cam08',
  'cam12', 'cam17', 'cam06', 'cam18', 'cam22', 'cam26',
  'cam16', 'cam29', 'cam25', 'cam07',
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
