/** "https://cctv.corp8.cloud/cam07/index.m3u8" -> "cam07" (also matches ".../live/stream/cam07/index.m3u8"). */
export function gridCamId(streamUrl: string): string | null {
  return streamUrl.match(/\/(cam\d{1,3})\//i)?.[1]?.toLowerCase() ?? null;
}

/**
 * The media-server path a camera plays from: a grid camera's id, or the `fed-<hex>` path of a camera onboarded through an adapter
 * (".../fed-3f9a1c2b7d4e/index.m3u8"; only the path matters, the host is whatever the media server was called when it was added).
 * Everything that is specific to the grid (WebRTC, stills and the app's HLS proxy, all with the grid login) keeps using gridCamId.
 */
export function mediaPathId(streamUrl: string): string | null {
  return gridCamId(streamUrl) ?? streamUrl.match(/\/(fed-[a-f0-9]{6,32})\/index\.m3u8/i)?.[1]?.toLowerCase() ?? null;
}
