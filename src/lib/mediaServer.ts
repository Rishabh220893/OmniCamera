import { useEffect, useState } from 'react';
import { auth } from './firebase';

/** What /api/media/config says about the media server (media-server/): where it is and how to log in. */
export interface MediaConfig {
  enabled: boolean;
  hlsUrl?: string;
  user?: string;
  password?: string;
  /** Live tiles in the grid that play from the media server; the rest stay refreshed stills. */
  maxLiveTiles?: number;
}

/** Cameras whose media-server stream failed this session; they use the app's own proxy instead. */
export const mediaFailedCameras = new Set<string>();

/** "https://cctv.corp8.cloud/cam07/index.m3u8" -> "cam07" */
export function gridCamId(streamUrl: string): string | null {
  return streamUrl.match(/\/(cam\d{1,3})\//i)?.[1]?.toLowerCase() ?? null;
}

export function mediaPlaylistUrl(cfg: MediaConfig, camId: string): string {
  // MediaMTX answers the first playlist request with a one-time redirect to "?cookieCheck=1", and a browser
  // drops the Authorization header on a cross-origin redirect, so the login would be lost. Asking for
  // "?cookieCheck=1" up front skips that redirect.
  return `${(cfg.hlsUrl || '').replace(/\/+$/, '')}/${camId}/index.m3u8?cookieCheck=1`;
}

export function mediaAuthHeader(cfg: MediaConfig): string {
  return 'Basic ' + btoa(`${cfg.user || 'viewer'}:${cfg.password || ''}`);
}

async function fetchMediaConfig(): Promise<MediaConfig> {
  try {
    const user = auth.currentUser;
    const token = user ? await user.getIdToken() : null;
    const res = await fetch('/api/media/config', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return { enabled: false };
    return (await res.json()) as MediaConfig;
  } catch {
    return { enabled: false };
  }
}

let shared: Promise<MediaConfig> | null = null;
let sharedForUid: string | null | undefined;

/** One config per signed-in user, fetched once and shared by every tile. */
export function loadMediaConfig(): Promise<MediaConfig> {
  const uid = auth.currentUser?.uid ?? null;
  if (!shared || sharedForUid !== uid) { sharedForUid = uid; shared = fetchMediaConfig(); }
  return shared;
}

export function useMediaConfig(): MediaConfig | null {
  const [cfg, setCfg] = useState<MediaConfig | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => { loadMediaConfig().then((c) => { if (alive) setCfg(c); }); };
    refresh();
    const unsub = auth.onAuthStateChanged(() => refresh());
    return () => { alive = false; unsub(); };
  }, []);
  return cfg;
}
