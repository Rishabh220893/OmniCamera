/** The capacity formulas (scripts/capacity/platformModels.ts): worked by hand here, so a wrong formula cannot hide behind itself. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { busLoad, clipFetch, erasureOverhead, eventLoad, eventStorage, fmtBytes, mbpsIn, processesFor, searchRowsTouched, storagePlan, transferHours, videoBytesPerDay } from '../scripts/capacity/platformModels.ts';

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

test('video storage: 1 Mbit/s is 10.8 GB a day per camera; 80,000 cameras at 2 Mbit/s are 1.728 PB a day (docs/federation-plan.md section 3)', () => {
  close(videoBytesPerDay(1, 1), 10.8e9);
  close(videoBytesPerDay(80_000, 2), 1.728e15);
  close(videoBytesPerDay(1000, 2), 21.6e12);
});

test('storage plan: tiers add up; raw capacity is logical times the overhead of each tier; erasure coding is cheaper than copies', () => {
  assert.equal(erasureOverhead(4, 2), 1.5);
  assert.equal(erasureOverhead(8, 3), 1.375);
  const p = storagePlan({ cameras: 1000, mbps: 2, hot: { days: 3, overhead: 3 }, warm: { days: 4, overhead: 1.5 }, cold: { days: 23, overhead: 1.375 } });
  close(p.perDay, 21.6e12);
  close(p.hot.logical, 64.8e12);
  close(p.hot.raw, 194.4e12);
  close(p.warm.raw, 4 * 21.6e12 * 1.5);
  close(p.totalLogical, 30 * 21.6e12);
  close(p.totalRaw, 21.6e12 * (3 * 3 + 4 * 1.5 + 23 * 1.375));
  assert.equal(storagePlan({ cameras: 10, mbps: 1, hot: { days: 7, overhead: 1 } }).cold.raw, 0, 'a tier that is not there is zero');
});

test('bandwidth: 80,000 cameras at 2 Mbit/s are 160 Gbit/s into one centre; moving a PB over 100 Gbit/s takes days', () => {
  assert.equal(mbpsIn(80_000, 2), 160_000);
  close(transferHours(1e15, 100_000, 0.7), (1e15 * 8) / (100_000e6 * 0.7) / 3600);
  assert.equal(transferHours(1e15, 100_000, 0.7) > 30, true);
});

test('clip fetch: a 10-minute clip at 2 Mbit/s is 150 MB; alone over a 20 Mbit/s link at 70% it takes about 86 s; four at once share the link', () => {
  const one = clipFetch({ clipMinutes: 10, mbps: 2, linkMbps: 20, concurrent: 1 });
  close(one.bytes, 150e6);
  close(one.seconds, (150e6 * 8) / (14e6));
  const four = clipFetch({ clipMinutes: 10, mbps: 2, linkMbps: 20, concurrent: 4 });
  close(four.seconds, one.seconds * 4);
  close(four.perClipMbps, 3.5);
});

test('event load: analysed events plus pushed ones; per second, per day and in bytes', () => {
  const l = eventLoad({ cameras: 80_000, intervalS: 60, gatePassRate: 0.25, eventsPerAnalysis: 3, pushedPerCameraHour: 12, avgEventBytes: 390 });
  close(l.analysedPerSecond, (80_000 / 60) * 0.25 * 3);
  close(l.pushedPerSecond, 80_000 * 12 / 3600);
  close(l.perSecond, 1000 + 266.6666667, 1e-6);
  close(l.perDay, l.perSecond * 86_400);
  close(l.bytesPerDay, l.perDay * 390);
});

test('event storage and search: rows and index overhead; an indexed search touches a page, an unindexed one the table', () => {
  const s = eventStorage(86_400_000, 450, 30);
  close(s.rows, 2.592e9);
  close(s.dataBytes, 2.592e9 * 450);
  close(s.withIndexesBytes, s.dataBytes * 2.4);
  assert.equal(searchRowsTouched({ tableRows: 1e9, matchingFraction: 0.01, pageSize: 100, indexed: true }), 10_000);
  assert.equal(searchRowsTouched({ tableRows: 1e9, matchingFraction: 0.01, pageSize: 100, indexed: false }), 1e9);
  assert.equal(searchRowsTouched({ tableRows: 500, matchingFraction: 0.001, pageSize: 100, indexed: true }), 500, 'never more than the table');
});

test('bus and processes: MB/s and partitions; processes needed against a measured capacity with headroom', () => {
  const b = busLoad(1266.67, 390);
  close(b.MBps, 0.494, 1e-3);
  assert.equal(b.partitions, 1);
  assert.equal(busLoad(100_000, 400, 10).partitions, 4);
  assert.equal(processesFor(1266, 5000), 1);
  assert.equal(processesFor(10_000, 5000, 0.6), 4);
  assert.equal(fmtBytes(1.728e15), '1.73 PB');
  assert.equal(fmtBytes(21.6e12), '21.6 TB');
});
