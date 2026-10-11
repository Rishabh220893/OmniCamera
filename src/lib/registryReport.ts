import { CameraConfig } from '../types';

/** A square of the map where no camera of the registry reaches (the centre, and how far the nearest camera is). */
export interface UncoveredZone { lat: number; lng: number; nearestMeters: number }

export interface MetadataGap { cameraId: string; cameraName: string; department: string; missing: string[] }

export interface GapAnalysisReport {
  unlocated: CameraConfig[];
  offlineOrDegraded: CameraConfig[];
  ageing: CameraConfig[];
  stale: CameraConfig[];
  departmentCoverage: { department: string; count: number }[];
  /** Cameras whose record lacks something a planner needs (ownership, storage, install date, type, department). */
  incompleteMetadata: MetadataGap[];
  /** Squares inside the area the registry's cameras span that none of them covers. Empty with fewer than 3 located cameras. */
  uncoveredZones: UncoveredZone[];
  /** The squares that are covered (the other half of the grid), so the map can paint them too. */
  coveredZones: UncoveredZone[];
  coverage: { radiusMeters: number; cellMeters: number; cellsChecked: number; coveredPercent: number; /** All uncovered squares; `uncoveredZones` lists only the emptiest ones. */ uncoveredTotal: number };
  generatedAt: Date;
}

const DEFAULT_AGEING_YEARS = 5;
const DEFAULT_STALE_DAYS = 7;
export const DEFAULT_COVERAGE_RADIUS_M = 300;
/** At most this many squares are checked; a wide area gets bigger squares instead of a slower report. */
const MAX_CELLS = 2500;

const EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Which parts of the area the cameras span are not within `radiusMeters` of any camera. The area is the bounding box of the located
 * cameras plus one radius of margin, cut into squares (half a radius wide, or larger for a wide area so that at most 2,500 are checked).
 * It says where the registry has no camera; it cannot know about buildings, roads or what is worth watching.
 */
export function findUncoveredZones(cameras: CameraConfig[], radiusMeters = DEFAULT_COVERAGE_RADIUS_M): { zones: UncoveredZone[]; covered: UncoveredZone[]; cellMeters: number; cellsChecked: number; coveredPercent: number; uncoveredTotal: number } {
  const pts = cameras.filter((c) => c.location && Number.isFinite(c.location.lat) && Number.isFinite(c.location.lng)).map((c) => c.location!);
  if (pts.length < 3) return { zones: [], covered: [], cellMeters: 0, cellsChecked: 0, coveredPercent: 100, uncoveredTotal: 0 };
  const midLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const mPerDegLat = 111_320, mPerDegLng = 111_320 * Math.cos(rad(midLat));
  const pad = radiusMeters;
  const minLat = Math.min(...pts.map((p) => p.lat)) - pad / mPerDegLat, maxLat = Math.max(...pts.map((p) => p.lat)) + pad / mPerDegLat;
  const minLng = Math.min(...pts.map((p) => p.lng)) - pad / mPerDegLng, maxLng = Math.max(...pts.map((p) => p.lng)) + pad / mPerDegLng;
  const heightM = (maxLat - minLat) * mPerDegLat, widthM = (maxLng - minLng) * mPerDegLng;
  const cellMeters = Math.max(Math.round(radiusMeters / 2), Math.ceil(Math.sqrt((heightM * widthM) / MAX_CELLS)));
  const rows = Math.max(1, Math.ceil(heightM / cellMeters)), cols = Math.max(1, Math.ceil(widthM / cellMeters));
  const zones: UncoveredZone[] = [];
  const coveredZones: UncoveredZone[] = [];
  let covered = 0;
  // Cameras are put in the grid's own squares, and the nearest one to a square is looked for ring by ring outwards, stopping as soon as no
  // camera in a farther ring can be nearer. The result is the same as comparing with every camera (tested), without N comparisons per square.
  const buckets = new Map<number, Array<{ lat: number; lng: number }>>();
  for (const p of pts) {
    const br = Math.min(rows - 1, Math.max(0, Math.floor(((p.lat - minLat) * mPerDegLat) / cellMeters)));
    const bc = Math.min(cols - 1, Math.max(0, Math.floor(((p.lng - minLng) * mPerDegLng) / cellMeters)));
    const key = br * cols + bc;
    const list = buckets.get(key);
    if (list) list.push(p); else buckets.set(key, [p]);
  }
  const maxRing = Math.max(rows, cols);
  const nearestTo = (lat: number, lng: number, r: number, c: number): number => {
    let best = Infinity;
    const scan = (rr: number, cc: number) => {
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) return;
      const list = buckets.get(rr * cols + cc);
      if (!list) return;
      for (const p of list) { const d = distanceMeters(lat, lng, p.lat, p.lng); if (d < best) best = d; }
    };
    for (let k = 0; k <= maxRing; k++) {
      if (k === 0) scan(r, c);
      else {
        for (let cc = c - k; cc <= c + k; cc++) { scan(r - k, cc); scan(r + k, cc); } // the ring's top and bottom rows
        for (let rr = r - k + 1; rr <= r + k - 1; rr++) { scan(rr, c - k); scan(rr, c + k); } // and its two sides
      }
      if (best <= k * cellMeters) break; // every camera in a farther ring is at least k squares away
    }
    return best;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = minLat + ((r + 0.5) * cellMeters) / mPerDegLat, lng = minLng + ((c + 0.5) * cellMeters) / mPerDegLng;
      const nearest = nearestTo(lat, lng, r, c);
      // Covered = any part of the square is within the radius of a camera (centre distance minus the half diagonal), so a camera inside a large square covers it.
      if (nearest - cellMeters * 0.7071 <= radiusMeters) { covered++; coveredZones.push({ lat: +lat.toFixed(5), lng: +lng.toFixed(5), nearestMeters: Math.round(nearest) }); }
      else zones.push({ lat: +lat.toFixed(5), lng: +lng.toFixed(5), nearestMeters: Math.round(nearest) });
    }
  }
  zones.sort((a, b) => b.nearestMeters - a.nearestMeters); // the emptiest first
  const checked = rows * cols;
  return { zones, covered: coveredZones, uncoveredTotal: zones.length, cellMeters, cellsChecked: checked, coveredPercent: Math.round((covered / checked) * 1000) / 10 };
}

