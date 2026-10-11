/** The geometry and settings behind the zone and line screen (src/lib/detectorZones.ts), checked against the server's own reader of them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MOTION_PERCENT, detectorOf, lineFromDrag, motionLabel, pointIn, withDetector, zoneFromDrag } from '../src/lib/detectorZones.ts';
import { configOf, detectLocal } from '../server/analytics/localDetector.ts';
import { FINGERPRINT_H, FINGERPRINT_W } from '../server/frameGate.ts';

const box = { left: 100, top: 50, width: 400, height: 200 };

test('pointIn: a pointer position becomes a fraction of the picture, clamped to it', () => {
  assert.deepEqual(pointIn(box, 300, 150), { x: 0.5, y: 0.5 });
  assert.deepEqual(pointIn(box, 50, 400), { x: 0, y: 1 });
  assert.deepEqual(pointIn({ left: 0, top: 0, width: 0, height: 0 }, 5, 5), { x: 0, y: 0 });
});

test('zoneFromDrag: any drag direction gives the same rectangle; a click or a sliver is nothing; it stays inside the picture', () => {
  assert.deepEqual(zoneFromDrag({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.8 }), { x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
  assert.deepEqual(zoneFromDrag({ x: 0.6, y: 0.8 }, { x: 0.2, y: 0.3 }), { x: 0.2, y: 0.3, w: 0.4, h: 0.5 });
  assert.equal(zoneFromDrag({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.9 }), null);
  const z = zoneFromDrag({ x: 0.9, y: 0.9 }, { x: 1, y: 1 })!;
  assert.equal(z.x + z.w <= 1.0001 && z.y + z.h <= 1.0001, true);
});

test('lineFromDrag: keeps the direction; a click is nothing', () => {
  assert.deepEqual(lineFromDrag({ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.7 }), { x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.7 });
  assert.equal(lineFromDrag({ x: 0.3, y: 0.3 }, { x: 0.31, y: 0.3 }), null);
});

test('withDetector / detectorOf: settings round-trip; nothing drawn leaves no entry; other analyzers are kept; defaults are not stored', () => {
  const s = { zone: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, line: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, motionPercent: 4 };
  const saved = withDetector({ other: { a: 1 } }, s)!;
  assert.deepEqual(detectorOf(saved), s);
  assert.deepEqual(saved.other, { a: 1 });
  assert.equal(withDetector(undefined, {}), undefined, 'nothing drawn: no analyzers at all');
  assert.deepEqual(withDetector({ other: 1 }, {}), { other: 1 });
  assert.equal((withDetector(undefined, { motionPercent: DEFAULT_MOTION_PERCENT })), undefined, 'the default is not written down');
  assert.equal((withDetector(undefined, { motionPercent: 99 })!['local-detector'] as any).motionPercent, 20, 'capped');
  assert.deepEqual(detectorOf({ 'local-detector': { zone: { x: 2, y: 0, w: 1, h: 1 }, line: { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }, motionPercent: -1 } }), {}, 'malformed settings are ignored');
});

test('what the screen saves is what the server reads (same zone, line and sensitivity)', () => {
  const analyzers = withDetector(undefined, { zone: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, line: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, motionPercent: 3 });
  const cfg = configOf({ id: 'c', name: 'c', analyzers } as any);
  assert.deepEqual([cfg.zone, cfg.line, cfg.motionPercent], [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, 3]);
  // A block moving in the middle of the picture is an intrusion in the drawn zone; the same block in a corner is not.
  const grey = (): Uint8Array => new Uint8Array(FINGERPRINT_W * FINGERPRINT_H).fill(100);
  const block = (x0: number, y0: number, w: number, h: number) => { const f = grey(); for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y * FINGERPRINT_W + x] = 250; return f; };
  const inside = detectLocal(grey(), block(24, 12, 16, 12), cfg).map((e) => e.type);
  assert.equal(inside.includes('vms.intrusion'), true);
  const corner = detectLocal(grey(), block(0, 0, 8, 6), cfg).map((e) => e.type);
  assert.equal(corner.includes('vms.intrusion'), false);
});

test('motionLabel gives a sentence for each range', () => {
  assert.match(motionLabel(0.5), /Very sensitive/);
  assert.equal(motionLabel(1.5), 'Normal');
  assert.match(motionLabel(6), /Less/);
  assert.match(motionLabel(15), /Low/);
});
