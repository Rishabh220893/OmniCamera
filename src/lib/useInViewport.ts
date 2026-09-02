import { RefObject, useEffect, useState } from 'react';

/**
 * Tracks whether an element is within (or near) the viewport, debounced on
 * the way OUT of view. Used to gate live video connections in a large
 * camera grid — decoding 30 simultaneous 1080p WebRTC streams was observed
 * saturating the browser's decode pipeline badly enough that tiles which
 * HAD connected successfully would lose frames and drop, even with
 * signaling-side concurrency already limited (see whepClient.ts). Only
 * cameras actually visible (plus a scroll-ahead margin) need to be
 * decoding at any given moment.
 *
 * A plain, undebounced IntersectionObserver reading isn't safe to gate a
 * live connection on directly: a tile sitting right at the rootMargin
 * boundary can flip in/out of "intersecting" repeatedly as the page
 * re-renders (e.g. a neighboring tile's video loading shifts layout by a
 * pixel), and tearing a connection down and rebuilding it on every flip was
 * observed causing a tight connect/disconnect loop that never actually got
 * a camera live. Becoming visible is reported immediately; becoming hidden
 * only takes effect after it's stayed hidden for `leaveDebounceMs`.
 *
 * That debounce needs to comfortably outlast ordinary scrolling, not just
 * render jitter — a viewer scrolling down to check another camera and
 * back up within a few seconds is normal browsing, not "gone", and a
 * production report confirmed a short debounce was tearing down tiles the
 * viewer considered already-loaded on completely ordinary scrolling.
 * Generous here costs little: it only delays reclaiming decode capacity
 * for a tile actually abandoned, it never delays reconnecting one that's
 * visible.
 */
export function useInViewport<T extends Element>(
  ref: RefObject<T>,
  rootMargin = '150px',
  leaveDebounceMs = 30_000,
): boolean {
  const [rawInViewport, setRawInViewport] = useState(false);
  const [debouncedInViewport, setDebouncedInViewport] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setRawInViewport(true); return; }
    const observer = new IntersectionObserver(
      (entries) => setRawInViewport(entries[0]?.isIntersecting ?? false),
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin]);

  useEffect(() => {
    if (rawInViewport) { setDebouncedInViewport(true); return; }
    const timer = setTimeout(() => setDebouncedInViewport(false), leaveDebounceMs);
    return () => clearTimeout(timer);
  }, [rawInViewport, leaveDebounceMs]);

  return debouncedInViewport;
}
