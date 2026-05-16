import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeImageData, summarizeScene, toneFromRgb } from '../src/sceneAnalyzer.js';

test('toneFromRgb labels dominant color families', () => {
  assert.equal(toneFromRgb(230, 60, 40), 'warm/red');
  assert.equal(toneFromRgb(30, 150, 55), 'green/outdoor');
  assert.equal(toneFromRgb(20, 30, 180), 'cool/blue');
});

test('analyzeImageData produces bounded scene signals', () => {
  const data = new Uint8ClampedArray(64 * 4).fill(120);
  const imageData = { data };
  const result = analyzeImageData(imageData, null, ['Ava']);

  assert.ok(result.people >= 0);
  assert.ok(result.vehicles >= 0);
  assert.ok(result.brightness > 0);
  assert.equal(result.observedFaces.length, result.faces);
});

test('summarizeScene includes camera name and recognized faces', () => {
  const summary = summarizeScene({
    people: 1,
    vehicles: 2,
    faces: 1,
    brightness: 0.5,
    motion: 0.6,
    dominantTone: 'neutral',
    observedFaces: ['Mina'],
  }, 'Lobby');

  assert.match(summary, /Lobby/);
  assert.match(summary, /recognized: Mina/);
  assert.match(summary, /active motion/);
});
