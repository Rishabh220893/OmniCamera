import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoute, buildSightings, describeEdit, findPossibleMatches, haversineKm, pairKey, plateDistance, routeToCsv,
  RouteSighting, sightingId,
} from '../src/lib/plateTracking';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

// Ahmedabad / Gandhinagar / Vadodara-ish coordinates
const AHD = { lat: 23.0225, lng: 72.5714 };
const GNR = { lat: 23.2156, lng: 72.6369 }; // ~22 km from AHD
const VAD = { lat: 22.3072, lng: 73.1812 }; // ~101 km from AHD

const sight = (cam: string, minutes: number, location?: { lat: number; lng: number }, extra: Partial<RouteSighting> = {}): RouteSighting => ({
  id: `${cam}-${minutes}`, plate: 'GJ01AB1234', cameraId: cam, cameraName: `Cam ${cam}`, department: 'Police', location,
  timestamp: at(minutes), confidence: 0.9, source: 'anpr', matchedAs: 'exact', ...extra,
});

test('haversine distance is about right', () => {
  assert.ok(Math.abs(haversineKm(AHD, GNR) - 22) < 2);
  assert.ok(Math.abs(haversineKm(AHD, VAD) - 101) < 2); // hand-checked: sqrt(79.5² + 62.5²)
  assert.equal(haversineKm(AHD, AHD), 0);
});

test('buildSightings normalises, de-duplicates and attaches confidence + stable ids', () => {
  const cam = { id: 'c1', name: 'Gate', department: 'Police', location: AHD };
  const out = buildSightings(cam, at(0), ['gj 01-ab 1234', 'GJ01AB1234', 'MH12XY9999', ''],
    [{ plate: 'GJ01AB1234', confidence: 0.93, formatValid: true, corrected: true }], 'anpr');
  assert.deepEqual(out.map((s) => s.plate), ['GJ01AB1234', 'MH12XY9999']);
  assert.equal(out[0].confidence, 0.93);
  assert.equal(out[0].corrected, true);
  assert.equal(out[1].confidence, null, 'no read info -> null, not a made-up number');
  assert.equal(out[0].id, sightingId('c1', at(0), 'GJ01AB1234'));
  assert.deepEqual(out[0].location, AHD);
});

test('plateDistance: confusable swaps are half edits and explain themselves', () => {
  const r = plateDistance('GJ01AB1234', 'GJO1AB1234');
  assert.equal(r.distance, 0.5);
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].type, 'confusable');
  assert.equal(describeEdit(r.edits[0]), 'digit 0 ↔ letter O at position 3 (look-alike)');
  assert.equal(r.edits[0].candidatePosition, 3, 'position within the candidate, for highlighting');
  assert.equal(plateDistance('GJ01AB1234', 'GJ01AB123').edits[0].candidatePosition, undefined, 'a missing character has no place in the candidate');
  assert.equal(plateDistance('GJ01AB1234', 'GJ01AB1235').distance, 1);
  assert.equal(plateDistance('GJ01AB1234', 'GJ01AB123').distance, 1);
  assert.equal(plateDistance('GJ01AB1234', 'GJ01AB1234').distance, 0);
  assert.equal(plateDistance('GJ01AB1234', 'GJ01CD9999').distance > 1, true);
});

test('possible matches: near-misses only, exact excluded, ranked, short strings ignored', () => {
  const candidates = [
    { plate: 'GJ01AB1234', count: 9 },       // exact — not a candidate
    { plate: 'GJO1AB1234', count: 2 },       // 0/O  -> 0.5
    { plate: 'GJ01AB1Z34', count: 5 },       // 2/Z  -> 0.5, more sightings so ranks first
    { plate: 'GJ01AB1235', count: 7 },       // one real substitution -> 1
    { plate: 'GJ01AB123', count: 1 },        // one deletion -> 1
    { plate: 'GJ01CD9999', count: 50 },      // unrelated
    { plate: 'GJ01AB12345', count: 1 },      // one insertion -> 1
    { plate: 'GJ', count: 3 },               // too short
  ];
  const m = findPossibleMatches('gj 01 ab 1234', candidates);
  assert.deepEqual(m.map((x) => x.plate), ['GJ01AB1Z34', 'GJO1AB1234', 'GJ01AB1235', 'GJ01AB123', 'GJ01AB12345']);
  assert.ok(m.every((x) => x.plate !== 'GJ01AB1234'));
  assert.deepEqual(findPossibleMatches('GJ', candidates), []);
  assert.equal(findPossibleMatches('GJ01AB1234', candidates, 0.5).length, 2, 'stricter threshold keeps only look-alike swaps');
});