export function computeGapAnalysis(
  cameras: CameraConfig[],
  opts: { ageingYears?: number; staleDays?: number; coverageRadiusMeters?: number } = {}
): GapAnalysisReport {
  const ageingYears = opts.ageingYears ?? DEFAULT_AGEING_YEARS;
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const radius = opts.coverageRadiusMeters ?? DEFAULT_COVERAGE_RADIUS_M;
  const now = Date.now();
  const ageingCutoff = new Date();
  ageingCutoff.setFullYear(ageingCutoff.getFullYear() - ageingYears);
  const staleCutoffMs = staleDays * 24 * 60 * 60 * 1000;

  const unlocated = cameras.filter(c => !c.location);
  const offlineOrDegraded = cameras.filter(c => c.connectivityStatus === 'offline' || c.connectivityStatus === 'degraded');
  const ageing = cameras.filter(c => c.installDate && new Date(c.installDate) < ageingCutoff);
  const stale = cameras.filter(c => {
    if (!c.lastAnalysisTime) return true;
    const t = c.lastAnalysisTime instanceof Date ? c.lastAnalysisTime.getTime() : new Date(c.lastAnalysisTime).getTime();
    return now - t > staleCutoffMs;
  });

  const deptCounts = new Map<string, number>();
  cameras.forEach(c => {
    const dept = c.department?.trim() || 'Unassigned';
    deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
  });
  const departmentCoverage = Array.from(deptCounts.entries())
    .map(([department, count]) => ({ department, count }))
    .sort((a, b) => a.count - b.count);

  const incompleteMetadata: MetadataGap[] = [];
  for (const c of cameras) {
    const missing: string[] = [];
    if (!c.department?.trim()) missing.push('department');
    if (!c.ownership?.trim()) missing.push('ownership');
    if (!c.cameraType) missing.push('camera type');
    if (!c.storageDetails?.trim()) missing.push('storage details');
    if (!c.installDate) missing.push('install date');
    if (!c.location) missing.push('location');
    if (missing.length) incompleteMetadata.push({ cameraId: c.id, cameraName: c.name, department: c.department?.trim() || 'Unassigned', missing });
  }

  const cov = findUncoveredZones(cameras, radius);
  return {
    unlocated, offlineOrDegraded, ageing, stale, departmentCoverage, incompleteMetadata,
    uncoveredZones: cov.zones, coveredZones: cov.covered, coverage: { radiusMeters: radius, cellMeters: cov.cellMeters, cellsChecked: cov.cellsChecked, coveredPercent: cov.coveredPercent, uncoveredTotal: cov.uncoveredTotal },
    generatedAt: new Date(),
  };
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  // A cell that starts like a formula would run in a spreadsheet; a quote-prefix keeps it text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The whole gap report as one CSV (a section per finding), for planners who work in a spreadsheet. */
export function gapReportToCsv(r: GapAnalysisReport): string {
  const rows: unknown[][] = [];
  const add = (...cells: unknown[]) => rows.push(cells);
  add('Gap analysis report', r.generatedAt.toISOString());
  add('Uncovered squares', r.coverage.uncoveredTotal, 'listed below', r.uncoveredZones.length);
  add('Coverage radius (m)', r.coverage.radiusMeters, 'Square size (m)', r.coverage.cellMeters, 'Squares checked', r.coverage.cellsChecked, 'Covered %', r.coverage.coveredPercent);
  add();
  add('Section', 'Camera id', 'Camera', 'Department', 'Detail');
  const dept = (c: CameraConfig) => c.department?.trim() || 'Unassigned';
  r.unlocated.forEach((c) => add('Unlocated', c.id, c.name, dept(c), 'No coordinates'));
  r.offlineOrDegraded.forEach((c) => add('Offline or degraded', c.id, c.name, dept(c), c.connectivityStatus));
  r.ageing.forEach((c) => add('Ageing', c.id, c.name, dept(c), `Installed ${c.installDate}`));
  r.stale.forEach((c) => add('Stale', c.id, c.name, dept(c), 'No recent analysis'));
  r.incompleteMetadata.forEach((m) => add('Incomplete metadata', m.cameraId, m.cameraName, m.department, `Missing: ${m.missing.join(', ')}`));
  add();
  add('Uncovered zone', 'Latitude', 'Longitude', 'Nearest camera (m)');
  r.uncoveredZones.forEach((z) => add('Uncovered zone', z.lat, z.lng, z.nearestMeters));
  add();
  add('Department', 'Cameras');
  r.departmentCoverage.forEach((d) => add('Department', d.department, d.count));
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
