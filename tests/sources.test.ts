/**
 * Cameras onboarded through adapters (federation plan A4): the sealed address, path building from a per-camera source, the onboarding
 * service (with its refusals and its rollback), putting the paths on the media server next to the grid's, the HTTP routes, and what a tile
 * needs to play such a camera.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createSecretBox, parseSecretKey, secretBoxFromEnv, SecretKeyError } from '../server/sources/secretBox.ts';
import { SOURCES_SITE, createMemorySourceStore } from '../server/sources/store.ts';
import { createOnboarding, pickRtsp, type NewRegistryCamera, type RegistryWriter } from '../server/sources/onboard.ts';
import { openSourceAddress } from '../server/sources/address.ts';
import { sourcesMediaPlan } from '../server/sources/media.ts';
import { applySourcesMedia } from '../server/sources/apply.ts';
import { createFirestoreRegistryWriter, registryDocument } from '../server/sources/firestoreRegistry.ts';
import { registerSourceRoutes, type SourceRoutesContext } from '../server/sources/routes.ts';
import { createAdapterRegistry, AdapterError, type CameraRef, type SourceAdapter, type StreamEndpoint } from '../server/adapters/index.ts';
import { buildPaths, renderPathsYaml, type PathBuildOptions } from '../server/mediaPaths.ts';
import { decide } from '../server/cameraRecipe.ts';
import type { ProbeReport } from '../server/cameraProfile.ts';
import { GRID_REPORTS } from './fixtures/grid-2026-10-08.ts';
import { memoryProfileStore } from './fixtures/memoryProfileStore.ts';
import { gridCamId, mediaPathId } from '../src/lib/gridCamId.ts';
import { plannedRecipes } from '../src/lib/panelTiles.ts';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const box = createSecretBox(parseSecretKey(KEY));

// ---- the sealed address --------------------------------------------------------------------------------------------------------

test('secret box: seals and opens; a different key, a changed value or a plain value is refused; nothing readable is stored', () => {
  const url = 'rtsp://admin:Pa%24%24w0rd@10.0.0.5:554/Streaming/Channels/101';
  const sealed = box.seal(JSON.stringify({ rtspUrl: url }));
  assert.match(sealed, /^v1\./);
  assert.equal(sealed.includes('Pa%24%24w0rd') || sealed.includes('admin'), false, 'the login is not in the stored text');
  assert.notEqual(box.seal('x'), box.seal('x'), 'a fresh nonce each time');
  assert.deepEqual(JSON.parse(box.open(sealed)), { rtspUrl: url });
  const other = createSecretBox(Buffer.alloc(32, 7));
  assert.throws(() => other.open(sealed), SecretKeyError);
  const parts = sealed.split('.'); parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => box.open(parts.join('.')), SecretKeyError);
  assert.throws(() => box.open('not sealed'), SecretKeyError);
});

test('secret key: hex or base64 of 32 bytes; a bad one is an error, none at all is "no box"', () => {
  assert.equal(parseSecretKey(KEY).length, 32);
  assert.equal(parseSecretKey(Buffer.alloc(32, 1).toString('base64')).length, 32);
  assert.throws(() => parseSecretKey('too short'), SecretKeyError);
  assert.equal(secretBoxFromEnv({}), null);
  assert.equal(secretBoxFromEnv({ SOURCE_SECRET_KEY: '  ' }), null);
  assert.throws(() => secretBoxFromEnv({ SOURCE_SECRET_KEY: 'abc' }), SecretKeyError);
  assert.ok(secretBoxFromEnv({ SOURCE_SECRET_KEY: KEY }));
});

test('address: a sealed value needs the key; a value with no login is stored plain and needs none', () => {
  const sealed = box.seal(JSON.stringify({ rtspUrl: 'rtsp://u:p@h/x' }));
  assert.equal(openSourceAddress({ cameraId: 'a', sealed }, box).rtspUrl, 'rtsp://u:p@h/x');
  assert.throws(() => openSourceAddress({ cameraId: 'a', sealed }, null), /SOURCE_SECRET_KEY/);
  assert.equal(openSourceAddress({ cameraId: 'a', sealed: JSON.stringify({ rtspUrl: 'rtsp://h/x' }) }, null).rtspUrl, 'rtsp://h/x');
  assert.throws(() => openSourceAddress({ cameraId: 'a', sealed: null }, box), /no stored address/);
});

// ---- paths from a camera's own address -----------------------------------------------------------------------------------------

const gridOpts = (over: Partial<PathBuildOptions> = {}): PathBuildOptions => ({
  site: { host: '103.250.160.189', rtspPort: 8554, pathPrefix: 'stream' }, credentials: () => ({ user: 'me@example.com', pass: 'p@ss' }),
  transcode: { ffmpeg: 'ffmpeg', bitrate: '2500k', publishPort: 18554, scaleFilter: null }, startTimeout: '60s', closeAfter: '5s', ...over,
});
const fixture = (id: string) => GRID_REPORTS.find((r) => r.cameraId === id)!;
const asSource = (base: string, id: string, over: Partial<ProbeReport> = {}): ProbeReport => ({ ...structuredClone(fixture(base)), cameraId: id, site: SOURCES_SITE, ...over });
const item = (id: string, base = 'cam01') => ({ cameraId: id, decision: decide(asSource(base, id), { encoder: 'qsv' }) });

test('paths: a camera with its own address is pulled from it, plain or through ffmpeg; the grid\'s login is never used for it', () => {
  const urls: Record<string, string> = { 'fed-aaa111': 'rtsp://admin:secret@10.1.1.5:554/Streaming/Channels/101', 'fed-bbb222': 'rtsp://10.1.1.6/stream?channel=1&subtype=0' };
  const o = gridOpts({ credentials: () => { throw new Error('the grid login must not be asked for'); }, sourceUrlFor: (id) => urls[id] ?? null, requireSource: true });
  const plain = buildPaths([item('fed-aaa111')], o).paths['fed-aaa111'];
  assert.equal(plain.source, urls['fed-aaa111']);
  assert.equal(plain.sourceOnDemand, true);
  const hevc = buildPaths([item('fed-bbb222', 'cam06')], o).paths['fed-bbb222'];
  assert.match(hevc.runOnDemand!, /-c:v hevc_qsv -rtsp_transport tcp -i rtsp:\/\/10\.1\.1\.6\/stream\?channel=1&subtype=0 -an/);
  assert.match(hevc.runOnDemand!, /rtsp:\/\/127\.0\.0\.1:18554\/fed-bbb222$/);
  const r = buildPaths([item('fed-unknown')], o);
  assert.deepEqual(Object.keys(r.paths), []);
  assert.deepEqual(r.skipped, [{ cameraId: 'fed-unknown', why: 'no stored address for this camera' }]);
});

test('paths: without requireSource a camera the source map does not know is still the grid\'s; the YAML quotes addresses that need it', () => {
  const o = gridOpts({ sourceUrlFor: () => null });
  assert.match(buildPaths([{ cameraId: 'cam01', decision: decide(fixture('cam01'), {}) }], o).paths.cam01.source!, /^rtsp:\/\/me%40example\.com:p%40ss@103\.250\.160\.189:8554\/stream\/cam01$/);
  const yml = renderPathsYaml({
    'fed-a': { source: 'rtsp://u:p@h:554/a?x=1&y=2', rtspTransport: 'tcp', sourceOnDemand: true },
    'fed-b': { source: "rtsp://u:it's #hot@h/a", rtspTransport: 'tcp' },
  });
  assert.match(yml, /source: rtsp:\/\/u:p@h:554\/a\?x=1&y=2\n/, 'a normal address stays plain');
  assert.match(yml, /source: 'rtsp:\/\/u:it''s #hot@h\/a'\n/, 'an address with a quote and a # is quoted');
});

// ---- the onboarding service ----------------------------------------------------------------------------------------------------

/** A stand-in adapter. Like the real ones, its probe reports under the id it was given. */
function fakeAdapter(kind: string, o: { url?: string; report?: (id: string) => ProbeReport; endpoints?: StreamEndpoint[]; deviceFails?: boolean; probes?: string[]; delayMs?: number } = {}): SourceAdapter {
  return {
    kind, label: kind, description: kind, accepts: () => true,
    deviceInfo: async () => { if (o.deviceFails) throw new AdapterError('no device info'); return { manufacturer: 'Acme', model: 'X-100', firmware: '1', serial: 's', hardwareId: null }; },
    channels: async () => [{ channel: 1, name: 'Gate', online: true, address: null }, { channel: 2, name: null, online: false, address: null }, { channel: 3, name: 'Yard', online: null, address: null }],
    endpoints: async () => o.endpoints ?? [{ protocol: 'rtsp', role: 'analysis', url: o.url ?? 'rtsp://admin:s3cret@10.1.1.5:554/Streaming/Channels/101', label: 'Main stream' }],
    probe: async (ref: CameraRef) => { o.probes?.push(ref.id); if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs)); return (o.report ?? ((id: string) => asSource('cam01', id)))(ref.id); },
  };
}

