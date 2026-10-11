import { auth } from './firebase';

export type SnippetStatus = 'recording' | 'ready' | 'failed';
export interface SnippetRow {
  id: string; userId: string; cameraId: string; cameraName: string; department: string | null; title: string; status: SnippetStatus;
  requestedSeconds: number; actualSeconds: number | null; bytes: number; hasThumb: boolean; error: string | null; sha256: string | null;
  createdAt: string; finishedAt: string | null; fileUrl: string | null; thumbUrl: string | null;
}

export interface StreamAccess { email?: string; password?: string }

async function headers(access?: StreamAccess, json = false): Promise<Record<string, string>> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(access?.email ? { 'X-Stream-Email': access.email } : {}),
    ...(access?.password ? { 'X-Stream-Password': access.password } : {}),
  };
}

async function request<T>(path: string, init: { method?: string; body?: unknown; access?: StreamAccess } = {}): Promise<T> {
  const res = await fetch(path, { method: init.method ?? 'GET', headers: await headers(init.access, init.body !== undefined), body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || (res.status === 404 ? 'The snippet recorder is not available on this server.' : `The server answered ${res.status}.`));
  return data as T;
}

export const snippetsApi = {
  list: (cameraId?: string) => request<{ snippets: SnippetRow[] }>(`/api/snippets${cameraId ? `?cameraId=${encodeURIComponent(cameraId)}` : ''}`).then((r) => r.snippets),
  get: (id: string) => request<{ snippet: SnippetRow }>(`/api/snippets/${encodeURIComponent(id)}`).then((r) => r.snippet),
  start: (cameraId: string, seconds: number, title: string, access: StreamAccess) =>
    request<{ snippet: SnippetRow }>('/api/snippets', { method: 'POST', body: { cameraId, seconds, ...(title.trim() ? { title: title.trim() } : {}) }, access }).then((r) => r.snippet),
  remove: (id: string) => request<{ status: string }>(`/api/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** The video or the picture as an object URL (the request carries the sign-in, which a plain <video src> cannot). The caller revokes it. */
  blobUrl: async (path: string): Promise<string> => {
    const res = await fetch(path, { headers: await headers() });
    if (!res.ok) throw new Error(`The file could not be loaded (${res.status}).`);
    return URL.createObjectURL(await res.blob());
  },
  download: async (s: SnippetRow): Promise<void> => {
    const url = await snippetsApi.blobUrl(`/api/snippets/${encodeURIComponent(s.id)}/file`);
    const a = document.createElement('a'); a.href = url; a.download = `${s.title.replace(/[^\w.-]+/g, '_').slice(0, 80) || s.id}.mp4`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