test('pairKey is symmetric and punctuation-insensitive', () => {
  assert.equal(pairKey('GJ01AB1234', 'gj-01-ab-1235'), pairKey('GJ01AB1235', 'GJ01AB1234'));
});

test('route: reads at one camera within the dwell window are a single visit', () => {
  const r = buildRoute([sight('A', 0, AHD), sight('A', 2, AHD), sight('A', 4, AHD, { confidence: 0.97 })]);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].sightings.length, 3);
  assert.equal(r.segments[0].bestConfidence, 0.97);
  assert.equal(r.legs.length, 0);
});

test('route: a return to an earlier camera is a new segment; legs carry distance and speed', () => {
  const r = buildRoute([sight('A', 0, AHD), sight('B', 30, GNR), sight('A', 60, AHD)]);
  assert.deepEqual(r.segments.map((s) => s.cameraId), ['A', 'B', 'A']);
  assert.equal(r.legs.length, 2);
  assert.ok(Math.abs(r.legs[0].distanceKm! - 22) < 2);
  assert.ok(Math.abs(r.legs[0].speedKmh! - 44) < 5, 'about 22 km in 30 min');
  assert.deepEqual(r.legs[0].flags, []);
  assert.ok(Math.abs(r.totalDistanceKm - 44) < 4);
  assert.equal(r.firstSeen!.getTime(), at(0).getTime());
  assert.equal(r.lastSeen!.getTime(), at(60).getTime());
});

test('route: input order does not matter', () => {
  const r = buildRoute([sight('B', 30, GNR), sight('A', 0, AHD)]);
  assert.deepEqual(r.segments.map((s) => s.cameraId), ['A', 'B']);
});

test('route: impossible speed and simultaneity are flagged, not hidden', () => {
  const fast = buildRoute([sight('A', 0, AHD), sight('V', 10, VAD)]); // ~101 km in 10 min ≈ 600 km/h
  assert.deepEqual(fast.legs[0].flags, ['implausible_speed']);
  const sim = buildRoute([sight('A', 0, AHD), sight('V', 0, VAD)]);
  assert.deepEqual(sim.legs[0].flags, ['simultaneous']);
  const overlap = buildRoute([sight('A', 0, AHD), sight('A2', 0, { lat: AHD.lat + 0.0005, lng: AHD.lng })]);
  assert.deepEqual(overlap.legs[0].flags, [], 'two cameras ~50 m apart can both see the vehicle');
});

test('route: cameras with no location are listed but the leg is flagged', () => {
  const r = buildRoute([sight('A', 0, AHD), sight('B', 5, undefined)]);
  assert.equal(r.segments.length, 2);
  assert.deepEqual(r.legs[0].flags, ['no_location']);
  assert.equal(r.legs[0].distanceKm, null);
});

test('route: empty input', () => {
  const r = buildRoute([]);
  assert.deepEqual([r.segments, r.legs, r.firstSeen, r.lastSeen, r.totalDistanceKm], [[], [], null, null, 0]);
});

test('csv report: one row per sighting, evidence columns, injection-safe', () => {
  const r = buildRoute([
    sight('A', 0, AHD),
    sight('B', 30, GNR, { plate: 'GJO1AB1234', matchedAs: 'confirmed', confidence: 0.71, cameraName: '=HYPERLINK("x")' }),
  ]);
  const lines = routeToCsv('GJ01AB1234', r).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Segment,Timestamp,Camera/);
  assert.match(lines[1], /^1,2026-01-01T10:00:00.000Z,Cam A,Police,23.0225,72.5714,GJ01AB1234,GJ01AB1234,exact,0.90,anpr,,,$/);
  assert.match(lines[2], /confirmed look-alike,0.71,anpr,2\d\.\d\d,4\d,$/);
  assert.ok(lines[2].includes(`"'=HYPERLINK(""x"")"`), 'formula-looking text is neutralised and quoted');
});
