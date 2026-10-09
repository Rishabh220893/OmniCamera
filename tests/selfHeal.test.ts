import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProbeReport } from '../server/cameraProfile.ts';
import { decide } from '../server/cameraRecipe.ts';
import { createSelfHealer, DEFAULT_HEAL_CONFIG, effectiveRecipe, healConfigFromEnv, healModeFromEnv, nextRungDown, promotion } from '../server/selfHeal.ts';
import type { MediaEvent } from '../server/mediaEvents.ts';
import { memoryProfileStore } from './fixtures/memoryProfileStore.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

const byId = (id: string) => GRID_REPORTS.find((r) => r.cameraId === id)!;
const MIN = 60_000, HOUR = 3_600_000;
const T0 = Date.parse('2026-10-09T10:00:00.000Z');
const crash = (cameraId: string, at: number, kind: MediaEvent['kind'] = 'dts_error'): MediaEvent => ({ cameraId, kind, at, message: 'unable to extract DTS: too many reordered frames (11)' });

function setup(ids: string[], mode: 'dry' | 'on' = 'on', encoder: 'qsv' | 'none' = 'qsv') {
  const m = memoryProfileStore(ids.map(byId));
  let now = T0;
  let applies = 0;
  const healer = createSelfHealer({ store: m.store, site: 'grid', encoder, mode, now: () => now, apply: async () => { applies++; return []; } });
  return { ...m, healer, set: (t: number) => { now = t; }, applies: () => applies, row: (id: string) => m.rows.get(`grid/${id}`)! };
}
const crashes = async (s: ReturnType<typeof setup>, id: string, at: number, n = 3) => {
  for (let i = 0; i < n; i++) await s.healer.onEvent(crash(id, at + i * 60_000));
  await s.healer.idle();
};

test('floor: B makes a clean camera re-encode, F makes any live camera snapshots, an override beats both', () => {
  const clean = byId('cam01');
  assert.equal(decide(clean).recipe, 'A');
  const b = decide(clean, { heal: { recipe: 'B', reason: '3 muxer crashes' } });
  assert.deepEqual([b.recipe, b.transcode, b.encode?.bframes, b.encode?.gopFrames, b.focusRecipe], ['B', true, 0, 30, null]);
  assert.match(b.reason, /Self-heal: 3 muxer crashes.*measured as A/);
  assert.equal(decide(clean, { heal: { recipe: 'B', reason: 'x' }, encoder: 'none' }).recipe, 'F', 'no encoder: never software');
  assert.equal(decide(byId('cam26'), { heal: { recipe: 'B', reason: 'x' } }).recipe, 'D', 'a tall clean stream floors to D, not B');
  const f = decide(byId('cam28'), { heal: { recipe: 'F', reason: 'x' } });
  assert.deepEqual([f.recipe, f.transcode, f.encode, f.gridLive, f.wanted], ['F', false, null, false, 'B']);
  assert.equal(decide(byId('cam28'), { heal: { recipe: 'B', reason: 'x' } }).recipe, 'B', 'already re-encoded: floor B changes nothing');
  assert.equal(decide(byId('cam22'), { heal: { recipe: 'F', reason: 'x' } }).recipe, 'G', 'G stays G: only a probe says no video');
  assert.equal(decide(clean, { heal: { recipe: 'F', reason: 'x' }, force: 'A' }).recipe, 'A', 'a manual override wins');
});

