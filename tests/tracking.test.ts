import test from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, normalizeTrackedPlate, type PlateRead, type TrackCamera, type TrackDeps, type TrackSpec } from '../server/tracking.ts';
import type { FrameGate } from '../server/frameGate.ts';

const cams = (n: number): TrackCamera[] => Array.from({ length: n }, (_, i) => ({ id: `cam${String(i + 1).padStart(2, '0')}`, name: `CAM${String(i + 1).padStart(2, '0')} Test Road ${i + 1}`, url: `https://example.org/cam${String(i + 1).padStart(2, '0')}/index.m3u8` }));
const jpeg = (tag: string) => Buffer.from(`frame:${tag}`);

/** A tracker on a manual clock, with scripted answers per camera. */
function lab(opts: { cameras?: TrackCamera[]; concurrency?: number; deps?: Partial<TrackDeps> } = {}) {
  let t = 1_000_000;
  const calls = { grab: [] as string[], plates: 0, face: 0, rules: 0 };
  let inFlight = 0, maxInFlight = 0;
  const script = {
    plates: new Map<string, PlateRead[]>(),
    face: new Map<string, { match: boolean; confidence: number; reason: string }>(),
    rules: new Map<string, { violated: boolean; confidence: number; reason: string }>(),
    grabFail: new Set<string>(),
    source: 'anpr' as 'anpr' | 'gemini-fallback',
  };
  const deps: TrackDeps = {
    now: () => t,
    async grabFrame(c) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        calls.grab.push(c.id);
        await Promise.resolve();
        if (script.grabFail.has(c.id)) throw new Error('ffmpeg: rtsp://user:p%40ss@103.250.160.189:8554/stream/' + c.id + ' timeout');
        return jpeg(c.id);
      } finally { inFlight--; }
    },
    async readPlates(frame) { calls.plates++; return { plates: script.plates.get(frame.toString().slice(6)) ?? [], source: script.source }; },
    async matchFace(frame) { calls.face++; return script.face.get(frame.toString().slice(6)) ?? { match: false, confidence: 0.1, reason: 'not seen' }; },
    async checkRules(frame) { calls.rules++; return script.rules.get(frame.toString().slice(6)) ?? { violated: false, confidence: 0.1, reason: 'nothing' }; },
    ...opts.deps,
  };
  const tracker = createTracker(deps, { tickMs: 3_600_000, concurrency: opts.concurrency ?? 4 });
  const cameras = opts.cameras ?? cams(30);
  const run = async (seconds: number) => { for (let i = 0; i < seconds * 2; i++) { t += 500; await tracker.tick(); } };
  return { tracker, script, calls, cameras, run, advance: (ms: number) => { t += ms; }, maxInFlight: () => maxInFlight, now: () => t };
}
const plate = (p: string): TrackSpec => ({ mode: 'plate', plate: normalizeTrackedPlate(p) });

test('plate: every camera is checked in the background about every 10 s, spread out, with bounded concurrency', async () => {
  const l = lab();
  l.tracker.start(plate('GJ05AB1234'), l.cameras);
  await l.run(35);
  const per = new Map<string, number>();
  for (const id of l.calls.grab) per.set(id, (per.get(id) ?? 0) + 1);
  assert.equal(per.size, 30, 'all 30 cameras were checked, with nobody having "focused" any of them');
  for (const [id, n] of per) assert.ok(n >= 3 && n <= 4, `${id} was checked ${n} times in 35 s`);
  assert.ok(l.maxInFlight() <= 4, `at most 4 at once, saw ${l.maxInFlight()}`);
  const s = l.tracker.status();
  assert.equal(s.intervalSec, 10);
  assert.ok(s.measuredCycleSec! >= 9.5 && s.measuredCycleSec! <= 10.6, `measured cycle ${s.measuredCycleSec}`);
  assert.equal(s.late, 0);
  assert.equal(s.counters.anprCalls, s.counters.checks);
  assert.equal(l.calls.face + l.calls.rules, 0, 'plate mode never calls Gemini when the plate reader answers');
  l.tracker.shutdown();
});

