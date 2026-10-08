import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPaths, renderPathsYaml, urlEncode, durationMs, pathMatches, diffPaths, ffmpegCommand, type PathBuildOptions } from '../server/mediaPaths.ts';
import { decide, type Recipe } from '../server/cameraRecipe.ts';
import { credentialResolver, credentialNames } from '../server/siteSecrets.ts';
import { planMedia } from '../server/mediaPlan.ts';
import { mergeProfileFiles } from '../server/profileFiles.ts';
import { loadLocalEnv } from '../server/localEnv.ts';
import { createProfileStore, deriveFlags, PROBE_VERSION, type ProbeReport } from '../server/cameraProfile.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

const ENTRYPOINT = join(import.meta.dirname, '..', 'media-server', 'entrypoint.sh');
const HAS_SH = spawnSync('sh', ['-c', 'true']).status === 0 && spawnSync('sh', ['-c', 'printf %02X "\'a"']).status === 0;
const sh = { skip: !HAS_SH && 'sh not available' };

const opts = (over: Partial<PathBuildOptions> = {}): PathBuildOptions => ({
  site: { host: '103.250.160.189', rtspPort: 8554, pathPrefix: 'stream' },
  credentials: () => ({ user: 'me@example.com', pass: "p@ss!w0rd" }),
  transcode: { ffmpeg: 'ffmpeg', bitrate: '2500k', publishPort: 18554, scaleFilter: null },
  startTimeout: '60s', closeAfter: '5s', ...over,
});
const byId = (id: string) => GRID_REPORTS.find((r) => r.cameraId === id)!;
const item = (id: string, force?: Recipe) => ({ cameraId: id, decision: decide(byId(id), { force }) });

test('urlEncode keeps only A-Za-z0-9 . ~ _ - like the shell entrypoint', () => {
  assert.equal(urlEncode('me@example.com'), 'me%40example.com');
  assert.equal(urlEncode("p@ss!w0rd'x"), 'p%40ss%21w0rd%27x');
  assert.equal(urlEncode('a b/c'), 'a%20b%2Fc');
});

test('recipe A is a plain on-demand pull; B, C and D are an ffmpeg re-encode; F and G have no path', () => {
  const { paths, skipped } = buildPaths([item('cam01'), item('cam28'), item('cam06'), item('cam26'), item('cam22')], opts());
  assert.deepEqual(Object.keys(paths).sort(), ['cam01', 'cam06', 'cam26', 'cam28']);
  assert.deepEqual(paths.cam01, {
    source: 'rtsp://me%40example.com:p%40ss%21w0rd@103.250.160.189:8554/stream/cam01', rtspTransport: 'tcp', sourceOnDemand: true,
    sourceOnDemandStartTimeout: '60s', sourceOnDemandCloseAfter: '5s',
  });
  assert.equal(paths.cam28.runOnDemandRestart, true);
  assert.equal(paths.cam28.source, undefined);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Object.keys(buildPaths([item('cam01', 'F'), item('cam01', 'G')], opts()).paths), [], 'a forced F or G removes the path');
});

test('the ffmpeg command is the one proven on the demo PC: hardware decode of the source codec, no B-frames, 30-frame GOP', () => {
  const hevc = buildPaths([item('cam06')], opts()).paths.cam06.runOnDemand!;
  assert.equal(hevc, "ffmpeg -hide_banner -loglevel warning -hwaccel qsv -c:v hevc_qsv -rtsp_transport tcp -i rtsp://me%40example.com:p%40ss%21w0rd@103.250.160.189:8554/stream/cam06 -an -c:v h264_qsv -b:v 2500k -g 30 -bf 0 -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:18554/cam06");
  assert.match(buildPaths([item('cam28')], opts()).paths.cam28.runOnDemand!, /-c:v h264_qsv -rtsp_transport tcp -i/);
  assert.doesNotMatch(hevc, /use_wallclock_as_timestamps/);
});