test('ladder: A -> B (floor B), B/C/D -> F, nothing below F, no step for an overridden camera', () => {
  const m = memoryProfileStore(['cam01', 'cam28', 'cam06', 'cam26', 'cam22'].map(byId));
  const row = (id: string) => m.rows.get(`grid/${id}`)!;
  assert.deepEqual(nextRungDown(row('cam01'), 'qsv'), { floor: 'B', from: 'A', to: 'B' });
  assert.deepEqual(nextRungDown(row('cam28'), 'qsv'), { floor: 'F', from: 'B', to: 'F' });
  assert.deepEqual(nextRungDown(row('cam06'), 'qsv'), { floor: 'F', from: 'C', to: 'F' });
  assert.deepEqual(nextRungDown(row('cam26'), 'qsv'), { floor: 'F', from: 'D', to: 'F' });
  assert.equal(nextRungDown(row('cam22'), 'qsv'), null);
  assert.deepEqual(nextRungDown(row('cam01'), 'none'), { floor: 'B', from: 'A', to: 'F' });
  assert.equal(nextRungDown({ ...row('cam01'), override: 'A' }, 'qsv'), null);
  assert.equal(nextRungDown({ ...row('cam01'), healFloor: { recipe: 'F', reason: '', at: '' } }, 'qsv'), null);
});

test('dry run: three crashes in ten minutes are recorded as "would move" and change nothing', async () => {
  const s = setup(['cam01'], 'dry');
  await crashes(s, 'cam01', T0);
  assert.equal(s.row('cam01').healFloor, null);
  assert.equal(effectiveRecipe(s.row('cam01'), 'qsv'), 'A');
  assert.equal(s.applies(), 0);
  assert.equal(s.changes.length, 1);
  assert.deepEqual([s.changes[0].source, s.changes[0].from, s.changes[0].to], ['dry', 'A', 'B']);
  assert.match(s.changes[0].trigger, /3 muxer crashes in 2 min/);
  assert.equal((s.changes[0].evidence.events as unknown[]).length, 3);
  assert.equal(s.healer.status().counters.wouldDemote, 1);
});

test('on: demotes A -> B, records the evidence and the packet loss, applies once, and respects the cooldown', async () => {
  const c = setup(['cam01']); // clean, so the table plays it direct and the first step is A -> B
  await c.healer.onEvent({ cameraId: 'cam01', kind: 'packet_loss', at: T0, message: '', value: 1000 });
  await crashes(c, 'cam01', T0);
  assert.deepEqual(c.row('cam01').healFloor && [c.row('cam01').healFloor!.recipe], ['B']);
  assert.equal(effectiveRecipe(c.row('cam01'), 'qsv'), 'B');
  assert.equal(c.applies(), 1);
  assert.equal(c.changes[0].evidence.rtpPacketsLost, 1000);
  assert.equal(c.changes[0].source, 'auto');

  // More crashes inside the cooldown: no second step, even though the window fills again.
  c.set(T0 + 10 * MIN);
  await crashes(c, 'cam01', T0 + 10 * MIN);
  assert.equal(effectiveRecipe(c.row('cam01'), 'qsv'), 'B');
  assert.equal(c.changes.length, 1);

  // After the cooldown the next three move it B -> F.
  c.set(T0 + 45 * MIN);
  await crashes(c, 'cam01', T0 + 45 * MIN);
  assert.equal(c.row('cam01').healFloor?.recipe, 'F');
  assert.equal(effectiveRecipe(c.row('cam01'), 'qsv'), 'F');
  assert.deepEqual(c.changes.map((x) => `${x.from}>${x.to}`), ['A>B', 'B>F']);
  assert.equal(c.applies(), 2);
});

test('what does not count: two crashes, crashes spread over more than the window, 401s, loss alone, and other classes mixed', async () => {
  const s = setup(['cam01']);
  await crashes(s, 'cam01', T0, 2);
  await s.healer.onEvent(crash('cam01', T0 + 11 * MIN)); // the first two have aged out of the 10 minute window
  await s.healer.idle();
  for (let i = 0; i < 10; i++) await s.healer.onEvent({ cameraId: 'cam01', kind: 'auth_rejected', at: T0 + 12 * MIN, message: '401' });
  await s.healer.onEvent({ cameraId: 'cam01', kind: 'packet_loss', at: T0 + 12 * MIN, message: '', value: 99_999 });
  // one crash of each of three classes is not three of one class
  await s.healer.onEvent({ cameraId: 'cam01', kind: 'source_error', at: T0 + 12 * MIN, message: '' });
  await s.healer.onEvent({ cameraId: 'cam01', kind: 'ffmpeg_exit', at: T0 + 12 * MIN, message: '' });
  await s.healer.idle();
  assert.equal(s.changes.length, 0);
  assert.equal(s.row('cam01').healFloor, null);
  assert.equal(s.healer.status().counters.ignoredAuth, 10);
});

