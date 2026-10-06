/**
 * Demo-grid cameras from most to least reliable, so the first page of the feed shows the ones that actually
 * stream. Ranked from production logs and HARs: the first group connected and delivered clean frames within
 * about 5-15 s every time (and played from the media server); the middle groups were slower, intermittent or
 * not measured; the last group times out waiting for a keyframe or loses a large share of its packets at the
 * grid itself (cam07, 16, 25 and 29 log hundreds of lost RTP packets per second), so no client change fixes
 * them. Re-measure with `node scripts/check-grid-health.mjs` and paste its list here.
 */
export const GRID_HEALTH_ORDER: readonly string[] = [
  'cam01', 'cam02', 'cam03', 'cam13', 'cam14', 'cam15', 'cam05', 'cam12', 'cam20', 'cam19',
  'cam04', 'cam23', 'cam17', 'cam06',
  'cam08', 'cam10', 'cam27', 'cam30', 'cam18', 'cam22', 'cam26',
  'cam09', 'cam11', 'cam21', 'cam24', 'cam28',
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
