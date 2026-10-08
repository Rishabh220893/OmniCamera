import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFramecrc, parseFfmpegInput, buildSampleArgs, parseFfprobeStreams, parseShowInfo, countLogProblems, keyframeIntervals, buildSample, classifyConnectError,
  deriveFlags, createProfileStore, PROFILE_SCHEMA, type ProbeReport,
} from '../server/cameraProfile.ts';
import { GRID_GROUND_TRUTH } from '../server/gridGroundTruth.ts';

const info = (t: number, key: number, type: string) =>
  `[Parsed_showinfo_0 @ 0x1] n:   0 pts:   0 pts_time:${t}    duration: 1 fmt:yuv420p sar:0/1 s:1920x1080 i:P iskey:${key} type:${type} checksum:00`;

test('parses ffprobe streams', () => {
  const d = parseFfprobeStreams(JSON.stringify({ streams: [
    { codec_type: 'video', codec_name: 'hevc', profile: 'Main', width: 2560, height: 1440, avg_frame_rate: '25/1', bit_rate: '4000000', has_b_frames: 2 },
    { codec_type: 'audio' },
  ] }));
  assert.deepEqual(d, { codec: 'hevc', profile: 'Main', width: 2560, height: 1440, fps: 25, bitrate: 4000000, hasBFramesHint: true, hasAudio: true });
  assert.equal(parseFfprobeStreams('not json'), null);
  assert.equal(parseFfprobeStreams('{"streams":[{"codec_type":"audio"}]}'), null);
});

test('reads showinfo lines and keyframe spacing', () => {
  const stderr = [info(0, 1, 'I'), info(1, 0, 'P'), info(2, 0, 'B'), info(3, 1, 'I'), info(9, 1, 'I'), 'noise'].join('\n');
  const f = parseShowInfo(stderr);
  assert.equal(f.length, 5);
  assert.deepEqual(keyframeIntervals(f), { min: 3, median: 6, max: 6 });
  assert.equal(keyframeIntervals(f.slice(0, 2)), null);
});

test('counts problem lines in the ffmpeg log', () => {
  const p = countLogProblems([
    '[rtsp @ 0x1] RTP: missed 3 packets', '[rtsp @ 0x1] RTP: missed 2 packets',
    '[h264 @ 0x2] error while decoding MB 1 2', '[hls @ 0x3] Non-monotonous DTS in output stream', 'ordinary line',
  ].join('\n'));
  assert.deepEqual({ ...p, samples: undefined }, { missedPackets: 5, corruptErrors: 1, timestampErrors: 1, samples: undefined });
  assert.deepEqual(p.samples, ['error while decoding MB N N', 'Non-monotonous DTS in output stream']);
});

test('connect errors get named stages and never leak credentials', () => {
  assert.equal(classifyConnectError('method DESCRIBE failed: 401 Unauthorized').stage, 'bad_credentials');
  assert.equal(classifyConnectError('Connection refused').stage, 'unreachable');
  assert.equal(classifyConnectError('Invalid data found when processing input').stage, 'no_describe');
  // Numbers in decode noise must not read as an HTTP status.
  assert.equal(classifyConnectError('[h264 @ 0x1] concealing 401 DC, 403 AC errors').stage, 'no_describe');
  assert.ok(!classifyConnectError('rtsp://user:secret@h:8554/x: 404').detail.includes('secret'));
});

const sample = (over: Partial<ReturnType<typeof buildSample>> = {}) => ({ ...buildSample({ requestedSec: 30, elapsedSec: 30, timeToFirstFrameMs: 2000, stderr: '' }), ...over });
const d = (over = {}) => ({ codec: 'h264', profile: 'Main', width: 1920, height: 1080, fps: 25, bitrate: null, hasBFramesHint: false, hasAudio: false, ...over });

test('flags each fault class from the plan', () => {
  assert.deepEqual(deriveFlags(d(), sample()), []);
  assert.ok(deriveFlags(d({ codec: 'hevc' }), sample()).includes('h265'));
  assert.ok(deriveFlags(d({ codec: 'mjpeg' }), sample()).includes('other_codec'));
  assert.ok(deriveFlags(d({ hasBFramesHint: true }), sample()).includes('bframes'));
  assert.ok(deriveFlags(d(), sample({ bFrames: 4 })).includes('bframes'));
  assert.ok(deriveFlags(d({ height: 1440 }), sample()).includes('high_resolution'));
  assert.ok(deriveFlags(d(), sample({ frames: 100, keyframeIntervalSec: { min: 55, median: 59, max: 60 } })).includes('sparse_keyframes'));
  assert.ok(!deriveFlags(d(), sample({ keyframeIntervalSec: { min: 2, median: 3, max: 4 } })).includes('sparse_keyframes'));
  assert.ok(deriveFlags(d(), sample({ frames: 100, missedPackets: 10 })).includes('packet_loss'));
  assert.ok(!deriveFlags(d(), sample({ frames: 750, missedPackets: 2 })).includes('packet_loss'));
  assert.ok(deriveFlags(d(), sample({ corruptErrors: 1 })).includes('corrupt_frames'));
  assert.ok(deriveFlags(d(), sample({ timeToFirstFrameMs: 14_000 })).includes('slow_first_frame'));
  assert.ok(deriveFlags(d(), sample({ exitedEarly: true })).includes('closed_early'));
});

