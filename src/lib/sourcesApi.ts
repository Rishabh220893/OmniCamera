import { auth } from './firebase';

/** What the Registry shows about a camera onboarded through an adapter (server/sources/routes.ts). */
export interface SourceRow {
  cameraId: string; name: string; adapter: string; host: string | null; port: number | null; departmentId: string | null;
  registryId: string | null; ownerUid: string; createdAt: string;
  recipe: string | null; pathKind: string | null; failure: string | null; probedAt: string | null;
}
export interface AdapterInfo { kind: string; label: string; description: string; canDiscover: boolean; canReadDevice: boolean; canListChannels: boolean }
export interface DiscoveredDevice { adapter: string; address: string; serviceUrls: string[]; name?: string; hardware?: string; manufacturer?: string }
export interface ChannelRow { channel: number; name: string | null; online: boolean | null; address: string | null }

/** The camera as the server takes it (a CameraRef). `credentials` is used for the call and stored sealed; it is never returned. */
export interface SourceCamera {
  id: string; adapter?: string; host?: string; port?: number; url?: string; name?: string;
  credentials?: { user: string; pass: string }; options?: Record<string, unknown>;
}

export type OnboardResponse =
  | { ok: true; cameraId: string; registryId: string; adapter: string; name: string; recipe: string; reason: string; pathKind: 'pull' | 're-encode' | 'none'; warnings: string[]; flags: string[] }
  | { ok: false; code: string; error: string; failure?: string | null; detail?: string | null };

export interface JobStatus {
  id: string; state: 'running' | 'done'; total: number; done: number; error?: string;
  results: Array<{ channel: number; name: string; result: OnboardResponse }>;
}

/** Calls the onboarding endpoints as the signed-in administrator. A refusal that carries a result body (a camera that could not be added) is returned, not thrown. */
async function call<T>(path: string, init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; allowBody?: boolean } = {}): Promise<T> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  // A server that does not have the route answers with the app's own page (HTML), not JSON: say so instead of showing an empty list.
  if (data === null || typeof data !== 'object') throw new Error(res.ok ? 'This server did not answer as expected (is it running an older version without this feature?).' : `The server answered ${res.status}.`);
  if (!res.ok && !(init.allowBody && (data as { ok?: boolean }).ok === false)) throw new Error((data as { error?: string }).error || `The server answered ${res.status}.`);
  return data as T;
}

export const sourcesApi = {
  list: () => call<{ sources: SourceRow[]; keyConfigured: boolean; canApplyMedia: boolean }>('/api/sources'),
  adapters: () => call<{ adapters?: AdapterInfo[] }>('/api/adapters').then((r) => r.adapters ?? []),
  discover: (adapter: string) => call<{ devices?: DiscoveredDevice[] }>('/api/adapters/discover', { method: 'POST', body: { adapter, timeoutMs: 4000 } }).then((r) => r.devices ?? []),
  channels: (camera: SourceCamera) => call<{ channels?: ChannelRow[] }>('/api/adapters/channels', { method: 'POST', body: { camera } }).then((r) => r.channels ?? []),
  onboard: (b: { camera: SourceCamera; name?: string; departmentId?: string | null; force?: boolean }) => call<OnboardResponse>('/api/sources/onboard', { method: 'POST', body: b, allowBody: true }),
  onboardChannels: (b: { camera: SourceCamera; channels: number[]; namePrefix?: string; departmentId?: string | null; force?: boolean }) =>
    call<{ jobId: string; total: number }>('/api/sources/onboard-channels', { method: 'POST', body: b }),
  job: (id: string) => call<{ job: JobStatus }>(`/api/sources/jobs/${encodeURIComponent(id)}`).then((r) => r.job),
  reprobe: (id: string) => call<{ ok: boolean; recipe?: string; failure?: string | null; error?: string }>(`/api/sources/${encodeURIComponent(id)}/reprobe`, { method: 'POST', body: {} }),
  remove: (id: string) => call<{ status: string }>(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  applyMedia: (dryRun: boolean) => call<{ dryRun: boolean; add: string[]; replace: string[]; remove: string[]; unchanged: string[]; errors: string[]; skipped: Array<{ cameraId: string; why: string }>; gridInFile?: boolean }>('/api/sources/apply-media', { method: 'POST', body: { dryRun } }),
};