test('a manual override is never changed by self-healing, a camera that failed its probe is left alone, and off ignores events', async () => {
  const o = setup(['cam01']);
  o.row('cam01').override = 'A';
  await crashes(o, 'cam01', T0);
  assert.equal(o.changes.length, 0);
  assert.equal(o.healer.status().counters.skippedOverride, 1);

  const g = setup(['cam22']);
  await crashes(g, 'cam22', T0);
  assert.equal(g.changes.length, 0);

  const m = memoryProfileStore([byId('cam01')]);
  const off = createSelfHealer({ store: m.store, site: 'grid', encoder: 'qsv', mode: 'off', now: () => T0 });
  for (let i = 0; i < 5; i++) await off.onEvent(crash('cam01', T0 + i * MIN));
  await off.idle();
  assert.equal(m.changes.length, 0);
});

test('a camera nobody profiled is ignored, and events from one camera never count for another', async () => {
  const s = setup(['cam01', 'cam03']);
  await s.healer.onEvent(crash('cam01', T0)); await s.healer.onEvent(crash('cam03', T0 + 1)); await s.healer.onEvent(crash('cam01', T0 + 2)); await s.healer.onEvent(crash('cam03', T0 + 3));
  await crashes(s, 'camNEW', T0);
  assert.equal(s.changes.length, 0);
});

test('promotion needs clean probes in a row AND the time, and each rung restarts the clock (F -> B -> measured)', () => {
  const s = setup(['cam01']);
  const row = s.row('cam01');
  const probe = (offsetH: number, over: Partial<ProbeReport> = {}): ProbeReport => ({ ...byId('cam01'), probedAt: new Date(T0 + offsetH * HOUR).toISOString(), ...over });
  const dirty = (offsetH: number) => probe(offsetH, { sample: { ...byId('cam01').sample!, corruptErrors: 100 }, flags: ['corrupt_frames'] });
  row.healFloor = { recipe: 'F', reason: 'x', at: new Date(T0).toISOString() };
  const cfg = DEFAULT_HEAL_CONFIG;
  const ask = (hist: ProbeReport[], at: number) => promotion(row, hist, T0 + at * HOUR, cfg, 'qsv');

  assert.equal(ask([probe(2), probe(1)], 3), null, 'clean probes, but not 24 hours yet');
  assert.equal(ask([probe(25)], 26), null, 'only one clean probe');
  assert.equal(ask([probe(26), probe(25)], 27)?.floor, 'B', 'F -> B first when the stream is clean enough to play direct');
  assert.equal(ask([probe(26), dirty(25)], 27), null, 'a damaged probe in between stops it');
  assert.equal(ask([probe(26), probe(25), probe(-1)], 27)?.probes, 2, 'only probes after the move count');
  row.healFloor = { recipe: 'B', reason: 'x', at: new Date(T0).toISOString() };
  assert.deepEqual(ask([probe(26), probe(25)], 27), { floor: null, probes: 2 }, 'B -> measured');
  // A camera whose measurements already re-encode never needs the B rung.
  // cam24 re-encodes by nature (B-frames, long gaps) but has no damage: from F it goes straight back to measured.
  const m = memoryProfileStore([byId('cam24'), byId('cam28')]);
  const r24 = m.rows.get('grid/cam24')!;
  r24.healFloor = { recipe: 'F', reason: 'x', at: new Date(T0).toISOString() };
  const p24 = (h: number): ProbeReport => ({ ...byId('cam24'), probedAt: new Date(T0 + h * HOUR).toISOString() });
  assert.deepEqual(promotion(r24, [p24(26), p24(25)], T0 + 27 * HOUR, cfg, 'qsv'), { floor: null, probes: 2 });
  // cam28 is damaged by nature: it stays where self-healing put it until a person resets it.
  const r28 = m.rows.get('grid/cam28')!;
  r28.healFloor = { recipe: 'F', reason: 'x', at: new Date(T0).toISOString() };
  const p28 = (h: number): ProbeReport => ({ ...byId('cam28'), probedAt: new Date(T0 + h * HOUR).toISOString() });
  assert.equal(promotion(r28, [p28(26), p28(25)], T0 + 27 * HOUR, cfg, 'qsv'), null);
});

