/**
 * The only way a VMS connector talks to a department system: GET requests, plus one explicit login call for systems that need a token.
 * No other method exists here, so a connector cannot change anything on the system even by mistake. Errors are classified so the
 * runner can tell "wrong password" (stop and say so) from "unreachable" (retry with back-off) from "the system is struggling".
 */
import { VmsError } from './types';

export interface ReadClient {
  /** GET, returns the body text. Throws VmsError. */
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: string; headers: Headers }>;
  /** POST used only to sign in (token exchange). Kept separate so the count of "writes" a system sees is auditable. */
  login(path: string, body: unknown): Promise<{ status: number; body: string }>;
}

export function createReadClient(o: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number; headers?: () => Record<string, string> }): ReadClient {
  const f = o.fetch ?? fetch;
  const timeout = o.timeoutMs ?? 10_000;
  const classify = (e: unknown): never => {
    if (e instanceof VmsError) throw e;
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new VmsError(`The system did not answer within ${timeout} ms.`, 'unreachable');
    throw new VmsError(`Could not reach the system (${e instanceof Error ? (e.cause as Error | undefined)?.message ?? e.message : String(e)}).`, 'unreachable');
  };
  return {
    async get(path, headers = {}) {
      let r: Response;
      try { r = await f(o.baseUrl + path, { method: 'GET', headers: { ...(o.headers?.() ?? {}), ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'manual' }); }
      catch (e) { return classify(e); }
      const body = await r.text().catch(() => '');
      if (r.status === 401 || r.status === 403) throw new VmsError(`The system refused the login (HTTP ${r.status}).`, 'auth');
      if (r.status === 429) throw new VmsError('The system asked us to slow down (HTTP 429).', 'rate_limited');
      if (r.status >= 500) throw new VmsError(`The system failed (HTTP ${r.status}).`, 'upstream');
      if (r.status >= 300) throw new VmsError(`Unexpected answer from the system (HTTP ${r.status}).`, 'protocol');
      return { status: r.status, body, headers: r.headers };
    },
    async login(path, body) {
      let r: Response;
      try { r = await f(o.baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'manual' }); }
      catch (e) { return classify(e); }
      const text = await r.text().catch(() => '');
      if (r.status === 401 || r.status === 403) throw new VmsError('The system refused the login.', 'auth');
      if (r.status >= 500) throw new VmsError(`The system failed (HTTP ${r.status}).`, 'upstream');
      if (r.status >= 300) throw new VmsError(`Unexpected answer to sign-in (HTTP ${r.status}).`, 'protocol');
      return { status: r.status, body: text };
    },
  };
}

export function parseJson<T>(body: string, what: string): T {
  try { return JSON.parse(body) as T; } catch { throw new VmsError(`The system's ${what} was not valid JSON.`, 'protocol'); }
}
