import { auth } from './firebase';
import type { MediaApplyResponse, ProbeJobStatus, ProfilesResponse, RecipeCode } from './cameraProfileView';

/** Calls the server's playback-profile endpoints as the signed-in user (a guest in the local demo has no token, and the server allows that there). */
async function call<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `The server answered ${res.status}.`);
  return data as T;
}

export const profilesApi = {
  list: (site: string) => call<ProfilesResponse>(`/api/camera-profiles?site=${encodeURIComponent(site)}`),
  importSaved: (site: string) => call<{ imported: number; files: number }>('/api/camera-profiles/import', { method: 'POST', body: { site } }),
  probe: (site: string, cameraIds: string[], sampleSec = 30) => call<{ probe: ProbeJobStatus }>('/api/camera-profiles/probe', { method: 'POST', body: { site, cameraIds, sampleSec } }),
  stopProbe: (site: string) => call<{ probe: ProbeJobStatus }>('/api/camera-profiles/probe/stop', { method: 'POST', body: { site } }),
  setOverride: (site: string, cameraId: string, recipe: RecipeCode | null, reason: string | null) =>
    call<{ ok: true }>('/api/camera-profiles/override', { method: 'POST', body: { site, cameraId, recipe, reason } }),
  applyMedia: (site: string, dryRun: boolean) => call<MediaApplyResponse>('/api/camera-profiles/apply-media', { method: 'POST', body: { site, dryRun } }),
};