test('recipe D scales down only when a scale filter has been set; none is assumed because scale_qsv failed', () => {
  assert.doesNotMatch(buildPaths([item('cam26')], opts()).paths.cam26.runOnDemand!, / -vf /);
  const cmd = buildPaths([item('cam26')], opts({ transcode: { ffmpeg: 'ffmpeg', bitrate: '2500k', publishPort: 18554, scaleFilter: 'vpp_qsv=w=1920:h=1080' } })).paths.cam26.runOnDemand!;
  assert.match(cmd, / -an -vf vpp_qsv=w=1920:h=1080 -c:v h264_qsv /);
  assert.doesNotMatch(buildPaths([item('cam06')], opts({ transcode: { ffmpeg: 'ffmpeg', bitrate: '2500k', publishPort: 18554, scaleFilter: 'x' } })).paths.cam06.runOnDemand!, / -vf /, 'only D scales');
});

test('cameras that cannot be served are skipped with the reason', () => {
  const av1 = { cameraId: 'camA', decision: { ...decide(byId('cam06')), encode: { inputCodec: 'av1', bframes: 0 as const, gopFrames: 30, maxHeight: null } } };
  const bad = { cameraId: 'cam 1; rm', decision: decide(byId('cam01')) };
  const r = buildPaths([av1, bad], opts());
  assert.deepEqual(r.paths, {});
  assert.match(r.skipped.find((s) => s.cameraId === 'camA')!.why, /no hardware decoder for av1/);
  assert.match(r.skipped.find((s) => s.cameraId === 'cam 1; rm')!.why, /letters, digits/);
  assert.equal(ffmpegCommand('cam06', 'hevc', null, 30, opts()).includes('rtsp://127.0.0.1:18554/cam06'), true);
});

test('the YAML matches what media-server/entrypoint.sh writes for the same cameras today', sh, () => {
  const dir = mkdtempSync(join(tmpdir(), 'paths-'));
  const config = join(dir, 'm.yml');
  const env = {
    PATH: process.env.PATH ?? '', MEDIAMTX_BIN: 'true', MEDIAMTX_CONFIG: config, GRID_EMAIL: 'me@example.com', GRID_PASSWORD: 'p@ss!w0rd',
    MEDIA_VIEWER_PASSWORD: 'abc123', CAMERA_IDS: 'cam01,cam06,cam28', MEDIA_TRANSCODE_IDS: 'cam06,cam28:h264',
  };
  assert.equal(spawnSync('sh', [ENTRYPOINT], { env, encoding: 'utf8' }).status, 0);
  const legacy = readFileSync(config, 'utf8').split('\npaths:\n')[1];
  const mine = renderPathsYaml(buildPaths([item('cam01'), item('cam06'), item('cam28')], opts()).paths);
  assert.equal(mine, legacy);
});

