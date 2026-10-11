/**
 * The bus on Apache Kafka (federation plan A6; the briefs name Kafka). Same contract as the in-process and Redis buses (`tests/busConformance.ts`).
 *
 * *** NOT RUN against a Kafka broker. *** There was no broker on the machine this was written on. It follows the documented kafkajs API and is
 * run through the shared contract suite only against a small in-memory stand-in for the client (`tests/lab/fakeKafka.ts`), which proves the logic
 * (ordering, groups, retries, dead letters, replay) but not Kafka itself: consumer rebalances, leader changes, real offsets and retention are
 * unverified. Run `tests/bus.test.ts` with TEST_KAFKA_BROKERS set against a real broker before relying on it.
 *
 * Mapping to the contract:
 *   - a topic is a Kafka topic with ONE partition, because the contract promises one total order and offsets that sort in publish order;
 *     that bounds a topic's throughput to one partition's (tens of MB/s), ample for events and metadata. Retention is `retention.ms` (and
 *     `retention.bytes` when given), not a message count.
 *   - the message id is the Kafka offset; a group is a Kafka consumer group; `from: 'earliest' | 'latest'` is where a NEW group starts.
 *   - a batch that keeps failing: the first message of it is written to `<topic>.dlq` after `maxAttempts` and skipped, the rest go on.
 *   - `read` replays with a short-lived consumer in its own throw-away group; `info` reads the broker's offsets and the groups' commits.
 */
import { randomUUID } from 'node:crypto';
import type { Kafka, KafkaMessage } from 'kafkajs';
import { BusError, DLQ, checkNames, type BusMessage, type EventBus, type Handler, type Publish, type SubscribeOptions, type Subscription } from './types';