test('end to end: re-probes bring a demoted camera back up one rung at a time; a flapping camera does not', async () => {
  const s = setup(['cam01']);
  await crashes(s, 'cam01', T0); // A -> B
  s.set(T0 + 31 * MIN);
  await crashes(s, 'cam01', T0 + 31 * MIN); // B -> F
  assert.equal(effectiveRecipe(s.row('cam01'), 'qsv'), 'F');
  const floorAt = Date.parse(s.row('cam01').healFloor!.at);

  const reprobe = async (afterMs: number, bad = false) => {
    const at = floorAt + afterMs;
    s.set(at);
    const report: ProbeReport = bad
      ? { ...byId('cam01'), probedAt: new Date(at).toISOString(), sample: { ...byId('cam01').sample!, corruptErrors: 200 }, flags: ['corrupt_frames'] }
      : { ...byId('cam01'), probedAt: new Date(at).toISOString() };
    const prev = s.rows.get('grid/cam01') ?? null;
    await s.store.saveProbe(report);
    await s.store.saveDecision('grid', 'cam01', { ...decide(report) });
    await s.healer.afterProbe(report, prev);
    await s.healer.idle();
  };

  await reprobe(1 * HOUR); await reprobe(2 * HOUR);
  assert.equal(s.row('cam01').healFloor?.recipe, 'F', 'clean, but too early');
  await reprobe(25 * HOUR, true); await reprobe(26 * HOUR);
  assert.equal(s.row('cam01').healFloor?.recipe, 'F', 'a damaged probe breaks the run of clean ones');
  await reprobe(27 * HOUR);
  assert.equal(s.row('cam01').healFloor?.recipe, 'B', 'two clean in a row after 24 h: F -> B');
  await reprobe(28 * HOUR); await reprobe(29 * HOUR);
  assert.equal(s.row('cam01').healFloor?.recipe, 'B', 'the clock restarted at the new rung, so not yet');
  await reprobe(52 * HOUR); await reprobe(53 * HOUR);
  assert.equal(s.row('cam01').healFloor, null);
  assert.equal(effectiveRecipe(s.row('cam01'), 'qsv'), 'A');
  assert.ok(s.changes.filter((c) => c.source === 'auto').map((c) => `${c.from}>${c.to}`).join(',').endsWith('F>B,B>A'));
});

test('a re-probe that changes the choice is recorded, and applied only when self-healing is on', async () => {
  for (const mode of ['dry', 'on'] as const) {
    const s = setup(['cam01'], mode);
    const prev = s.row('cam01');
    const worse: ProbeReport = { ...byId('cam01'), probedAt: new Date(T0 + HOUR).toISOString(), sample: { ...byId('cam01').sample!, corruptErrors: 200 }, flags: ['corrupt_frames'] };
    await s.store.saveProbe(worse);
    await s.healer.afterProbe(worse, prev);
    await s.healer.idle();
    assert.deepEqual(s.changes.map((c) => [c.source, c.from, c.to]), [['reprobe', 'A', 'B']], mode);
    assert.match(s.changes[0].trigger, /damaged video/);
    assert.equal(s.applies(), mode === 'on' ? 1 : 0, mode);
  }
});

test('reset to measured clears the floor, records who did it, and applies when on', async () => {
  const s = setup(['cam01']);
  await crashes(s, 'cam01', T0);
  assert.equal(await s.healer.reset('cam01'), true);
  assert.equal(s.row('cam01').healFloor, null);
  assert.deepEqual(s.changes.map((c) => c.source), ['auto', 'manual']);
  assert.equal(s.applies(), 2);
  assert.equal(await s.healer.reset('cam01'), false, 'nothing left to reset');
});