function setup(o: { adapter?: SourceAdapter; withBox?: boolean; registryFails?: boolean; base?: string } = {}) {
  const profiles = memoryProfileStore();
  const sources = createMemorySourceStore();
  const created: NewRegistryCamera[] = [];
  const removed: string[] = [];
  const registry: RegistryWriter = {
    create: async (c) => { if (o.registryFails) throw new Error('Firestore is down'); created.push(c); return `reg-${created.length}`; },
    remove: async (id) => { removed.push(id); },
  };
  const rtsp = fakeAdapter('rtsp');
  const adapters = createAdapterRegistry([o.adapter ?? fakeAdapter('hikvision'), rtsp]);
  let n = 0;
  const onboarding = createOnboarding({
    adapters, profiles: profiles.store, sources, registry, box: o.withBox === false ? null : box, encoder: 'qsv',
    mediaBase: () => o.base ?? 'https://media.example.org', newId: () => `fed-${(++n).toString(16).padStart(12, '0')}`, now: () => new Date('2026-10-10T10:00:00Z'), log: { warn() {}, info() {} },
  });
  return { onboarding, profiles, sources, created, removed, adapters };
}
const input = { camera: { id: 'device', adapter: 'hikvision', host: '10.1.1.5' } as CameraRef, ownerUid: 'admin-1' };

