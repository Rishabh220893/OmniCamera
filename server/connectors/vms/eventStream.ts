/**
 * A `VmsConnector` for a device that PUSHES its events over a connection it keeps open (Hikvision `alertStream`, Dahua `eventManager.cgi`,
 * and anything like them). It holds the connection in the background, reconnects with back-off, and puts what arrives in a `StreamBuffer`, so
 * the existing runner (polling, back-off, status, bus, cursor file) works unchanged: it simply reads the buffer.
 *
 *   - Health is honest: while the stream is down `events()` throws (`auth` for a refused login, `unreachable`/`upstream` otherwise), so the
 *     system shows as degraded or down, instead of looking healthy and silent. It recovers by itself when the connection returns.
 *   - A connection that stays silent for `idleTimeoutMs` (devices send heartbeats) is torn down and re-opened: a half-dead TCP connection
 *     otherwise looks alive forever.
 *   - A refused login is retried slowly (at least a minute), never hammered.
 *   - Events missed while disconnected are gone: push feeds have no replay. `status()` says when it was last connected.
 */
import { createStreamBuffer, type StreamBuffer } from './streamBuffer';
import type { StreamEndpoint } from '../../adapters/types';
import { VmsError, type EventPage, type VmsCamera, type VmsConnector, type VmsEvent, type VmsHealth } from './types';

/** What a vendor supplies: how to open the stream and how to read its bytes. */
export interface StreamProtocol {
  open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** A fresh parser per connection: text in, the events completed so far out. Partial records stay inside it until more text arrives. */
  createParser(): (chunk: string) => VmsEvent[];
}

export interface EventStreamOptions {
  protocol: StreamProtocol;
  cameras(): Promise<VmsCamera[]>;
  streams(cameraId: string): Promise<StreamEndpoint[]>;
  /** A real call to the device (not the stream), for `health()`. */
  ping(): Promise<void>;
  buffer?: StreamBuffer;
  /** Tear the connection down after this long with no bytes at all. Default 60 s. */
  idleTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** How long the first `events()` waits for the first connection result, so "from now" really starts once connected. Default 3 s. */
  firstConnectWaitMs?: number;
  now?: () => Date;
  log?: Pick<Console, 'warn' | 'info'>;
  label?: string;
}

export interface StreamStatus {
  state: 'connecting' | 'connected' | 'down' | 'auth_failed' | 'closed';
  connectedSince: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  reconnects: number;
  eventsReceived: number;
  dropped: number;
}

export type EventStreamConnector = VmsConnector & { close(): Promise<void>; status(): StreamStatus };

export function createEventStreamConnector(o: EventStreamOptions): EventStreamConnector {
  const buffer = o.buffer ?? createStreamBuffer();
  const now = o.now ?? (() => new Date());
  const log = o.log ?? console;
  const idleMs = o.idleTimeoutMs ?? 60_000;
  const backoffBase = o.backoffBaseMs ?? 1000, backoffMax = o.backoffMaxMs ?? 5 * 60_000;
  const st: StreamStatus = { state: 'connecting', connectedSince: null, lastConnectedAt: null, lastError: null, reconnects: 0, eventsReceived: 0, dropped: 0 };
  let lastErr: VmsError | null = null;
  let failures = 0;
  let closed = false;
  let loop: Promise<void> | null = null;
  let ctl: AbortController | null = null;
  let wake: (() => void) | null = null;
  let firstResult: Promise<void> | null = null;
  let settleFirst: (() => void) | null = null;

  const sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); wake = () => { clearTimeout(t); resolve(); }; });

  async function connectOnce(): Promise<void> {
    ctl = new AbortController();
    const c = ctl;
    const body = await o.protocol.open(c.signal);
    st.state = 'connected'; st.connectedSince = now().toISOString(); st.lastConnectedAt = st.connectedSince; lastErr = null;
    settleFirst?.();
    const parse = o.protocol.createParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let idle: ReturnType<typeof setTimeout> | null = null;
    const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => c.abort(new Error('no data from the device')), idleMs); idle.unref?.(); };
    arm();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new VmsError('The device closed the event stream.', 'upstream');
        arm();
        failures = 0; // data is flowing: the next failure starts the back-off from the beginning
        for (const ev of parse(decoder.decode(value, { stream: true }))) { buffer.push(ev); st.eventsReceived++; }
      }
    } catch (e) {
      if (closed) return;
      if (c.signal.aborted && c.signal.reason instanceof Error && c.signal.reason.message === 'no data from the device') throw new VmsError(`No data from the device for ${Math.round(idleMs / 1000)} s (its heartbeat stopped); reconnecting.`, 'upstream');
      throw e instanceof VmsError ? e : new VmsError(e instanceof Error ? e.message : String(e), 'upstream');
    } finally {
      if (idle) clearTimeout(idle);
      try { c.abort(); } catch { /* already closed */ }
      st.connectedSince = null;
    }
  }

  async function run(): Promise<void> {
    while (!closed) {
      try {
        st.state = st.lastConnectedAt ? 'connecting' : st.state;
        await connectOnce();
      } catch (e) {
        if (closed) break;
        const err = e instanceof VmsError ? e : new VmsError(e instanceof Error ? e.message : String(e), 'upstream');
        lastErr = err; st.lastError = err.message; failures++;
        st.state = err.code === 'auth' ? 'auth_failed' : 'down';
        if (failures === 1 || failures % 10 === 0) log.warn(`[EVENT STREAM${o.label ? ' ' + o.label : ''}] ${err.code}: ${err.message}`);
        settleFirst?.();
        const wait = Math.min(backoffMax, Math.max(err.code === 'auth' ? 60_000 : 0, backoffBase * 2 ** Math.min(failures - 1, 16)));
        st.reconnects++;
        await sleep(wait);
      }
    }
    st.state = 'closed';
  }

  function ensureRunning() {
    if (loop || closed) return;
    firstResult = new Promise<void>((resolve) => { settleFirst = resolve; });
    loop = run();
  }

  return {
    async cameras() { ensureRunning(); return o.cameras(); },
    async streams(id) { return o.streams(id); },

    async events(cursor: string | null, limit: number): Promise<EventPage> {
      ensureRunning();
      // The very first call waits (briefly) to learn whether the connection works, so "from now" means from when it was open.
      if (firstResult) { await Promise.race([firstResult, new Promise<void>((r) => { const t = setTimeout(r, o.firstConnectWaitMs ?? 3000); t.unref?.(); })]); firstResult = null; }
      st.dropped = buffer.dropped();
      if (st.state !== 'connected' && lastErr) throw lastErr;
      return buffer.read(cursor, limit);
    },

    async health(): Promise<VmsHealth> {
      const t = Date.now();
      try { await o.ping(); }
      catch (e) { return { ok: false, latencyMs: Date.now() - t, detail: e instanceof Error ? e.message : String(e) }; }
      const streamOk = st.state === 'connected';
      return { ok: streamOk, latencyMs: Date.now() - t, detail: streamOk ? `event stream connected since ${st.connectedSince}` : `event stream ${st.state}${st.lastError ? `: ${st.lastError}` : ''}` };
    },

    status: () => ({ ...st, dropped: buffer.dropped() }),

    async close() {
      closed = true;
      try { ctl?.abort(); } catch { /* nothing open */ }
      wake?.();
      settleFirst?.();
      await loop;
      loop = null;
    },
  };
}
