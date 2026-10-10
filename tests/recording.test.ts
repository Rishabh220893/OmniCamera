import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PolicyError, parsePolicy, recordFields } from '../server/recording/policy.ts';
import { createRecordingStore, parseSegmentName, segmentName as segName } from '../server/recording/store.ts';
import { createHoldStore, createPolicyStore, runRetention } from '../server/recording/retention.ts';
import { ClipError, makeClip, sha256File } from '../server/recording/clip.ts';
import { buildPaths, renderPathsYaml, pathMatches, type PathBuildOptions } from '../server/mediaPaths.ts';
import type { Decision } from '../server/cameraRecipe.ts';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skipFf = haveFfmpeg ? false : 'ffmpeg is not available';
const root = mkdtempSync(path.join(tmpdir(), 'rec-test-'));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

const segmentName = (d: Date) => segName(d, 'utc');
const U = { nameTime: 'utc' as const };
const T0 = new Date('2026-10-10T10:00:00.000Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

/** A real, finished MP4 of `sec` seconds (160x90, 10 fps, a keyframe every second) named for its start time. */
function makeSegment(dir: string, cam: string, start: Date, sec: number, mtime?: Date): string {
  mkdirSync(path.join(dir, cam), { recursive: true });
  const file = path.join(dir, cam, segmentName(start));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${sec}:size=160x90:rate=10`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', file]);
  assert.equal(r.status, 0, String(r.stderr));
  const m = mtime ?? new Date(start.getTime() + sec * 1000);
  utimesSync(file, m, m);
  return file;
}

// ---- policy and names ------------------------------------------------------------------------------------------------------

test('policy: only valid modes and day counts', () => {
  assert.deepEqual(parsePolicy({ mode: 'continuous' }), { mode: 'continuous', keepDays: 7 });
  assert.deepEqual(parsePolicy({ mode: 'off', keepDays: '30' }), { mode: 'off', keepDays: 30 });
  for (const bad of [null, {}, { mode: 'event' }, { mode: 'continuous', keepDays: 0 }, { mode: 'continuous', keepDays: 1.5 }, { mode: 'continuous', keepDays: 99999 }, { mode: 'continuous', keepDays: 'x' }]) {
    assert.throws(() => parsePolicy(bad), PolicyError, JSON.stringify(bad));
  }
});

test('segment names round-trip to the microsecond in either clock; anything else is not a segment', () => {
  const d = new Date('2026-10-10T10:20:30.123Z');
  assert.equal(segmentName(d), '2026-10-10_10-20-30-123000.mp4');
  assert.equal(parseSegmentName(segmentName(d), 'utc')?.getTime(), d.getTime());
  assert.equal(parseSegmentName(segName(d, 'local'))?.getTime(), d.getTime(), 'local clock round-trips on this machine');
  for (const n of ['x.mp4', '2026-10-10_10-20-30.mp4', '2026-13-10_10-20-30-000000.mp4', '2026-02-31_10-20-30-000000.mp4', '2026-10-10_10-20-30-123000.mp4.part', '../2026-10-10_10-20-30-123000.mp4']) {
    assert.equal(parseSegmentName(n, 'utc'), null, n);
    assert.equal(parseSegmentName(n), null, n);
  }
});

// ---- MediaMTX configuration ------------------------------------------------------------------------------------------------

const DEC_A = { recipe: 'A', transcode: false, encode: null } as unknown as Decision;
const DEC_B = { recipe: 'B', transcode: true, encode: { inputCodec: 'hevc', maxHeight: null, gopFrames: 50 } } as unknown as Decision;
const build = (rec: PathBuildOptions['recording']): PathBuildOptions => ({
  site: { host: 'h', rtspPort: 8554, pathPrefix: 'p' }, credentials: () => ({ user: 'u', pass: 'p' }),
  transcode: { ffmpeg: 'ffmpeg', bitrate: '1M', publishPort: 8555, scaleFilter: null }, startTimeout: '30s', closeAfter: '10s', recording: rec,
});

test('media config: a recorded plain pull is always on and records; others are unchanged; a re-encode is reported, not recorded', () => {
  const rec = { dir: 'C:\\rec\\', policy: (id: string) => (id === 'off1' ? { mode: 'off' as const, keepDays: 7 } : { mode: 'continuous' as const, keepDays: 7 }) };
  const plan = buildPaths([{ cameraId: 'cam1', decision: DEC_A }, { cameraId: 'off1', decision: DEC_A }, { cameraId: 'enc1', decision: DEC_B }], build(rec));
  assert.equal(plan.paths.cam1.sourceOnDemand, undefined, 'a recorded camera is not pulled on demand');
  assert.deepEqual([plan.paths.cam1.record, plan.paths.cam1.recordPath, plan.paths.cam1.recordFormat, plan.paths.cam1.recordDeleteAfter], [true, 'C:/rec/%path/%Y-%m-%d_%H-%M-%S-%f', 'fmp4', '0s']);
  assert.equal(plan.paths.off1.sourceOnDemand, true);
  assert.equal(plan.paths.off1.record, undefined);
  assert.equal(plan.paths.enc1.record, undefined);
  assert.deepEqual(plan.notRecorded.map((n) => n.cameraId), ['enc1']);
  const yaml = renderPathsYaml(plan.paths);
  assert.match(yaml, /  cam1:\n    source: rtsp:\/\/u:p@h:8554\/p\/cam1\n    rtspTransport: tcp\n    record: yes\n    recordPath: 'C:\/rec\/%path\/%Y-%m-%d_%H-%M-%S-%f'\n    recordFormat: fmp4\n    recordPartDuration: 1s\n    recordSegmentDuration: 600s\n    recordDeleteAfter: 0s\n/);
  assert.ok(!/cam1:[^]*sourceOnDemand[^]*off1:/.test(yaml), 'no on-demand line under cam1');
  // without a recording option nothing changes
  assert.equal(buildPaths([{ cameraId: 'cam1', decision: DEC_A }], build(undefined)).paths.cam1.sourceOnDemand, true);
});

test('media config: a running path that is not recording yet no longer "matches", and one that is does (durations as MediaMTX prints them)', () => {
  const want = buildPaths([{ cameraId: 'cam1', decision: DEC_A }], build({ dir: '/rec', policy: () => ({ mode: 'continuous', keepDays: 7 }) })).paths.cam1;
  const running = { source: want.source, rtspTransport: 'tcp', sourceOnDemand: false, record: true, recordPath: want.recordPath, recordFormat: 'fmp4', recordPartDuration: '1s', recordSegmentDuration: '10m0s', recordDeleteAfter: '0s' };
  assert.equal(pathMatches(running, want), true);
  assert.equal(pathMatches({ ...running, record: false }, want), false);
  assert.equal(pathMatches({ ...running, recordSegmentDuration: '1h0m0s' }, want), false);
  const wantLive = buildPaths([{ cameraId: 'cam1', decision: DEC_A }], build(undefined)).paths.cam1;
  assert.equal(pathMatches({ source: wantLive.source, rtspTransport: 'tcp', sourceOnDemand: true, sourceOnDemandStartTimeout: '30s', sourceOnDemandCloseAfter: '10s', record: true }, wantLive), false, 'a path still recording after its policy was switched off is replaced');
});

// ---- the index -----------------------------------------------------------------------------------------------------------

test('store: real files give start, true duration, coverage and gaps; the segment being written is open; junk is ignored', { skip: skipFf }, async () => {
  const hot = path.join(root, 'idx');
  makeSegment(hot, 'cam1', at(0), 4);
  makeSegment(hot, 'cam1', at(4), 4);          // continuous with the first
  makeSegment(hot, 'cam1', at(20), 4);         // 12 s hole before it
  const openFile = makeSegment(hot, 'cam1', at(30), 2, new Date(T0.getTime() + 31_900));
  writeFileSync(path.join(hot, 'cam1', 'notes.txt'), 'x');
  writeFileSync(path.join(hot, 'cam1', 'garbage.mp4'), 'x');
  mkdirSync(path.join(hot, 'bad name'), { recursive: true });
  const store = createRecordingStore({ hotDir: hot, now: () => at(32), openWithinMs: 3000, ...U });

  assert.deepEqual(await store.cameras(), ['cam1']);
  const segs = await store.all('cam1');
  assert.equal(segs.length, 4);
  assert.deepEqual(segs.map((s) => Math.round(((s.end ?? at(32)).getTime() - s.start.getTime()) / 1000)), [4, 4, 4, 2]);
  assert.equal(segs[3].end, null, 'written to a moment ago: still open');
  assert.equal(segs[3].file, openFile);

  const cov = await store.coverage('cam1', at(0), at(28));
  assert.deepEqual(cov.gaps.map((g) => [(g.from.getTime() - T0.getTime()) / 1000, (g.to.getTime() - T0.getTime()) / 1000]), [[8, 20], [24, 28]], 'the hole, then the time after the last segment');
  assert.ok(Math.abs(cov.recordedMs - 12_000) < 400, `recorded ${cov.recordedMs}`);
  assert.equal((await store.segments('cam1', at(5), at(6))).length, 1, 'a window inside one segment');
  assert.equal((await store.segments('cam1', at(9), at(19))).length, 0);
  assert.deepEqual(await store.all('../etc'), []);
  assert.deepEqual(await store.all('nobody'), []);
  const u = await store.usage();
  assert.equal(u.cameras[0].segments, 4);
  assert.ok(u.totalBytes > 0 && u.freeBytes.hot !== null);
});

// ---- clips --------------------------------------------------------------------------------------------------------------

function probe(file: string): { duration: number; frames: number } {
  const d = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const f = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file]);
  return { duration: parseFloat(String(d.stdout)), frames: parseInt(String(f.stdout), 10) };
}

test('clip: joins consecutive segments into one playable file, copy-cut at a keyframe, with hashes and honest gaps', { skip: skipFf, timeout: 60_000 }, async () => {
  const hot = path.join(root, 'clip');
  makeSegment(hot, 'camA', at(0), 4);
  makeSegment(hot, 'camA', at(4), 4);
  makeSegment(hot, 'camA', at(12), 4); // hole 8..12
  const store = createRecordingStore({ hotDir: hot, now: () => at(100), ...U });
  const out = path.join(root, 'out', 'a.mp4');

  const c = await makeClip(store, { cameraId: 'camA', from: at(2), to: at(6), outFile: out, maxSeconds: 600, hash: true });
  const p = probe(out);
  assert.ok(Math.abs(p.duration - 4) < 1.2, `duration ${p.duration}`);
  assert.ok(p.frames >= 35 && p.frames <= 50, `frames ${p.frames}`);
  assert.equal(c.segments.length, 2);
  assert.equal(c.sha256, await sha256File(out));
  assert.ok(c.segments.every((s) => /^[0-9a-f]{64}$/.test(s.sha256!)));
  assert.equal(c.gaps.length, 0);
  assert.equal(readdirSync(path.dirname(out)).filter((n) => n.includes('list') || n.includes('part')).length, 0, 'no temporary files left');

  const spanning = await makeClip(store, { cameraId: 'camA', from: at(0), to: at(16), outFile: path.join(root, 'out', 'b.mp4'), maxSeconds: 600 });
  assert.deepEqual(spanning.gaps.map((g) => [(Date.parse(g.from) - T0.getTime()) / 1000, (Date.parse(g.to) - T0.getTime()) / 1000]), [[8, 12]], 'the hole is reported, not hidden');

  await assert.rejects(makeClip(store, { cameraId: 'camA', from: at(40), to: at(50), outFile: path.join(root, 'out', 'c.mp4'), maxSeconds: 600 }), (e) => e instanceof ClipError && e.code === 'no_footage');
  await assert.rejects(makeClip(store, { cameraId: 'camA', from: at(0), to: at(5000), outFile: path.join(root, 'out', 'd.mp4'), maxSeconds: 600 }), (e) => e instanceof ClipError && e.code === 'too_long');
  await assert.rejects(makeClip(store, { cameraId: 'camA', from: at(5), to: at(5), outFile: path.join(root, 'out', 'e.mp4'), maxSeconds: 600 }), (e) => e instanceof ClipError && e.code === 'bad_range');
  assert.ok(!existsSyncSafe(path.join(root, 'out', 'c.mp4')), 'a failed clip leaves no file');
});

const existsSyncSafe = (f: string) => existsSync(f);

test('clip: a path with a quote and spaces in it still works', { skip: skipFf, timeout: 60_000 }, async () => {
  const hot = path.join(root, "it's a dir");
  makeSegment(hot, 'camQ', at(0), 3);
  const store = createRecordingStore({ hotDir: hot, now: () => at(100), ...U });
  const c = await makeClip(store, { cameraId: 'camQ', from: at(0), to: at(3), outFile: path.join(root, 'out', 'q.mp4'), maxSeconds: 60 });
  assert.ok(Math.abs(probe(c.file).duration - 3) < 1);
});

// ---- retention, tiers and holds --------------------------------------------------------------------------------------------

test('retention: old segments move to the warm tier then are deleted; holds, open and recent segments are never touched; dry run changes nothing', { skip: skipFf, timeout: 60_000 }, async () => {
  const hot = path.join(root, 'ret-hot'), warm = path.join(root, 'ret-warm');
  const day = 86_400_000;
  const now = new Date(T0.getTime() + 40 * day);
  const seg = (ageDays: number) => new Date(now.getTime() - ageDays * day);
  makeSegment(hot, 'camR', seg(40), 2);   // beyond keepDays 30 -> delete
  makeSegment(hot, 'camR', seg(35), 2);   // beyond keepDays, but held -> kept
  makeSegment(hot, 'camR', seg(10), 2);   // older than hotDays 7 -> warm
  makeSegment(hot, 'camR', seg(1), 2);    // recent -> stays
  makeSegment(hot, 'camR', new Date(now.getTime() - 5000), 2, new Date(now.getTime() - 1000)); // still being written
  const store = createRecordingStore({ hotDir: hot, warmDir: warm, now: () => now, ...U });
  const holds = createHoldStore(path.join(root, 'holds.json'), () => now);
  const hold = await holds.add({ cameraId: 'camR', from: new Date(seg(35).getTime() - 1000), to: new Date(seg(35).getTime() + 5000), reason: 'case 12', by: 'officer' });
  const opts = { store, policyFor: () => ({ mode: 'continuous' as const, keepDays: 30 }), holds, hotDays: 7, now: () => now };

  const dry = await runRetention({ ...opts, dryRun: true });
  assert.deepEqual([dry.deleted, dry.moved, dry.heldKept, dry.openKept, dry.dryRun], [1, 1, 1, 1, true]);
  assert.equal((await store.all('camR')).length, 5, 'dry run touched nothing');

  const real = await runRetention(opts);
  assert.deepEqual([real.deleted, real.moved, real.heldKept, real.errors], [1, 1, 1, 0]);
  assert.ok(real.freedBytes > 0);
  const after = await store.all('camR');
  assert.equal(after.length, 4);
  assert.deepEqual(after.map((s) => s.tier), ['hot', 'warm', 'hot', 'hot'], 'the held one stays hot; the 10-day one is warm; both timelines are read together');

  // releasing the hold lets the next run delete it
  assert.ok(await holds.release(hold.id, 'officer'));
  assert.equal(await holds.release(hold.id, 'officer'), null, 'already released');
  const later = await runRetention(opts);
  assert.equal(later.deleted, 1);
  assert.equal((await store.all('camR')).length, 3);
  assert.equal((await holds.list('camR')).length, 0);
  assert.equal((await holds.list('camR', true)).length, 1, 'the released hold stays on record');
});

test('retention: the delete is refused for anything that is not a recorded segment under the recordings folder', async () => {
  const store = createRecordingStore({ hotDir: path.join(root, 'safe'), ...U });
  const victim = path.join(root, 'victim.mp4');
  writeFileSync(victim, 'keep me');
  await assert.rejects(store.remove({ cameraId: 'x', start: T0, end: T0, file: victim, bytes: 1, tier: 'hot' }), /not a recorded segment/);
  await assert.rejects(store.remove({ cameraId: 'x', start: T0, end: T0, file: path.join(root, 'safe', '..', segmentName(T0)), bytes: 1, tier: 'hot' }), /not a recorded segment/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep me');
});

test('policy store: survives a restart, applies the default, and concurrent changes do not lose each other', async () => {
  const file = path.join(root, 'policy.json');
  const a = createPolicyStore(file);
  await a.load();
  assert.equal(a.forCamera('c1').mode, 'off', 'nothing is recorded unless asked');
  await Promise.all(Array.from({ length: 20 }, (_, i) => a.setCamera(`cam${i}`, { mode: 'continuous', keepDays: i + 1 })));
  await a.setDefault({ mode: 'continuous', keepDays: 3 });
  const b = createPolicyStore(file);
  await b.load();
  assert.deepEqual([b.forCamera('cam7'), b.forCamera('unknown')], [{ mode: 'continuous', keepDays: 8 }, { mode: 'continuous', keepDays: 3 }]);
  assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).cameras).length, 20);
  await b.clearCamera('cam7');
  assert.equal(b.forCamera('cam7').keepDays, 3);
});

// ---- the real recorder -----------------------------------------------------------------------------------------------------

const MEDIAMTX = path.resolve('media-server/bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const haveMtx = existsSync(MEDIAMTX) && haveFfmpeg;
const skipMtx = haveMtx ? false : 'MediaMTX or ffmpeg is not available';
let mtx: ChildProcess | null = null, pub: ChildProcess | null = null;
const freePort = () => new Promise<number>((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); s.on('error', reject); });
after(() => { for (const p of [pub, mtx]) { try { p?.kill('SIGKILL'); } catch { /* gone */ } } });

test('real MediaMTX: the generated recording settings produce segments the index reads back with the right start time, duration and a playable clip', { skip: skipMtx, timeout: 120_000 }, async () => {
  const dir = path.join(root, 'mtx'); mkdirSync(dir, { recursive: true });
  const recDir = path.join(dir, 'recordings');
  const port = await freePort();
  const fields = { ...recordFields(recDir), recordSegmentDuration: '4s' };
  writeFileSync(path.join(dir, 'mediamtx.yml'), `logLevel: error
api: false
metrics: false
pprof: false
playback: false
rtmp: false
hls: false
webrtc: false
srt: false
moq: false
rtsp: true
rtspTransports: [tcp]
rtspAddress: 127.0.0.1:${port}
authInternalUsers:
  - user: any
    pass: ''
    ips: []
    permissions: [{ action: publish }, { action: read }]
paths:
  recCam:
    record: yes
    recordPath: '${fields.recordPath}'
    recordFormat: ${fields.recordFormat}
    recordPartDuration: ${fields.recordPartDuration}
    recordSegmentDuration: ${fields.recordSegmentDuration}
    recordDeleteAfter: ${fields.recordDeleteAfter}
`);
  mtx = spawn(MEDIAMTX, [path.join(dir, 'mediamtx.yml')], { cwd: dir, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(mtx.exitCode, null, 'MediaMTX started with the generated recording settings');
  const started = new Date();
  pub = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '14', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${port}/recCam`], { stdio: 'ignore' });
  await new Promise((r) => pub!.on('close', r));
  await new Promise((r) => setTimeout(r, 2500));
  const finished = new Date();

  const store = createRecordingStore({ hotDir: recDir, openWithinMs: 1500 });
  const segs = await store.all('recCam');
  assert.ok(segs.length >= 3, `segments: ${segs.length}`);
  for (const s of segs) {
    assert.ok(s.start.getTime() >= started.getTime() - 2000 && s.start.getTime() <= finished.getTime(), `start ${s.start.toISOString()} outside ${started.toISOString()}..${finished.toISOString()} (the name is the media server's local time)`);
    assert.ok(s.end !== null && s.end > s.start);
  }
  const total = segs.reduce((n, s) => n + (s.end!.getTime() - s.start.getTime()), 0) / 1000;
  assert.ok(total > 10 && total < 17, `recorded ${total}s of a 14s stream`);

  const mid = new Date(segs[0].start.getTime() + 1500);
  const clip = await makeClip(store, { cameraId: 'recCam', from: mid, to: new Date(mid.getTime() + 7000), outFile: path.join(dir, 'clip.mp4'), maxSeconds: 60, hash: true });
  const p = probe(clip.file);
  assert.ok(p.duration > 5 && p.duration < 9, `clip duration ${p.duration}`);
  assert.ok(p.frames > 50, `frames ${p.frames}`);
  assert.ok(clip.segments.length >= 2);
});