test('onboard: probes through the adapter, then saves profile, sealed source and Registry camera; the camera is found by its media path', async () => {
  const t = setup();
  const r = await t.onboarding.onboardOne({ ...input, name: 'Gate camera', departmentId: 'Traffic' });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.cameraId, 'fed-000000000001');
  assert.equal(r.recipe, 'A');
  assert.equal(r.pathKind, 'pull');
  assert.deepEqual(r.device?.model, 'X-100');
  const prof = await t.profiles.store.getProfile(SOURCES_SITE, r.cameraId);
  assert.equal(prof!.report.site, SOURCES_SITE, 'profiled under the sources site, with the path as its id');
  const rec = (await t.sources.get(SOURCES_SITE, r.cameraId))!;
  assert.equal(rec.registryId, 'reg-1');
  assert.equal(rec.departmentId, 'Traffic');
  assert.equal(JSON.stringify(rec).includes('s3cret'), false, 'no login anywhere in the stored record');
  assert.equal(openSourceAddress(rec, box).rtspUrl, 'rtsp://admin:s3cret@10.1.1.5:554/Streaming/Channels/101');
  const cam = t.created[0];
  assert.deepEqual([cam.name, cam.ownerUid, cam.departmentId, cam.adapter, cam.sourceId], ['Gate camera', 'admin-1', 'Traffic', 'hikvision', r.cameraId]);
  assert.equal(mediaPathId(cam.streamUrl), r.cameraId, 'a tile finds the path in the camera\'s stream address');
  assert.equal(gridCamId(cam.streamUrl), null, 'and it is not mistaken for a grid camera');
  assert.match(cam.streamUrl, /^https:\/\/media\.example\.org\/fed-/);
  const doc = registryDocument(cam, 'NOW');
  assert.equal(JSON.stringify(doc).includes('s3cret'), false, 'the Registry document carries no login');
  assert.deepEqual([doc.useRemoteFeed, doc.onboardedVia, doc.sourceId, doc.departmentId], [true, 'adapter', r.cameraId, 'Traffic']);
});

test('onboard: an H.265 camera is planned as a re-encode, and its media path is built from the stored address', async () => {
  const t = setup({ adapter: fakeAdapter('hikvision', { report: (id) => asSource('cam06', id) }) });
  const r = await t.onboarding.onboardOne(input);
  assert.ok(r.ok && r.pathKind === 're-encode');
  const plan = await sourcesMediaPlan({ profiles: t.profiles.store, sources: t.sources, box, encoder: 'qsv', build: gridOpts() });
  assert.deepEqual(Object.keys(plan.paths), ['fed-000000000001']);
  assert.match(plan.paths['fed-000000000001'].runOnDemand!, /-i rtsp:\/\/admin:s3cret@10\.1\.1\.5:554\/Streaming\/Channels\/101 -an/);
  assert.deepEqual(plan.managed, ['fed-000000000001']);
});

