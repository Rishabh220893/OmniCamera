/** Registry gap analysis (Model 1): uncovered zones, incomplete metadata, ageing, and the CSV a planner opens in a spreadsheet. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeGapAnalysis, findUncoveredZones, gapReportToCsv, distanceMeters } from '../src/lib/registryReport.ts';
import type { CameraConfig } from '../src/types.ts';

const cam = (id: string, over: Partial<CameraConfig> = {}): CameraConfig => ({
  id, name: `Cam ${id}`, peopleThreshold: 0, vehicleThreshold: 0, sensitivity: 0, interval: 60, webhookUrl: '', useRemoteFeed: false, remoteStreamUrl: '', facingMode: 'user', suspiciousRules: '',
  department: 'Traffic', ownership: 'GSDMA', cameraType: 'fixed' as never, storageDetails: 'NVR-1', installDate: '2024-01-01', location: { lat: 23.0, lng: 72.5 }, ...over,
} as CameraConfig);

test('distance: one degree of latitude is about 111 km', () => {
  assert.ok(Math.abs(distanceMeters(23, 72, 24, 72) - 111_195) < 300);
});

test('uncovered zones: needs 3 located cameras; two cameras far apart leave a gap between them, a tight cluster leaves none', () => {
  assert.deepEqual(findUncoveredZones([cam('a'), cam('b', { location: { lat: 23.1, lng: 72.5 } })]).zones, [], 'fewer than 3 located cameras: nothing to say');
  const tight = [cam('a'), cam('b', { location: { lat: 23.0005, lng: 72.5 } }), cam('c', { location: { lat: 23.0, lng: 72.5005 } })];
  const t = findUncoveredZones(tight, 300);
  assert.ok(t.coveredPercent >= 50 && t.cellsChecked <= 30, `a tight cluster covers its own small area (${t.coveredPercent}% of ${t.cellsChecked} squares)`);
  const spread = [cam('a'), cam('b', { location: { lat: 23.1, lng: 72.5 } }), cam('c', { location: { lat: 23.0, lng: 72.6 } })];
  const s = findUncoveredZones(spread, 300);
  assert.ok(s.zones.length > 0 && s.coveredPercent < 50, `a spread-out registry leaves most of its area uncovered (${s.coveredPercent}%)`);
  assert.ok(s.zones[0].nearestMeters >= s.zones[s.zones.length - 1].nearestMeters, 'the emptiest zone comes first');
  assert.ok(s.cellsChecked <= 2500, 'a wide area gets bigger squares, not a slower report');
});

test('gap report: missing metadata is listed per camera; ageing and unlocated are found; the CSV neutralises formulas', () => {
  const r = computeGapAnalysis([
    cam('ok'),
    cam('old', { installDate: '2010-05-01' }),
    cam('bare', { ownership: undefined, storageDetails: '', location: undefined, department: undefined, cameraType: undefined, installDate: undefined, name: '=HYPERLINK("x")' }),
  ]);
  assert.deepEqual(r.ageing.map((c) => c.id), ['old']);
  assert.deepEqual(r.unlocated.map((c) => c.id), ['bare']);
  const bare = r.incompleteMetadata.find((m) => m.cameraId === 'bare')!;
  assert.deepEqual(bare.missing.sort(), ['camera type', 'department', 'install date', 'location', 'ownership', 'storage details'].sort());
  assert.equal(r.incompleteMetadata.some((m) => m.cameraId === 'ok'), false);
  const csv = gapReportToCsv(r);
  assert.ok(csv.includes("'=HYPERLINK"), 'a camera name that starts with = is kept as text');
  assert.ok(csv.includes('Ageing') && csv.includes('Incomplete metadata') && csv.includes('Uncovered zone'));
});
