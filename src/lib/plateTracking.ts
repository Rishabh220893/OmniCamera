/**
 * Plate sighting model, near-miss plate matching and route reconstruction.
 *
 * Pure functions only (no DOM, no Firebase) so the same code runs in the
 * browser, in the server's analysis worker, and under `npm test`.
 */

export interface LatLng { lat: number; lng: number }

/** One plate read at one camera at one moment. Persisted append-only. */
export interface PlateSighting {
  id: string;
  plate: string;
  cameraId: string;
  cameraName: string;
  department?: string;
  /** Camera position when the plate was read (kept even if the camera is later moved or deleted). */
  location?: LatLng;
  timestamp: Date;
  /** OCR confidence 0–1; null when the read came from a source that doesn't report one. */
  confidence: number | null;
  source: 'anpr' | 'gemini' | 'gemini-fallback';
  formatValid?: boolean;
  corrected?: boolean;
}

export const normalizePlate = (raw: string): string => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------------------
// Recording sightings
// ---------------------------------------------------------------------------

export interface SightingCamera { id: string; name: string; department?: string; location?: LatLng }
export interface PlateReadInfo { plate: string; confidence: number; formatValid?: boolean; corrected?: boolean }

/** Stable id, so retrying a write can't create a duplicate sighting. */
export const sightingId = (cameraId: string, at: Date, plate: string) => `${cameraId}_${at.getTime()}_${plate}`;

export function buildSightings(
  camera: SightingCamera,
  at: Date,
  plates: string[],
  reads: PlateReadInfo[],
  source: PlateSighting['source'],
): PlateSighting[] {
  const readByPlate = new Map(reads.map((r) => [normalizePlate(r.plate), r]));
  const seen = new Set<string>();
  const out: PlateSighting[] = [];
  for (const raw of plates) {
    const plate = normalizePlate(raw);
    if (!plate || seen.has(plate)) continue;
    seen.add(plate);
    const read = readByPlate.get(plate);
    out.push({
      id: sightingId(camera.id, at, plate), plate, cameraId: camera.id, cameraName: camera.name,
      department: camera.department, location: camera.location, timestamp: at,
      confidence: read ? read.confidence : null, source,
      formatValid: read?.formatValid, corrected: read?.corrected,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Possible matches (near-miss plates)
// ---------------------------------------------------------------------------

/** Characters OCR commonly confuses; a swap inside a group is a "half" edit. */
const CONFUSABLE_GROUPS = ['0OQD', '1IL', '8B', '5S', '2Z', '6G', 'UV'];
const CONFUSABLE_COST = 0.5;
const MIN_PLATE_LENGTH = 4;

const confusable = (a: string, b: string) => CONFUSABLE_GROUPS.some((g) => g.includes(a) && g.includes(b));

export interface PlateEdit {
  type: 'confusable' | 'substitute' | 'insert' | 'delete';
  /** 1-based position in the searched plate. */
  position: number;
  /** 1-based position in the candidate plate (absent for a deletion — the character isn't there). */
  candidatePosition?: number;
  from?: string;
  to?: string;
}

/** OCR-aware edit distance from `a` (the searched plate) to `b` (a plate seen), with the edits that explain it. */
export function plateDistance(a: string, b: string): { distance: number; edits: PlateEdit[] } {
  const n = a.length, m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) d[i][0] = i;
  for (let j = 1; j <= m; j++) d[0][j] = j;
  const subCost = (x: string, y: string) => (x === y ? 0 : confusable(x, y) ? CONFUSABLE_COST : 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]));
    }
  }
  const edits: PlateEdit[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1])) {
      if (a[i - 1] !== b[j - 1]) edits.push({ type: confusable(a[i - 1], b[j - 1]) ? 'confusable' : 'substitute', position: i, candidatePosition: j, from: a[i - 1], to: b[j - 1] });
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      edits.push({ type: 'delete', position: i, from: a[i - 1] }); i--;
    } else {
      edits.push({ type: 'insert', position: i + 1, candidatePosition: j, to: b[j - 1] }); j--;
    }
  }
  return { distance: d[n][m], edits: edits.reverse() };
}

export interface PlateCandidate { plate: string; count: number; lastSeen?: Date }
export interface PossibleMatch extends PlateCandidate { distance: number; edits: PlateEdit[] }

/**
 * Plates that are *probably the same plate misread*: within one real edit, or
 * up to two OCR-confusable swaps. Exact matches are excluded (they're the
 * result, not a candidate) and very short strings are ignored. A person
 * decides whether a candidate is really the same vehicle.
 */
export function findPossibleMatches(query: string, candidates: PlateCandidate[], maxDistance = 1): PossibleMatch[] {
  const q = normalizePlate(query);
  if (q.length < MIN_PLATE_LENGTH) return [];
  const out: PossibleMatch[] = [];
  for (const c of candidates) {
    const plate = normalizePlate(c.plate);
    if (plate === q || plate.length < MIN_PLATE_LENGTH || Math.abs(plate.length - q.length) > 1) continue;
    const { distance, edits } = plateDistance(q, plate);
    if (distance <= maxDistance) out.push({ ...c, plate, distance, edits });
  }
  return out.sort((x, y) => x.distance - y.distance || y.count - x.count || x.plate.localeCompare(y.plate));
}

/** "digit 0" / "letter O" — in a monospace font these look the same, so say which is which. */
const charName = (c: string) => (/\d/.test(c) ? `digit ${c}` : `letter ${c}`);