test('onboard: an unreachable camera, a refused login and a camera with no video are refused, and nothing is left behind', async () => {
  for (const [failure, code] of [['unreachable', 'unreachable'], ['bad_credentials', 'bad_credentials'], ['no_frame', 'no_video']] as const) {
    const t = setup({ adapter: fakeAdapter('hikvision', { report: (id) => asSource('cam01', id, { reachable: false, failure, failureDetail: '10.1.1.5:554: timed out', describe: null, sample: null, flags: [] }) }) });
    const r = await t.onboarding.onboardOne(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, code);
    assert.match(r.error, /Nothing was added/);
    assert.equal((await t.sources.list(SOURCES_SITE)).length, 0);
    assert.equal(t.created.length, 0);
    assert.equal((await t.profiles.store.listProfiles(SOURCES_SITE)).length, 0);
  }
});

test('onboard: "force" adds a camera that cannot be reached now, with a warning and no playable path', async () => {
  const t = setup({ adapter: fakeAdapter('hikvision', { report: (id) => asSource('cam01', id, { reachable: false, failure: 'unreachable', failureDetail: 'timed out', describe: null, sample: null, flags: [] }) }) });
  const r = await t.onboarding.onboardOne({ ...input, force: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.pathKind, 'none');
  assert.ok(r.warnings.some((w) => /no playable path/.test(w)));
  assert.equal(t.created.length, 1);
});

test('onboard: a login is stored only when there is a key; a camera with no login needs none; the probe is not run for nothing', async () => {
  const probes: string[] = [];
  const noKey = setup({ withBox: false, adapter: fakeAdapter('hikvision', { probes }) });
  const r = await noKey.onboarding.onboardOne(input);
  assert.equal(r.ok === false && r.code, 'no_key');
  assert.deepEqual(probes, [], 'refused before any probe');

  const open = setup({ withBox: false, adapter: fakeAdapter('hikvision', { url: 'rtsp://10.1.1.5/live' }) });
  const ok = await open.onboarding.onboardOne(input);
  assert.ok(ok.ok);
  const rec = (await open.sources.list(SOURCES_SITE))[0];
  assert.equal(openSourceAddress(rec, null).rtspUrl, 'rtsp://10.1.1.5/live');
});

test('onboard: a source the media server cannot serve, and a bad reference, are explained', async () => {
  const mjpeg = setup({ adapter: fakeAdapter('http', { endpoints: [{ protocol: 'mjpeg', role: 'browser', url: 'http://10.1.1.5/video.mjpg' }] }) });
  const r = await mjpeg.onboarding.onboardOne({ ...input, camera: { id: 'd', adapter: 'http', url: 'http://10.1.1.5/video.mjpg' } });
  assert.equal(r.ok === false && r.code, 'unsupported');
  const noAdapter = setup();
  const bad = await noAdapter.onboarding.onboardOne({ ...input, camera: { id: 'd', adapter: 'nope', host: 'h' } });
  assert.equal(bad.ok === false && bad.code, 'bad_ref');
});

test('onboard: if the Registry cannot be written, the profile and the source are taken back out', async () => {
  const t = setup({ registryFails: true });
  const r = await t.onboarding.onboardOne(input);
  assert.equal(r.ok === false && r.code, 'store');
  assert.equal((await t.sources.list(SOURCES_SITE)).length, 0);
  assert.equal((await t.profiles.store.listProfiles(SOURCES_SITE)).length, 0, 'the profile is gone too');
});

test('onboard: stream choice - the named profile or the sub stream, else the main one; device make is optional; no media base is a warning', async () => {
  const eps: StreamEndpoint[] = [
    { protocol: 'rtsp', role: 'analysis', url: 'rtsp://h/main', label: 'Main stream' }, { protocol: 'rtsp', role: 'analysis', url: 'rtsp://h/sub', label: 'Sub stream' },
    { protocol: 'snapshot', role: 'snapshot', url: 'http://h/snap' },
  ];
  assert.equal(pickRtsp(eps, { id: 'a' })!.url, 'rtsp://h/main');
  assert.equal(pickRtsp(eps, { id: 'a', options: { stream: 'sub' } })!.url, 'rtsp://h/sub');
  assert.equal(pickRtsp(eps, { id: 'a', options: { profile: 'Sub stream' } })!.url, 'rtsp://h/sub');
  assert.equal(pickRtsp([eps[2]], { id: 'a' }), null);
  const t = setup({ base: '', adapter: fakeAdapter('hikvision', { deviceFails: true, url: 'rtsp://10.1.1.5/live' }) });
  const r = await t.onboarding.onboardOne(input);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.warnings.some((w) => /MEDIA_SERVER_URL/.test(w)) && r.warnings.some((w) => /Make and model/.test(w)));
  assert.equal(mediaPathId(t.created[0].streamUrl), r.cameraId, 'still findable without a known media host');
});

