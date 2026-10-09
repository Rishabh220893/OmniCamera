import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaLogParser, type MediaEvent } from '../server/mediaEvents.ts';
import { tailFile } from '../server/logTail.ts';

const feedAll = (lines: string[], t0 = 1_000_000) => {
  const p = createMediaLogParser();
  const out: MediaEvent[] = [];
  lines.forEach((l, i) => { const e = p.feed(l, t0 + i * 100); if (e) out.push(e); });
  return out;
};
const ts = (h: number, m: number, s: number) => new Date(2026, 9, 9, h, m, s).getTime();

test('parser: the cam14 incident (loss, then the muxer dies) is read from the log text', () => {
  const ev = feedAll([
    '2026/10/09 02:13:50 INF [path cam14] runOnDemand command started',
    '2026/10/09 02:14:06 WAR [path cam14] [RTSP source] 312 RTP packets lost',
    '2026/10/09 02:14:08 WAR [path cam14] [RTSP source] 1 RTP packet lost',
    '2026/10/09 02:14:11 ERR [HLS] [muxer cam14] unable to extract DTS: too many reordered frames (11)',
  ]);
  assert.deepEqual(ev.map((e) => [e.cameraId, e.kind, e.value ?? null]), [['cam14', 'packet_loss', 312], ['cam14', 'packet_loss', 1], ['cam14', 'dts_error', null]]);
  assert.equal(ev[2].at, ts(2, 14, 11));
});

test('parser: a 401 from the camera host is the grid limiting the account, never a camera failure', () => {
  // The exact sequence seen in a real log on 2026-10-09: ffmpeg prints its own 401 lines, then MediaMTX says the command exited.
  const ev = feedAll([
    '2026/10/09 17:53:24 ERR [path cam03] [RTSP source] bad status code: 401 (Unauthorized)',
    '[in#0 @ 00000201d4848900] method DESCRIBE failed: 401 (Unauthorized)',
    'Error opening input files: Server returned 401 Unauthorized (authorization failed)',
    '2026/10/09 17:53:28 INF [path cam28] runOnDemand command exited: command exited with code 3469724424',
  ]);
  assert.deepEqual(ev.map((e) => e.kind), ['auth_rejected', 'auth_rejected']);
});

test('parser: an ffmpeg exit with no 401 before it is a failure of the re-encode, with its exit code', () => {
  const ev = feedAll(['2026/10/09 10:00:00 INF [path cam06] runOnDemand command exited: command exited with code 1']);
  assert.deepEqual(ev.map((e) => [e.kind, e.value]), [['ffmpeg_exit', 1]]);
  // A 401 long before (more than 15 s of wall time) does not excuse a later exit.
  const p = createMediaLogParser();
  p.feed('Server returned 401 Unauthorized', 0);
  assert.equal(p.feed('2026/10/09 10:00:00 INF [path cam06] runOnDemand command exited: command exited with code 1', 60_000)?.kind, 'ffmpeg_exit');
});

test('parser: source errors and credentials are redacted; unrelated lines and other paths are ignored', () => {
  const ev = feedAll([
    '2026/10/09 10:00:00 INF [HLS] [session 153273e1] created by 127.0.0.1:55557',
    '2026/10/09 10:00:01 INF [HLS] [session 153273e1] closed: failed to authenticate: authentication failed',
    '2026/10/09 10:00:02 INF [path cam01] [RTSP source] started on demand',
    '2026/10/09 10:00:03 ERR [path cam09] [RTSP source] connection refused rtsp://user:p%40ss@103.250.160.189:8554/stream/cam09',
    '2026/10/09 10:00:04 INF MediaMTX v1.21.1, windows, amd64',
  ]);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].cameraId, ev[0].kind], ['cam09', 'source_error']);
  assert.ok(!ev[0].message.includes('p%40ss'));
  assert.match(ev[0].message, /rtsp:\/\/\*\*\*@103\.250\.160\.189/);
});

test('tail: reads only what is appended, never replays history, handles a half-written line and a replaced file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const file = join(dir, 'm.log');
  writeFileSync(file, 'old line 1\nold line 2\n');
  const got: string[] = [];
  const tail = tailFile(file, (l) => got.push(l), 3_600_000);
  try {
    await tail.poll();
    assert.deepEqual(got, [], 'history is not replayed');
    appendFileSync(file, 'new 1\nnew 2 hal');
    await tail.poll();
    assert.deepEqual(got, ['new 1'], 'a half-written last line waits');
    appendFileSync(file, 'f done\n');
    await tail.poll();
    assert.deepEqual(got, ['new 1', 'new 2 half done']);
    // Truncated / replaced (log rotation): start again from the top of the new file.
    renameSync(file, join(dir, 'm.old'));
    writeFileSync(file, 'fresh 1\n');
    await tail.poll();
    assert.deepEqual(got.slice(-1), ['fresh 1']);
    assert.equal(tail.error(), null);
    rmSync(file);
    await tail.poll();
    assert.match(tail.error() ?? '', /ENOENT|no such file/i, 'a missing file is reported, not thrown');
  } finally { tail.stop(); rmSync(dir, { recursive: true, force: true }); }
});
