import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(import.meta.dirname, '..', 'media-server', 'entrypoint.sh');
const HAS_SH = spawnSync('sh', ['-c', 'true']).status === 0 && spawnSync('sh', ['-c', 'printf %02X "\'a"']).status === 0;

/** Runs the entrypoint with a stand-in for MediaMTX (`true`), so only the config it writes is checked. */
function run(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const config = join(dir, 'mediamtx.yml');
  const res = spawnSync('sh', [ENTRYPOINT], {
    env: { PATH: process.env.PATH ?? '', MEDIAMTX_BIN: 'true', MEDIAMTX_CONFIG: config, ...env },
    encoding: 'utf8',
  });
  let yml = '';
  try { yml = readFileSync(config, 'utf8'); } catch { /* not written on refusal */ }
  return { status: res.status, stderr: res.stderr, yml };
}
const base = { GRID_EMAIL: 'me@example.com', GRID_PASSWORD: 'p@ss!w0rd', MEDIA_VIEWER_PASSWORD: 'abc123' };

test('entrypoint: one on-demand path per camera, credentials percent-encoded', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run({ ...base, CAMERA_IDS: 'cam01,cam02' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.yml.match(/^ {2}cam\d+:/gm) ?? []).length, 2);
  assert.match(r.yml, /source: rtsp:\/\/me%40example\.com:p%40ss%21w0rd@103\.250\.160\.189:8554\/stream\/cam01/);
  assert.equal((r.yml.match(/sourceOnDemand: yes/g) ?? []).length, 2);
});

test('entrypoint: defaults to cam01..cam30', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run(base);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.yml.match(/^ {2}cam\d+:/gm) ?? []).length, 30);
  assert.match(r.yml, /^ {2}cam30:/m);
});

test("entrypoint: the '*' origin is written literally, never expanded into file names", { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run(base);
  assert.match(r.yml, /hlsAllowOrigins: \['\*'\]/);
  assert.doesNotMatch(r.yml, /entrypoint\.sh|Dockerfile/);
  const two = run({ ...base, MEDIA_ALLOW_ORIGIN: 'https://a.example, https://b.example' });
  assert.match(two.yml, /hlsAllowOrigins: \['https:\/\/a\.example', 'https:\/\/b\.example'\]/);
});

test('entrypoint: nobody can publish, only the viewer can read, and unneeded services are off', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run(base);
  assert.doesNotMatch(r.yml, /action: publish/);
  assert.match(r.yml, /user: viewer[\s\S]*action: read/);
  for (const off of ['rtsp: no', 'rtmp: no', 'srt: no', 'moq: no']) assert.ok(r.yml.includes(off), off);
});

test('entrypoint: refuses missing settings, a viewer password MediaMTX would reject, and unsafe camera ids', { skip: !HAS_SH && 'sh not available' }, () => {
  assert.notEqual(run({ ...base, GRID_PASSWORD: '' }).status, 0);
  assert.notEqual(run({ ...base, MEDIA_VIEWER_PASSWORD: '' }).status, 0);
  const space = run({ ...base, MEDIA_VIEWER_PASSWORD: 'has space' });
  assert.notEqual(space.status, 0);
  assert.match(space.stderr, /MEDIA_VIEWER_PASSWORD/);
  assert.notEqual(run({ ...base, CAMERA_IDS: "cam01,x: {evil}" }).status, 0);
});

test('entrypoint: a single quote in a secret cannot break out of the YAML', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run({ ...base, MEDIA_ALLOW_ORIGIN: "https://x.example'; evil: 1; '" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.yml, /^evil:/m);
  assert.ok(r.yml.includes("''"), 'quotes are doubled');
});

test('entrypoint: standard HLS (fmp4) by default, overridable', { skip: !HAS_SH && 'sh not available' }, () => {
  assert.match(run(base).yml, /hlsVariant: fmp4/);
  assert.match(run({ ...base, MEDIA_HLS_VARIANT: 'lowLatency' }).yml, /hlsVariant: lowLatency/);
});

test('entrypoint: HLS trusts proxies by default so sessions keep one client IP behind Render', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run(base);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.yml, /hlsTrustedProxies: \['0\.0\.0\.0\/0', '::\/0'\]/);
  const custom = run({ ...base, MEDIA_TRUSTED_PROXIES: '10.0.0.0/8' });
  assert.match(custom.yml, /hlsTrustedProxies: \['10\.0\.0\.0\/8'\]/);
  assert.notEqual(run({ ...base, MEDIA_TRUSTED_PROXIES: "1.1.1.1'; evil: 1" }).status, 0);
});

test('entrypoint: transcoding is off by default and leaves the RTSP listener closed', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run({ ...base, CAMERA_IDS: 'cam06' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.yml, /^rtsp: no$/m);
  assert.doesNotMatch(r.yml, /runOnDemand|action: publish/);
});

test('entrypoint: listed cameras are re-encoded to H.264 by ffmpeg, the others are still pulled directly', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run({ ...base, CAMERA_IDS: 'cam01,cam06', MEDIA_TRANSCODE_IDS: 'cam06' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.yml, /^rtsp: yes$/m);
  assert.match(r.yml, /rtspAddress: 127\.0\.0\.1:18554/); // private: never reachable from other machines
  assert.match(r.yml, /action: publish\s+path: '~\^\(cam06\)\$'/); // only that path may be published, and only from localhost
  assert.match(r.yml, /cam06:\s+runOnDemand: 'ffmpeg .*hevc_qsv .*@103\.250\.160\.189:8554\/stream\/cam06 .*h264_qsv .*rtsp:\/\/127\.0\.0\.1:18554\/cam06'/);
  assert.match(r.yml, /cam01:\s+source: rtsp:\/\//);
  assert.doesNotMatch(r.yml, /use_wallclock_as_timestamps/); // breaks h264_qsv on cam06
});

test('entrypoint: transcode settings are validated', { skip: !HAS_SH && 'sh not available' }, () => {
  assert.notEqual(run({ ...base, MEDIA_TRANSCODE_IDS: "cam06'; evil" }).status, 0);
  assert.notEqual(run({ ...base, MEDIA_TRANSCODE_IDS: 'cam06', MEDIA_TRANSCODE_BITRATE: '2500k; rm' }).status, 0);
  assert.notEqual(run({ ...base, MEDIA_TRANSCODE_IDS: 'cam06', MEDIA_FFMPEG: 'ffmpeg -x' }).status, 0);
});

test('entrypoint: a transcoded camera can name its input codec (cam28:h264), H.265 stays the default', { skip: !HAS_SH && 'sh not available' }, () => {
  const r = run({ ...base, CAMERA_IDS: 'cam06,cam28', MEDIA_TRANSCODE_IDS: 'cam06,cam28:h264' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.yml, /action: publish\s+path: '~\^\(cam06\|cam28\)\$'/);
  assert.match(r.yml, /cam06:\s+runOnDemand: 'ffmpeg .*-c:v hevc_qsv /);
  assert.match(r.yml, /cam28:\s+runOnDemand: 'ffmpeg .*-c:v h264_qsv -rtsp_transport/);
  assert.notEqual(run({ ...base, MEDIA_TRANSCODE_IDS: 'cam28:vp9' }).status, 0);
});