test('onboard: probe again from the stored address; remove takes out the Registry camera, the source and the profile', async () => {
  const t = setup();
  const r = await t.onboarding.onboardOne(input);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(await t.onboarding.reprobe(r.cameraId), { ok: true, recipe: 'A', failure: null });
  assert.equal((await t.onboarding.reprobe('fed-ffffffffffff')).ok, false);
  assert.equal(await t.onboarding.remove(r.cameraId), true);
  assert.deepEqual(t.removed, ['reg-1']);
  assert.equal((await t.sources.list(SOURCES_SITE)).length, 0);
  assert.equal((await t.profiles.store.listProfiles(SOURCES_SITE)).length, 0);
  assert.equal(await t.onboarding.remove(r.cameraId), false);
  const plan = await sourcesMediaPlan({ profiles: t.profiles.store, sources: t.sources, box, encoder: 'qsv', build: gridOpts() });
  assert.deepEqual(plan.paths, {});
});

// ---- the Registry document ----------------------------------------------------------------------------------------------------

test('registry writer: creates the camera document, records the audit, and removes it again', async () => {
  const docs = new Map<string, Record<string, unknown>>();
  const audit: unknown[] = [];
  let n = 0;
  const w = createFirestoreRegistryWriter({
    db: { collection: () => ({ add: async (d) => { const id = `d${++n}`; docs.set(id, d); return { id }; }, doc: (id) => ({ delete: async () => { docs.delete(id); } }) }) },
    timestamp: () => 'TS', audit: async (e) => { audit.push(e); },
  });
  const id = await w.create({ name: 'Gate', ownerUid: 'u1', departmentId: null, adapter: 'onvif', sourceId: 'fed-1', streamUrl: 'https://m/fed-1/index.m3u8', device: null });
  assert.equal(docs.get(id)!.createdAt, 'TS');
  assert.equal('departmentId' in docs.get(id)!, false, 'no department field when there is none');
  await w.remove(id);
  assert.equal(docs.size, 0);
  assert.deepEqual(audit, [{ cameraId: 'd1', cameraName: 'Gate', action: 'create', userId: 'u1' }, { cameraId: 'd1', cameraName: 'Gate', action: 'delete', userId: 'u1' }]);
});

// ---- the media server ---------------------------------------------------------------------------------------------------------

/** A stand-in for the MediaMTX control API: keeps paths in memory. */
async function fakeMediaApi(initial: Array<Record<string, unknown>> = []) {
  const state = new Map(initial.map((p) => [String(p.name), p]));
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = url.pathname.match(/^\/v3\/config\/paths\/(list|add|replace|delete)(?:\/(.+))?$/);
      if (!m) { res.writeHead(404).end(); return; }
      const [, verb, name] = m;
      if (verb === 'list') { const all = [...state.values()]; res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ itemCount: all.length, pageCount: 1, items: all })); return; }
      calls.push(`${verb} ${name}`);
      if (verb === 'delete') state.delete(name); else state.set(name, { name, ...JSON.parse(body || '{}') });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, state, close: () => server.close() };
}

