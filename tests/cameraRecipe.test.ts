import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, allocateSlots, healthScore, speedOf, type Decision } from '../server/cameraRecipe.ts';
import { deriveFlags, PROBE_VERSION, type DescribeResult, type ProbeReport, type SampleMeasurement } from '../server/cameraProfile.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

const describe0: DescribeResult = { codec: 'h264', profile: 'High', width: 1920, height: 1080, fps: 25, bitrate: null, hasBFramesHint: false, hasAudio: false };
const sample0: SampleMeasurement = {
  requestedSec: 30, elapsedSec: 30, frames: 750, timeToFirstFrameMs: 3000, keyframeIntervalSec: { min: 2, median: 2, max: 2 }, bFrames: 0,
  reorderedPackets: 0, maxReorderSec: 0, keyframeCount: 15, spanSec: 29, sinceLastKeyframeSec: 1, problemSamples: [], missedPackets: 0,
  corruptErrors: 0, timestampErrors: 0, exitedEarly: false,
};
const report = (d: Partial<DescribeResult> = {}, s: Partial<SampleMeasurement> = {}, over: Partial<ProbeReport> = {}): ProbeReport => {
  const describe = { ...describe0, ...d }, sample = { ...sample0, ...s };
  return {
    cameraId: 'camX', site: 'test', transport: 'tcp', probedAt: '2026-10-08T00:00:00.000Z', probeVersion: PROBE_VERSION, reachable: true,
    failure: null, failureDetail: null, describe, sample, whep: { ok: true, status: 200, ms: 100 }, flags: deriveFlags(describe, sample), ...over,
  };
};
const failure = (f: ProbeReport['failure'], detail = 'x'): ProbeReport => ({ ...report(), failure: f, failureDetail: detail, describe: null, sample: null, flags: [] });

test('A: a clean H.264 stream passes through, and is a WebRTC candidate for the focused tile', () => {
  const d = decide(report());
  assert.equal(d.recipe, 'A');
  assert.equal(d.transcode, false);
  assert.equal(d.encode, null);
  assert.equal(d.focusRecipe, 'E');
  assert.equal(d.speed, 'fast');
  assert.equal(d.gridLive, true);
});

test('B: B-frames or sparse keyframes in H.264 need a re-encode with short GOP and no B-frames', () => {
  for (const r of [report({ hasBFramesHint: true }), report({}, { reorderedPackets: 20, maxReorderSec: 2 }), report({}, { keyframeIntervalSec: { min: 50, median: 59, max: 60 } })]) {
    const d = decide(r);
    assert.equal(d.recipe, 'B', d.reason);
    assert.equal(d.transcode, true);
    assert.deepEqual(d.encode, { inputCodec: 'h264', bframes: 0, keyframeEverySec: 3, maxHeight: null });
    assert.equal(d.focusRecipe, null, 'WebRTC needs neither B-frames nor a long wait for a keyframe');
  }
});

test('the keyframe limit is 7 s: 6 s passes (cam05 played), 8 s does not', () => {
  assert.equal(decide(report({}, { keyframeIntervalSec: { min: 4, median: 5, max: 6 } })).recipe, 'A');
  assert.equal(decide(report({}, { keyframeIntervalSec: { min: 4, median: 7, max: 8 } })).recipe, 'B');
});

test('damaged video needs the re-encode even when the codec, B-frames and keyframes are fine', () => {
  const d = decide(report({}, { frames: 300, corruptErrors: 75 }));
  assert.equal(d.recipe, 'B');
  assert.match(d.reason, /damaged video \(75 decoder errors in 300 frames\)/);
  assert.equal(d.focusRecipe, null);
  assert.equal(decide(report({}, { frames: 300, corruptErrors: 9 })).recipe, 'A', 'a few start-up errors are not damage');
});

test('C: H.265 and other codecs are re-encoded to H.264, keeping the source codec for decoding', () => {
  for (const codec of ['hevc', 'mjpeg', 'av1']) {
    const d = decide(report({ codec }));
    assert.equal(d.recipe, 'C', codec);
    assert.equal(d.encode?.inputCodec, codec);
  }
  assert.match(decide(report({ codec: 'hevc' })).reason, /H\.265/);
});