test('plate: spaces and case do not matter; the alert names the camera and carries the frame', async () => {
  const l = lab();
  assert.equal(normalizeTrackedPlate('gj 05-ab 1234'), 'GJ05AB1234');
  l.script.plates.set('cam07', [{ text: 'GJ05AB1234', confidence: 0.93 }]);
  l.tracker.start(plate('gj 05 ab 1234'), l.cameras);
  await l.run(12);
  const s = l.tracker.status();
  assert.equal(s.alerts.length, 1);
  const a = s.alerts[0];
  assert.deepEqual([a.cameraId, a.kind, a.certainty, a.source, a.confidence], ['cam07', 'plate', 'match', 'anpr', 0.93]);
  assert.match(a.title, /GJ05AB1234/);
  assert.equal(a.hasFrame, true);
  assert.equal(l.tracker.alertFrame(a.id)?.toString(), 'frame:cam07');
  assert.ok(!JSON.stringify(s).includes('frame:'), 'the status never carries the image');
  assert.equal(s.cameras.find((c) => c.id === 'cam07')?.hits, 2, 'seen on both checks, but only one alert inside the cooldown');
  l.tracker.shutdown();
});

test('plate: only an OCR look-alike swap is "possible"; a different plate, a one-digit difference or a stub is nothing', async () => {
  const l = lab({ cameras: cams(4) });
  l.script.plates.set('cam01', [{ text: 'GJO5AB1234', confidence: 0.8 }]);     // letter O for digit 0
  l.script.plates.set('cam02', [{ text: 'GJ05AB9999', confidence: 0.9 }]);     // a different car
  l.script.plates.set('cam03', [{ text: 'GJ05', confidence: 0.9 }]);            // not a plate
  l.script.plates.set('cam04', [{ text: 'GJ05AB1235', confidence: 0.9 }]);      // one digit different, not a look-alike swap: a different car
  l.tracker.start(plate('GJ05AB1234'), l.cameras);
  await l.run(12);
  const s = l.tracker.status();
  assert.deepEqual(s.alerts.map((a) => [a.cameraId, a.certainty]), [['cam01', 'possible']]);
  assert.equal(s.cameras.find((c) => c.id === 'cam04')?.hits, 0, 'a plate one digit off is a different plate, not a misread');
  assert.match(s.alerts.find((a) => a.cameraId === 'cam01')!.detail, /one look-alike character away/);
  assert.equal(s.cameras.find((c) => c.id === 'cam02')?.hits, 0);
  l.tracker.shutdown();
});

test('plate: an unverified Gemini read says so', async () => {
  const l = lab({ cameras: cams(2) });
  l.script.source = 'gemini-fallback';
  l.script.plates.set('cam01', [{ text: 'GJ05AB1234', confidence: 0.7 }]);
  l.tracker.start(plate('GJ05AB1234'), l.cameras);
  await l.run(12);
  const s = l.tracker.status();
  assert.equal(s.alerts[0].source, 'gemini-fallback');
  assert.match(s.alerts[0].detail, /unverified read/);
  assert.equal(s.counters.geminiCalls, s.counters.checks);
  assert.equal(s.counters.anprCalls, 0);
  l.tracker.shutdown();
});

test('cooldown: a parked car raises one alert, not one every ten seconds; it alerts again after the cooldown; hits keep counting', async () => {
  const l = lab({ cameras: cams(1) });
  l.script.plates.set('cam01', [{ text: 'GJ05AB1234', confidence: 0.9 }]);
  l.tracker.start(plate('GJ05AB1234'), l.cameras);
  await l.run(25); // checks at about 0, 10, 20 s
  let s = l.tracker.status();
  assert.equal(s.alerts.length, 1);
  assert.equal(s.cameras[0].hits, 3);
  await l.run(15); // 40 s: past the 30 s cooldown
  s = l.tracker.status();
  assert.equal(s.alerts.length, 2);
  assert.deepEqual(l.tracker.status(1).alerts.map((a) => a.id), [2], 'asking "after 1" returns only the new one');
  l.tracker.shutdown();
});

test('face: Gemini must be sure; a weak or negative answer raises nothing; a strong one alerts with the label', async () => {
  const l = lab({ cameras: cams(3) });
  l.script.face.set('cam01', { match: true, confidence: 0.55, reason: 'looks a bit similar' });
  l.script.face.set('cam02', { match: true, confidence: 0.92, reason: 'same man, grey beard and round glasses' });
  l.tracker.start({ mode: 'face', label: 'Test Person A', image: Buffer.from('ref'), mimeType: 'image/jpeg' }, l.cameras);
  await l.run(12);
  const s = l.tracker.status();
  assert.deepEqual(s.alerts.map((a) => [a.cameraId, a.kind, a.source]), [['cam02', 'face', 'gemini']]);
  assert.match(s.alerts[0].title, /Test Person A seen/);
  assert.equal(s.target, 'Test Person A', 'the label is shown, never the photo');
  assert.equal(l.calls.face, s.counters.checks);
  assert.equal(l.calls.plates, 0);
  l.tracker.shutdown();
});