test('media: the sources\' paths are put on the running server without touching the grid\'s, and the generated file keeps both', async () => {
  const t = setup();
  const r = await t.onboarding.onboardOne(input);
  assert.ok(r.ok);
  if (!r.ok) return;
  const grid = memoryProfileStore([fixture('cam01')]);
  await grid.store.saveDecision('grid', 'cam01', { ...decide(fixture('cam01'), {}) });
  const media = await fakeMediaApi([{ name: 'cam01', source: 'rtsp://old' }]);
  const dir = mkdtempSync(join(tmpdir(), 'src-apply-'));
  const pathsFile = join(dir, 'paths.generated.yml');
  try {
    const both = { profiles: new Proxy(t.profiles.store, { get: (s, p) => (p === 'listProfiles' ? async (site: string) => (site === 'grid' ? grid.store.listProfiles(site) : s.listProfiles(site)) : (s as never)[p]) }) as typeof t.profiles.store };
    const common = { ...both, sources: t.sources, box, encoder: 'qsv' as const, sourcesBuild: gridOpts({ credentials: () => { throw new Error('not for sources'); } }), grid: { site: 'grid', build: gridOpts() }, api: media.api, pathsFile };
    const dry = await applySourcesMedia({ ...common, dryRun: true });
    assert.deepEqual(dry.add, ['fed-000000000001']);
    assert.equal(media.calls.length, 0, 'a dry run changes nothing');
    const done = await applySourcesMedia({ ...common, dryRun: false });
    assert.deepEqual(media.calls, ['add fed-000000000001'], 'only the source\'s path is touched; the grid\'s cam01 (different on the server) is not');
    assert.deepEqual(done.errors, []);
    assert.equal(done.gridInFile, true);
    const file = readFileSync(pathsFile, 'utf8');
    assert.match(file, /^  cam01:$/m);
    assert.match(file, /^  fed-000000000001:$/m);
    assert.match(file, /source: rtsp:\/\/admin:s3cret@10\.1\.1\.5:554\/Streaming\/Channels\/101/);
    // After the camera is removed, the next apply takes its path off the server
    await t.onboarding.remove(r.cameraId);
    const gone = await applySourcesMedia({ ...common, dryRun: false });
    assert.deepEqual(gone.remove, ['fed-000000000001']);
    assert.equal(media.state.has('fed-000000000001'), false);
    assert.equal(media.state.has('cam01'), true, 'the grid\'s path was never managed by this call');

    // No grid login configured: the running server is changed, the file is left alone (writing it would drop the grid's paths)
    const t2 = setup();
    await t2.onboarding.onboardOne(input);
    const media2 = await fakeMediaApi();
    try {
      const res = await applySourcesMedia({ profiles: t2.profiles.store, sources: t2.sources, box, encoder: 'qsv', sourcesBuild: gridOpts(), grid: null, api: media2.api, pathsFile: join(dir, 'other.yml'), dryRun: false });
      assert.deepEqual(res.add, ['fed-000000000001']);
      assert.equal(res.gridInFile, false);
      assert.equal(res.fileWritten, null);
    } finally { media2.close(); }
  } finally { media.close(); }
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------

async function withRoutes(run: (c: { call: (who: string | null, method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>; t: ReturnType<typeof setup> }) => Promise<void>, o: { unavailable?: string; adapter?: SourceAdapter; applyMedia?: SourceRoutesContext['applyMedia']; allowPrivate?: boolean } = {}) {
  const t = setup({ adapter: o.adapter });
  const app = express();
  app.use(express.json());
  registerSourceRoutes(app, {
    onboarding: t.onboarding, sources: t.sources, keyConfigured: true, allowPrivate: o.allowPrivate ?? true,
    profileViews: async () => (await t.profiles.store.listProfiles(SOURCES_SITE)).map((p) => ({ cameraId: p.report.cameraId, recipe: decide(p.report, {}).recipe, pathKind: 'pull', failure: p.report.failure, probedAt: p.report.probedAt })),
    requireAdmin: async (req, res) => { const who = req.header('x-user'); if (!who) { res.status(401).json({ error: 'no' }); return null; } if (who !== 'admin') { res.status(403).json({ error: 'not allowed' }); return null; } return 'admin-1'; },
    unavailable: async () => o.unavailable ?? null, applyMedia: o.applyMedia,
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run({ t, call: async (who, method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(who ? { 'x-user': who } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    } });
  } finally { server.close(); }
}

test('routes: admins only, and a server that cannot do it says why', async () => {
  await withRoutes(async ({ call }) => {
    for (const [m, p] of [['GET', '/api/sources'], ['POST', '/api/sources/onboard'], ['POST', '/api/sources/onboard-channels'], ['GET', '/api/sources/jobs/x'], ['POST', '/api/sources/fed-aaaaaa/reprobe'], ['DELETE', '/api/sources/fed-aaaaaa'], ['POST', '/api/sources/apply-media']] as const) {
      assert.equal((await call(null, m, p, {})).status, 401, `${m} ${p}`);
      assert.equal((await call('viewer', m, p, {})).status, 403, `${m} ${p}`);
    }
  });
  await withRoutes(async ({ call }) => {
    const r = await call('admin', 'GET', '/api/sources');
    assert.equal(r.status, 501);
    assert.match(r.json.error, /Postgres/);
  }, { unavailable: 'Onboarding cameras through adapters keeps them in Postgres.' });
});

test('routes: onboard a camera, list it with its recipe, probe it again, remove it', async () => {
  await withRoutes(async ({ call, t }) => {
    const bad = await call('admin', 'POST', '/api/sources/onboard', { camera: { id: 'device' } });
    assert.equal(bad.status, 400);
    const noDept = await call('admin', 'POST', '/api/sources/onboard', { camera: { id: 'device', adapter: 'hikvision', host: '10.1.1.5' }, departmentId: '../x' });
    assert.equal(noDept.status, 400);
    const ok = await call('admin', 'POST', '/api/sources/onboard', { camera: { id: 'device', adapter: 'hikvision', host: '10.1.1.5', credentials: { user: 'admin', pass: 's3cret' } }, name: 'Gate', departmentId: 'Traffic', location: { lat: 23.03, lng: 72.58 } });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.ok, true);
    assert.equal(JSON.stringify(ok.json).includes('s3cret'), false, 'no login in the answer');
    assert.deepEqual([t.created[0].ownerUid, t.created[0].departmentId, t.created[0].location], ['admin-1', 'Traffic', { lat: 23.03, lng: 72.58 }]);
    const list = await call('admin', 'GET', '/api/sources');
    assert.equal(list.json.sources.length, 1);
    assert.deepEqual([list.json.sources[0].name, list.json.sources[0].host, list.json.sources[0].recipe, list.json.keyConfigured], ['Gate', '10.1.1.5', 'A', true]);
    assert.equal(JSON.stringify(list.json).includes('s3cret'), false);
    assert.equal((await call('admin', 'POST', `/api/sources/${ok.json.cameraId}/reprobe`, {})).json.recipe, 'A');
    assert.equal((await call('admin', 'POST', '/api/sources/fed-aaaaaaaaaaaa/reprobe', {})).status, 404);
    assert.equal((await call('admin', 'POST', '/api/sources/not-an-id/reprobe', {})).status, 404);
    assert.equal((await call('admin', 'DELETE', `/api/sources/${ok.json.cameraId}`)).status, 200);
    assert.equal((await call('admin', 'DELETE', `/api/sources/${ok.json.cameraId}`)).status, 404);
    assert.equal((await call('admin', 'GET', '/api/sources')).json.sources.length, 0);
  });
});

test('routes: a camera that cannot be reached is a 422 that says so and adds nothing; a missing key is a 409', async () => {
  const dead = fakeAdapter('hikvision', { report: (id) => asSource('cam01', id, { reachable: false, failure: 'unreachable', failureDetail: '10.1.1.5:554: timed out', describe: null, sample: null, flags: [] }) });
  await withRoutes(async ({ call, t }) => {
    const r = await call('admin', 'POST', '/api/sources/onboard', { camera: { id: 'device', adapter: 'hikvision', host: '10.1.1.5' } });
    assert.equal(r.status, 422);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, 'unreachable');
    assert.match(r.json.error, /Nothing was added/);
    assert.equal(t.created.length, 0);
    const forced = await call('admin', 'POST', '/api/sources/onboard', { camera: { id: 'device', adapter: 'hikvision', host: '10.1.1.5' }, force: true });
    assert.equal(forced.status, 201);
  }, { adapter: dead });
});

test('routes: private addresses are refused unless allowed', async () => {
  await withRoutes(async ({ call }) => {
    const r = await call('admin', 'POST', '/api/sources/onboard', { camera: { id: 'device', adapter: 'hikvision', host: '192.168.1.5' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /private network/);
  }, { allowPrivate: false });
});

test('routes: a whole recorder runs as a job - the connected channels, one at a time, with a result each; one at a time overall', async () => {
  await withRoutes(async ({ call, t }) => {
    const start = await call('admin', 'POST', '/api/sources/onboard-channels', { camera: { id: 'nvr', adapter: 'hikvision', host: '10.1.1.9' }, namePrefix: 'Depot', departmentId: 'Traffic' });
    assert.equal(start.status, 202);
    assert.equal(start.json.total, 2, 'channel 2 is offline and left out; channel 3 does not say, so it is tried');
    assert.equal((await call('admin', 'POST', '/api/sources/onboard-channels', { camera: { id: 'nvr', adapter: 'hikvision', host: '10.1.1.9' } })).status, 409, 'one recorder at a time');
    let job: any;
    for (let i = 0; i < 100; i++) { job = (await call('admin', 'GET', `/api/sources/jobs/${start.json.jobId}`)).json.job; if (job.state === 'done') break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal(job.state, 'done');
    assert.deepEqual(job.results.map((r: any) => [r.channel, r.name, r.result.ok]), [[1, 'Depot - Gate', true], [3, 'Depot - Yard', true]]);
    assert.deepEqual(t.created.map((c) => c.name), ['Depot - Gate', 'Depot - Yard']);
    assert.ok(t.created.every((c) => c.departmentId === 'Traffic'));
    assert.equal((await call('admin', 'GET', '/api/sources')).json.sources.length, 2);
    // chosen channels only; an unknown one is a 404
    const some = await call('admin', 'POST', '/api/sources/onboard-channels', { camera: { id: 'nvr', adapter: 'hikvision', host: '10.1.1.9' }, channels: [1] });
    assert.equal(some.json.total, 1);
    for (let i = 0; i < 100; i++) { if ((await call('admin', 'GET', `/api/sources/jobs/${some.json.jobId}`)).json.job.state === 'done') break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal((await call('admin', 'POST', '/api/sources/onboard-channels', { camera: { id: 'nvr', adapter: 'hikvision', host: '10.1.1.9' }, channels: [99] })).status, 404);
    assert.equal((await call('admin', 'GET', '/api/sources/jobs/nope')).status, 404);
  }, { adapter: fakeAdapter('hikvision', { delayMs: 40 }) });
});

test('routes: apply-media shows what would change by default, and says so when the media server is out of reach', async () => {
  const seen: boolean[] = [];
  await withRoutes(async ({ call }) => {
    assert.equal((await call('admin', 'POST', '/api/sources/apply-media', {})).json.dryRun, true);
    assert.equal((await call('admin', 'POST', '/api/sources/apply-media', { dryRun: false })).json.dryRun, false);
    assert.deepEqual(seen, [true, false]);
  }, { applyMedia: async (dry) => { seen.push(dry); return { dryRun: dry }; } });
  await withRoutes(async ({ call }) => {
    assert.equal((await call('admin', 'POST', '/api/sources/apply-media', {})).status, 501);
  });
});

// ---- what a tile needs ---------------------------------------------------------------------------------------------------------

test('tiles: a camera on the media server is played from it; only the grid\'s cameras use the grid\'s WebRTC, stills and proxy', () => {
  assert.equal(mediaPathId('https://cctv.corp8.cloud/cam07/index.m3u8'), 'cam07');
  assert.equal(mediaPathId('https://any.host/FED-3F9A1C2B7D4E/index.m3u8'), 'fed-3f9a1c2b7d4e');
  assert.equal(mediaPathId('https://any.host/fed-3f9a1c2b7d4e/other.m3u8'), null);
  assert.equal(mediaPathId('https://any.host/cam07x/index.m3u8'), null);
  assert.equal(gridCamId('https://any.host/fed-3f9a1c2b7d4e/index.m3u8'), null);
  const base = { url: 'https://any.host/fed-3f9a1c2b7d4e/index.m3u8', hlsSupported: true, hasLogin: true };
  const fed = { ...base, camId: null, mediaId: 'fed-3f9a1c2b7d4e' };
  assert.deepEqual(plannedRecipes({ ...fed, media: { enabled: true } }), ['media'], 'no WebRTC, no stills, no grid proxy for it');
  assert.deepEqual(plannedRecipes({ ...fed, media: null }), [], 'without a media server nothing can play it');
  const grid = { url: 'https://cctv.corp8.cloud/cam07/index.m3u8', hlsSupported: true, hasLogin: true, camId: 'cam07' };
  assert.deepEqual(plannedRecipes({ ...grid, media: { enabled: true } }), ['media', 'whep', 'proxy', 'stills'], 'the grid is as before');
  assert.deepEqual(plannedRecipes({ ...grid, mediaId: 'cam07', media: { enabled: true } }), ['media', 'whep', 'proxy', 'stills']);
});
