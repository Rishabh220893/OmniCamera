/**
 * The in-process bus: complete and fast, bounded, and what a single server and every test use. Messages are lost when the process
 * exits, which is why `redisBus.ts` exists for anything that must survive a restart or span several servers.
 * Offsets are zero-padded integers so they sort as strings, like a Redis stream id does.
 */
import { BusError, DLQ, checkNames, type BusMessage, type EventBus, type Handler, type Publish, type SubscribeOptions, type Subscription } from './types';

export interface MemoryBusOptions {
  /** Messages kept per topic. Default 100,000. */
  maxLength?: number;
  /** Messages older than this are dropped. Default 24 h. */
  maxAgeMs?: number;
  now?: () => Date;
  log?: Pick<Console, 'warn'>;
}

interface Topic { base: number; msgs: Array<BusMessage>; next: number; groups: Map<string, number>; waiters: Set<() => void> }

const pad = (n: number) => String(n).padStart(16, '0');
const num = (id: string) => Number(id);

export function createMemoryBus(o: MemoryBusOptions = {}): EventBus {
  const maxLength = o.maxLength ?? 100_000, maxAgeMs = o.maxAgeMs ?? 24 * 3600_000;
  const now = o.now ?? (() => new Date());
  const log = o.log ?? console;
  const topics = new Map<string, Topic>();
  const subs = new Set<Subscription>();
  let closed = false;

  const topic = (name: string): Topic => {
    let t = topics.get(name);
    if (!t) { t = { base: 1, msgs: [], next: 1, groups: new Map(), waiters: new Set() }; topics.set(name, t); }
    return t;
  };
  function trim(t: Topic) {
    const cutoff = now().getTime() - maxAgeMs;
    let drop = Math.max(0, t.msgs.length - maxLength);
    while (drop < t.msgs.length && Date.parse(t.msgs[drop].ts) < cutoff) drop++;
    if (drop > 0) { t.msgs.splice(0, drop); t.base += drop; }
  }
  const after = (t: Topic, afterNum: number, limit: number) => t.msgs.slice(Math.max(0, afterNum + 1 - t.base), Math.max(0, afterNum + 1 - t.base) + limit);

  const bus: EventBus = {
    kind: 'memory',

    async publish<T>(name: string, messages: Array<Publish<T>>) {
      checkNames(name);
      if (closed) throw new BusError('The bus is closed.');
      const t = topic(name);
      const ids: string[] = [];
      const ts = now().toISOString();
      for (const m of messages) {
        const id = pad(t.next++);
        t.msgs.push({ id, topic: name, key: m.key, ts, value: m.value });
        ids.push(id);
      }
      trim(t);
      for (const w of [...t.waiters]) w();
      return ids;
    },

    async read<T>(name: string, afterId: string | null, limit: number) {
      checkNames(name);
      const t = topics.get(name);
      if (!t) return [];
      return after(t, afterId === null ? t.base - 1 : num(afterId), Math.max(0, Math.min(limit, 10_000))) as Array<BusMessage<T>>;
    },

    async info(name: string) {
      checkNames(name);
      const t = topics.get(name);
      const groups: Record<string, { lag: number }> = {};
      if (t) for (const [g, pos] of t.groups) groups[g] = { lag: Math.max(0, t.next - 1 - pos) };
      return { length: t?.msgs.length ?? 0, oldestId: t?.msgs[0]?.id ?? null, newestId: t?.msgs.length ? t.msgs[t.msgs.length - 1].id : null, groups };
    },

    async subscribe<T>(name: string, group: string, handler: Handler<T>, opts: SubscribeOptions = {}): Promise<Subscription> {
      checkNames(name, group);
      if (closed) throw new BusError('The bus is closed.');
      const t = topic(name);
      // A group that already exists continues; a new one starts where it was asked to.
      if (!t.groups.has(group)) t.groups.set(group, opts.from === 'earliest' ? t.base - 1 : t.next - 1);
      const batch = Math.max(1, opts.batch ?? 50), maxAttempts = Math.max(1, opts.maxAttempts ?? 5), retryMs = opts.retryMs ?? 200;
      const stats = { delivered: 0, failures: 0, deadLettered: 0 };
      let stopped = false;
      let wake: (() => void) | null = null;
      const waitForMore = (ms: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); t.waiters.delete(done); wake = null; resolve(); }
        t.waiters.add(done); wake = done;
      });

      let sleepWake: (() => void) | null = null;
      const sleep = (ms: number) => new Promise<void>((resolve) => {
        const tm = setTimeout(done, ms);
        function done() { clearTimeout(tm); sleepWake = null; resolve(); }
        sleepWake = done;
      });

      const loop = (async () => {
        let attempts = 0;
        while (!stopped) {
          let pos = t.groups.get(group)!;
          // Anything trimmed away before it was read is gone; carry on from the oldest that is left.
          if (pos < t.base - 1) { log.warn(`[BUS] group '${group}' on '${name}' fell behind retention and skipped ${t.base - 1 - pos} messages.`); pos = t.base - 1; t.groups.set(group, pos); }
          const msgs = after(t, pos, batch);
          if (!msgs.length) { await waitForMore(60_000); continue; }
          try {
            await handler(msgs as Array<BusMessage<T>>);
            t.groups.set(group, num(msgs[msgs.length - 1].id));
            stats.delivered += msgs.length;
            attempts = 0;
          } catch (e) {
            stats.failures++;
            attempts++;
            if (attempts >= maxAttempts) {
              // Park the batch's first message (the one most likely to be the poison) and carry on with the rest.
              const bad = msgs[0];
              await bus.publish(DLQ(name), [{ key: bad.key, value: { original: bad, group, error: e instanceof Error ? e.message : String(e), attempts } }]);
              t.groups.set(group, num(bad.id));
              stats.deadLettered++;
              attempts = 0;
              log.warn(`[BUS] '${name}' message ${bad.id} failed ${maxAttempts} times in group '${group}' and was moved to ${DLQ(name)}.`);
            } else if (!stopped) await sleep(Math.min(30_000, retryMs * 2 ** (attempts - 1)));
          }
        }
      })();

      const sub: Subscription = {
        stats: () => ({ ...stats }),
        async stop() { stopped = true; wake?.(); sleepWake?.(); subs.delete(sub); await loop; },
      };
      subs.add(sub);
      return sub;
    },

    async close() { closed = true; await Promise.all([...subs].map((s) => s.stop())); },
  };
  return bus;
}
