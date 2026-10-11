/** AI analysis of a recorded clip: where frames are taken, how answers become a timeline, and what happens when the analysis fails or is stopped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeClip, clock, findingAt, findingFromAnswer, sampleTimes, summarizeFindings, MAX_FRAMES, type FrameFinding } from '../src/lib/clipAnalysis.ts';

const f = (at: number, over: Partial<FrameFinding> = {}): FrameFinding => ({ at, summary: `s${at}`, people: 0, vehicles: 0, plates: [], alerts: [], unusual: false, ...over });

test('sampleTimes: evenly spread, at least 4 s apart, at most 12, never at the very start or end', () => {
  assert.deepEqual(sampleTimes(0), []);
  assert.deepEqual(sampleTimes(NaN), []);
  assert.deepEqual(sampleTimes(3), [1.5], 'a very short clip gets one frame in the middle');
  assert.deepEqual(sampleTimes(20), [2, 6, 10, 14, 18], '5 frames, 4 s apart');
  const long = sampleTimes(120);
  assert.equal(long.length, MAX_FRAMES);
  assert.ok(long[0] > 0.2 && long[long.length - 1] < 119.8);
  for (let i = 1; i < long.length; i++) assert.ok(long[i] - long[i - 1] >= 4);
  assert.equal(sampleTimes(23.5).length, 5);
});

test('answers become findings; missing or odd fields are tolerated', () => {
  assert.deepEqual(findingFromAnswer(2, { summary: ' Two people ', counts: { people: 2, vehicles: 1 }, detected_plates: ['GJ05AB1234'], alerts: ['loitering'], isUnusual: true }),
    { at: 2, summary: 'Two people', people: 2, vehicles: 1, plates: ['GJ05AB1234'], alerts: ['loitering'], unusual: true });
  const empty = findingFromAnswer(5, {});
  assert.deepEqual([empty.summary, empty.people, empty.plates, empty.unusual], ['Nothing to report.', 0, [], false]);
  assert.deepEqual(findingFromAnswer(1, { counts: { people: 'x' }, detected_plates: 'nope' }).plates, []);
});

test('summary: largest counts, all plates once, when it was unusual; failed frames are counted but not used', () => {
  const s = summarizeFindings([f(2, { people: 1, plates: ['A1'] }), f(6, { people: 4, vehicles: 2, plates: ['A1', 'B2'], unusual: true, alerts: ['x'] }), f(10, { error: 'boom', people: 99 })]);
  assert.deepEqual([s.frames, s.failed, s.maxPeople, s.maxVehicles, s.plates, s.unusualAt, s.alerts], [3, 1, 4, 2, ['A1', 'B2'], [6], ['x']]);
  assert.deepEqual(summarizeFindings([]), { frames: 0, failed: 0, maxPeople: 0, maxVehicles: 0, plates: [], unusualAt: [], alerts: [] });
});

test('findingAt: the latest finding at or before the playback time (a caption follows the video)', () => {
  const list = [f(2), f(6), f(10)];
  assert.equal(findingAt(list, 1), null, 'before the first frame there is no caption');
  assert.equal(findingAt(list, 2)?.at, 2);
  assert.equal(findingAt(list, 7.9)?.at, 6);
  assert.equal(findingAt(list, 100)?.at, 10);
  assert.equal(clock(65), '1:05'); assert.equal(clock(9), '0:09');
});

test('analyzeClip: one request per frame, in order, with progress; a failed frame is recorded and the rest carry on', async () => {
  const seen: number[] = [], progress: number[] = [];
  let n = 0;
  const r = await analyzeClip({
    videoUrl: 'x', duration: 20, camera: { id: 'c', name: 'C' },
    grab: async (at) => { seen.push(at); return 'AAAA'; },
    ask: async () => { n++; if (n === 2) throw new Error('rate limited'); return { summary: `frame ${n}`, counts: { people: n } }; },
    onProgress: (done, total) => progress.push(done * 100 + total),
  });
  assert.deepEqual(seen, [2, 6, 10, 14, 18]);
  assert.deepEqual(progress, [105, 205, 305, 405, 505]);
  assert.equal(r.length, 5);
  assert.equal(r[1].error, 'rate limited');
  assert.deepEqual(r.filter((x) => !x.error).map((x) => x.summary), ['frame 1', 'frame 3', 'frame 4', 'frame 5']);
});

test('analyzeClip: three failures in a row stop it (the analysis is down); a missing picture is a failed frame; stopping keeps what was done', async () => {
  const down = await analyzeClip({ videoUrl: 'x', duration: 60, camera: { id: 'c', name: 'C' }, grab: async () => 'AAAA', ask: async () => { throw new Error('no API key'); } });
  assert.equal(down.length, 3, 'stopped after three in a row');
  assert.ok(down.every((x) => x.error === 'no API key'));
  const blank = await analyzeClip({ videoUrl: 'x', duration: 8, camera: { id: 'c', name: 'C' }, grab: async () => null, ask: async () => ({}) });
  assert.match(blank[0].error ?? '', /No picture/);
  const ctl = new AbortController(); let calls = 0;
  const part = await analyzeClip({ videoUrl: 'x', duration: 40, camera: { id: 'c', name: 'C' }, signal: ctl.signal, grab: async () => 'AAAA', ask: async () => { calls++; if (calls === 2) ctl.abort(); return { summary: 'ok' }; } });
  assert.equal(part.length, 2, 'the two finished frames are kept');
});
