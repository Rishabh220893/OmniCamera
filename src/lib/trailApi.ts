import { auth } from './firebase';
import { call } from './adminApi';

export interface PlateSummary { plate: string; reads: number; cameras: number; departments: string[]; lastSeen: string }
export interface TrailSighting { id: string; plate: string; cameraId: string; cameraName: string; department?: string; location?: { lat: number; lng: number }; timestamp: string; confidence: number | null; source: string; matchedAs: 'exact' | 'confirmed' }
export interface TrailSegment { index: number; cameraId: string; cameraName: string; department?: string; location?: { lat: number; lng: number }; start: string; end: string; sightings: TrailSighting[]; bestConfidence: number | null }
export interface TrailLeg { fromIndex: number; toIndex: number; distanceKm: number | null; seconds: number; speedKmh: number | null; flags: Array<'implausible_speed' | 'simultaneous' | 'no_location'> }
export interface Trail {
  plate: string;
  window: { from: string; to: string };
  reads: number;
  route: { segments: TrailSegment[]; legs: TrailLeg[]; totalDistanceKm: number; firstSeen: string | null; lastSeen: string | null };
  departments: string[];
  possible: Array<{ plate: string; count: number; distance: number; lastSeen?: string }>;
  confirmed: string[];
  elsewhere: Array<{ department: string; reads: number }>;
  truncated: boolean;
  notes: string[];
}

const trailPath = (plate: string, days: number, also: string[]) => `/api/trail/${encodeURIComponent(plate)}?days=${days}${also.length ? `&also=${also.map(encodeURIComponent).join(',')}` : ''}`;

export const trailApi = {
  plates: (days: number, q = '') => call<{ plates: PlateSummary[]; truncated: boolean }>(`/api/trail/plates?days=${days}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  trail: (plate: string, days: number, also: string[] = []) => call<Trail>(trailPath(plate, days, also)),
  /** The evidence as a CSV file (fetched with the sign-in, then saved). */
  async downloadCsv(plate: string, days: number, also: string[] = []): Promise<void> {
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
    const res = await fetch(`${trailPath(plate, days, also)}&format=csv`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `The server answered ${res.status}.`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `trail-${plate}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

/** Where each camera sits in a box: a plain projection (longitude scaled by the cosine of the middle latitude) that keeps the shape of the route. */
export function projectPoints(points: Array<{ lat: number; lng: number }>, width: number, height: number, pad = 24): Array<{ x: number; y: number }> {
  if (points.length === 0) return [];
  const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * k, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const offX = (width - spanX * scale) / 2, offY = (height - spanY * scale) / 2;
  return points.map((p) => ({ x: offX + (p.lng - minLng) * k * scale, y: height - (offY + (p.lat - minLat) * scale) }));
}
