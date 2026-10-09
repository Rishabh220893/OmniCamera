/** "https://cctv.corp8.cloud/cam07/index.m3u8" -> "cam07" (also matches ".../live/stream/cam07/index.m3u8"). */
export function gridCamId(streamUrl: string): string | null {
  return streamUrl.match(/\/(cam\d{1,3})\//i)?.[1]?.toLowerCase() ?? null;
}