test('entrypoint with MEDIA_PATHS_FILE: the generated paths replace the camera loop, and re-encoded cameras can publish locally', sh, () => {
  const dir = mkdtempSync(join(tmpdir(), 'paths-'));
  const file = join(dir, 'paths.yml'), config = join(dir, 'm.yml');
  const yml = renderPathsYaml(buildPaths([item('cam01'), item('cam06')], opts()).paths);
  writeFileSync(file, '# generated\n' + yml);
  const base = { PATH: process.env.PATH ?? '', MEDIAMTX_BIN: 'true', MEDIAMTX_CONFIG: config, GRID_EMAIL: 'x@y.z', GRID_PASSWORD: 'pw', MEDIA_VIEWER_PASSWORD: 'abc123' };
  const r = spawnSync('sh', [ENTRYPOINT], { env: { ...base, MEDIA_PATHS_FILE: file }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(config, 'utf8');
  assert.equal(out.split('\npaths:\n')[1], '# generated\n' + yml, 'the file is used as it is');
  assert.deepEqual(out.match(/^ {2}cam\d+:/gm), ['  cam01:', '  cam06:'], 'not the default 30 cameras');
  assert.match(out, /^rtsp: yes\nrtspAddress: 127\.0\.0\.1:18554/m);
  assert.match(out, /user: any[\s\S]*ips: \['127\.0\.0\.1', '::1'\][\s\S]*action: publish\n/);
  assert.match(r.stdout, /2 paths from /);
  const both = spawnSync('sh', [ENTRYPOINT], { env: { ...base, MEDIA_PATHS_FILE: file, MEDIA_TRANSCODE_IDS: 'cam06' }, encoding: 'utf8' });
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /not both/);
  const missing = spawnSync('sh', [ENTRYPOINT], { env: { ...base, MEDIA_PATHS_FILE: join(dir, 'nope.yml') }, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not exist/);
});

test('durations compare by value, so "1m0s" from the server equals our "60s"', () => {
  assert.equal(durationMs('60s'), 60_000);
  assert.equal(durationMs('1m0s'), 60_000);
  assert.equal(durationMs('500ms'), 500);
  assert.equal(durationMs('1h2m3s'), 3_723_000);
  assert.equal(durationMs(''), null);
  assert.equal(durationMs('soon'), null);
});

test('pathMatches: ignores defaults the server adds, but notices a path that pulls when it should re-encode', () => {
  const want = buildPaths([item('cam01')], opts()).paths.cam01;
  const served = { name: 'cam01', ...want, sourceOnDemandStartTimeout: '1m0s', sourceOnDemandCloseAfter: '5s', maxReaders: 0, record: false, runOnDemand: '', runOnDemandRestart: false };
  assert.equal(pathMatches(served, want), true);
  assert.equal(pathMatches({ ...served, source: 'rtsp://other' }, want), false);
  assert.equal(pathMatches({ ...served, sourceOnDemandStartTimeout: '10s' }, want), false);
  const re = buildPaths([item('cam28')], opts()).paths.cam28;
  assert.equal(pathMatches({ name: 'cam28', ...served }, re), false, 'a pull path is not a re-encode path');
  assert.equal(pathMatches({ name: 'cam28', ...re, source: '', sourceOnDemand: false, runOnDemandStartTimeout: '1m0s', runOnDemandCloseAfter: '5s' }, re), true);
  assert.equal(pathMatches({ name: 'cam28', ...re, source: 'rtsp://still-pulling' }, re), false, 'a leftover source from the old recipe');
});

test('pathMatches: a re-encode path as the real MediaMTX 1.21.1 reports it (source "publisher") is unchanged', () => {
  const re = buildPaths([item('cam28')], opts()).paths.cam28;
  const realAnswer = {
    name: 'cam28', source: 'publisher', sourceOnDemand: false, sourceOnDemandStartTimeout: '10s', sourceOnDemandCloseAfter: '10s', rtspTransport: 'automatic',
    runOnDemand: re.runOnDemand, runOnDemandRestart: true, runOnDemandStartTimeout: '1m0s', runOnDemandCloseAfter: '5s',
  };
  assert.equal(pathMatches(realAnswer, re), true);
  assert.equal(pathMatches({ ...realAnswer, runOnDemandRestart: false }, re), false);
  const pull = buildPaths([item('cam01')], opts()).paths.cam01;
  assert.equal(pathMatches(realAnswer, pull), false, 'a re-encode path is not a pull path');
});

test('diffPaths: add, replace, remove and leave alone; paths it does not manage are never removed', () => {
  const want = buildPaths([item('cam01'), item('cam06'), item('cam28')], opts()).paths;
  const current = [
    { name: 'all_others', source: 'publisher' },
    { name: 'cam01', ...want.cam01 },
    { name: 'cam06', source: 'rtsp://x', sourceOnDemand: true },
    { name: 'cam22', source: 'rtsp://y', sourceOnDemand: true },
    { name: 'cam99', source: 'rtsp://z' },
  ];
  const d = diffPaths(current, want, ['cam01', 'cam06', 'cam22', 'cam28']);
  assert.deepEqual(d, { add: ['cam28'], replace: ['cam06'], remove: ['cam22'], unchanged: ['cam01'] });
});

test('site secrets: one login per site, an optional login for one camera, and a clear error when none is set', () => {
  assert.deepEqual(credentialNames('grid'), { user: 'GRID_EMAIL', pass: 'GRID_PASSWORD' });
  assert.deepEqual(credentialNames('north-gate', 'cam07'), { user: 'NORTH_GATE_CAM07_EMAIL', pass: 'NORTH_GATE_CAM07_PASSWORD' });
  const get = credentialResolver('grid', { GRID_EMAIL: 'a', GRID_PASSWORD: 'b', GRID_CAM07_EMAIL: 'c', GRID_CAM07_PASSWORD: 'd' });
  assert.deepEqual(get('cam01'), { user: 'a', pass: 'b' });
  assert.deepEqual(get('cam07'), { user: 'c', pass: 'd' });
  assert.deepEqual(credentialResolver('grid', { STREAM_EMAIL: 's', STREAM_PASSWORD: 't' })('cam01'), { user: 's', pass: 't' }, 'the grid also accepts the app\'s STREAM_* names');
  assert.throws(() => credentialResolver('other', { STREAM_EMAIL: 's', STREAM_PASSWORD: 't' })('cam01'), /set OTHER_EMAIL and OTHER_PASSWORD/);
  assert.throws(() => credentialResolver('grid', { GRID_EMAIL: 'a' })('cam01'), /No login for site 'grid'/);
});

test('planMedia: profiles and overrides in, paths out; an override changes the path and the reason says so', () => {
  const rows = GRID_REPORTS.map((report) => ({ report, override: report.cameraId === 'cam01' ? 'B' : report.cameraId === 'cam06' ? 'F' : null, overrideReason: null }));
  const p = planMedia(rows, { encoder: 'qsv', build: opts() });
  assert.ok(p.paths.cam01.runOnDemand, 'forced to B: now a re-encode');
  assert.equal(p.paths.cam06, undefined, 'forced to F: no path');
  assert.equal(p.managed.length, 30);
  assert.match(p.decisions.find((d) => d.cameraId === 'cam01')!.decision.reason, /Manual override to B/);
  assert.equal(planMedia(rows, { encoder: 'none', build: opts() }).paths.cam28, undefined, 'no encoder: no re-encode path');
});

test('profile files merge, and loadLocalEnv lets scale.local win over demo.local and the shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prof-'));
  const rep = (id: string, failure: ProbeReport['failure']): ProbeReport => ({ ...GRID_REPORTS[0], cameraId: id, failure, flags: deriveFlags(null, null), probeVersion: PROBE_VERSION });
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ reports: [rep('cam01', null), rep('cam02', 'no_frame')] }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ reports: [rep('cam01', 'bad_credentials'), rep('cam02', null), rep('cam03', null)] }));
  const merged = mergeProfileFiles([join(dir, 'a.json'), join(dir, 'b.json')]);
  assert.deepEqual(merged.map((r) => [r.cameraId, r.failure]), [['cam01', null], ['cam02', null], ['cam03', null]], 'a later failure never replaces a good result');
  writeFileSync(join(dir, 'demo.local'), 'GRID_EMAIL=demo\nGRID_PASSWORD="dpw"\r\n');
  writeFileSync(join(dir, 'scale.local'), 'GRID_EMAIL=scale\n');
  const env = loadLocalEnv([join(dir, 'demo.local'), join(dir, 'scale.local'), join(dir, 'missing.local')], { GRID_EMAIL: 'shell', OTHER: 'x' });
  assert.deepEqual([env.GRID_EMAIL, env.GRID_PASSWORD, env.OTHER], ['scale', 'dpw', 'x']);
});

