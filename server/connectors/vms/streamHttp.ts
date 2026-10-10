/**
 * Opens the long-lived HTTP response a device writes its events to (Hikvision `alertStream`, Dahua `eventManager.cgi?action=attach`).
 * One GET, following the device's Digest or Basic challenge, returning the body stream. Nothing but GET is ever sent (docs/connectors-vms.md,
 * "read-only"). The time limit applies only until the device has answered with headers: once the stream is open it may stay quiet for as long
 * as the caller's own idle watchdog allows.
 */
import { authorizationFor, parseAuthChallenge } from '../../adapters/onvifProtocol';
import { VmsError, type VmsSystemConfig } from './types';

export interface OpenStreamOptions {
  url: string;
  credentials?: VmsSystemConfig['credentials'];
  fetch?: typeof fetch;
  signal: AbortSignal;
  /** How long to wait for the device to answer with headers. Default 15 s. */
  connectTimeoutMs?: number;
  headers?: Record<string, string>;
}

function classify(status: number, what: string): VmsError {
  if (status === 401 || status === 403) return new VmsError(`${what} refused the login (HTTP ${status}).`, 'auth');
  if (status === 404 || status === 405 || status === 501) return new VmsError(`${what} does not offer an event stream here (HTTP ${status}). Is this the right kind of device, and is the event service switched on?`, 'protocol');
  if (status === 429 || status === 503) return new VmsError(`${what} is busy (HTTP ${status}); it may allow only a few event connections at once.`, 'rate_limited');
  return new VmsError(`${what} answered HTTP ${status}.`, 'upstream');
}

export async function openEventStream(o: OpenStreamOptions): Promise<ReadableStream<Uint8Array>> {
  const f = o.fetch ?? fetch;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(o.signal.reason);
  if (o.signal.aborted) throw new VmsError('Stopped.', 'upstream');
  o.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(new Error('timed out waiting for the device to answer')), o.connectTimeoutMs ?? 15_000);
  const host = (() => { try { return new URL(o.url).host; } catch { return o.url; } })();
  const what = `The device at ${host}`;
  const get = (authorization?: string) => f(o.url, { method: 'GET', headers: { Accept: '*/*', ...o.headers, ...(authorization ? { Authorization: authorization } : {}) }, signal: ctl.signal, redirect: 'manual' });
  try {
    let res: Response;
    try { res = await get(); }
    catch (e) { throw new VmsError(`${what} cannot be reached: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`, 'unreachable'); }
    if (res.status === 401 && o.credentials?.user) {
      const header = res.headers.get('www-authenticate');
      await res.body?.cancel().catch(() => undefined);
      const ch = header ? parseAuthChallenge(header) : null;
      const u = new URL(o.url);
      const auth = ch && authorizationFor(ch, { method: 'GET', uri: u.pathname + u.search, user: o.credentials.user, pass: o.credentials.pass });
      if (!auth) throw new VmsError(`${what} asked for a login this connector cannot answer (${header ?? 'no challenge'}).`, 'auth');
      try { res = await get(auth); }
      catch (e) { throw new VmsError(`${what} cannot be reached: ${e instanceof Error ? e.message : String(e)}`, 'unreachable'); }
    }
    if (!res.ok || !res.body) { await res.body?.cancel().catch(() => undefined); throw classify(res.status, what); }
    // The link from the caller's signal to the open stream stays: aborting the signal is how the connection is closed later.
    return res.body;
  } catch (e) {
    o.signal.removeEventListener('abort', onAbort);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
