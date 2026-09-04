/**
 * Single-flight gates for grid-tile snapshot captures.
 *
 * History here matters. Originally WHEP snapshot captures (see
 * whepClient.ts) had their own concurrency gate and captureHlsSnapshot had
 * none at all — a HAR caught the gap: a slow HLS fallback fetch (this
 * origin routinely takes 10-45s) ran fully concurrently with fresh WHEP
 * negotiations, and three of those WHEP requests failed outright (status 0,
 * 100% "blocked" — cancelled before ever reaching the network), consistent
 * with both transports overloading the same single Render server at once.
 * The fix at the time was one gate shared by both transports.
 *
 * That overcorrected. A follow-up HAR over a full 3-minute session showed
 * only 6 of 24+ grid tiles ever got a single turn: a codec-fallback camera
 * on the HLS path took ~57s end-to-end for ONE capture (WHEP's 400 reject,
 * then HLS's own slow manifest/segment fetches) while holding the one
 * shared slot the whole time — starving every other tile, including fast
 * WHEP cameras that normally finish in 5-10s, of a turn at all.
 *
 * The actual fix is two separate lanes, not one merged one: WHEP captures
 * serialize against each other (that contention was real — see
 * whepClient.ts's own history), and HLS captures separately serialize
 * against each other, so a slow HLS turn can no longer block WHEP
 * progress. Total concurrent capture-related fetches is capped at 2 (one
 * per lane) — still a small fraction of the original unthrottled
 * free-for-all that caused the very first version of this problem.
 */
export interface CaptureGate {
  acquire: () => Promise<() => void>;
}

function createCaptureGate(maxConcurrent: number): CaptureGate {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        const grant = () => {
          active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active--;
            const next = queue.shift();
            if (next) next();
          });
        };
        if (active < maxConcurrent) grant();
        else queue.push(grant);
      });
    },
  };
}

export const whepCaptureGate = createCaptureGate(1);
export const hlsCaptureGate = createCaptureGate(1);
