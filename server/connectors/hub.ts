/**
 * Makes calling an outside system safe: every call has a time limit, answers are remembered for a while (the same plate is read many
 * times a minute), a system that keeps failing is left alone for a while instead of being hammered (circuit breaker), and the number
 * of calls in flight is capped. A failure is reported to the caller as a ConnectorError; it never reaches the camera pipeline.
 */
import { ConnectorError, type Connector, type ConnectorQuery, type ConnectorResult } from './types';

export interface HubOptions {
  /** Per-call limit. */
  timeoutMs?: number;
  /** How long an answer is reused (found or not). 0 turns the cache off. */
  cacheTtlMs?: number;
  /** After this many failures in a row a connector is skipped for `breakMs`. */
  failuresToOpen?: number;
  breakMs?: number;
  /** Calls in flight to one connector at once; the rest are refused as `unavailable` rather than queued without bound. */
  maxInFlight?: number;
  maxCacheEntries?: number;
  now?: () => number;
}

interface Stats { calls: number; cacheHits: number; failures: number; timeouts: number; refused: number; lastError: string | null; lastOkAt: string | null }
interface State { failures: number; openUntil: number; inFlight: number; stats: Stats }

export interface ConnectorStatus {
  id: string; label: string; description: string; mock: boolean; queries: readonly string[];
  state: 'ok' | 'failing' | 'open';
  stats: Stats;
}

export function createConnectorHub(connectors: Connector[], o: HubOptions = {}) {
  const timeoutMs = o.timeoutMs ?? 3000, cacheTtlMs = o.cacheTtlMs ?? 5 * 60_000, failuresToOpen = o.failuresToOpen ?? 5, breakMs = o.breakMs ?? 30_000;
  const maxInFlight = o.maxInFlight ?? 8, maxCache = o.maxCacheEntries ?? 5000, clock = o.now ?? Date.now;
  const byId = new Map(connectors.map((c) => [c.id, c]));
  if (byId.size !== connectors.length) throw new Error('Two connectors share an id.');
  const state = new Map(connectors.map((c) => [c.id, { failures: 0, openUntil: 0, inFlight: 0, stats: { calls: 0, cacheHits: 0, failures: 0, timeouts: 0, refused: 0, lastError: null, lastOkAt: null } } as State]));
  const cache = new Map<string, { until: number; result: ConnectorResult }>();
  const inflight = new Map<string, Promise<ConnectorResult>>();

  const keyOf = (id: string, q: ConnectorQuery) => `${id}\u0000${JSON.stringify(q)}`;

  async function lookup(id: string, query: ConnectorQuery): Promise<ConnectorResult> {
    const c = byId.get(id);
    if (!c) throw new ConnectorError(`No connector named '${id}'.`, 'unknown_connector');
    if (!c.queries.includes(query.type)) throw new ConnectorError(`${id} does not answer '${query.type}' queries.`, 'unsupported_query');
    const s = state.get(id)!;
    const key = keyOf(id, query);
    const hit = cache.get(key);
    if (hit && hit.until > clock()) { s.stats.cacheHits++; return { ...hit.result, cached: true }; }
    // Two callers asking the same thing at once share one call.
    const shared = inflight.get(key);
    if (shared) return shared;
    if (s.openUntil > clock()) { s.stats.refused++; throw new ConnectorError(`${id} is paused after repeated failures (${s.stats.lastError ?? 'unknown'}).`, 'circuit_open'); }
    if (s.inFlight >= maxInFlight) { s.stats.refused++; throw new ConnectorError(`${id} is busy.`, 'unavailable'); }

    const run = (async () => {
      s.inFlight++; s.stats.calls++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const result = await Promise.race([
          c.lookup(query, ctl.signal),
          new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(new ConnectorError(`${id} did not answer within ${timeoutMs} ms.`, 'timeout')), { once: true })),
        ]);
        s.failures = 0; s.stats.lastOkAt = new Date(clock()).toISOString();
        if (cacheTtlMs > 0) {
          if (cache.size >= maxCache) cache.delete(cache.keys().next().value as string);
          cache.set(key, { until: clock() + cacheTtlMs, result });
        }
        return result;
      } catch (e) {
        const err = e instanceof ConnectorError ? e : new ConnectorError(e instanceof Error ? e.message : String(e), 'upstream');
        // A bad question or a question the system does not take is the caller's fault, not a sign the system is down.
        if (err.code !== 'bad_query' && err.code !== 'unsupported_query') {
          s.failures++; s.stats.failures++; s.stats.lastError = err.message;
          if (err.code === 'timeout') s.stats.timeouts++;
          if (s.failures >= failuresToOpen) s.openUntil = clock() + breakMs;
        }
        throw err;
      } finally { clearTimeout(timer); s.inFlight--; inflight.delete(key); }
    })();
    inflight.set(key, run);
    return run;
  }

  return {
    lookup,
    get: (id: string) => byId.get(id),
    /** The connectors that answer this kind of query. */
    answering: (type: ConnectorQuery['type']) => connectors.filter((c) => c.queries.includes(type)),
    status(): ConnectorStatus[] {
      return connectors.map((c) => {
        const s = state.get(c.id)!;
        return { id: c.id, label: c.label, description: c.description, mock: c.mock, queries: c.queries, state: s.openUntil > clock() ? 'open' : s.failures > 0 ? 'failing' : 'ok', stats: { ...s.stats } };
      });
    },
    clearCache: () => cache.clear(),
  };
}
export type ConnectorHub = ReturnType<typeof createConnectorHub>;