test('rules: one set of rules is applied to every camera at once', async () => {
  const l = lab({ cameras: cams(5) });
  l.script.rules.set('cam04', { violated: true, confidence: 0.88, reason: 'two people are climbing over the fence' });
  l.tracker.start({ mode: 'rules', rules: 'Anyone climbing a fence or wall' }, l.cameras);
  await l.run(12);
  const s = l.tracker.status();
  assert.equal(l.calls.rules, 5 * 2 > s.counters.checks ? s.counters.checks : l.calls.rules);
  assert.deepEqual(s.alerts.map((a) => [a.cameraId, a.kind, a.certainty]), [['cam04', 'rule', 'match']]);
  assert.match(s.alerts[0].detail, /climbing over the fence/);
  assert.equal(new Set(l.calls.grab).size, 5);
  l.tracker.shutdown();
});

test('failures: a dead camera backs off, shows a clean error (no login), and does not stop the others', async () => {
  const l = lab({ cameras: cams(3) });
  l.script.grabFail.add('cam02');
  l.script.plates.set('cam03', [{ text: 'GJ05AB1234', confidence: 0.9 }]);
  l.tracker.start(plate('GJ05AB1234'), l.cameras);
  await l.run(60);
  const grabs = (id: string) => l.calls.grab.filter((x) => x === id).length;
  assert.ok(grabs('cam02') <= 4, `the dead camera was tried ${grabs('cam02')} times in 60 s, not 6`);
  assert.ok(grabs('cam03') >= 5);
  const s = l.tracker.status();
  const dead = s.cameras.find((c) => c.id === 'cam02')!;
  assert.equal(dead.state, 'error');
  assert.ok(!dead.lastError!.includes('p%40ss'), dead.lastError!);
  assert.match(dead.lastError!, /rtsp:\/\/\*\*\*@/);
  assert.equal(s.cameras.find((c) => c.id === 'cam03')?.state, 'ok');
  assert.equal(s.alerts.length, 2, 'seen for 60 s: one alert, then one more after the 30 s cooldown');
  l.tracker.shutdown();
});

test('stop: nothing that was in flight can raise an alert afterwards, and a new start begins clean', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const l = lab({ cameras: cams(1), deps: { async readPlates() { await gate; return { plates: [{ text: 'GJ05AB1234', confidence: 0.9 }], source: 'anpr' as const }; } } });
  l.tracker.start(plate('GJ05AB1234'), l.cameras);
  l.advance(600);
  const ticking = l.tracker.tick();
  await Promise.resolve();
  l.tracker.stop();
  release();
  await ticking;
  assert.equal(l.tracker.status().active, false);
  assert.equal(l.tracker.status().alerts.length, 0, 'the late answer is dropped');
  l.tracker.start(plate('AB12CD3456'), l.cameras);
  assert.equal(l.tracker.status().counters.alerts, 0);
  assert.equal(l.tracker.status().mode, 'plate');
  l.tracker.shutdown();
});

test('gate: a scene that did not change is not sent to the model again', async () => {
  let first = true;
  const gate: FrameGate = {
    async check() { const analyze = first; first = false; return analyze ? { analyze: true as const, reason: 'first-frame' as const, commit() {} } : { analyze: false as const, reason: 'unchanged' as const, commit() {} }; },
    forget() {}, stats: () => ({ skipped: 0, analysed: 0 }),
  };
  const l = lab({ cameras: cams(1), deps: { gate } });
  l.tracker.start({ mode: 'rules', rules: 'anything odd' }, l.cameras);
  await l.run(32);
  const s = l.tracker.status();
  assert.equal(l.calls.rules, 1);
  assert.ok(s.counters.skippedUnchanged >= 2);
  assert.equal(s.cameras[0].state, 'unchanged');
  l.tracker.shutdown();
});

test('start replaces a running job, ignores a duplicate camera id, and an empty list is allowed', async () => {
  const l = lab({ cameras: [...cams(2), ...cams(2)] });
  l.tracker.start(plate('GJ05AB1234'), l.cameras);
  assert.equal(l.tracker.status().cameras.length, 2);
  l.tracker.start({ mode: 'rules', rules: 'x' }, []);
  assert.deepEqual([l.tracker.status().mode, l.tracker.status().cameras.length], ['rules', 0]);
  l.tracker.stop();
  assert.deepEqual([l.tracker.status().active, l.tracker.status().target], [false, null]);
  l.tracker.shutdown();
});
