/**
 * The bus on Redis Streams: survives restarts, shared by several servers, bounded by stream length. Same contract as the in-process
 * bus (`tests/busConformance.ts`).
 *
 * *** NOT RUN against a Redis. *** No Redis server was available when this was written; it follows the documented XADD / XRANGE /
 * XGROUP / XREADGROUP / XACK / XAUTOCLAIM behaviour (Redis 6.2+, `XINFO GROUPS` lag needs 7.0) and is exercised by the conformance
 * suite only when TEST_REDIS_URL is set. Run that before relying on it.
 *
 * Each subscription uses its own connection (a blocking read holds one). Messages a crashed consumer left unacknowledged are claimed
 * by another member of the group after `claimIdleMs`.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { BusError, DLQ, checkNames, type BusMessage, type EventBus, type Handler, type Publish, type SubscribeOptions, type Subscription } from './types';

export interface RedisBusOptions {
  /** Approximate messages kept per topic (XADD MAXLEN ~). Default 100,000. */
  maxLength?: number;
  /** Idle time before another consumer takes over a stalled message. Default 60 s. */
  claimIdleMs?: number;
  /** Prefix for stream keys, so several apps can share one Redis. Default `bus:`. */
  prefix?: string;
  log?: Pick<Console, 'warn'>;
}

type Entry = [id: string, fields: string[]];

function toMessage<T>(topic: string, [id, fields]: Entry): BusMessage<T> {
  const f: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
  return { id, topic, key: f.key || undefined, ts: f.ts, value: JSON.parse(f.v) as T };
}

/** `redis` is used for commands; `connect()` must return a fresh connection for each blocking consumer. */
export function createRedisBus(redis: Redis, connect: () => Redis, o: RedisBusOptions = {}): EventBus {
  const maxLength = o.maxLength ?? 100_000, claimIdle = o.claimIdleMs ?? 60_000, prefix = o.prefix ?? 'bus:';
  const log = o.log ?? console;
  const key = (t: string) => `${prefix}${t}`;
  const subs = new Set<Subscription>();
  const conns = new Set<Redis>();
  let closed = false;

  const bus: EventBus = {
    kind: 'redis',

    async publish<T>(topic: string, messages: Array<Publish<T>>) {
      checkNames(topic);
      if (closed) throw new BusError('The bus is closed.');
      if (!messages.length) return [];
      const ts = new Date().toISOString();
      const p = redis.pipeline();
      for (const m of messages) p.xadd(key(topic), 'MAXLEN', '~', maxLength, '*', 'key', m.key ?? '', 'ts', ts, 'v', JSON.stringify(m.value));
      const res = await p.exec();
      return (res ?? []).map(([err, id]) => { if (err) throw err; return String(id); });
    },

    async read<T>(topic: string, afterId: string | null, limit: number) {
      checkNames(topic);
      const rows = (await redis.xrange(key(topic), afterId === null ? '-' : `(${afterId}`, '+', 'COUNT', Math.max(1, Math.min(limit, 10_000)))) as Entry[];
      return rows.map((r) => toMessage<T>(topic, r));
    },

    async info(topic: string) {
      checkNames(topic);
      const k = key(topic);
      const [length, first, last] = await Promise.all([redis.xlen(k), redis.xrange(k, '-', '+', 'COUNT', 1) as Promise<Entry[]>, redis.xrevrange(k, '+', '-', 'COUNT', 1) as Promise<Entry[]>]);
      const groups: Record<string, { lag: number }> = {};
      try {
        for (const g of (await redis.xinfo('GROUPS', k)) as unknown[][]) {
          const m: Record<string, unknown> = {};
          for (let i = 0; i < g.length; i += 2) m[String(g[i])] = g[i + 1];
          groups[String(m.name)] = { lag: Number(m.lag ?? 0) + Number(m.pending ?? 0) * 0 };
        }
      } catch { /* the stream does not exist yet */ }
      return { length, oldestId: first[0]?.[0] ?? null, newestId: last[0]?.[0] ?? null, groups };
    },

    async subscribe<T>(topic: string, group: string, handler: Handler<T>, opts: SubscribeOptions = {}): Promise<Subscription> {
      checkNames(topic, group);
      if (closed) throw new BusError('The bus is closed.');
      const k = key(topic);
      try { await redis.xgroup('CREATE', k, group, opts.from === 'earliest' ? '0' : '$', 'MKSTREAM'); }
      catch (e) { if (!String((e as Error).message).includes('BUSYGROUP')) throw e; }

      const conn = connect(); conns.add(conn);
      const consumer = `c-${randomUUID().slice(0, 8)}`;
      const batch = Math.max(1, opts.batch ?? 50), maxAttempts = Math.max(1, opts.maxAttempts ?? 5), retryMs = opts.retryMs ?? 200;
      const stats = { delivered: 0, failures: 0, deadLettered: 0 };
      let stopped = false;

      async function handle(entries: Entry[]): Promise<boolean> {
        const msgs = entries.map((e) => toMessage<T>(topic, e));
        let attempts = 0;
        while (!stopped) {
          try {
            await handler(msgs);
            await redis.xack(k, group, ...msgs.map((m) => m.id));
            stats.delivered += msgs.length;
            return true;
          } catch (e) {
            stats.failures++;
            if (++attempts >= maxAttempts) {
              const bad = msgs[0];
              await bus.publish(DLQ(topic), [{ key: bad.key, value: { original: bad, group, error: e instanceof Error ? e.message : String(e), attempts } }]);
              await redis.xack(k, group, bad.id);
              stats.deadLettered++;
              log.warn(`[BUS] '${topic}' message ${bad.id} failed ${maxAttempts} times in group '${group}' and was moved to ${DLQ(topic)}.`);
              return false;
            }
            await new Promise((r) => setTimeout(r, Math.min(30_000, retryMs * 2 ** (attempts - 1))));
          }
        }
        return false;
      }

      const loop = (async () => {
        let startup = true;
        let lastClaim = 0;
        while (!stopped) {
          try {
            let entries: Entry[] = [];
            if (startup) {
              // First finish what this consumer name left unacknowledged (none for a new name), then read new messages.
              startup = false;
            }
            if (Date.now() - lastClaim > claimIdle) {
              lastClaim = Date.now();
              const claimed = (await redis.xautoclaim(k, group, consumer, claimIdle, '0', 'COUNT', batch)) as [string, Entry[]];
              entries = (claimed[1] ?? []).filter((e) => e && e[1]);
            }
            if (!entries.length) {
              const res = (await conn.xreadgroup('GROUP', group, consumer, 'COUNT', batch, 'BLOCK', 1000, 'STREAMS', k, '>')) as Array<[string, Entry[]]> | null;
              entries = res?.[0]?.[1] ?? [];
            }
            if (entries.length) await handle(entries);
          } catch (e) {
            if (stopped) break;
            log.warn(`[BUS] consumer '${group}' on '${topic}' hit an error and will retry: ${e instanceof Error ? e.message : e}`);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      })();

      const sub: Subscription = {
        stats: () => ({ ...stats }),
        async stop() { stopped = true; subs.delete(sub); await loop; conn.disconnect(); conns.delete(conn); },
      };
      subs.add(sub);
      return sub;
    },

    async close() { closed = true; await Promise.all([...subs].map((s) => s.stop())); for (const c of conns) c.disconnect(); },
  };
  return bus;
}
