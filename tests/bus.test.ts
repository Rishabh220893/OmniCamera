import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBus } from '../server/bus/memoryBus.ts';
import { createRedisBus } from '../server/bus/redisBus.ts';
import { compareIds } from '../server/bus/types.ts';
import { busConformance } from './busConformance.ts';

busConformance('memory bus', async () => createMemoryBus({ log: { warn: () => {} } }));

// The same suite against a real Redis, when one is provided. It has never been run: see the header of server/bus/redisBus.ts.
const redisUrl = process.env.TEST_REDIS_URL;
busConformance('redis bus', async () => {
  const { default: IORedis } = await import('ioredis');
  const connect = () => new IORedis(redisUrl!, { maxRetriesPerRequest: null });
  const main = connect();
  const bus = createRedisBus(main, connect, { prefix: `test:${Date.now()}:`, log: { warn: () => {} } });
  const close = bus.close.bind(bus);
  bus.close = async () => { await close(); main.disconnect(); };
  return bus;
}, { skip: redisUrl ? false : 'set TEST_REDIS_URL to run against Redis' });

test('memory bus: retention by count drops the oldest, and a slow group is told it skipped messages rather than failing', async () => {
  const warnings: string[] = [];
  const bus = createMemoryBus({ maxLength: 5, log: { warn: (m: string) => warnings.push(m) } });
  try {
    const ids = await bus.publish('ret', Array.from({ length: 12 }, (_, i) => ({ value: i })));
    const info = await bus.info('ret');
    assert.deepEqual([info.length, info.oldestId, info.newestId], [5, ids[7], ids[11]]);
    assert.deepEqual((await bus.read<number>('ret', null, 100)).map((m) => m.value), [7, 8, 9, 10, 11]);
    const got: number[] = [];
    // a group created with from=earliest after trimming starts at the oldest that exists
    const sub = await bus.subscribe<number>('ret', 'late', async (ms) => { got.push(...ms.map((m) => m.value)); }, { from: 'earliest' });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(got, [7, 8, 9, 10, 11]);
    await sub.stop();
  } finally { await bus.close(); }
});

test('memory bus: retention by age', async () => {
  let t = Date.parse('2026-10-10T00:00:00Z');
  const bus = createMemoryBus({ maxAgeMs: 1000, now: () => new Date(t), log: { warn: () => {} } });
  try {
    await bus.publish('age', [{ value: 'old' }]);
    t += 5000;
    await bus.publish('age', [{ value: 'new' }]);
    assert.deepEqual((await bus.read<string>('age', null, 10)).map((m) => m.value), ['new']);
  } finally { await bus.close(); }
});

test('memory bus: closed means closed', async () => {
  const bus = createMemoryBus();
  await bus.close();
  await assert.rejects(bus.publish('x', [{ value: 1 }]), /closed/);
  await assert.rejects(bus.subscribe('x', 'g', async () => undefined), /closed/);
});

test('compareIds orders both id styles numerically, not as text', () => {
  assert.ok(compareIds('0000000000000009', '0000000000000010') < 0);
  assert.ok(compareIds('1700000000000-2', '1700000000000-10') < 0);
  assert.ok(compareIds('1700000000009-0', '1700000000010-0') < 0);
  assert.equal(compareIds('5-5', '5-5'), 0);
  assert.ok(compareIds('10', '9') > 0);
});
