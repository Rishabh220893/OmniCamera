/** Why a drawn zone might never raise anything: what the Settings screen tells the person, and the one-click fixes it offers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localWatchProblems } from '../src/lib/localWatch.ts';

const cam = (over: Record<string, unknown> = {}) => ({ serverAnalysis: true, interval: 5, useRemoteFeed: true, remoteStreamUrl: 'https://x/a.m3u8', ...over }) as never;
const ids = (c: unknown, available = true) => localWatchProblems(c as never, available).map((p) => p.id);

test('a camera that is set up properly has no problems', () => assert.deepEqual(ids(cam()), []));

test('server analysis off is named and can be switched on in one click', () => {
  const p = localWatchProblems(cam({ serverAnalysis: false }), true);
  assert.deepEqual(p.map((x) => x.id), ['server-off']);
  assert.deepEqual(p[0].fix?.patch, { serverAnalysis: true });
});

test('a slow picture interval is explained and can be set to 5 seconds in one click; 10 seconds is fine', () => {
  const p = localWatchProblems(cam({ interval: 60 }), true);
  assert.deepEqual(p.map((x) => x.id), ['slow-interval']);
  assert.match(p[0].text, /every 60 s/);
  assert.deepEqual(p[0].fix?.patch, { interval: 5 });
  assert.deepEqual(ids(cam({ interval: 10 })), []);
  assert.deepEqual(ids(cam({ interval: 11 })), ['slow-interval']);
  assert.deepEqual(ids(cam({ interval: 0 })), ['slow-interval'], 'no interval set means the 60 s default');
});

test('no stream address, or no analysis worker on the server, cannot be fixed from here and are said plainly', () => {
  assert.deepEqual(ids(cam({ remoteStreamUrl: '' })), ['no-stream']);
  assert.deepEqual(ids(cam({ useRemoteFeed: false })), ['no-stream']);
  const w = localWatchProblems(cam({ serverAnalysis: false }), false);
  assert.deepEqual(w.map((x) => x.id), ['worker-missing'], 'when the worker is missing, "turn on" would do nothing, so it is not offered');
  assert.equal(w[0].fix, undefined);
});
