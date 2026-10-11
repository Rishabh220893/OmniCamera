/**
 * A small in-memory stand-in for the part of the kafkajs client that `server/bus/kafkaBus.ts` uses (producer, admin, consumer with eachBatch and
 * eachMessage), so the shared bus contract can be run without a broker. It models ONE broker and ONE partition per topic: ordered offsets,
 * consumer groups with committed offsets, `seek`, and batches that are fetched again when a handler throws (as kafkajs does).
 *
 * It encodes my reading of the kafkajs documentation, so it can only catch mistakes in the bus's own logic. It is NOT evidence that the bus works
 * with Kafka: only a run against a real broker is (TEST_KAFKA_BROKERS in tests/bus.test.ts).
 */
interface Rec { offset: number; key: Buffer | null; value: Buffer; headers: Record<string, Buffer>; timestamp: string }
interface Topic { records: Rec[]; low: number; next: number }

export function createFakeKafka() {
  const topics = new Map<string, Topic>();
  const groups = new Map<string, Map<string, number>>(); // group -> topic -> committed next offset
  const high = (t: Topic) => t.next;

  const producer = () => ({
    async connect() {}, async disconnect() {},
    async send({ topic, messages }: { topic: string; messages: Array<{ key: string | null; value: string; headers?: Record<string, string> }> }) {
      const t = topics.get(topic);
      if (!t) throw new Error(`This server does not host this topic-partition (${topic})`);
      const base = t.next;
      for (const m of messages) {
        t.records.push({ offset: t.next++, key: m.key === null ? null : Buffer.from(m.key), value: Buffer.from(m.value), headers: Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k, Buffer.from(v)])), timestamp: String(Date.now()) });
      }
      return [{ topicName: topic, partition: 0, errorCode: 0, baseOffset: String(base), offset: String(base), logAppendTime: '-1', logStartOffset: String(t.low) }];
    },
  });

  const admin = () => ({
    async connect() {}, async disconnect() {},
    async createTopics({ topics: list }: { topics: Array<{ topic: string }> }) { let made = false; for (const x of list) if (!topics.has(x.topic)) { topics.set(x.topic, { records: [], low: 0, next: 0 }); made = true; } return made; },
    async fetchTopicOffsets(topic: string) { const t = topics.get(topic); if (!t) throw new Error('UNKNOWN_TOPIC_OR_PARTITION'); return [{ partition: 0, offset: String(high(t)), high: String(high(t)), low: String(t.low) }]; },
    async listGroups() { return { groups: [...groups.keys()].map((groupId) => ({ groupId, protocolType: 'consumer' })) }; },
    async fetchOffsets({ groupId, topics: ts }: { groupId: string; topics: string[] }) { return ts.map((topic) => ({ topic, partitions: [{ partition: 0, offset: String(groups.get(groupId)?.get(topic) ?? -1), metadata: null }] })); },
    async setOffsets({ groupId, topic, partitions }: { groupId: string; topic: string; partitions: Array<{ partition: number; offset: string }> }) { if (!groups.has(groupId)) groups.set(groupId, new Map()); groups.get(groupId)!.set(topic, Number(partitions[0].offset)); },
    async deleteGroups(ids: string[]) { for (const id of ids) groups.delete(id); return ids.map((groupId) => ({ groupId, errorCode: 0 })); },
  });

  const consumer = ({ groupId }: { groupId: string }) => {
    let subscribed: string[] = [], fromBeginning = false, running = false, loop: Promise<void> | null = null, seekTo: number | null = null;
    const pos = (topic: string) => groups.get(groupId)?.get(topic);
    const batchOf = (topic: string, from: number, t: Topic) => t.records.filter((r) => r.offset >= from).map((r) => ({ offset: String(r.offset), key: r.key, value: r.value, headers: r.headers, timestamp: r.timestamp }));
    return {
      async connect() {}, async disconnect() { running = false; await loop; },
      async subscribe({ topics: ts, fromBeginning: fb }: { topics: string[]; fromBeginning?: boolean }) { subscribed = ts; fromBeginning = !!fb; },
      seek({ offset }: { topic: string; partition: number; offset: string }) { seekTo = Number(offset); },
      async stop() { running = false; await loop; },
      async commitOffsets(list: Array<{ topic: string; partition: number; offset: string }>) { for (const x of list) { if (!groups.has(groupId)) groups.set(groupId, new Map()); groups.get(groupId)!.set(x.topic, Number(x.offset)); } },
      async run(cfg: { eachBatch?: (p: any) => Promise<void>; eachMessage?: (p: any) => Promise<void>; autoCommit?: boolean }) {
        running = true;
        const topic = subscribed[0];
        const t = topics.get(topic)!;
        let next = pos(topic) ?? (fromBeginning ? t.low : high(t));
        loop = (async () => {
          while (running) {
            if (seekTo !== null) { next = seekTo; seekTo = null; }
            const messages = batchOf(topic, next, t);
            if (!messages.length) { await new Promise((r) => setTimeout(r, 5)); continue; }
            let resolved = next - 1;
            try {
              if (cfg.eachBatch) {
                await cfg.eachBatch({ batch: { topic, partition: 0, messages, highWatermark: String(high(t)) }, resolveOffset: (o: string) => { resolved = Math.max(resolved, Number(o)); }, heartbeat: async () => {}, isRunning: () => running, isStale: () => false, pause: () => () => {}, uncommittedOffsets: () => ({ topics: [] }), commitOffsetsIfNecessary: async () => {} });
              } else if (cfg.eachMessage) {
                for (const m of messages) { if (!running) break; await cfg.eachMessage({ topic, partition: 0, message: m, heartbeat: async () => {}, pause: () => () => {} }); resolved = Number(m.offset); if (seekTo !== null) break; }
              }
            } catch { /* a handler that throws is fetched again from the first unresolved offset */ await new Promise((r) => setTimeout(r, 5)); }
            if (seekTo === null) next = resolved + 1;
          }
        })();
      },
    };
  };

  return { producer, admin, consumer, topics, groups };
}
export type FakeKafka = ReturnType<typeof createFakeKafka>;
