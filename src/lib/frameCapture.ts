/**
 * Shared still-frame capture for both snapshot transports (WHEP and HLS —
 * see whepClient.ts/hlsSnapshot.ts). Both used to draw straight to canvas
 * and accept whatever came out the instant the settle delay elapsed, with
 * no check on the actual pixel content — only that the video element had
 * non-zero dimensions.
 *
 * A screen recording showed the real consequence: a grid tile can end up
 * showing solid black, permanently, counted as a completely normal
 * successful "live" capture — no error, no retry, just black. The
 * integrator guide already warns about this exact failure mode: "a join
 * can start on a corrupt/black decoder frame that self-corrects almost
 * immediately." The original 900ms settle was written for that same
 * warning, but never actually checked whether the frame it grabbed WAS
 * still that transient black one — it just trusted a fixed delay to
 * always be long enough, which the recording shows isn't reliably true.
 */

const BLANK_FRAME_MAX_CHANNEL = 4;
const BLANK_FRAME_SAMPLE_GRID = 8;

/**
 * Samples a small grid of points across the frame rather than every pixel
 * — cheap, and enough to tell "no real signal decoded yet" (uniformly at
 * or near zero everywhere) from a legitimately dark scene (a night-vision
 * feed, an unlit room), which still has some pixel variation — sensor
 * noise if nothing else — that a genuinely blank decoder frame does not.
 */
function isCanvasBlank(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  for (let row = 0; row < BLANK_FRAME_SAMPLE_GRID; row++) {
    for (let col = 0; col < BLANK_FRAME_SAMPLE_GRID; col++) {
      const x = Math.min(width - 1, Math.floor((col + 0.5) * width / BLANK_FRAME_SAMPLE_GRID));
      const y = Math.min(height - 1, Math.floor((row + 0.5) * height / BLANK_FRAME_SAMPLE_GRID));
      const [red, green, blue] = ctx.getImageData(x, y, 1, 1).data;
      if (Math.max(red, green, blue) > BLANK_FRAME_MAX_CHANNEL) return false;
    }
  }
  return true;
}

function drawFrame(video: HTMLVideoElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(video, 0, 0);
  return { canvas, ctx };
}

/**
 * Captures a still frame from `video`, giving a blank frame up to
 * `blankRetries` more short waits to self-correct before accepting
 * whatever it gets — never rejects forever, so a camera whose real feed
 * genuinely is black (lens cap, hard night vision) still eventually gets
 * a snapshot instead of looping indefinitely.
 */
export function captureFrameAllowingSettle(
  video: HTMLVideoElement,
  opts: { blankRetries?: number; retryDelayMs?: number } = {}
): Promise<string> {
  const { blankRetries = 2, retryDelayMs = 700 } = opts;
  return new Promise((resolve, reject) => {
    const attempt = (retriesLeft: number) => {
      if (!video.videoWidth) { reject(new Error('No frame available to capture')); return; }
      let canvas: HTMLCanvasElement;
      let ctx: CanvasRenderingContext2D;
      try {
        ({ canvas, ctx } = drawFrame(video));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Canvas unavailable'));
        return;
      }
      if (retriesLeft > 0 && isCanvasBlank(ctx, canvas.width, canvas.height)) {
        setTimeout(() => attempt(retriesLeft - 1), retryDelayMs);
        return;
      }
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    attempt(blankRetries);
  });
}
