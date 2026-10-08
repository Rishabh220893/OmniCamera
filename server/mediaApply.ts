/**
 * Changes a RUNNING MediaMTX to match the wanted paths, through its control API, without restarting it
 * (docs/camera-onboarding-plan.md section 6). Paths that did not change are not touched, so cameras being watched keep playing.
 * A path that is replaced or removed drops its current viewers, who reconnect on their own.
 *
 * Changes made through the API live only in the running server. The same paths are also written to the generated file
 * (server/mediaPaths.ts renderPathsYaml) that the server starts from, so a restart comes back the same.
 */
import { diffPaths, type PathConf, type PathDiff } from './mediaPaths';

export interface ApplyOptions {
  /** e.g. http://127.0.0.1:9997 (the media server only lets this machine call the API). */
  api: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  auth?: { user: string; pass: string };
}

export interface ApplyResult {
  diff: PathDiff;
  applied: boolean;
  /** One line per call that failed, with the server's answer. A failure does not stop the other changes. */
  errors: string[];
}

const headers = (o: ApplyOptions): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(o.auth ? { Authorization: 'Basic ' + Buffer.from(`${o.auth.user}:${o.auth.pass}`).toString('base64') } : {}),
});

export async function listPaths(o: ApplyOptions): Promise<Array<Record<string, unknown>>> {
  const f = o.fetchImpl ?? fetch;
  const items: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 1000; page++) {
    const r = await f(`${o.api}/v3/config/paths/list?page=${page}&itemsPerPage=500`, { headers: headers(o), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`MediaMTX API answered ${r.status} to the path list: ${(await r.text()).slice(0, 200)}`);
    const body = (await r.json()) as { pageCount?: number; items?: Array<Record<string, unknown>> };
    items.push(...(body.items ?? []));
    if (page + 1 >= (body.pageCount ?? 1)) break;
  }
  return items;
}

export async function applyPaths(want: Record<string, PathConf>, managed: Iterable<string>, o: ApplyOptions): Promise<ApplyResult> {
  const f = o.fetchImpl ?? fetch;
  const diff = diffPaths(await listPaths(o), want, managed);
  if (o.dryRun) return { diff, applied: false, errors: [] };
  const errors: string[] = [];
  const call = async (verb: 'add' | 'replace' | 'delete', id: string, conf?: PathConf) => {
    try {
      const r = await f(`${o.api}/v3/config/paths/${verb}/${encodeURIComponent(id)}`, {
        method: verb === 'delete' ? 'DELETE' : 'POST', headers: headers(o), body: conf ? JSON.stringify(conf) : undefined, signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) errors.push(`${verb} ${id}: ${r.status} ${(await r.text()).slice(0, 160).replace(/rtsp:\/\/[^@\s"]*@/g, 'rtsp://***@')}`);
    } catch (e) { errors.push(`${verb} ${id}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  for (const id of diff.add) await call('add', id, want[id]);
  for (const id of diff.replace) await call('replace', id, want[id]);
  for (const id of diff.remove) await call('delete', id);
  return { diff, applied: true, errors };
}