test('store: list profiles with overrides, save the decision, set and clear an override (with a reason)', async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const store = createProfileStore({
    query: async (text, params) => {
      calls.push({ text, params });
      return /SELECT profile/.test(text) ? { rows: [{ profile: GRID_REPORTS[0], recipe_override: 'B', override_reason: 'cam damaged on 10-08' }] } : { rows: [] };
    },
  });
  const rows = await store.listProfiles('grid');
  assert.deepEqual(rows.map((r) => [r.report.cameraId, r.override, r.overrideReason]), [['cam01', 'B', 'cam damaged on 10-08']]);
  await store.saveDecision('grid', 'cam01', { recipe: 'A', reason: 'clean' });
  assert.match(calls.at(-1)!.text, /SET recipe = \$3, recipe_reason = \$4, decision = \$5/);
  await store.setOverride('grid', 'cam01', 'C', 'forced for the demo');
  assert.deepEqual(calls.at(-1)!.params, ['grid', 'cam01', 'C', 'forced for the demo']);
  await store.setOverride('grid', 'cam01', null, null);
  assert.deepEqual(calls.at(-1)!.params, ['grid', 'cam01', null, null]);
  await assert.rejects(store.setOverride('grid', 'cam01', 'Z', 'x'), /Unknown recipe/);
  await assert.rejects(store.setOverride('grid', 'cam01', 'B', '  '), /needs a reason/);
});