export const describeEdit = (e: PlateEdit): string => {
  switch (e.type) {
    case 'confusable': return `${charName(e.from!)} ↔ ${charName(e.to!)} at position ${e.position} (look-alike)`;
    case 'substitute': return `${charName(e.from!)} → ${charName(e.to!)} at position ${e.position}`;
    case 'insert': return `extra ${charName(e.to!)} at position ${e.position}`;
    case 'delete': return `missing ${charName(e.from!)} at position ${e.position}`;
  }
};

/** Order-independent key for a pair of plates, so a decision applies in both directions. */
export const pairKey = (a: string, b: string): string => {
  const [x, y] = [normalizePlate(a), normalizePlate(b)].sort();
  return `${x}__${y}`;
};

// ---------------------------------------------------------------------------
// Route reconstruction
// ---------------------------------------------------------------------------

export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RouteSighting extends PlateSighting {
  /** Plate the user searched for; differs from `plate` when this read came from a confirmed look-alike. */
  matchedAs: 'exact' | 'confirmed';
}

export interface RouteSegment {
  index: number;
  cameraId: string;
  cameraName: string;
  department?: string;
  location?: LatLng;
  start: Date;
  end: Date;
  sightings: RouteSighting[];
  bestConfidence: number | null;
}

export type LegFlag = 'implausible_speed' | 'simultaneous' | 'no_location';

export interface RouteLeg {
  fromIndex: number;
  toIndex: number;
  distanceKm: number | null;
  seconds: number;
  speedKmh: number | null;
  flags: LegFlag[];
}

export interface Route {
  segments: RouteSegment[];
  legs: RouteLeg[];
  totalDistanceKm: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
}

export interface RouteOptions {
  /** Consecutive reads at one camera closer than this are one visit, not many. */
  dwellGapMs?: number;
  /** Faster than this between two cameras is flagged as probably a misread or a different vehicle. */
  maxSpeedKmh?: number;
  /** Cameras closer than this can legitimately see the same vehicle at once (overlapping views). */
  simultaneousToleranceKm?: number;
}

const SIMULTANEOUS_GRACE_MS = 1000;

export function buildRoute(sightings: RouteSighting[], opts: RouteOptions = {}): Route {
  const { dwellGapMs = 5 * 60_000, maxSpeedKmh = 160, simultaneousToleranceKm = 0.3 } = opts;
  const sorted = [...sightings].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id));

  const segments: RouteSegment[] = [];
  for (const s of sorted) {
    const last = segments[segments.length - 1];
    if (last && last.cameraId === s.cameraId && s.timestamp.getTime() - last.end.getTime() <= dwellGapMs) {
      last.sightings.push(s);
      last.end = s.timestamp;
      if (s.confidence !== null && (last.bestConfidence === null || s.confidence > last.bestConfidence)) last.bestConfidence = s.confidence;
    } else {
      segments.push({
        index: segments.length, cameraId: s.cameraId, cameraName: s.cameraName, department: s.department,
        location: s.location, start: s.timestamp, end: s.timestamp, sightings: [s], bestConfidence: s.confidence,
      });
    }
  }

  const legs: RouteLeg[] = [];
  let totalDistanceKm = 0;
  for (let i = 1; i < segments.length; i++) {
    const from = segments[i - 1], to = segments[i];
    const seconds = Math.max(0, (to.start.getTime() - from.end.getTime()) / 1000);
    const flags: LegFlag[] = [];
    let distanceKm: number | null = null;
    let speedKmh: number | null = null;
    if (from.location && to.location) {
      distanceKm = haversineKm(from.location, to.location);
      totalDistanceKm += distanceKm;
      if (seconds * 1000 <= SIMULTANEOUS_GRACE_MS) {
        if (distanceKm > simultaneousToleranceKm) flags.push('simultaneous');
      } else {
        speedKmh = distanceKm / (seconds / 3600);
        if (speedKmh > maxSpeedKmh) flags.push('implausible_speed');
      }
    } else {
      flags.push('no_location');
    }
    legs.push({ fromIndex: i - 1, toIndex: i, distanceKm, seconds, speedKmh, flags });
  }

  return {
    segments, legs, totalDistanceKm,
    firstSeen: sorted.length ? sorted[0].timestamp : null,
    lastSeen: sorted.length ? sorted[sorted.length - 1].timestamp : null,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  // Leading = + - @ would be run as a formula by spreadsheet apps; plate and camera text comes from OCR/users.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const ROUTE_CSV_HEADER = [
  'Segment', 'Timestamp', 'Camera', 'Department', 'Latitude', 'Longitude', 'Plate read', 'Searched plate',
  'Match', 'OCR confidence', 'Source', 'Leg distance (km)', 'Leg speed (km/h)', 'Flags',
];

/** One row per sighting (the evidence), with each segment's incoming-leg figures on its first row. */
export function routeToCsv(searched: string, route: Route): string {
  const q = normalizePlate(searched);
  const rows: string[] = [ROUTE_CSV_HEADER.join(',')];
  for (const seg of route.segments) {
    const leg = route.legs.find((l) => l.toIndex === seg.index);
    seg.sightings.forEach((s, i) => {
      rows.push([
        seg.index + 1, s.timestamp.toISOString(), s.cameraName, s.department ?? '',
        s.location?.lat ?? '', s.location?.lng ?? '', s.plate, q,
        s.matchedAs === 'exact' ? 'exact' : 'confirmed look-alike',
        s.confidence === null ? '' : s.confidence.toFixed(2), s.source,
        i === 0 && leg?.distanceKm != null ? leg.distanceKm.toFixed(2) : '',
        i === 0 && leg?.speedKmh != null ? leg.speedKmh.toFixed(0) : '',
        i === 0 && leg ? leg.flags.join(' ') : '',
      ].map(csvCell).join(','));
    });
  }
  return rows.join('\n') + '\n';
}
