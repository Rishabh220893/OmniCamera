import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileRow, ProfileStore, ProbeReport } from '../server/cameraProfile.ts';
import { profileView, summarize, listViews, saveReport, importSaved, applyToMedia } from '../server/profileService.ts';
import { createProbeJob } from '../server/probeJob.ts';
import { pathBuildOptionsFromEnv } from '../server/mediaPlan.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';

/** An in-memory ProfileStore with the same behaviour as the Postgres one, for testing what sits on top of it. */
function memoryStore(initial: ProbeReport[] = []) {
  const rows = new Map<string, ProfileRow & { decision?: Record<string, unknown> }>();
  const log: string[] = [];
  for (const report of initial) rows.set(`${report.site}/${report.cameraId}`, { report, override: null, overrideReason: null });
  const store: ProfileStore = {
    ensureSchema: async () => {},
    async listProfiles(site) { return [...rows.values()].filter((r) => r.report.site === site).sort((a, b) => a.report.cameraId.localeCompare(b.report.cameraId)); },
    async saveProbe(report) { log.push(`probe ${report.cameraId}`); const prev = rows.get(`${report.site}/${report.cameraId}`); rows.set(`${report.site}/${report.cameraId}`, { report, override: prev?.override ?? null, overrideReason: prev?.overrideReason ?? null }); },
    async saveDecision(site, cameraId, decision) { log.push(`decision ${cameraId} ${decision.recipe}`); const r = rows.get(`${site}/${cameraId}`); if (r) r.decision = decision; },
    async setOverride(site, cameraId, recipe, reason) { const r = rows.get(`${site}/${cameraId}`); if (r) { r.override = recipe; r.overrideReason = reason; } },
    async history() { return []; },
  };
  return { store, rows, log };
}
const byId = (id: string) => GRID_REPORTS.find((r) => r.cameraId === id)!;
const row = (id: string, override: string | null = null, overrideReason: string | null = null): ProfileRow => ({ report: byId(id), override, overrideReason });

test('view: what was measured and what was decided, in numbers a person can read', () => {
  const v = profileView(row('cam28'), 'qsv');
  assert.equal(v.recipe, 'B');
  assert.equal(v.codec, 'h264');
  assert.deepEqual([v.width, v.height], [1280, 960]);
  assert.equal(v.firstFrameSec, 22.6);
  assert.equal(v.keyframeGapSec, 16.9);
  assert.equal(v.reorderSec, 2);
  assert.equal(v.damagePer100, 34);
  assert.equal(v.pathKind, 're-encode');
  assert.equal(v.cause, 'B-frames, long gaps between keyframes, damaged video');
  assert.equal(v.override, null);
  assert.match(v.reason, /B-frames.*keyframes up to 17s apart.*damaged video/);
  const clean = profileView(row('cam01'), 'qsv');
  assert.deepEqual([clean.recipe, clean.pathKind, clean.gridLive, clean.webrtcFocus, clean.speed], ['A', 'pull', true, true, 'fast']);
});

test('view: failures show why, and have no path', () => {
  const v = profileView(row('cam22'), 'qsv');
  assert.equal(v.recipe, 'G');
  assert.equal(v.failure, 'no_frame');
  assert.equal(v.pathKind, 'none');
  assert.equal(v.firstFrameSec, null);
  assert.equal(v.keyframeGapSec, null);
  assert.equal(v.damagePer100, null);
});

