/**
 * The executable form of the bus contract (server/bus/types.ts). Every implementation is run through `busConformance` and must pass
 * all of it: tests/bus.test.ts does that for the in-process bus, and for Redis Streams when TEST_REDIS_URL is set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DLQ, compareIds, type BusMessage, type EventBus } from '../server/bus/types.ts';

const until = async (cond: () => boolean | Promise<boolean>, ms = 4000, what = 'condition') => {
  const t = Date.now();
  while (!(await cond())) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); }
};

let counter = 0;
const uniq = (base: string) => `${base}.${Date.now().toString(36)}${(counter++).toString(36)}`;

export function busConformance(name: string, make: () => Promise<EventBus>, o: { skip?: string | false } = {}): void {
  const t = (title: string, fn: (bus: EventBus) => Promise<void>, timeout = 20_000) =>
    test(`${name}: ${title}`, { skip: o.skip, timeout }, async () => { const bus = await make(); try { await fn(bus); } finally { await bus.close(); } });

  t('publish returns increasing ids and read replays them in order, from any point', async (bus) => {
    const topic = uniq('t');
    const ids = await bus.publish(topic, [{ value: 1 }, { value: 2, key: 'k' }, { value: 3 }]);
    assert.equal(ids.length, 3);
    assert.ok(compareIds(ids[0], ids[1]) < 0 && compareIds(ids[1], ids[2]) < 0);
    const all = await bus.read<number>(topic, null, 10);
    assert.deepEqual(all.map((m) => m.value), [1, 2, 3]);
    assert.deepEqual(all.map((m) => m.id), ids);
    assert.equal(all[1].key, 'k');
    assert.equal(all[0].key, undefined);
    assert.equal(all[0].topic, topic);
    assert.ok(!Number.isNaN(Date.parse(all[0].ts)));
    assert.deepEqual((await bus.read<number>(topic, ids[0], 10)).map((m) => m.value), [2, 3]);
    assert.deepEqual((await bus.read<number>(topic, ids[2], 10)).map((m) => m.value), []);
    assert.deepEqual((await bus.read<number>(topic, null, 2)).map((m) => m.value), [1, 2]);
    assert.deepEqual(await bus.read(uniq('empty'), null, 10), []);
    assert.deepEqual(await bus.publish(topic, []), []);
  });

  t('values keep their shape (objects, nested, unicode, null fields)', async (bus) => {
    const topic = uniq('shape');
    const v = { a: 1, b: { c: [1, 2, { d: 'x' }] }, s: 'नमस्ते "quoted" \n newline', n: null };
    await bus.publish(topic, [{ value: v }]);
    assert.deepEqual((await bus.read(topic, null, 1))[0].value, v);
  });

  t('names are checked', async (bus) => {
    for (const bad of ['', 'Upper', 'has space', '1x', 'a/b', 'x'.repeat(100)]) await assert.rejects(bus.publish(bad, [{ value: 1 }]), /Topic/, bad);
    await assert.rejects(bus.subscribe(uniq('t'), 'Bad Group', async () => undefined), /Group/);
  });

  t('a new group with from=earliest sees history and then live messages, in order, once', async (bus) => {
    const topic = uniq('hist');
    await bus.publish(topic, [{ value: 1 }, { value: 2 }]);
    const seen: number[] = [];
    const sub = await bus.subscribe<number>(topic, 'g', async (ms) => { seen.push(...ms.map((m) => m.value)); }, { from: 'earliest' });
    await bus.publish(topic, [{ value: 3 }]);
    await bus.publish(topic, [{ value: 4 }, { value: 5 }]);
    await until(() => seen.length >= 5, 4000, 'five messages');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    await sub.stop();
    assert.equal(sub.stats().delivered, 5);
  });

  t('a new group with from=latest skips history', async (bus) => {
    const topic = uniq('late');
    await bus.publish(topic, [{ value: 'old' }]);
    const seen: string[] = [];
    const sub = await bus.subscribe<string>(topic, 'g', async (ms) => { seen.push(...ms.map((m) => m.value)); }, { from: 'latest' });
    await bus.publish(topic, [{ value: 'new' }]);
    await until(() => seen.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen, ['new']);
    await sub.stop();
  });

  t('each group sees every message; a group that stops and comes back continues where it left off', async (bus) => {
    const topic = uniq('groups');
    const a: number[] = [], b: number[] = [];
    const sa = await bus.subscribe<number>(topic, 'ga', async (ms) => { a.push(...ms.map((m) => m.value)); }, { from: 'earliest' });
    const sb = await bus.subscribe<number>(topic, 'gb', async (ms) => { b.push(...ms.map((m) => m.value)); }, { from: 'earliest' });
    await bus.publish(topic, [{ value: 1 }, { value: 2 }]);
    await until(() => a.length === 2 && b.length === 2);
    await sa.stop();
    await bus.publish(topic, [{ value: 3 }]);
    await until(() => b.length === 3);
    const again: number[] = [];
    const sa2 = await bus.subscribe<number>(topic, 'ga', async (ms) => { again.push(...ms.map((m) => m.value)); }, { from: 'latest' });
    await until(() => again.length === 1, 6000, 'group ga to catch up');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(again, [3], 'continued after 2, did not replay 1-2 and did not skip 3 although from=latest');
    assert.deepEqual(b, [1, 2, 3]);
    await sa2.stop(); await sb.stop();
  });

  t('a failing handler gets the same batch again (at-least-once), then it goes through', async (bus) => {
    const topic = uniq('retry');
    let calls = 0;
    const got: number[] = [];
    const sub = await bus.subscribe<number>(topic, 'g', async (ms) => { calls++; if (calls < 3) throw new Error('flaky'); got.push(...ms.map((m) => m.value)); }, { from: 'earliest', retryMs: 20 });
    await bus.publish(topic, [{ value: 7 }]);
    await until(() => got.length === 1);
    assert.equal(calls, 3);
    assert.equal(sub.stats().failures, 2);
    assert.deepEqual(got, [7]);
    await sub.stop();
  });

  t('a poison message goes to the dead-letter topic and the rest keep flowing', async (bus) => {
    const topic = uniq('poison');
    const got: string[] = [];
    const sub = await bus.subscribe<string>(topic, 'g', async (ms) => {
      if (ms.some((m) => m.value === 'poison')) throw new Error('cannot handle this');
      got.push(...ms.map((m) => m.value));
    }, { from: 'earliest', maxAttempts: 3, retryMs: 10, batch: 1 });
    await bus.publish(topic, [{ value: 'a' }, { value: 'poison' }, { value: 'b' }]);
    await until(() => got.length === 2, 6000, 'a and b');
    assert.deepEqual(got, ['a', 'b']);
    await until(async () => (await bus.read(DLQ(topic), null, 10)).length === 1, 4000, 'one dead letter');
    const dead = (await bus.read<{ original: BusMessage<string>; group: string; error: string; attempts: number }>(DLQ(topic), null, 10))[0].value;
    assert.deepEqual([dead.original.value, dead.group, dead.error, dead.attempts], ['poison', 'g', 'cannot handle this', 3]);
    assert.equal(sub.stats().deadLettered, 1);
    await sub.stop();
  });

  t('info reports length, bounds and how far behind each group is', async (bus) => {
    const topic = uniq('info');
    assert.deepEqual((await bus.info(topic)).length, 0);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sub = await bus.subscribe<number>(topic, 'slow', async () => { await gate; }, { from: 'earliest', batch: 1 });
    const ids = await bus.publish(topic, [{ value: 1 }, { value: 2 }, { value: 3 }]);
    await new Promise((r) => setTimeout(r, 150));
    const i = await bus.info(topic);
    assert.equal(i.length, 3);
    assert.equal(i.oldestId, ids[0]);
    assert.equal(i.newestId, ids[2]);
    assert.ok(i.groups.slow.lag >= 2, `lag ${i.groups.slow?.lag}`);
    release();
    await until(async () => (await bus.info(topic)).groups.slow.lag === 0, 4000, 'lag 0');
    await sub.stop();
  });

  t('stop is prompt even while idle, and nothing is delivered after it', async (bus) => {
    const topic = uniq('stop');
    const got: number[] = [];
    const sub = await bus.subscribe<number>(topic, 'g', async (ms) => { got.push(...ms.map((m) => m.value)); }, { from: 'earliest' });
    const t0 = Date.now();
    await sub.stop();
    assert.ok(Date.now() - t0 < 2500, `stop took ${Date.now() - t0} ms`);
    await bus.publish(topic, [{ value: 1 }]);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(got, []);
  });

  t('many messages in many batches arrive complete and in order', async (bus) => {
    const topic = uniq('many');
    const got: number[] = [];
    const sub = await bus.subscribe<number>(topic, 'g', async (ms) => { got.push(...ms.map((m) => m.value)); }, { from: 'earliest', batch: 37 });
    for (let i = 0; i < 20; i++) await bus.publish(topic, Array.from({ length: 50 }, (_, j) => ({ value: i * 50 + j })));
    await until(() => got.length === 1000, 8000, '1000 messages');
    assert.deepEqual(got, Array.from({ length: 1000 }, (_, i) => i));
    await sub.stop();
  }, 30_000);
}
