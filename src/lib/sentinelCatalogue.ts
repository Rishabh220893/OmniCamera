/**
 * Fetches the live camera list from the grid's own catalogue
 * (https://cctv.corp8.cloud/cameras.json, per its integrator guide) instead
 * of relying only on the hardcoded list in demoGridCameras.ts.
 *
 * The guide: "Start from the catalogue rather than hard-coding — the
 * camera set can change." Routed through the existing server-side
 * /api/camera-catalogue proxy (not called directly) for the same reasons
 * the HLS/WHEP paths are proxied: avoiding CORS, and keeping the access
 * password off the browser's network tab. That route already tries
 * /cameras.json before falling back to /api/ingest, and authenticates the
 * same way the confirmed-working HLS path does (password, session-cookie
 * login) — no separate email credential needed here, unlike WHEP/RTSP.
 *
 * The exact cameras.json shape isn't something this code has observed
 * directly, so field lookup is deliberately tolerant of a few plausible
 * naming conventions. Per the guide, <id> is "cam01 … cam30" and HLS lives
 * at https://cctv.corp8.cloud/<id>/index.m3u8 — that URL is constructed
 * directly from the id rather than trusting a possibly-differently-shaped
 * URL field in the catalogue response, since the id->URL mapping is the
 * one thing the guide states outright.
 */

import { parseLatLng } from './bulkImport';

export interface SentinelCameraEntry {
  name: string;
  remoteStreamUrl: string;
  isLive: boolean | null;
  /** Present only if the catalogue provides valid coordinates. */
  lat?: number;
  lng?: number;
  department?: string;
}

/** `bundled-fallback` means the real catalogue was unreachable and the server substituted its built-in list. */
export type CatalogueSource = 'live' | 'bundled-fallback';

export interface SentinelCatalogue {
  entries: SentinelCameraEntry[];
  source: CatalogueSource;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

function firstBoolean(obj: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const lower = val.toLowerCase();
      if (lower === 'live' || lower === 'online' || lower === 'up' || lower === 'true') return true;
      if (lower === 'offline' || lower === 'down' || lower === 'false') return false;
    }
  }
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Digs into a few plausible wrapper shapes to find the camera list: a bare
 * array, an array under a common key, or an object keyed by camera id
 * (`{ "cam01": {...}, "cam02": {...} }`), in which case the key becomes the id.
 */
export function extractCameraArray(payload: unknown): Record<string, unknown>[] {
  const records = (arr: unknown[]) => arr.filter(isRecord);
  if (Array.isArray(payload)) return records(payload);
  if (!isRecord(payload)) return [];
  for (const key of ['cameras', 'data', 'items', 'streams', 'results']) {
    const val = payload[key];
    if (Array.isArray(val)) return records(val);
    if (isRecord(val)) return keyedRecords(val);
  }
  return keyedRecords(payload);
}

function keyedRecords(obj: Record<string, unknown>): Record<string, unknown>[] {
  const entries = Object.entries(obj);
  if (entries.length === 0 || !entries.every(([, v]) => isRecord(v))) return [];
  return entries.map(([key, v]) => ({ id: key, ...(v as Record<string, unknown>) }));
}

/** Coordinates from `lat`/`lng`-style fields, or from a nested `location`/`coordinates`/`geo` object. */
function readCoordinates(cam: Record<string, unknown>): { lat: number; lng: number } | undefined {
  const direct = parseLatLng(cam.lat ?? cam.latitude, cam.lng ?? cam.lon ?? cam.long ?? cam.longitude);
  if (direct) return direct;
  for (const key of ['location', 'coordinates', 'coords', 'geo', 'position']) {
    const nested = cam[key];
    if (isRecord(nested)) {
      const c = parseLatLng(nested.lat ?? nested.latitude, nested.lng ?? nested.lon ?? nested.long ?? nested.longitude);
      if (c) return c;
    }
  }
  return undefined;
}

/** Turns a catalogue response into registry-ready entries. Pure, so it can be tested without a network. */
export function parseCatalogue(payload: unknown): SentinelCameraEntry[] {
  const seenIds = new Set<string>();
  const entries: SentinelCameraEntry[] = [];
  for (const cam of extractCameraArray(payload)) {
    const id = firstString(cam, ['id', 'camera_id', 'cam_id', 'camId']);
    if (!id || seenIds.has(id.toLowerCase())) continue;
    seenIds.add(id.toLowerCase());

    // `location` is a text label in some catalogues and an object of coordinates in others.
    const label = firstString(cam, ['location', 'name', 'label', 'site', 'title']) || `Camera ${id}`;
    const name = label.toLowerCase().includes(id.toLowerCase()) ? label : `${id} ${label}`.trim();
    const coords = readCoordinates(cam);
    entries.push({
      name,
      // The id -> HLS URL mapping is the one thing the integrator guide states outright.
      remoteStreamUrl: `https://cctv.corp8.cloud/${id}/index.m3u8`,
      isLive: firstBoolean(cam, ['live', 'is_live', 'status', 'online']),
      ...(coords ? coords : {}),
      department: firstString(cam, ['department', 'dept', 'department_name']) ?? undefined,
    });
  }
  return entries;
}

export async function fetchSentinelCatalogue(streamAccessPassword: string, streamAccessEmail?: string): Promise<SentinelCatalogue> {
  const res = await fetch(`/api/camera-catalogue?host=${encodeURIComponent('cctv.corp8.cloud')}${streamAccessPassword ? `&password=${encodeURIComponent(streamAccessPassword)}` : ''}${streamAccessEmail ? `&email=${encodeURIComponent(streamAccessEmail)}` : ''}`);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Catalogue request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  // The server answers 200 with its own built-in 30-camera list when the real
  // catalogue is unreachable; without this check that is indistinguishable from the real thing.
  const source: CatalogueSource = res.headers.get('X-Catalogue-Source') === 'bundled-fallback' ? 'bundled-fallback' : 'live';

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Catalogue response wasn't valid JSON: ${text.slice(0, 200)}`);
  }

  const entries = parseCatalogue(payload);
  if (entries.length === 0) {
    throw new Error(`Catalogue response had no usable cameras. Raw shape: ${text.slice(0, 300)}`);
  }
  return { entries, source };
}
