import type { CameraConfig } from '../types';
import { gridCamId } from './gridCamId';
import { detectStreamType } from './streamAdapters';

export type RecipeId = 'media' | 'whep' | 'proxy' | 'stills';

/** In the order they are tried: the cheapest for the grid first, a refreshed still last (it shows something whenever the camera answers at all). */
export const RECIPE_LABEL: Record<RecipeId, string> = {
  media: 'Media server (HLS)', whep: 'WebRTC (WHEP)', proxy: 'App proxy (HLS)', stills: 'Refreshed still pictures',
};

/**
 * Which ways of playing a camera apply, in the order to try them (Full Panel > a tile opened full screen).
 *   media  the media server, when there is one: it serves any number of viewers from one pull of the camera
 *   whep   WebRTC straight from the grid. Opt-in per URL for a tile (deriveWhepCamId), but here it is simply one of the ways to try:
 *          a camera that refuses it just moves on
 *   proxy  the app's own HLS route, which needs the grid login
 *   stills a picture refreshed every few seconds, which needs the grid login too
 */
export function plannedRecipes(o: { camId: string | null; url: string; hlsSupported: boolean; media: { enabled?: boolean } | null; hasLogin: boolean }): RecipeId[] {
  const out: RecipeId[] = [];
  const hls = detectStreamType(o.url) === 'hls';
  if (o.camId && o.media?.enabled && o.hlsSupported) out.push('media');
  if (o.camId) out.push('whep');
  if (hls && o.hlsSupported && o.hasLogin) out.push('proxy');
  if (o.camId && o.hasLogin) out.push('stills');
  return out;
}

/** "cam07" for a grid camera, else the camera's own name. */
export function tileTitle(c: Pick<CameraConfig, 'remoteStreamUrl' | 'name'>): string { return (gridCamId(c.remoteStreamUrl) ?? c.name).toUpperCase(); }

/** The name without its leading id: "CAM07 - Hero showroom" -> "Hero showroom"; falls back to coordinates or department. */
export function tileSubtitle(c: Pick<CameraConfig, 'remoteStreamUrl' | 'name' | 'location' | 'department'>): string {
  const id = gridCamId(c.remoteStreamUrl);
  const rest = id ? c.name.replace(new RegExp(`^${id}\\s*[-–:]?\\s*`, 'i'), '') : '';
  return rest && rest.toLowerCase() !== id ? rest : (c.location ? `${c.location.lat.toFixed(3)}, ${c.location.lng.toFixed(3)}` : c.department || '');
}

/** How many Gemini calls a minute a job can make at most: every camera once per interval, every interval (scenes that did not change are skipped). */
export function geminiCallsPerMinute(cameras: number, intervalSec = 10): number { return Math.ceil((cameras * 60) / Math.max(1, intervalSec)); }
