import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProfileRow } from '../server/cameraProfile.ts';
import { classOf, createReprobeScheduler, DEFAULT_REPROBE_CONFIG, dueForReprobe, reprobeConfigFromEnv, reprobeEnabledFromEnv } from '../server/reprobeScheduler.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const ago = (h: number) => new Date(NOW - h * HOUR).toISOString();
const row = (id: string, probedHoursAgo: number, over: Partial<ProfileRow> = {}): ProfileRow => ({
  report: { ...GRID_REPORTS.find((r) => r.cameraId === 'cam01')!, cameraId: id, probedAt: ago(probedHoursAgo) }, override: null, overrideReason: null, ...over,
});
const cfg = DEFAULT_REPROBE_CONFIG;

test('due: healthy after 24 h, failing after 1 h, healed and unsupported after 6 h; nothing earlier', () => {
  const rows = [
    row('h1', 23), row('h2', 25),
    row('f1', 0.5, { lastFailure: { probedAt: ago(0.5), failure: 'no_frame', detail: null, inARow: 1 } }),
    row('f2', 3, { lastFailure: { probedAt: ago(1.5), failure: 'no_frame', detail: null, inARow: 1 } }),
    row('x1', 5, { healFloor: { recipe: 'F', reason: '', at: ago(5) } }), row('x2', 7, { healFloor: { recipe: 'B', reason: '', at: ago(7) } }),
    { ...row('u1', 5), report: { ...row('u1', 5).report, failure: 'no_frame' as const } }, { ...row('u2', 7), report: { ...row('u2', 7).report, failure: 'no_frame' as const } },
  ];
  assert.deepEqual(dueForReprobe(rows, NOW, cfg).map((d) => d.cameraId), ['f2', 'x2', 'u2', 'h2'], 'failing, healed, unsupported, healthy');
  assert.deepEqual(rows.map(classOf), ['healthy', 'healthy', 'failing', 'failing', 'healed', 'healed', 'unsupported', 'unsupported']);
});

test('due: the most overdue goes first within a class, and a failed attempt counts as an attempt', () => {
  const rows = [row('a', 30), row('b', 60), row('c', 40, { lastFailure: { probedAt: ago(2), failure: 'no_frame', detail: null, inARow: 1 } })];
  // c's good profile is 40 h old but it was tried 2 h ago and is "failing" (1 h): due. a and b are healthy and overdue.
  assert.deepEqual(dueForReprobe(rows, NOW, cfg).map((d) => d.cameraId), ['c', 'b', 'a']);
  const recent = [row('d', 40, { lastFailure: { probedAt: ago(0.2), failure: 'no_frame', detail: null, inARow: 1 } })];
  assert.deepEqual(dueForReprobe(recent, NOW, cfg), [], 'tried 12 minutes ago: not again yet');
});

test('tick: starts at most a batch, never while a probe runs, and stays inside the hourly budget', async () => {
  let now = NOW;
  const rows = Array.from({ length: 10 }, (_, i) => row(`c${String(i).padStart(2, '0')}`, 30 + i));
  const started: string[][] = [];
  let busy = false;
  const s = createReprobeScheduler({ list: async () => rows, start: (ids) => { started.push(ids); for (const r of rows) if (ids.includes(r.report.cameraId)) r.report.probedAt = new Date(now).toISOString(); return true; }, busy: () => busy, cfg: { ...cfg, perHour: 3, batch: 2 }, now: () => now });

  busy = true;
  assert.deepEqual(await s.tick(), [], 'a probe is running');
  busy = false;
  assert.deepEqual(await s.tick(), ['c09', 'c08'], 'the most overdue pair');
  // (The fake start stands in for the probe job, which refreshes the profile it probed.)
  assert.deepEqual(await s.tick(), ['c07'], 'only one left in this hour (3 per hour)');
  assert.deepEqual(await s.tick(), [], 'budget used up');
  now += 61 * 60_000;
  assert.deepEqual(await s.tick(), ['c06', 'c05'], 'an hour later the budget is back, and the cameras probed an hour ago are not due');
  assert.equal(started.length, 3);
  assert.equal((await s.status()).startedLastHour, 2);
});

test('tick: a refused start (probe already running elsewhere) spends no budget; an error is reported, not thrown', async () => {
  let accept = false, fail = false;
  const s = createReprobeScheduler({
    list: async () => { if (fail) throw new Error('database is down'); return [row('a', 48)]; },
    start: () => accept, busy: () => false, now: () => NOW,
  });
  assert.deepEqual(await s.tick(), []);
  accept = true;
  assert.deepEqual(await s.tick(), ['a'], 'the refused attempt cost nothing');
  fail = true;
  assert.deepEqual(await s.tick(), []);
  assert.match((await s.status()).error ?? '', /database is down/);
});

test('settings: off unless asked for; numbers from the environment', () => {
  assert.equal(reprobeEnabledFromEnv({}), false);
  assert.equal(reprobeEnabledFromEnv({ MEDIA_REPROBE: 'on' }), true);
  assert.deepEqual(reprobeConfigFromEnv({}), cfg);
  const c = reprobeConfigFromEnv({ MEDIA_REPROBE_HOURS: '12', MEDIA_REPROBE_PER_HOUR: '2', MEDIA_REPROBE_FAILING_MIN: 'x' });
  assert.deepEqual([c.healthyEveryMs, c.perHour, c.failingEveryMs], [12 * HOUR, 2, HOUR]);
});
