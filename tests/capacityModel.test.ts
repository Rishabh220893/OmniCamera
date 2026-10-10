import test from 'node:test';
import assert from 'node:assert/strict';
import { analysesPerSecond, camerasPerCore, capturesPerSecond, coresNeeded, dailyWrites, gatewayUplinkKbps, modelCallsPerDay, probeCampaignHours, probeConcurrencyFor, videoMbps } from '../scripts/capacity/model.ts';

const costs = { captureCpuS: 0.5, platformCpuS: 0.01, gateCpuS: 0.05 };
const rows = { eventBytes: 400, logBytes: 1000, eventsPerAnalysis: 2, notableShare: 0.1 };

test('capacity model: rates follow from cameras, interval and gate', () => {
  const f = { cameras: 600, intervalS: 60, gatePassRate: 0.25 };
  assert.equal(capturesPerSecond(f), 10);
  assert.equal(analysesPerSecond(f), 2.5);
  assert.equal(modelCallsPerDay(f), 216_000);
  assert.equal(modelCallsPerDay({ ...f, gatePassRate: 1 }), 864_000);
});

test('capacity model: cores needed and cameras per core are the same relationship', () => {
  const f = { cameras: 600, intervalS: 60, gatePassRate: 0.25 };
  // busy = 10 * (0.5 + 0.05) + 2.5 * 0.01 = 5.525 cores of work; at 60% target load that is 9.2 cores
  assert.ok(Math.abs(coresNeeded(f, costs) - 5.525 / 0.6) < 1e-9);
  const per = camerasPerCore(60, 0.25, costs);
  assert.equal(per, Math.floor(0.6 / ((0.55 + 0.25 * 0.01) / 60)));
  assert.ok(coresNeeded({ cameras: per, intervalS: 60, gatePassRate: 0.25 }, costs) <= 1.0001, 'one core serves that many');
  assert.ok(coresNeeded({ cameras: per + 20, intervalS: 60, gatePassRate: 0.25 }, costs) > 1, 'and not many more');
  assert.ok(camerasPerCore(120, 0.25, costs) > camerasPerCore(60, 0.25, costs), 'a longer interval fits more cameras');
});

test('capacity model: probing is real time, so a whole fleet takes days unless run wide', () => {
  assert.equal(probeCampaignHours(3600, 30, 6, 1), 36);
  assert.equal(probeCampaignHours(3600, 30, 6, 12), 3);
  assert.equal(probeConcurrencyFor(80_000, 30, 6, 24), 34, '80,000 cameras once a day need 34 probes at once');
  assert.equal(probeCampaignHours(80_000, 30, 6, 2), 400, 'two at a time: 16.7 days for one pass over a state');
});

test('capacity model: writes and storage scale with analyses, and the Firestore mode matters', () => {
  const f = { cameras: 1000, intervalS: 60, gatePassRate: 0.5 };
  const all = dailyWrites(f, rows, 'all'), notable = dailyWrites(f, rows, 'notable'), none = dailyWrites(f, rows, 'none');
  assert.equal(all.analysesPerDay, 720_000);
  assert.equal(all.postgresEventRows, 1_440_000);
  assert.equal(all.firestoreLogWrites, 720_000);
  assert.equal(notable.firestoreLogWrites, 72_000);
  assert.equal(none.firestoreLogWrites, 0);
  assert.ok(Math.abs(all.postgresGBPerDay - (720_000 * 1000 + 1_440_000 * 400) / 1e9) < 1e-9);
  assert.ok(Math.abs(all.writesPerSecondPeak - 25) < 1e-9);
});

test('capacity model: a gateway sends kilobits where video would send megabits', () => {
  const up = gatewayUplinkKbps(500, 60, 0.5, rows);
  assert.ok(up > 0 && up < 200, `uplink ${up} kbps`);
  assert.equal(videoMbps(500, 2000), 1000);
  assert.ok(videoMbps(500, 2000) * 1000 / up > 1000, 'three orders of magnitude less than the video');
  assert.ok(gatewayUplinkKbps(0, 60, 0.5, rows) > 0, 'an idle gateway still sends its heartbeat');
});
