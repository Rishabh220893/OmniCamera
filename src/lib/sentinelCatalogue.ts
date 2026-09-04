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

export interface SentinelCameraEntry {
  name: string;
  remoteStreamUrl: string;
  isLive: boolean | null;
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

/** Digs into a couple of plausible wrapper shapes to find the actual camera array. */
function extractCameraArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
  if (payload && typeof payload === 'object') {
    for (const key of ['cameras', 'data', 'items', 'streams', 'results']) {
      const val = (payload as Record<string, unknown>)[key];
      if (Array.isArray(val)) return val.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
    }
  }
  return [];
}

export async function fetchSentinelCatalogue(streamAccessPassword: string, streamAccessEmail?: string): Promise<SentinelCameraEntry[]> {
  const res = await fetch(`/api/camera-catalogue?host=${encodeURIComponent('cctv.corp8.cloud')}${streamAccessPassword ? `&password=${encodeURIComponent(streamAccessPassword)}` : ''}${streamAccessEmail ? `&email=${encodeURIComponent(streamAccessEmail)}` : ''}`);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Catalogue request failed (${res.status}): ${text.slice(0, 200)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Catalogue response wasn't valid JSON: ${text.slice(0, 200)}`);
  }

  const rawCameras = extractCameraArray(payload);
  if (rawCameras.length === 0) {
    throw new Error(`Catalogue response had no recognizable camera list. Raw shape: ${text.slice(0, 300)}`);
  }

  const entries: SentinelCameraEntry[] = [];
  for (const cam of rawCameras) {
    const id = firstString(cam, ['id', 'camera_id', 'cam_id', 'camId']);
    if (!id) continue;

    const label = firstString(cam, ['location', 'name', 'label', 'site', 'title']) || `Camera ${id}`;
    const isLive = firstBoolean(cam, ['live', 'is_live', 'status', 'online']);
    const remoteStreamUrl = `https://cctv.corp8.cloud/${id}/index.m3u8`;

    entries.push({ name: `${id} ${label}`.trim(), remoteStreamUrl, isLive });
  }

  if (entries.length === 0) {
    throw new Error(`Catalogue returned ${rawCameras.length} entries but none had a usable id field.`);
  }
  return entries;
}
