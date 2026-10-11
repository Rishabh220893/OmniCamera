/** A flag on a log raises a banner or pulses a tile only while it is recent: stored logs are loaded at start-up and the newest one of a camera can be days old. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_FRESH_MS, isFreshLog, isActualCriticalIncident } from '../src/lib/incidentUtils.ts';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const log = (minutesAgo: number, over: Record<string, unknown> = {}) => ({ id: 'l', cameraId: 'c', cameraName: 'C', timestamp: new Date(NOW - minutesAgo * 60_000), summary: '', counts: { people: 0, vehicles: 0, other: 0 }, isUnusual: true, alerts: [], ...over }) as never;

test('fresh: a flag from the last 15 minutes is live; an older one is history', () => {
  assert.equal(ALERT_FRESH_MS, 15 * 60_000);
  assert.equal(isFreshLog(log(0), NOW), true);
  assert.equal(isFreshLog(log(14), NOW), true);
  assert.equal(isFreshLog(log(16), NOW), false);
  assert.equal(isFreshLog(log(60 * 24 * 3), NOW), false, 'a flag from three days ago must not raise a banner at start-up');
});

test('fresh: timestamps that are strings (from storage) work; nonsense, missing and far-future times are not fresh', () => {
  assert.equal(isFreshLog({ timestamp: new Date(NOW - 60_000).toISOString() } as never, NOW), true);
  assert.equal(isFreshLog({ timestamp: 'not a date' } as never, NOW), false);
  assert.equal(isFreshLog(undefined, NOW), false);
  assert.equal(isFreshLog(null, NOW), false);
  assert.equal(isFreshLog(log(-60), NOW), false, 'a log dated an hour in the future is a wrong clock, not an alert');
  assert.equal(isFreshLog(log(-2), NOW), true, 'a minute or two of clock difference is tolerated');
});

test('the window can be changed, and an old critical log is still a critical incident (it stays in Logs); only its banner is time-limited', () => {
  assert.equal(isFreshLog(log(30), NOW, 60 * 60_000), true);
  assert.equal(isFreshLog(log(30), NOW, 10 * 60_000), false);
  const old = log(60 * 24, { sentiment: 'critical' });
  assert.equal(isActualCriticalIncident(old), true);
  assert.equal(isFreshLog(old, NOW), false);
});