test('D: a re-encode of a stream above 1080p is scaled down; a clean tall H.264 stays on A', () => {
  const d = decide(report({ codec: 'hevc', width: 2560, height: 1440 }));
  assert.equal(d.recipe, 'D');
  assert.equal(d.encode?.maxHeight, 1080);
  assert.equal(decide(report({ width: 2560, height: 1440 })).recipe, 'A');
  assert.equal(decide(report({ width: 2560, height: 1440 }, { reorderedPackets: 5, maxReorderSec: 1 })).recipe, 'D');
});

test('G: every failure stage is unsupported and the reason names it', () => {
  assert.match(decide(failure('unreachable', 'RTSP port 8554: ECONNREFUSED')).reason, /Unreachable.*ECONNREFUSED/);
  assert.match(decide(failure('bad_credentials')).reason, /Login rejected/);
  assert.match(decide(failure('no_frame', 'no frame within 60s')).reason, /No usable video.*60s/);
  assert.match(decide(failure('no_describe', 'ffprobe timed out')).reason, /No usable video/);
  for (const f of ['unreachable', 'bad_credentials', 'no_frame', 'no_describe'] as const) {
    const d = decide(failure(f));
    assert.equal(d.recipe, 'G');
    assert.equal(d.health, 0);
    assert.equal(d.gridLive, false);
  }
  assert.equal(decide(report({}, { frames: 0 })).recipe, 'G');
});

test('a stream that closes early is snapshot-only once, unsupported when it repeats', () => {
  const r = report({}, { elapsedSec: 8, exitedEarly: true });
  assert.equal(decide(r).recipe, 'F');
  assert.match(decide(r).reason, /closed after 8s/);
  assert.equal(decide(r, { closedEarlyRuns: 2 }).recipe, 'G');
});

test('F: a camera that needs a re-encode on a machine with no hardware encoder is snapshot-only, never software', () => {
  const d = decide(report({ codec: 'hevc' }), { encoder: 'none' });
  assert.equal(d.recipe, 'F');
  assert.equal(d.wanted, 'C');
  assert.equal(d.transcode, false);
  assert.equal(decide(report(), { encoder: 'none' }).recipe, 'A', 'pass-through needs no encoder');
});

test('start-up time: fast under 10 s, slow over 30 s, and slow cameras are not live in the grid', () => {
  assert.equal(speedOf(report({}, { timeToFirstFrameMs: 9_000 })), 'fast');
  assert.equal(speedOf(report({}, { timeToFirstFrameMs: 20_000 })), 'normal');
  assert.equal(speedOf(report({}, { timeToFirstFrameMs: 30_000 })), 'normal');
  assert.equal(speedOf(report({}, { timeToFirstFrameMs: 30_200 })), 'slow');
  assert.equal(decide(report({}, { timeToFirstFrameMs: 41_000 })).gridLive, false);
  assert.equal(decide(report({}, { timeToFirstFrameMs: 29_000 })).gridLive, true);
});

test('health: failures score 0, a fast clean camera scores high, damage and slowness cost points', () => {
  const clean = healthScore(report());
  assert.ok(clean >= 90, String(clean));
  assert.equal(healthScore(failure('no_frame')), 0);
  assert.ok(healthScore(report({}, { timeToFirstFrameMs: 35_000 })) < clean);
  assert.ok(healthScore(report({}, { frames: 100, corruptErrors: 200 })) < clean);
  assert.ok(healthScore(report({ codec: 'hevc' })) < clean, 'needing a re-encode costs a little');
  for (const r of GRID_REPORTS) { const h = healthScore(r); assert.ok(h >= 0 && h <= 100); }
});

const req = (id: string, r: ProbeReport, priority = 1) => ({ cameraId: id, decision: decide(r), priority });