export interface KafkaBusOptions {
  /** Prefix for topic and group names, so several apps can share one cluster. Default `omnisee.`. */
  prefix?: string;
  /** How long a topic keeps messages. Default 7 days. */
  retentionMs?: number;
  /** Optional size bound per topic (bytes). */
  retentionBytes?: number;
  /** Replication factor for topics this bus creates. Default 1 (a dev broker); use 3 on a cluster. */
  replicationFactor?: number;
  log?: Pick<Console, 'warn'>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toMessage<T>(topic: string, m: KafkaMessage): BusMessage<T> {
  const ts = m.headers?.ts ? String(m.headers.ts) : new Date(Number(m.timestamp)).toISOString();
  return { id: m.offset, topic, key: m.key ? m.key.toString() : undefined, ts, value: JSON.parse(m.value ? m.value.toString() : 'null') as T };
}

export function createKafkaBus(kafka: Kafka, o: KafkaBusOptions = {}): EventBus {
  const prefix = o.prefix ?? 'omnisee.';
  const log = o.log ?? console;
  const retentionMs = o.retentionMs ?? 7 * 24 * 3_600_000;
  const t = (topic: string) => `${prefix}${topic}`;
  const g = (group: string) => `${prefix}${group}`;
  const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 });
  const admin = kafka.admin();
  const subs = new Set<Subscription>();
  const ensured = new Set<string>();
  let ready: Promise<void> | null = null;
  let closed = false;

  const connect = () => (ready ??= Promise.all([producer.connect(), admin.connect()]).then(() => undefined));

  async function ensureTopic(topic: string): Promise<void> {
    if (ensured.has(topic)) return;
    await connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: [{
        topic: t(topic), numPartitions: 1, replicationFactor: o.replicationFactor ?? 1,
        configEntries: [{ name: 'retention.ms', value: String(retentionMs) }, ...(o.retentionBytes ? [{ name: 'retention.bytes', value: String(o.retentionBytes) }] : [])],
      }],
    }); // false when it already exists: fine
    ensured.add(topic);
  }

  const bus: EventBus = {
    kind: 'kafka',

    async publish<V>(topic: string, messages: Array<Publish<V>>) {
      checkNames(topic);
      if (closed) throw new BusError('The bus is closed.');
      if (!messages.length) return [];
      await ensureTopic(topic);
      const ts = new Date().toISOString();
      const res = await producer.send({ topic: t(topic), messages: messages.map((m) => ({ key: m.key ?? null, value: JSON.stringify(m.value), headers: { ts } })) });
      const base = BigInt(res[0]?.baseOffset ?? res[0]?.offset ?? '0');
      return messages.map((_, i) => String(base + BigInt(i)));
    },

    async read<V>(topic: string, afterId: string | null, limit: number) {
      checkNames(topic);
      await connect();
      const name = t(topic);
      let offsets;
      try { offsets = await admin.fetchTopicOffsets(name); } catch { return []; } // the topic does not exist yet
      const high = BigInt(offsets[0]?.high ?? '0'), low = BigInt(offsets[0]?.low ?? '0');
      const start = afterId === null ? low : BigInt(afterId) + 1n;
      if (start >= high || limit < 1) return [];
      const want = Math.max(1, Math.min(limit, 10_000));
      const groupId = g(`read.${randomUUID().slice(0, 12)}`);
      const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
      const out: Array<BusMessage<V>> = [];
      try {
        await consumer.connect();
        await consumer.subscribe({ topics: [name], fromBeginning: true });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new BusError(`Reading '${topic}' timed out.`)), 30_000);
          consumer.run({
            autoCommit: false,
            eachMessage: async ({ message }) => {
              // Delivery can begin before the seek takes effect: skip what is before the start and what was already taken.
              if (BigInt(message.offset) < start || (out.length > 0 && BigInt(message.offset) <= BigInt(out[out.length - 1].id))) return;
              out.push(toMessage<V>(topic, message));
              if (out.length >= want || BigInt(message.offset) + 1n >= high) { clearTimeout(timer); resolve(); }
            },
          }).then(() => consumer.seek({ topic: name, partition: 0, offset: start.toString() })).catch((e) => { clearTimeout(timer); reject(e); });
        });
      } finally {
        await consumer.stop().catch(() => undefined);
        await consumer.disconnect().catch(() => undefined);
        await admin.deleteGroups([groupId]).catch(() => undefined);
      }
      return out.slice(0, want);
    },

    async info(topic: string) {
      checkNames(topic);
      await connect();
      const name = t(topic);
      let offsets;
      try { offsets = await admin.fetchTopicOffsets(name); } catch { return { length: 0, oldestId: null, newestId: null, groups: {} }; }
      const high = BigInt(offsets[0]?.high ?? '0'), low = BigInt(offsets[0]?.low ?? '0');
      const length = Number(high - low);
      const groups: Record<string, { lag: number }> = {};
      try {
        for (const grp of (await admin.listGroups()).groups) {
          if (!grp.groupId.startsWith(prefix) || grp.groupId.startsWith(`${prefix}read.`)) continue;
          const committed = (await admin.fetchOffsets({ groupId: grp.groupId, topics: [name] }))[0]?.partitions?.[0]?.offset;
          if (committed === undefined) continue;
          const at = BigInt(committed) < 0n ? low : BigInt(committed); // -1: nothing committed yet
          groups[grp.groupId.slice(prefix.length)] = { lag: Number(high > at ? high - at : 0n) };
        }
      } catch (e) { log.warn(`[BUS] could not read consumer group offsets: ${e instanceof Error ? e.message : e}`); }
      return { length, oldestId: length > 0 ? String(low) : null, newestId: length > 0 ? String(high - 1n) : null, groups };
    },

    async subscribe<V>(topic: string, group: string, handler: Handler<V>, opts: SubscribeOptions = {}): Promise<Subscription> {
      checkNames(topic, group);
      if (closed) throw new BusError('The bus is closed.');
      await ensureTopic(topic);
      const maxAttempts = Math.max(1, opts.maxAttempts ?? 5), retryMs = opts.retryMs ?? 200;
      const stats = { delivered: 0, failures: 0, deadLettered: 0 };
      let stopped = false;
      // A NEW group's starting point is fixed now, by committing it: otherwise a group that starts at `latest` and stops before it commits anything
      // would start at `latest` again next time and miss what came in between. (The other buses keep a new group's position the same way.)
      const committed = (await admin.fetchOffsets({ groupId: g(group), topics: [t(topic)] }))[0]?.partitions?.[0]?.offset;
      if (committed === undefined || BigInt(committed) < 0n) {
        const [p] = await admin.fetchTopicOffsets(t(topic));
        await admin.setOffsets({ groupId: g(group), topic: t(topic), partitions: [{ partition: 0, offset: opts.from === 'earliest' ? p.low : p.high }] });
      }
      const consumer = kafka.consumer({ groupId: g(group), allowAutoTopicCreation: false, maxWaitTimeInMs: 500, sessionTimeout: 30_000 });
      await consumer.connect();
      await consumer.subscribe({ topics: [t(topic)], fromBeginning: opts.from === 'earliest' });
      const batchSize = Math.max(1, opts.batch ?? 50);

      await consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
          // Offsets are committed by hand, one past the last message handled (that is what Kafka means by a committed offset).
          const commit = (offset: string) => consumer.commitOffsets([{ topic: t(topic), partition: batch.partition, offset: String(BigInt(offset) + 1n) }]);
          let rest = batch.messages;
          while (rest.length && !stopped && isRunning() && !isStale()) {
            const slice = rest.slice(0, batchSize);
            const msgs = slice.map((m) => toMessage<V>(topic, m));
            let attempts = 0;
            for (;;) {
              try {
                await handler(msgs);
                resolveOffset(slice[slice.length - 1].offset);
                await commit(slice[slice.length - 1].offset);
                stats.delivered += msgs.length;
                rest = rest.slice(slice.length);
                break;
              } catch (e) {
                stats.failures++;
                if (++attempts >= maxAttempts) {
                  const bad = msgs[0];
                  await bus.publish(DLQ(topic), [{ key: bad.key, value: { original: bad, group, error: e instanceof Error ? e.message : String(e), attempts } }]);
                  resolveOffset(slice[0].offset);
                  await commit(slice[0].offset);
                  stats.deadLettered++;
                  log.warn(`[BUS] '${topic}' message ${bad.id} failed ${maxAttempts} times in group '${group}' and was moved to ${DLQ(topic)}.`);
                  rest = rest.slice(1);
                  break;
                }
                // Wait in short steps so the broker still sees this consumer alive.
                const wait = Math.min(30_000, retryMs * 2 ** (attempts - 1));
                for (let waited = 0; waited < wait && !stopped; waited += 1000) { await sleep(Math.min(1000, wait - waited)); await heartbeat().catch(() => undefined); }
                if (stopped) return;
              }
            }
            await heartbeat().catch(() => undefined);
          }
        },
      });

      const sub: Subscription = {
        stats: () => ({ ...stats }),
        async stop() { stopped = true; subs.delete(sub); await consumer.stop().catch(() => undefined); await consumer.disconnect().catch(() => undefined); },
      };
      subs.add(sub);
      return sub;
    },

    async close() {
      closed = true;
      await Promise.all([...subs].map((s) => s.stop()));
      await producer.disconnect().catch(() => undefined);
      await admin.disconnect().catch(() => undefined);
    },
  };
  return bus;
}