test('view: an override changes the recipe and keeps what the measurements chose', () => {
  const v = profileView(row('cam01', 'B', 'flickers on the big screen'), 'qsv');
  assert.equal(v.recipe, 'B');
  assert.equal(v.naturalRecipe, 'A');
  assert.equal(v.override, 'B');
  assert.equal(v.overrideReason, 'flickers on the big screen');
  assert.equal(v.pathKind, 're-encode');
  assert.match(v.reason, /Manual override to B \(the measurements chose A/);
  assert.equal(profileView(row('cam28', 'F', 'bandwidth'), 'qsv').pathKind, 'none');
});

test('view: with no hardware encoder a camera that needs a re-encode shows as snapshots only', () => {
  const v = profileView(row('cam28'), 'none');
  assert.equal(v.recipe, 'F');
  assert.match(v.reason, /no hardware encoder/);
});

test('summary: counts per recipe, the cameras that need a slot, and how many fit at once', () => {
  const views = GRID_REPORTS.map((r) => profileView({ report: r, override: null, overrideReason: null }, 'qsv'));
  const s = summarize(views, 6);
  assert.deepEqual(s.counts, { A: 4, B: 19, C: 4, D: 1, E: 0, F: 0, G: 2 });
  assert.equal(s.total, 30);
  assert.equal(s.needSlots, 24);
  assert.equal(s.liveTogether, 6);
  assert.equal(s.slots, 6);
  assert.equal(summarize(views, 100).liveTogether, 24);
  const withOverride = GRID_REPORTS.map((r) => profileView({ report: r, override: r.cameraId === 'cam01' ? 'B' : null, overrideReason: 'x' }, 'qsv'));
  assert.equal(summarize(withOverride, 6).overrides, 1);
  assert.equal(summarize(withOverride, 6).needSlots, 25);
});

test('list: sorted by camera number, not as text', async () => {
  const { store } = memoryStore(GRID_REPORTS.map((r, i) => ({ ...r, cameraId: ['cam10', 'cam2', 'cam1'][i % 3] + (i < 3 ? '' : String(i)) })).slice(0, 3));
  assert.deepEqual((await listViews(store, 'grid', 'qsv')).map((v) => v.cameraId), ['cam1', 'cam2', 'cam10']);
});

test('saving a probe stores the report and the decision, and keeps an existing override', async () => {
  const m = memoryStore([byId('cam01')]);
  await m.store.setOverride('grid', 'cam01', 'B', 'keep');
  await saveReport(m.store, { ...byId('cam01'), probedAt: '2026-10-09T00:00:00.000Z' }, 'qsv');
  assert.deepEqual(m.log, ['probe cam01', 'decision cam01 A']);
  assert.equal(m.rows.get('grid/cam01')!.override, 'B');
  assert.equal(m.rows.get('grid/cam01')!.report.probedAt, '2026-10-09T00:00:00.000Z');
});

test('import: loads the saved probe runs of one site, merged, with their decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ reports: [byId('cam01'), byId('cam22'), { ...byId('cam02'), site: 'elsewhere' }] }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ reports: [{ ...byId('cam22'), failure: 'bad_credentials' }] }));
  const m = memoryStore();
  const n = await importSaved(m.store, 'grid', [join(dir, 'a.json'), join(dir, 'b.json')], 'qsv');
  assert.equal(n, 2);
  assert.deepEqual([...m.rows.keys()].sort(), ['grid/cam01', 'grid/cam22']);
  assert.equal(m.rows.get('grid/cam22')!.decision?.recipe, 'G');
});

