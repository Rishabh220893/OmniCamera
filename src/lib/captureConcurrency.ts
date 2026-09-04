/**
 * Shared single-flight gate for grid-tile snapshot captures, across BOTH
 * transports (WHEP and its HLS fallback — see whepClient.ts/hlsSnapshot.ts).
 *
 * A HAR capture caught the gap this closes: WHEP's own capture-concurrency
 * gate (see whepClient.ts) only serialized WHEP attempts against each
 * other. It said nothing about captureHlsSnapshot, which runs its own
 * unrelated fetches with no limiting at all — so a slow HLS fallback fetch
 * (this origin routinely takes 10-45s) and the "next" WHEP capture in the
 * WHEP-only queue ran concurrently regardless, both hitting our own single
 * Render server. Three WHEP requests failed outright during exactly that
 * overlap (status 0, zero time in any phase but "blocked" — cancelled
 * before ever reaching the network), which fits a shared server/origin
 * running out of some concurrency headroom under that combined load. One
 * gate shared by both transports means "one capture in flight, period" is
 * actually true campus-wide, not just within one transport.
 */
const MAX_CONCURRENT_CAPTURES = 1;
let activeSlots = 0;
const queue: Array<() => void> = [];

export function acquireCaptureSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      activeSlots++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeSlots--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (activeSlots < MAX_CONCURRENT_CAPTURES) grant();
    else queue.push(grant);
  });
}
