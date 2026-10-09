/**
 * How many re-encodes the media server is running right now, from its control API. Information only: the media server does not
 * refuse a seventh (step 6 decides where that gate belongs), but the Registry shows "N of M slots" and warns when it is over.
 */
export interface RunningTranscodes { running: string[]; slots: number; over: boolean; at: string }

/** `items` is /v3/paths/list; `transcodeIds` the cameras whose current recipe re-encodes. A path counts while its stream is ready. */
export function runningTranscodes(items: Array<Record<string, unknown>>, transcodeIds: Iterable<string>, slots: number, now = new Date()): RunningTranscodes {
  const wanted = new Set(transcodeIds);
  const running = items.filter((p) => wanted.has(String(p.name)) && p.ready === true).map((p) => String(p.name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { running, slots, over: running.length > slots, at: now.toISOString() };
}

export async function fetchActivePaths(api: string, fetchImpl: typeof fetch = fetch): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 100; page++) {
    const r = await fetchImpl(`${api}/v3/paths/list?page=${page}&itemsPerPage=500`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`MediaMTX API answered ${r.status}`);
    const body = (await r.json()) as { pageCount?: number; items?: Array<Record<string, unknown>> };
    items.push(...(body.items ?? []));
    if (page + 1 >= (body.pageCount ?? 1)) break;
  }
  return items;
}
