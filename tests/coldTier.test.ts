import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createS3Client, S3Error } from '../server/recording/s3.ts';
import { createS3ColdTier } from '../server/recording/coldTier.ts';
import { createRecordingStore, segmentName } from '../server/recording/store.ts';
import { createHoldStore, runRetention } from '../server/recording/retention.ts';
import { makeClip, sha256File } from '../server/recording/clip.ts';
import { startFakeS3 } from './lab/fakeS3.ts';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skipFf = haveFfmpeg ? false : 'ffmpeg is not available';
const root = mkdtempSync(path.join(tmpdir(), 'cold-'));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

const T0 = new Date('2026-10-10T10:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const DAY = 86_400_000;

function seg(dir: string, cam: string, start: Date, sec: number, mtime?: Date) {
  mkdirSync(path.join(dir, cam), { recursive: true });
  const file = path.join(dir, cam, segmentName(start, 'utc'));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${sec}:size=160x90:rate=10`, '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', file]);
  assert.equal(r.status, 0);
  const m = mtime ?? new Date(start.getTime() + sec * 1000);
  utimesSync(file, m, m);
  return file;
}

const client = (s: Awaited<ReturnType<typeof startFakeS3>>, over: Record<string, unknown> = {}) =>
  createS3Client({ endpoint: s.url, region: 'us-east-1', bucket: s.bucket, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, ...over });

// ---- the client against a server that verifies signatures ------------------------------------------------------------

test('s3 client: put, head with metadata, list with paging and folders, download, delete - all signed correctly', async () => {
  const s = await startFakeS3();
  try {
    const c = client(s, { prefix: 'rec/' });
    const f = path.join(root, 'a.bin');
    const body = Buffer.alloc(300_000, 7); body.write('hello', 0);
    writeFileSync(f, body);
    await c.put('cam 1/2026-10-10_10-00-00-000000.mp4', f, { metadata: { duration: '12.5' }, contentType: 'video/mp4' });
    assert.deepEqual([...s.objects.keys()], ['rec/cam 1/2026-10-10_10-00-00-000000.mp4']);
    const h = await c.head('cam 1/2026-10-10_10-00-00-000000.mp4');
    assert.deepEqual([h!.size, h!.metadata.duration], [300_000, '12.5']);
    assert.equal(await c.head('nope'), null);

    for (let i = 0; i < 5; i++) await c.put(`cam2/f${i}.mp4`, f);
    s.setPageSize(2);
    const l = await c.list('cam2/');
    assert.deepEqual(l.objects.map((o) => o.key), [0, 1, 2, 3, 4].map((i) => `cam2/f${i}.mp4`), 'all five across three pages, prefix stripped');
    const folders = await c.list('', { delimiter: true });
    assert.deepEqual(folders.folders.sort(), ['cam 1/', 'cam2/']);

    const dest = path.join(root, 'down.bin');
    assert.equal(await c.download('cam2/f3.mp4', dest), 300_000);
    assert.equal(createHash('sha256').update(readFileSync(dest)).digest('hex'), createHash('sha256').update(body).digest('hex'));
    await assert.rejects(c.download('missing', path.join(root, 'x.bin')), (e) => e instanceof S3Error && e.status === 404);
    assert.ok(!existsSync(path.join(root, 'x.bin')) && !readdirSync(root).some((n) => n.endsWith('.part')), 'a failed download leaves nothing behind');

    await c.remove('cam2/f3.mp4');
    await c.remove('cam2/f3.mp4'); // already gone: fine
    assert.equal(s.objects.has('rec/cam2/f3.mp4'), false);
    assert.ok(s.requests.every((r) => !r.includes('undefined')));
  } finally { await s.close(); }
});

test('s3 client: bad keys and clock skew are refused by the server, outages are errors, a big-enough upload is not read into memory at once', async () => {
  const s = await startFakeS3();
  try {
    const f = path.join(root, 'b.bin'); writeFileSync(f, 'x');
    await assert.rejects(client(s, { secretAccessKey: 'wrong' }).put('k.mp4', f), (e) => e instanceof S3Error && e.code === 'SignatureDoesNotMatch');
    await assert.rejects(client(s, { accessKeyId: 'NOPE' }).put('k.mp4', f), (e) => e instanceof S3Error && e.code === 'InvalidAccessKeyId');
    await assert.rejects(client(s, { bucket: 'other' }).list(''), (e) => e instanceof S3Error && e.code === 'NoSuchBucket');
    s.skewClockBy(3 * 3600_000);
    await assert.rejects(client(s).list(''), (e) => e instanceof S3Error && e.code === 'RequestTimeTooSkewed');
    await assert.doesNotReject(client(s, { now: () => new Date(Date.now() + 3 * 3600_000) }).list(''), 'a client with a matching (wrong) clock is accepted: only the difference matters');
    s.skewClockBy(0);
    s.failNext(1, 503);
    await assert.rejects(client(s).list(''), (e) => e instanceof S3Error && e.status === 503);
    await client(s).list('');
    const dead = await startFakeS3(); const url = dead.url; await dead.close();
    await assert.rejects(client(s, { endpoint: url }).list(''), (e) => e instanceof S3Error && e.status === 0);
    // 40 MB goes up streamed and arrives intact
    const big = path.join(root, 'big.bin'); writeFileSync(big, Buffer.alloc(40 * 1024 * 1024, 3));
    await client(s).put('big.bin', big);
    assert.equal(s.objects.get('big.bin')!.body.length, 40 * 1024 * 1024);
  } finally { await s.close(); }
});

// ---- the cold tier inside the store ----------------------------------------------------------------------------------

test('cold tier: a segment moves to the object store, the local copy goes only after the store confirms it, and the timeline still shows it', { skip: skipFf, timeout: 60_000 }, async () => {
  const s = await startFakeS3();
  const hot = path.join(root, 'c1-hot');
  try {
    const f1 = seg(hot, 'camC', at(0), 4);
    seg(hot, 'camC', at(4), 4);
    const cold = createS3ColdTier(client(s));
    const store = createRecordingStore({ hotDir: hot, cold, cacheDir: path.join(root, 'c1-cache'), now: () => at(100), nameTime: 'utc' });
    const before = await store.all('camC');
    assert.equal(before.length, 2);
    await store.moveToCold(before[0]);
    assert.equal(existsSync(f1), false, 'local copy removed');
    assert.equal(s.objects.size, 1);
    const [key, obj] = [...s.objects.entries()][0];
    assert.equal(key, `camC/${segmentName(at(0), 'utc')}`);
    assert.ok(Number(obj.meta.duration) > 3.5 && Number(obj.meta.duration) < 4.5, `duration metadata ${obj.meta.duration}`);

    const after = await store.all('camC');
    assert.deepEqual(after.map((x) => x.tier), ['cold', 'hot']);
    assert.ok(Math.abs((after[0].end!.getTime() - after[0].start.getTime()) / 1000 - 4) < 0.6, 'duration comes from the object metadata');
    assert.deepEqual(await store.cameras(), ['camC']);
    const cov = await store.coverage('camC', at(0), at(8));
    assert.equal(cov.gaps.length, 0, 'continuous across a cold and a hot segment');
    assert.equal(store.hasCold, true);

    // a failed upload keeps the local copy
    const f2 = after[1].file;
    s.failNext(5, 500);
    await assert.rejects(store.moveToCold(after[1]));
    assert.ok(existsSync(f2), 'local copy kept when the upload failed');
    s.failNext(0);
    // an upload the store does not hold completely is not trusted
    const lying = createS3ColdTier({ ...client(s), head: async () => ({ size: 1, metadata: {}, lastModified: null }) } as never);
    const s2 = createRecordingStore({ hotDir: hot, cold: lying, now: () => at(100), nameTime: 'utc' });
    await assert.rejects(s2.moveToCold((await s2.all('camC')).find((x) => x.tier === 'hot')!), /local copy was kept/);
    assert.ok(existsSync(f2));
  } finally { await s.close(); }
});

test('cold tier: a clip across cold and hot footage is cut from downloaded copies, hashes match the originals, and the cache is bounded', { skip: skipFf, timeout: 90_000 }, async () => {
  const s = await startFakeS3();
  const hot = path.join(root, 'c2-hot'), cache = path.join(root, 'c2-cache');
  try {
    const files = [seg(hot, 'camD', at(0), 4), seg(hot, 'camD', at(4), 4), seg(hot, 'camD', at(8), 4)];
    const originalHashes = await Promise.all(files.map(sha256File));
    const store = createRecordingStore({ hotDir: hot, cold: createS3ColdTier(client(s)), cacheDir: cache, cacheMaxBytes: 1, now: () => at(100), nameTime: 'utc' });
    for (const x of (await store.all('camD')).slice(0, 2)) await store.moveToCold(x);
    assert.equal(readdirSync(path.join(hot, 'camD')).length, 1, 'two segments left the disk');

    const clip = await makeClip(store, { cameraId: 'camD', from: at(1), to: at(11), outFile: path.join(root, 'c2.mp4'), maxSeconds: 60, hash: true });
    assert.equal(clip.segments.length, 3);
    assert.deepEqual(clip.segments.map((x) => x.sha256), originalHashes, 'the hashes of segments fetched from the object store equal the originals');
    const d = parseFloat(String(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', clip.file]).stdout));
    assert.ok(d > 8 && d < 11.5, `duration ${d}`);
    const cached = readdirSync(path.join(cache, 'camD'));
    assert.ok(cached.length <= 2, `cache holds ${cached.length} files`);
    const again = await makeClip(store, { cameraId: 'camD', from: at(1), to: at(11), outFile: path.join(root, 'c2c.mp4'), maxSeconds: 60 });
    assert.equal(again.segments.length, 3, 'a clip may exceed the cache bound while it is being built');
    // a second clip over the same range reuses what is cached instead of downloading again
    const gets = s.requests.filter((r) => r.startsWith('GET /recordings/camD/')).length;
    await makeClip(store, { cameraId: 'camD', from: at(4), to: at(8), outFile: path.join(root, 'c2b.mp4'), maxSeconds: 60 });
    assert.ok(s.requests.filter((r) => r.startsWith('GET /recordings/camD/')).length - gets <= 1);
  } finally { await s.close(); }
});

test('retention with a cold tier: old goes to the object store, very old is deleted from it, held footage stays where it is', { skip: skipFf, timeout: 90_000 }, async () => {
  const s = await startFakeS3();
  const hot = path.join(root, 'c3-hot'), warm = path.join(root, 'c3-warm');
  try {
    const now = new Date(T0.getTime() + 100 * DAY);
    const old = (days: number) => new Date(now.getTime() - days * DAY);
    seg(hot, 'camE', old(95), 2);   // beyond keepDays 90 -> deleted
    seg(hot, 'camE', old(60), 2);   // beyond coldDays 30 -> object store
    seg(hot, 'camE', old(45), 2);   // held -> stays
    seg(hot, 'camE', old(20), 2);   // beyond hotDays 7 -> warm
    seg(hot, 'camE', old(1), 2);    // recent -> hot
    const store = createRecordingStore({ hotDir: hot, warmDir: warm, cold: createS3ColdTier(client(s)), cacheDir: path.join(root, 'c3-cache'), now: () => now, nameTime: 'utc' });
    const holds = createHoldStore(path.join(root, 'c3-holds.json'), () => now);
    await holds.add({ cameraId: 'camE', from: new Date(old(45).getTime() - 1000), to: new Date(old(45).getTime() + 3000), reason: 'case', by: 'officer' });
    const opts = { store, policyFor: () => ({ mode: 'continuous' as const, keepDays: 90 }), holds, hotDays: 7, coldDays: 30, now: () => now };

    const dry = await runRetention({ ...opts, dryRun: true });
    assert.deepEqual([dry.deleted, dry.movedToCold, dry.moved, dry.heldKept], [1, 1, 1, 1]);
    assert.equal(s.objects.size, 0, 'dry run uploads nothing');

    const r = await runRetention(opts);
    assert.deepEqual([r.deleted, r.movedToCold, r.moved, r.heldKept, r.errors], [1, 1, 1, 1, 0]);
    const tiers = (await store.all('camE')).map((x) => x.tier);
    assert.deepEqual(tiers, ['cold', 'hot', 'warm', 'hot'], 'cold, the held one still hot, warm, recent hot');
    assert.equal(s.objects.size, 1);

    // later the cold one passes keepDays too and is deleted from the object store
    const later = await runRetention({ ...opts, now: () => new Date(now.getTime() + 40 * DAY) });
    assert.ok(later.deleted >= 1);
    assert.ok(![...s.objects.keys()].some((k) => k.includes(segmentName(old(60), 'utc'))), 'the 100-day-old segment is gone from the object store');
    const none = await runRetention({ ...opts, coldDays: undefined, store: createRecordingStore({ hotDir: hot, warmDir: warm, now: () => now, nameTime: 'utc' }) });
    assert.equal(none.movedToCold, 0, 'without an object store nothing is uploaded');
  } finally { await s.close(); }
});

test('cold tier: a store without an object store refuses to touch cold segments instead of guessing; refuses odd names', { skip: skipFf, timeout: 60_000 }, async () => {
  const hot = path.join(root, 'c4-hot');
  const store = createRecordingStore({ hotDir: hot, now: () => at(100), nameTime: 'utc' });
  const fake = { cameraId: 'camF', start: T0, end: at(4), file: 'cold://camF/x.mp4', bytes: 1, tier: 'cold' as const };
  await assert.rejects(store.remove(fake), /not configured/);
  await assert.rejects(store.materialize(fake), /not configured/);
  const s = await startFakeS3();
  try {
    const withCold = createRecordingStore({ hotDir: hot, cold: createS3ColdTier(client(s)), now: () => at(100), nameTime: 'utc' });
    await assert.rejects(withCold.remove({ ...fake, file: 'cold://camF/../../etc/passwd' }), /Refusing/);
    await assert.rejects(withCold.remove({ ...fake, cameraId: '../x', file: `cold://x/${segmentName(T0, 'utc')}` }), /Refusing/);
  } finally { await s.close(); }
});
