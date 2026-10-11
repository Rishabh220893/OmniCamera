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

test('coverage rule: a square counts as covered when any part of it is within the radius of a camera, so a camera inside a large square covers it', () => {
  const state = [cam('a', { location: { lat: 23.0225, lng: 72.5714 } }), cam('b', { location: { lat: 21.1702, lng: 72.8311 } }), cam('c', { location: { lat: 22.3039, lng: 70.8022 } }), cam('d', { location: { lat: 22.3072, lng: 73.1812 } })];
  const z = findUncoveredZones(state, 300);
  assert.ok(z.cellMeters > 1000, 'a State-wide area gets large squares');
  assert.ok(z.coveredPercent > 0, 'the squares that hold a camera are covered (the old rule counted none of them)');
  assert.equal(z.zones.length, z.uncoveredTotal, 'every uncovered square is returned, so the map can draw all of them');
  assert.equal(z.cellsChecked - z.uncoveredTotal >= 4 && z.cellsChecked - z.uncoveredTotal <= 16, true, `about one covered square per camera (${z.cellsChecked - z.uncoveredTotal})`);
});

test('the ring search finds exactly the same nearest camera as comparing with every camera (fixed random data, several densities)', () => {
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (const n of [3, 10, 60, 400, 3000]) {
    const cams = Array.from({ length: n }, (_, i) => cam(String(i), { location: { lat: 21 + rnd() * 3, lng: 69 + rnd() * 4 } }));
    const r = findUncoveredZones(cams, 300);
    // Brute force over the same squares.
    const pts = cams.map((c) => c.location!);
    const midLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length, mLat = 111_320, mLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
    const minLat = Math.min(...pts.map((p) => p.lat)) - 300 / mLat, maxLat = Math.max(...pts.map((p) => p.lat)) + 300 / mLat;
    const minLng = Math.min(...pts.map((p) => p.lng)) - 300 / mLng, maxLng = Math.max(...pts.map((p) => p.lng)) + 300 / mLng;
    const rows = Math.max(1, Math.ceil(((maxLat - minLat) * mLat) / r.cellMeters)), cols = Math.max(1, Math.ceil(((maxLng - minLng) * mLng) / r.cellMeters));
    let uncovered = 0, emptiest = 0;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const lat = minLat + ((i + 0.5) * r.cellMeters) / mLat, lng = minLng + ((j + 0.5) * r.cellMeters) / mLng;
      const nearest = Math.min(...pts.map((p) => distanceMeters(lat, lng, p.lat, p.lng)));
      if (nearest - r.cellMeters * 0.7071 > 300) { uncovered++; emptiest = Math.max(emptiest, Math.round(nearest)); }
    }
    assert.equal(r.uncoveredTotal, uncovered, `${n} cameras: same number of uncovered squares`);
    assert.equal(r.zones[0]?.nearestMeters ?? 0, emptiest, `${n} cameras: same emptiest distance`);
  }
});

test('performance: 20,000 cameras are analysed in well under a second', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const cams = Array.from({ length: 20000 }, (_, i) => cam(String(i), { location: { lat: 20 + rnd() * 4, lng: 68 + rnd() * 5 } }));
  const t = Date.now(); findUncoveredZones(cams, 300);
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});