test('a failing apply is reported, not thrown, and the demotion still stands', async () => {
  const m = memoryProfileStore([byId('cam01')]);
  const healer = createSelfHealer({ store: m.store, site: 'grid', encoder: 'qsv', mode: 'on', now: () => T0, apply: async () => ['replace cam01: 500'] });
  for (let i = 0; i < 3; i++) await healer.onEvent(crash('cam01', T0 + i * MIN));
  await healer.idle();
  assert.equal(m.rows.get('grid/cam01')!.healFloor?.recipe, 'B');
  assert.match(healer.status().lastError ?? '', /replace cam01: 500/);
  assert.equal(healer.status().counters.applyErrors, 1);
});

test('settings: dry by default, numbers from the environment, nonsense falls back', () => {
  assert.equal(healModeFromEnv({}), 'dry');
  assert.equal(healModeFromEnv({ MEDIA_SELF_HEAL: 'ON' }), 'on');
  assert.equal(healModeFromEnv({ MEDIA_SELF_HEAL: 'off' }), 'off');
  assert.equal(healModeFromEnv({ MEDIA_SELF_HEAL: 'yes please' }), 'dry');
  assert.deepEqual(healConfigFromEnv({}), DEFAULT_HEAL_CONFIG);
  const c = healConfigFromEnv({ MEDIA_HEAL_FAILURES: '5', MEDIA_HEAL_WINDOW_MIN: '2', MEDIA_HEAL_COOLDOWN_MIN: 'abc', MEDIA_HEAL_PROMOTE_PROBES: '-1', MEDIA_HEAL_PROMOTE_HOURS: '12' });
  assert.deepEqual([c.failures, c.windowMs, c.cooldownMs, c.promoteProbes, c.promoteAfterMs], [5, 2 * MIN, 30 * MIN, 2, 12 * HOUR]);
});

test('from a log file: MediaMTX lines appended to the file move the camera, and 401 noise does not', async () => {
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { tailFile } = await import('../server/logTail.ts');
  const { createMediaLogParser } = await import('../server/mediaEvents.ts');
  const dir = mkdtempSync(join(tmpdir(), 'heal-'));
  const file = join(dir, 'mediamtx.log');
  writeFileSync(file, '2026/10/09 02:00:00 ERR [HLS] [muxer cam01] unable to extract DTS: too many reordered frames (1)\n'); // history: ignored
  const s = setup(['cam01']);
  const parser = createMediaLogParser();
  const tail = tailFile(file, (line) => { const ev = parser.feed(line); if (ev) void s.healer.onEvent(ev); }, 3_600_000);
  try {
    await tail.poll();
    const stamp = (m: number, sec: number) => `2026/10/09 02:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    appendFileSync(file, [
      `${stamp(14, 1)} ERR [path cam01] [RTSP source] bad status code: 401 (Unauthorized)`,
      `${stamp(14, 2)} WAR [path cam01] [RTSP source] 1042 RTP packets lost`,
      `${stamp(14, 11)} ERR [HLS] [muxer cam01] unable to extract DTS: too many reordered frames (11)`,
      `${stamp(15, 40)} ERR [HLS] [muxer cam01] unable to extract DTS: too many reordered frames (9)`,
      `${stamp(16, 20)} ERR [HLS] [muxer cam01] unable to extract DTS: too many reordered frames (12)`,
      '',
    ].join('\n'));
    await tail.poll();
    await s.healer.idle();
    assert.equal(s.row('cam01').healFloor?.recipe, 'B');
    assert.equal(s.changes.length, 1);
    assert.equal(s.changes[0].evidence.rtpPacketsLost, 1042);
    assert.equal(s.healer.status().counters.ignoredAuth, 1);
    assert.equal(s.healer.status().counters.failureEvents, 3, 'the old line in the file before we started was not replayed');
  } finally { tail.stop(); rmSync(dir, { recursive: true, force: true }); }
});