test('slots: pass-through cameras are free, the rest share the slots by priority, losers fall back to F with the reason', () => {
  const requests = [
    req('a', report()), req('b1', report({ hasBFramesHint: true }), 1), req('b2', report({ hasBFramesHint: true }), 3),
    req('c', report({ codec: 'hevc' }), 2), req('g', failure('no_frame'), 5),
  ];
  const out = allocateSlots(requests, 2);
  const by = Object.fromEntries(out.map((o) => [o.cameraId, o]));
  assert.equal(by.a.live, true);
  assert.equal(by.b2.live, true, 'highest priority gets a slot');
  assert.equal(by.c.live, true, 'second highest');
  assert.equal(by.b1.live, false);
  assert.equal(by.b1.decision.recipe, 'F');
  assert.equal(by.b1.decision.wanted, 'B');
  assert.match(by.b1.decision.reason, /No transcode slot free \(2 in use\)/);
  assert.equal(by.g.live, false);
  assert.equal(by.g.decision.recipe, 'G');
  assert.deepEqual(out.map((o) => o.cameraId), requests.map((r) => r.cameraId), 'order is kept');
  assert.equal(allocateSlots(requests, 0).filter((o) => o.decision.recipe === 'F').length, 3);
});

test('slots: equal priority is decided by health, then by order', () => {
  const healthy = req('healthy', report({ hasBFramesHint: true }, { timeToFirstFrameMs: 3000 }));
  const sick = req('sick', report({ hasBFramesHint: true }, { timeToFirstFrameMs: 28_000, frames: 100, corruptErrors: 100 }));
  const out = allocateSlots([sick, healthy], 1);
  assert.equal(out.find((o) => o.cameraId === 'healthy')?.live, true);
  assert.equal(out.find((o) => o.cameraId === 'sick')?.live, false);
});

// ---- The real grid, replayed -------------------------------------------------------------------------------------

const recipes = Object.fromEntries(GRID_REPORTS.map((r) => [r.cameraId, decide(r)]));

test('the grid as measured: what the plan already knew', () => {
  assert.equal(recipes.cam06.recipe, 'C');
  assert.equal(recipes.cam28.recipe, 'B');
  assert.equal(recipes.cam30.recipe, 'B');
  assert.equal(recipes.cam22.recipe, 'G');
  assert.equal(recipes.cam26.recipe, 'D');
  for (const id of ['cam12', 'cam17', 'cam18']) assert.equal(recipes[id].recipe, 'C', id);
  for (const id of ['cam09', 'cam24', 'cam25', 'cam27']) assert.equal(recipes[id].recipe, 'B', id);
  // cam07, 08, 10 and 18 were "unsupported" on 2026-10-07; on 2026-10-08 they delivered, so they have a recipe.
  for (const id of ['cam07', 'cam08', 'cam10']) assert.notEqual(recipes[id].recipe, 'G', id);
});

test('the grid as measured: slow cameras get snapshots in the grid', () => {
  for (const id of ['cam07', 'cam11', 'cam29', 'cam30']) assert.equal(recipes[id].gridLive, false, `${id} ${recipes[id].speed}`);
  assert.equal(recipes.cam28.gridLive, true);
});

test('the grid as measured: only a handful of cameras pass through, so the transcode slots are the constraint', () => {
  const count = (r: string) => Object.values(recipes).filter((d) => d.recipe === r).length;
  assert.deepEqual(['A', 'B', 'C', 'D', 'G'].map(count), [4, 19, 4, 1, 2]);
  assert.deepEqual(Object.keys(recipes).filter((id) => recipes[id].recipe === 'A'), ['cam01', 'cam02', 'cam03', 'cam05']);
  // Measured through MediaMTX without a re-encode on 2026-10-08: cam01 and cam05 played; cam13, 14, 15, 20, 23 crashed the HLS muxer.
  for (const id of ['cam13', 'cam14', 'cam15', 'cam20', 'cam23']) assert.equal(recipes[id].recipe, 'B', id);
  const wantsSlot = Object.values(recipes).filter((d) => d.transcode).length;
  assert.equal(wantsSlot, 24);
  // With every camera asking at once and 6 slots, 18 fall back to snapshots, each with its reason.
  const out = allocateSlots(GRID_REPORTS.map((r) => ({ cameraId: r.cameraId, decision: recipes[r.cameraId], priority: 1 })), 6);
  const fell = out.filter((o): o is typeof o & { decision: Decision } => o.decision.recipe === 'F');
  assert.equal(fell.length, 18);
  assert.ok(fell.every((o) => /No transcode slot free/.test(o.decision.reason)));
});
