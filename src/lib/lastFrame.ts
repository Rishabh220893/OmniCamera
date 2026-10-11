/**
 * The last picture a camera showed in its full-screen window, kept so that the camera's tile in Feed > Full Panel can show it after the window is closed.
 *
 * Deliberately separate from `snapshotCache` (the grid's background refreshes): a tile changes only when ITS full-screen window has been closed,
 * never because a background snapshot arrived, and never while the window is still open. Kept in memory and in sessionStorage (so it survives
 * a reload of the page), small (a 480 px JPEG is about 25 KB), and bounded to the most recent MAX_FRAMES cameras.
 */

export interface LastFrame { dataUrl: string; at: number }

const KEY = 'cam-last-frame-';
export const MAX_FRAMES = 60;

const frames = new Map<string, LastFrame>();
const listeners = new Set<() => void>();
let version = 0;

function load() {
  if (typeof sessionStorage === 'undefined') return;
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k?.startsWith(KEY)) continue;
      const raw = sessionStorage.getItem(k);
      if (!raw) continue;
      const j = JSON.parse(raw) as LastFrame;
      if (typeof j.dataUrl === 'string' && j.dataUrl.startsWith('data:image/') && Number.isFinite(j.at)) frames.set(k.slice(KEY.length), j);
    }
  } catch { /* storage unavailable or damaged: start empty */ }
}
load();

const notify = () => { version++; for (const l of listeners) l(); };

export function getLastFrame(cameraId: string): LastFrame | undefined { return frames.get(cameraId); }

/** Stores the frame and tells the listeners. A picture that is not an image data URL, or is implausibly small, is ignored. */
export function setLastFrame(cameraId: string, dataUrl: string, at: number = Date.now()): boolean {
  if (!cameraId || !dataUrl.startsWith('data:image/') || dataUrl.length < 200) return false;
  frames.set(cameraId, { dataUrl, at });
  // Keep only the newest MAX_FRAMES.
  if (frames.size > MAX_FRAMES) {
    const oldest = [...frames.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, frames.size - MAX_FRAMES);
    for (const [id] of oldest) { frames.delete(id); try { sessionStorage.removeItem(KEY + id); } catch { /* ignore */ } }
  }
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.setItem(KEY + cameraId, JSON.stringify({ dataUrl, at })); } catch { /* quota: the in-memory copy still works */ }
  }
  notify();
  return true;
}

export function clearLastFrame(cameraId: string): void {
  if (!frames.delete(cameraId)) return;
  try { sessionStorage.removeItem(KEY + cameraId); } catch { /* ignore */ }
  notify();
}

/** For useSyncExternalStore: re-render when any frame changes. */
export function subscribeLastFrames(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function lastFramesVersion(): number { return version; }

/** A small JPEG of what a <video> or <img> shows right now, or null when it shows nothing yet (not decoded, zero size) or the browser forbids reading it. */
export function captureFrame(el: HTMLVideoElement | HTMLImageElement | null | undefined, maxWidth = 480, quality = 0.7): string | null {
  if (!el) return null;
  try {
    const isVideo = 'videoWidth' in el;
    const w = isVideo ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
    const h = isVideo ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
    if (!w || !h) return null;
    if (isVideo && (el as HTMLVideoElement).readyState < 2) return null;
    const k = Math.min(1, maxWidth / w);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k)); canvas.height = Math.max(1, Math.round(h * k));
    canvas.getContext('2d')!.drawImage(el, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', quality);
    return url.length > 200 ? url : null;
  } catch { return null; } // a tainted canvas (a picture from another origin without permission) throws
}