const env = { GRID_EMAIL: 'me@example.com', GRID_PASSWORD: 'pw', GRID_RTSP_HOST: '203.0.113.9' };
function stubApi(existing: Array<Record<string, unknown>> = []) {
  const calls: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/list')) return new Response(JSON.stringify({ pageCount: 1, items: existing }), { status: 200 });
    calls.push(`${init?.method ?? 'GET'} ${u.pathname.replace('/v3/config/paths/', '')}`);
    return new Response('', { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

test('apply to media server: a dry run changes and writes nothing; a real apply changes the server and writes the file', async () => {
  const m = memoryStore([byId('cam01'), byId('cam28'), byId('cam22')]);
  const api = stubApi();
  const dir = mkdtempSync(join(tmpdir(), 'apply-'));
  const file = join(dir, 'bin', 'paths.generated.yml');
  const base = { site: 'grid', encoder: 'qsv' as const, build: pathBuildOptionsFromEnv('grid', env), api: 'http://127.0.0.1:9997', pathsFile: file, fetchImpl: api.impl };
  const dry = await applyToMedia(m.store, { ...base, dryRun: true });
  assert.deepEqual([dry.dryRun, dry.add, dry.replace, dry.remove, dry.fileWritten], [true, ['cam01', 'cam28'], [], [], null]);
  assert.deepEqual(api.calls, []);
  assert.equal(existsSync(file), false);
  const real = await applyToMedia(m.store, { ...base, dryRun: false });
  assert.deepEqual(api.calls.sort(), ['POST add/cam01', 'POST add/cam28']);
  assert.equal(real.fileWritten, file);
  const yml = readFileSync(file, 'utf8');
  assert.match(yml, /^ {2}cam01:\n {4}source: rtsp:\/\/me%40example\.com:pw@203\.0\.113\.9/m);
  assert.match(yml, /^ {2}cam28:\n {4}runOnDemand: 'ffmpeg/m);
  assert.doesNotMatch(yml, /cam22:/, 'no video, no path');
  assert.deepEqual(real.errors, []);
});

// ---- The probe job -----------------------------------------------------------------------------------------------

const fakeReport = (id: string, failure: ProbeReport['failure'] = null): ProbeReport => ({ ...byId('cam01'), cameraId: id, failure, failureDetail: failure ? 'x' : null });
const noSleep = { rejectionPauseMs: 0, sleep: async () => {} };

test('probe job: runs every camera, saves each result, and counts ok and failed', async () => {
  const saved: string[] = [];
  let running = 0, peak = 0;
  const job = createProbeJob({
    ...noSleep, concurrency: 2,
    probe: async (id) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return fakeReport(id, id === 'cam03' ? 'no_frame' : null); },
    save: async (r) => { saved.push(r.cameraId); },
  });
  assert.equal(job.start(['cam01', 'cam02', 'cam03', 'cam04', 'cam01']), true, 'duplicates are dropped');
  assert.equal(job.status().state, 'running');
  assert.equal(job.start(['cam09']), false, 'one run at a time');
  await job.settled();
  const s = job.status();
  assert.deepEqual([s.state, s.total, s.done, s.ok, s.failed, s.current], ['finished', 4, 4, 3, 1, []]);
  assert.deepEqual(saved.sort(), ['cam01', 'cam02', 'cam03', 'cam04']);
  assert.equal(peak, 2);
  assert.equal(job.start(['cam05']), true, 'a new run can start once the last one ended');
  await job.settled();
});

test('probe job: a 401 after good probes is retried once after a pause, and noted', async () => {
  let attempts = 0;
  const saved: ProbeReport[] = [];
  const job = createProbeJob({
    ...noSleep, concurrency: 1,
    probe: async (id) => { if (id === 'cam02' && attempts++ === 0) return fakeReport(id, 'bad_credentials'); return fakeReport(id); },
    save: async (r) => { saved.push(r); },
  });
  job.start(['cam01', 'cam02']);
  await job.settled();
  assert.deepEqual([job.status().state, job.status().ok, job.status().failed], ['finished', 2, 0]);
  assert.match(saved.find((r) => r.cameraId === 'cam02')!.notes![0], /rejected with 401 although earlier cameras/);
});

test('probe job: stops when the source keeps refusing, and says whether the login or a limit is to blame', async () => {
  const never = createProbeJob({ ...noSleep, concurrency: 1, probe: async (id) => fakeReport(id, 'bad_credentials'), save: async () => {} });
  never.start(['cam01', 'cam02', 'cam03', 'cam04', 'cam05']);
  await never.settled();
  assert.equal(never.status().state, 'stopped');
  assert.equal(never.status().done, 3);
  assert.match(never.status().message!, /rejected the login 3 times/);

  let n = 0;
  const later = createProbeJob({ ...noSleep, concurrency: 1, probe: async (id) => (n++ < 1 ? fakeReport(id) : fakeReport(id, 'bad_credentials')), save: async () => {} });
  later.start(['cam01', 'cam02', 'cam03', 'cam04', 'cam05', 'cam06', 'cam07', 'cam08']);
  await later.settled();
  assert.equal(later.status().state, 'stopped');
  assert.match(later.status().message!, /started refusing this account after 1 good probes.*not a wrong password/);
});

test('probe job: stop() ends the run and keeps what was probed; a camera that throws or fails to save does not end the run', async () => {
  const saved: string[] = [];
  const job = createProbeJob({ ...noSleep, concurrency: 1, probe: async (id) => { await new Promise((r) => setTimeout(r, 5)); return fakeReport(id); }, save: async (r) => { saved.push(r.cameraId); } });
  job.start(['cam01', 'cam02', 'cam03', 'cam04']);
  await new Promise((r) => setTimeout(r, 8));
  job.stop();
  await job.settled();
  assert.equal(job.status().state, 'stopped');
  assert.ok(saved.length >= 1 && saved.length < 4);
  assert.match(job.status().message!, /Stopped/);

  const odd = createProbeJob({
    ...noSleep, concurrency: 1,
    probe: async (id) => { if (id === 'cam02') throw new Error('ffmpeg not found'); return fakeReport(id); },
    save: async (r) => { if (r.cameraId === 'cam03') throw new Error('database down'); },
  });
  odd.start(['cam01', 'cam02', 'cam03', 'cam04']);
  await odd.settled();
  assert.deepEqual([odd.status().state, odd.status().done, odd.status().failed], ['finished', 4, 1]);
  assert.match(odd.status().message!, /Could not save cam03: database down|cam02: ffmpeg not found/);
});
