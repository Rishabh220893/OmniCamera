import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisTargets, canAnalyzeOnServer, GuardCamera, planGuardSync } from '../src/lib/guardSync';

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

test('a running analysis flags exactly its targets: deselected cameras and cameras left flagged by an earlier run are released', () => {
  const cameras = [cam('a', { serverAnalysis: true }), cam('b', { serverAnalysis: true }), cam('left-over', { serverAnalysis: true }), cam('c')];
  const r = planGuardSync({ ...base, isCapturing: true, targetIds: ['a', 'c'], cameras, guardFlaggedIds: new Set(['a', 'b']), wasCapturing: true });
  assert.deepEqual(r.disable.sort(), ['b', 'left-over'], 'a stays (a target); b was deselected; left-over was flagged by an earlier session');
  assert.deepEqual(r.enable, ['c']);
});

test('the stale-flag bug: ticking one camera while 30 are still flagged from before releases the other 29', () => {
  const cameras = Array.from({ length: 30 }, (_, i) => cam(`c${i}`, { serverAnalysis: true }));
  const r = planGuardSync({ ...base, isCapturing: true, targetIds: ['c7'], cameras, wasCapturing: false });
  assert.equal(r.disable.length, 29);
  assert.ok(!r.disable.includes('c7'));
  assert.deepEqual(r.enable, []);
});

test('Stop releases every flagged camera so nothing keeps analysing in the background', () => {
  const cameras = [cam('a', { serverAnalysis: true }), cam('b', { serverAnalysis: true }), cam('other', { serverAnalysis: true }), cam('idle')];
  const r = planGuardSync({ ...base, isCapturing: false, targetIds: ['a'], cameras, guardFlaggedIds: new Set(['b']), wasCapturing: true });
  assert.deepEqual(r.disable.sort(), ['a', 'b', 'other']);
});

test('merely opening the app (not running, not just stopped) never changes a flag', () => {
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

test('analysis targets: "all" is every camera; otherwise exactly the ticked ones, and the camera in focus is not added', () => {
  const all = ['a', 'b', 'c', 'd'];
  assert.deepEqual([...analysisTargets('all', ['b'], all)].sort(), all);
  assert.deepEqual([...analysisTargets('selected', ['b'], all)], ['b']);
  assert.deepEqual([...analysisTargets('selected', [], all)], [], 'nothing ticked means nothing to analyse');
  assert.deepEqual([...analysisTargets('active', ['c'], all)], ['c']);
});
