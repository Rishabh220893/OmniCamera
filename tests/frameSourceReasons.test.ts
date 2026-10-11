/** A failed picture grab says why (what each way of reading the camera did), not one fixed sentence: the log must let a person tell a timeout from a refusal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { grabFrame } from '../server/frameSource.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
process.env.FRAME_RTSP_TIMEOUT_MS = '2000';
process.env.FRAME_HLS_TIMEOUT_MS = '2000';
// A dead address may refuse at once or leave ffmpeg waiting: both are named.
const WHY = '(?:exit \\d+|no picture in 2 s)';
const PREFIX = 'Could not capture a frame from the camera stream';
const base = { localBaseUrl: 'http://127.0.0.1:9', creds: { email: 'a@b.c', password: 'SuperSecret1' }, gridRtspHost: '127.0.0.1:9' };

test('a camera that cannot be reached fails with each attempt named, and the message still starts as before and never carries the password', { skip: !hasFfmpeg }, async () => {
  const rtsp = new RegExp(`^${PREFIX} \\(rtsp ${WHY}\\)$`);
  const plain = new RegExp(`^${PREFIX} \\(stream ${WHY}\\)$`);
  const grid = new RegExp(`^${PREFIX} \\(rtsp ${WHY}; hls ${WHY}\\)$`);
  await assert.rejects(grabFrame({ ...base, url: 'rtsp://127.0.0.1:9/stream' }), (e: Error) => rtsp.test(e.message) && !e.message.includes('SuperSecret1'));
  await assert.rejects(grabFrame({ ...base, url: 'http://127.0.0.1:9/live.m3u8' }), (e: Error) => plain.test(e.message));
  // A grid camera: RTSP, then the proxied HLS, both named.
  await assert.rejects(grabFrame({ ...base, url: 'https://cctv.corp8.cloud/cam07/index.m3u8' }), (e: Error) => grid.test(e.message) && !e.message.includes('SuperSecret1'));
});

test('the screen still recognises the longer message', async () => {
  const { summariseAnalysis } = await import('../src/lib/analysisStatus.ts');
  const s = summariseAnalysis({ selected: true, lastAnalysisTime: new Date(), lastAnalysisError: `${PREFIX} (rtsp no picture in 25 s; hls no picture in 30 s)` });
  assert.match(JSON.stringify(s), /No picture from this camera/);
});
