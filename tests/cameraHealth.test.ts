import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_HEALTH_ORDER, sortByGridHealth } from '../src/lib/cameraHealth';

const cam = (id: string) => ({ id, remoteStreamUrl: `https://cctv.corp8.cloud/${id}/index.m3u8` });

test('health order lists each of the 30 grid cameras exactly once', () => {
  assert.equal(GRID_HEALTH_ORDER.length, 30);
  assert.equal(new Set(GRID_HEALTH_ORDER).size, 30);
  for (let i = 1; i <= 30; i++) assert.ok(GRID_HEALTH_ORDER.includes(`cam${String(i).padStart(2, '0')}`), `cam${i} missing`);
});

test('sortByGridHealth puts the reliable cameras first and the lossy ones last', () => {
  const shuffled = ['cam07', 'cam16', 'cam01', 'cam25', 'cam13', 'cam29', 'cam02'].map(cam);
  assert.deepEqual(sortByGridHealth(shuffled).map((c) => c.id), ['cam02', 'cam01', 'cam13', 'cam25', 'cam29', 'cam16', 'cam07']);
});

test('sortByGridHealth keeps non-grid cameras in front, in their own order, and unknown grid ids after known ones', () => {
  const own = { id: 'own-a', remoteStreamUrl: 'https://example.com/live.m3u8' };
  const own2 = { id: 'own-b', remoteStreamUrl: '' };
  const out = sortByGridHealth([cam('cam07'), own, cam('cam99'), cam('cam01'), own2]);
  assert.deepEqual(out.map((c) => c.id), ['own-a', 'own-b', 'cam01', 'cam07', 'cam99']);
});

test('sortByGridHealth does not mutate its input', () => {
  const input = [cam('cam07'), cam('cam01')];
  sortByGridHealth(input);
  assert.deepEqual(input.map((c) => c.id), ['cam07', 'cam01']);
});
