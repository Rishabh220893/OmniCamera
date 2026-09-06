/**
 * In-memory cache for recent camera snapshots.
 * Preserves the last-known successful capture for each camera so tiles never
 * flicker, vanish into blank gray boxes, or unmount their pictures when
 * refreshing in the background or recovering from transient network hiccups.
 */

const cache = new Map<string, string>();

if (typeof sessionStorage !== 'undefined') {
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('cam-snap-')) {
        const camId = key.slice(9);
        const val = sessionStorage.getItem(key);
        if (val) cache.set(camId, val);
      }
    }
  } catch {
    // Ignore storage availability errors
  }
}

export function getCachedSnapshot(cameraId: string): string | undefined {
  return cache.get(cameraId);
}

export function setCachedSnapshot(cameraId: string, dataUrl: string): void {
  if (dataUrl && dataUrl.length > 50) {
    cache.set(cameraId, dataUrl);
    if (typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(`cam-snap-${cameraId}`, dataUrl);
      } catch {
        // Ignore storage quota errors
      }
    }
  }
}

export function hasCachedSnapshot(cameraId: string): boolean {
  return cache.has(cameraId);
}

export function clearCachedSnapshot(cameraId: string): void {
  cache.delete(cameraId);
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.removeItem(`cam-snap-${cameraId}`);
    } catch {
      // Ignore
    }
  }
}
