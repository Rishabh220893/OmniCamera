/**
 * Fetches the live camera list from the Sentinel grid's own catalogue
 * (/api/sentinel-catalogue, proxied server-side from the grid's documented
 * /api/ingest endpoint) instead of relying on a hardcoded URL list.
 *
 * The grid's integrator guide is explicit: "Always start from the
 * catalogue rather than hard-coding endpoints... camera ids and the set of
 * available cameras can change; the catalogue is the contract, the URL
 * pattern is not." demoGridCameras.ts's static list is exactly the thing
 * that guide warns against — this is what replaces it as the primary
 * source, falling back to that static list only if the live fetch fails.
 *
 * The exact JSON shape returned by /api/ingest isn't something this code
 * has been able to observe directly (this grid's host isn't reachable from
 * the environment this was written in), so field lookup is deliberately
 * tolerant of several plausible naming conventions rather than assuming
 * one exact schema.
 */

export interface SentinelCameraEntry {
  name: string;
  remoteStreamUrl: string;
  isLive: boolean | null;
}

const SENTINEL_HOST = '103.250.160.189';

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

export async function fetchSentinelCatalogue(): Promise<SentinelCameraEntry[]> {
  const res = await fetch('/api/sentinel-catalogue');
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

    // Prefer an explicit URL the catalogue hands us directly; only fall
    // back to constructing one from the documented pattern (and this
    // fetch's own host) if the entry doesn't include one — the catalogue
    // is the source of truth per the guide, not a pattern we should
    // assume even here.
    const explicitHls = firstString(cam, ['hls', 'hls_url', 'hlsUrl']) ||
      firstString((cam.urls as Record<string, unknown>) || {}, ['hls', 'hls_url', 'hlsUrl']);
    const remoteStreamUrl = explicitHls || `http://${SENTINEL_HOST}/live/stream/${id}/index.m3u8`;

    entries.push({ name: `${id} ${label}`.trim(), remoteStreamUrl, isLive });
  }

  if (entries.length === 0) {
    throw new Error(`Catalogue returned ${rawCameras.length} entries but none had a usable id field.`);
  }
  return entries;
}
