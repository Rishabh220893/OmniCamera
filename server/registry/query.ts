/**
 * Filtering and export for the registry API (Model 1: "role-based search, filtering, export").
 * Pure functions over the camera records the route has already read, so they are tested without Firestore.
 */

export interface RegistryCamera {
  id: string;
  name?: string;
  department?: string;
  ownership?: string;
  cameraType?: string;
  connectivityStatus?: string;
  maintenanceStatus?: string;
  installDate?: string;
  storageDetails?: string;
  location?: { lat?: number; lng?: number };
  [k: string]: unknown;
}

export interface RegistryFilter {
  q?: string;
  department?: string;
  status?: string;
  maintenance?: string;
  type?: string;
  /** minLng,minLat,maxLng,maxLat */
  bbox?: [number, number, number, number];
  /** Only records installed before this date (ageing infrastructure). */
  installedBefore?: string;
}

export class FilterError extends Error {}

const text = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Reads the filter from a query string; a value that cannot be read is an error to tell the caller about, not something to ignore. */
export function parseFilter(query: Record<string, unknown>): RegistryFilter {
  const f: RegistryFilter = {};
  f.q = text(query.q); f.department = text(query.department); f.status = text(query.status); f.maintenance = text(query.maintenance); f.type = text(query.type);
  const before = text(query.installedBefore, 10);
  if (before) { if (!/^\d{4}-\d{2}-\d{2}$/.test(before) || Number.isNaN(Date.parse(before))) throw new FilterError("'installedBefore' must be a date like 2020-01-01."); f.installedBefore = before; }
  const bbox = text(query.bbox, 100);
  if (bbox) {
    const p = bbox.split(',').map((x) => Number(x));
    if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new FilterError("'bbox' must be minLng,minLat,maxLng,maxLat.");
    const [minLng, minLat, maxLng, maxLat] = p;
    if (minLng > maxLng || minLat > maxLat || minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) throw new FilterError("'bbox' is out of range or its corners are the wrong way round.");
    f.bbox = [minLng, minLat, maxLng, maxLat];
  }
  for (const k of Object.keys(f) as Array<keyof RegistryFilter>) if (f[k] === undefined) delete f[k];
  return f;
}

export function filterCameras<T extends RegistryCamera>(cameras: T[], f: RegistryFilter): T[] {
  const q = f.q?.toLowerCase();
  return cameras.filter((c) => {
    if (q && !`${c.name ?? ''} ${c.department ?? ''} ${c.ownership ?? ''} ${c.storageDetails ?? ''}`.toLowerCase().includes(q)) return false;
    if (f.department && (c.department ?? '').toLowerCase() !== f.department.toLowerCase()) return false;
    if (f.status && (c.connectivityStatus ?? 'unknown') !== f.status) return false;
    if (f.maintenance && (c.maintenanceStatus ?? 'operational') !== f.maintenance) return false;
    if (f.type && (c.cameraType ?? '') !== f.type) return false;
    if (f.installedBefore && !(c.installDate && c.installDate < f.installedBefore)) return false;
    if (f.bbox) {
      const lat = c.location?.lat, lng = c.location?.lng;
      if (typeof lat !== 'number' || typeof lng !== 'number') return false;
      if (lng < f.bbox[0] || lat < f.bbox[1] || lng > f.bbox[2] || lat > f.bbox[3]) return false;
    }
    return true;
  });
}

/** RFC 7946 GeoJSON, for QGIS, ArcGIS, Leaflet and anything else that reads it. Cameras without coordinates are left out (they have no geometry). */
export function toGeoJson(cameras: RegistryCamera[]) {
  return {
    type: 'FeatureCollection' as const,
    features: cameras
      .filter((c) => typeof c.location?.lat === 'number' && typeof c.location?.lng === 'number')
      .map((c) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [c.location!.lng as number, c.location!.lat as number] },
        properties: { id: c.id, name: c.name ?? '', department: c.department ?? '', ownership: c.ownership ?? '', cameraType: c.cameraType ?? '', connectivityStatus: c.connectivityStatus ?? 'unknown', maintenanceStatus: c.maintenanceStatus ?? 'operational', installDate: c.installDate ?? '', storageDetails: c.storageDetails ?? '' },
      })),
  };
}

const COLUMNS = ['id', 'name', 'department', 'ownership', 'cameraType', 'connectivityStatus', 'maintenanceStatus', 'installDate', 'storageDetails', 'lat', 'lng'] as const;
const cell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // a cell that starts like a formula stays text in a spreadsheet
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The same columns the bulk-import CSV reads, so an export can be edited and imported again. */
export function toCsv(cameras: RegistryCamera[]): string {
  const rows = cameras.map((c) => COLUMNS.map((k) => (k === 'lat' ? c.location?.lat : k === 'lng' ? c.location?.lng : c[k])).map(cell).join(','));
  return [COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
