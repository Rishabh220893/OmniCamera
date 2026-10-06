import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAnalyzeOnServer, GuardCamera, planGuardSync } from '../src/lib/guardSync';

const cam = (id: string, over: Partial<GuardCamera> = {}): GuardCamera => ({ id, useRemoteFeed: true, remoteStreamUrl: `https://grid.example.com/${id}/index.m3u8`, serverAnalysis: false, ...over });
const base = { guardFlaggedIds: new Set<string>(), failedIds: new Set<string>(), wasCapturing: false };

test('guard off and nothing flagged by it: nothing to do', () => {
  const r = planGuardSync({ ...base, isCapturing: false, targetIds: ['a'], cameras: [cam('a')] });
  assert.deepEqual(r, { enable: [], disable: [] });
});

test('Activate Guard flags the targeted remote-feed cameras, and only those', () => {
  const cameras = [cam('a'), cam('b'), cam('c')];
  const r = planGuardSync({ ...base, isCapturing: true, targetIds: ['a', 'b'], cameras });
  assert.deepEqual(r.enable.sort(), ['a', 'b']);
  assert.deepEqual(r.disable, []);
});

test('cameras the server cannot capture are never handed over (webcam, no URL, private address)', () => {
  const cameras = [cam('webcam', { useRemoteFeed: false }), cam('empty', { remoteStreamUrl: '  ' }), cam('lan', { remoteStreamUrl: 'http://192.168.1.20/stream' }), cam('ok')];
  const r = planGuardSync({ ...base, isCapturing: true, targetIds: cameras.map((c) => c.id), cameras });
  assert.deepEqual(r.enable, ['ok'], 'so the browser loop keeps analysing the others');
  assert.equal(canAnalyzeOnServer(cameras[2]), false);
});

test('a camera already flagged is not written again', () => {
  const r = planGuardSync({ ...base, isCapturing: true, targetIds: ['a'], cameras: [cam('a', { serverAnalysis: true })] });
  assert.deepEqual(r, { enable: [], disable: [] });
});

test('deselecting a camera while the guard runs releases only cameras this guard flagged', () => {
  const cameras = [cam('a', { serverAnalysis: true }), cam('b', { serverAnalysis: true }), cam('pre', { serverAnalysis: true })];
  const r = planGuardSync({ ...base, isCapturing: true, targetIds: ['a'], cameras, guardFlaggedIds: new Set(['a', 'b']), wasCapturing: true });
  assert.deepEqual(r.disable, ['b'], 'a stays (still selected); "pre" was flagged in Settings, not by the guard');
});

test('Pause Guard releases the flagged cameras and the ones it was targeting', () => {
  const cameras = [cam('a', { serverAnalysis: true }), cam('b', { serverAnalysis: true }), cam('other', { serverAnalysis: true })];
  const r = planGuardSync({ ...base, isCapturing: false, targetIds: ['a'], cameras, guardFlaggedIds: new Set(['b']), wasCapturing: true });
  assert.deepEqual(r.disable.sort(), ['a', 'b']);
  assert.ok(!r.disable.includes('other'), 'cameras outside the guard are untouched');
});

test('after the pause has been handled, later re-renders do not touch Settings-flagged cameras', () => {
  const r = planGuardSync({ ...base, isCapturing: false, targetIds: ['a'], cameras: [cam('a', { serverAnalysis: true })], wasCapturing: false });
  assert.deepEqual(r, { enable: [], disable: [] });
});

test('a camera whose enable write failed is not retried until the guard is paused', () => {
  const r = planGuardSync({ ...base, isCapturing: true, targetIds: ['a'], cameras: [cam('a')], failedIds: new Set(['a']) });
  assert.deepEqual(r.enable, []);
});

import { toggleGuardSelection } from '../src/lib/guardSync';

test('ticking a camera in the default "active" scope switches to "selected" and keeps the tick', () => {
  const r = toggleGuardSelection('active', new Set(), 'cam05');
  assert.equal(r.scope, 'selected');
  assert.deepEqual([...r.selected], ['cam05']);
});

test('several cameras can be ticked one after another, and unticked again', () => {
  let state = { scope: 'active' as const, selected: new Set<string>() } as { scope: 'active' | 'selected' | 'all'; selected: Set<string> };
  for (const id of ['cam05', 'cam13', 'cam14']) state = toggleGuardSelection(state.scope, state.selected, id);
  assert.deepEqual([...state.selected].sort(), ['cam05', 'cam13', 'cam14']);
  state = toggleGuardSelection(state.scope, state.selected, 'cam13');
  assert.deepEqual([...state.selected].sort(), ['cam05', 'cam14']);
  assert.equal(state.scope, 'selected');
});

test('in "all" scope a click changes nothing (every camera is already included)', () => {
  const r = toggleGuardSelection('all', new Set(['x']), 'cam05');
  assert.equal(r.scope, 'all');
  assert.deepEqual([...r.selected], ['x']);
});
