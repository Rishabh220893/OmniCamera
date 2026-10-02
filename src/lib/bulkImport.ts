/**
 * Planning for bulk camera onboarding (CSV import and the grid catalogue).
 *
 * Pure: given the rows to import and the cameras already registered, decide
 * what to create, what to *fill in* on cameras that already exist, and what to
 * skip — so the same code path serves a CSV, the live catalogue, and tests.
 */
export type ImportRow = Record<string, string>;

export interface ExistingCameraLike {
  id: string;
  name: string;
  remoteStreamUrl?: string;
  department?: string;
  ownership?: string;
  cameraType?: string;
  installDate?: string;
  storageDetails?: string;
  location?: { lat: number; lng: number };
}

export interface FillUpdate {
  id: string;
  name: string;
  fields: Record<string, unknown>;
}

export interface ImportPlan {
  create: ImportRow[];
  /** Existing cameras (matched by stream URL) that gain data they were missing. Nothing already set is overwritten. */
  update: FillUpdate[];
  /** Existing cameras that already have everything the row offers. */
  unchanged: number;
  /** Rows with no name. */
  invalid: number;
  /** Rows repeating a stream URL already seen earlier in the same batch. */
  duplicatesInBatch: number;
  /** Cameras covered by this import (new + matched) that still have no map location — their routes can't be mapped. */
  withoutLocation: number;
}

export const urlKey = (url: string | undefined): string => (url ?? '').trim().toLowerCase();

/** Valid WGS84 coordinates, or undefined. Rejects NaN, out-of-range values, and the (0,0) "null island" placeholder. */
export function parseLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | undefined {
  const toNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const la = toNum(lat), ln = toNum(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return undefined;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return undefined;
  if (la === 0 && ln === 0) return undefined;
  return { lat: la, lng: ln };
}

const FILLABLE = ['department', 'ownership', 'cameraType', 'installDate', 'storageDetails'] as const;

export function planBulkImport(rows: ImportRow[], existing: ExistingCameraLike[]): ImportPlan {
  const existingByUrl = new Map<string, ExistingCameraLike>();
  for (const c of existing) {
    const key = urlKey(c.remoteStreamUrl);
    if (key && !existingByUrl.has(key)) existingByUrl.set(key, c);
  }

  const plan: ImportPlan = { create: [], update: [], unchanged: 0, invalid: 0, duplicatesInBatch: 0, withoutLocation: 0 };
  const seenInBatch = new Set<string>();

  for (const row of rows) {
    if (!row.name?.trim()) { plan.invalid++; continue; }
    const key = urlKey(row.remoteStreamUrl);
    if (key) {
      if (seenInBatch.has(key)) { plan.duplicatesInBatch++; continue; }
      seenInBatch.add(key);
    }
    const rowLocation = parseLatLng(row.lat, row.lng);
    const match = key ? existingByUrl.get(key) : undefined;

    if (!match) {
      plan.create.push(row);
      if (!rowLocation) plan.withoutLocation++;
      continue;
    }

    const fields: Record<string, unknown> = {};
    for (const f of FILLABLE) {
      if (row[f]?.trim() && !match[f]?.toString().trim()) fields[f] = row[f].trim();
    }
    if (rowLocation && !match.location) fields.location = rowLocation;
    if (Object.keys(fields).length > 0) plan.update.push({ id: match.id, name: match.name, fields });
    else plan.unchanged++;
    if (!match.location && !rowLocation) plan.withoutLocation++;
  }
  return plan;
}

/** Splits work into Firestore-sized batches (a batch holds at most 500 operations). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ImportSummary { created: number; updated: number; unchanged: number; invalid: number; duplicatesInBatch: number; withoutLocation: number }

export const summarizePlan = (p: ImportPlan): ImportSummary => ({
  created: p.create.length, updated: p.update.length, unchanged: p.unchanged,
  invalid: p.invalid, duplicatesInBatch: p.duplicatesInBatch, withoutLocation: p.withoutLocation,
});

export function describeSummary(s: ImportSummary): string {
  const parts = [`${s.created} added`];
  if (s.updated) parts.push(`${s.updated} updated with missing details`);
  if (s.unchanged) parts.push(`${s.unchanged} already up to date`);
  if (s.duplicatesInBatch) parts.push(`${s.duplicatesInBatch} duplicate${s.duplicatesInBatch !== 1 ? 's' : ''} in the list skipped`);
  if (s.invalid) parts.push(`${s.invalid} row${s.invalid !== 1 ? 's' : ''} without a name skipped`);
  let text = parts.join(', ') + '.';
  if (s.withoutLocation) text += ` ${s.withoutLocation} camera${s.withoutLocation !== 1 ? 's have' : ' has'} no map location, so vehicle routes through ${s.withoutLocation !== 1 ? 'them' : 'it'} can't be mapped — add coordinates in Settings or re-import a CSV with lat/lng.`;
  return text;
}
