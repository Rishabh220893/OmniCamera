/** The last full-screen frame of a camera, for its tile in Feed > Full Panel: stored only when told to, announced to listeners, bounded. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FRAMES, clearLastFrame, getLastFrame, lastFramesVersion, setLastFrame, subscribeLastFrames } from '../src/lib/lastFrame.ts';

const img = (n: number) => `data:image/jpeg;base64,${'A'.repeat(300)}${n}`;

test('a frame is stored per camera, replaces the previous one, and listeners hear about it', () => {
  let heard = 0;
  const off = subscribeLastFrames(() => { heard++; });
  const v0 = lastFramesVersion();
  assert.equal(getLastFrame('camA'), undefined, 'nothing until a window has been closed');
  assert.equal(setLastFrame('camA', img(1), 1000), true);
  assert.equal(getLastFrame('camA')?.dataUrl, img(1));
  assert.equal(getLastFrame('camA')?.at, 1000);
  assert.equal(getLastFrame('camB'), undefined, 'another camera is not touched');
  setLastFrame('camA', img(2), 2000);
  assert.equal(getLastFrame('camA')?.dataUrl, img(2), 'the newest frame wins');
  assert.equal(heard, 2);
  assert.equal(lastFramesVersion(), v0 + 2);
  off();
  setLastFrame('camA', img(3));
  assert.equal(heard, 2, 'an unsubscribed listener is not called');
  clearLastFrame('camA');
  assert.equal(getLastFrame('camA'), undefined);
});

test('things that are not pictures are refused and change nothing', () => {
  const v = lastFramesVersion();
  assert.equal(setLastFrame('x', 'hello'), false);
  assert.equal(setLastFrame('x', 'data:text/html;base64,AAAA' + 'A'.repeat(300)), false);
  assert.equal(setLastFrame('x', 'data:image/jpeg;base64,AA'), false, 'too small to be a real frame');
  assert.equal(setLastFrame('', img(1)), false);
  assert.equal(getLastFrame('x'), undefined);
  assert.equal(lastFramesVersion(), v);
});

test(`only the newest ${MAX_FRAMES} cameras are kept`, () => {
  for (let i = 0; i < MAX_FRAMES + 5; i++) setLastFrame(`bulk${i}`, img(i), 10_000 + i);
  assert.equal(getLastFrame('bulk0'), undefined, 'the oldest were dropped');
  assert.equal(getLastFrame('bulk4'), undefined);
  assert.notEqual(getLastFrame('bulk5'), undefined);
  assert.notEqual(getLastFrame(`bulk${MAX_FRAMES + 4}`), undefined);
  for (let i = 0; i < MAX_FRAMES + 5; i++) clearLastFrame(`bulk${i}`);
});