test('a sample that ends early after frames arrived is "closed early"; one with no frames is not', () => {
  const frames = [info(0, 1, 'I'), info(1, 0, 'P')].join('\n');
  assert.equal(buildSample({ requestedSec: 30, elapsedSec: 8, timeToFirstFrameMs: 500, stderr: frames }).exitedEarly, true);
  assert.equal(buildSample({ requestedSec: 30, elapsedSec: 8, timeToFirstFrameMs: null, stderr: '' }).exitedEarly, false);
});

test('packet timestamps: no reordering when pts equals dts, reordering when pts runs ahead', () => {
  const head = '#tb 0: 1/90000\n#media_type 0: video\n';
  const row = (dts: number, pts: number) => `0, ${dts}, ${pts}, 3600, 1000, 0x1`;
  const flat = parseFramecrc(head + [0, 3600, 7200, 10800].map((t) => row(t, t)).join('\n'));
  assert.deepEqual(flat, { packets: 4, reorderedPackets: 0, maxReorderSec: 0, dtsBackwards: 0 });
  const b = parseFramecrc(head + [row(0, 7200), row(3600, 14400), row(7200, 10800), row(10800, 21600)].join('\n'));
  assert.equal(b.reorderedPackets, 4);
  assert.equal(b.maxReorderSec, 0.12);
  assert.equal(parseFramecrc(head + [row(7200, 7200), row(3600, 3600)].join('\n')).dtsBackwards, 1);
  assert.equal(parseFramecrc('').packets, 0);
});

test('a lone keyframe in a long sample means sparse keyframes; a packet-level reorder means B-frames', () => {
  const lone = [info(0, 1, 'I'), ...Array.from({ length: 20 }, (_, i) => info(i + 1, 0, 'P'))].join('\n');
  const s = buildSample({ requestedSec: 30, elapsedSec: 30, timeToFirstFrameMs: 2000, stderr: lone });
  assert.equal(s.keyframeCount, 1);
  assert.equal(s.sinceLastKeyframeSec, 20);
  assert.ok(deriveFlags(d(), s).includes('sparse_keyframes'));
  const packets = '#tb 0: 1/90000\n0, 0, 7200, 3600, 1000, 0x1\n0, 3600, 3600, 3600, 1000, 0x2\n';
  const r = buildSample({ requestedSec: 30, elapsedSec: 30, timeToFirstFrameMs: 2000, stderr: '', packets });
  assert.equal(r.reorderedPackets, 1);
  assert.ok(deriveFlags(d(), r).includes('bframes'));
});

test('describes the input from ffmpeg when ffprobe could not', () => {
  const line = '  Stream #0:0: Video: hevc (Main), yuv420p(tv), 2560x1440, 13 fps, 25 tbr, 90k tbn';
  assert.deepEqual(parseFfmpegInput(`Input #0, rtsp\n${line}\n`), { codec: 'hevc', profile: 'Main', width: 2560, height: 1440, fps: 13, bitrate: null, hasBFramesHint: false, hasAudio: false });
  assert.equal(parseFfmpegInput('nothing here'), null);
});

test('sample arguments decode with showinfo and copy packets to stdout, with progress on stderr', () => {
  const a = buildSampleArgs('rtsp://h/x', 'tcp', 30);
  assert.ok(a.join(' ').includes('-progress pipe:2'));
  assert.ok(a.join(' ').endsWith('-f framecrc pipe:1'));
  assert.equal(a.indexOf('-t') < a.indexOf('-i'), true);
});

test('ground truth: every expectation names real flags/stages', () => {
  assert.deepEqual(GRID_GROUND_TRUTH.cam26.flags, ['h265', 'high_resolution']);
  assert.deepEqual(GRID_GROUND_TRUTH.cam22.flags, ['h265']);
  assert.deepEqual(GRID_GROUND_TRUTH.cam30.flags, ['sparse_keyframes']);
});

test('store appends history and upserts the current profile, without touching the recipe columns', async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const store = createProfileStore({ query: async (text, params) => { calls.push({ text, params }); return { rows: [] }; } });
  const report: ProbeReport = {
    cameraId: 'cam06', site: 'grid', transport: 'tcp', probedAt: '2026-10-08T00:00:00.000Z', probeVersion: 1, reachable: true,
    failure: null, failureDetail: null, describe: d({ codec: 'hevc' }), sample: sample(), whep: null, flags: ['h265'],
  };
  await store.saveProbe(report);
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /INSERT INTO probe_runs/);
  assert.match(calls[1].text, /ON CONFLICT \(site, camera_id\) DO UPDATE/);
  assert.ok(!/recipe/.test(calls[1].text.split('DO UPDATE')[1]));
  assert.deepEqual(calls[1].params?.slice(0, 2), ['grid', 'cam06']);
  assert.deepEqual(calls[1].params?.[10], ['h265']);
  assert.ok(!JSON.stringify(calls).match(/password|secret/i));
  assert.match(PROFILE_SCHEMA, /PRIMARY KEY \(site, camera_id\)/);
});
