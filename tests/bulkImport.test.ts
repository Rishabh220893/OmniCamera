import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, describeSummary, ExistingCameraLike, ImportRow, parseLatLng, planBulkImport, summarizePlan } from '../src/lib/bulkImport';
import { extractCameraArray, parseCatalogue, fetchSentinelCatalogue } from '../src/lib/sentinelCatalogue';

const row = (n: number, extra: Record<string, string> = {}): ImportRow => ({
  name: `Camera ${n}`, remoteStreamUrl: `https://cctv.corp8.cloud/cam${String(n).padStart(2, '0')}/index.m3u8`, ...extra,
});
const rows = (n: number, extra: Record<string, string> = {}) => Array.from({ length: n }, (_, i) => row(i + 1, extra));

test('parseLatLng accepts real coordinates and rejects junk', () => {
  assert.deepEqual(parseLatLng('23.0225', '72.5714'), { lat: 23.0225, lng: 72.5714 });
  assert.deepEqual(parseLatLng(23, 72), { lat: 23, lng: 72 });
  for (const [a, b] of [['', ''], ['abc', '72'], ['NaN', 'NaN'], ['91', '72'], ['23', '181'], ['0', '0'], [undefined, undefined], [null, null]]) {
    assert.equal(parseLatLng(a, b), undefined, `${a},${b}`);
  }
});

test('plan: 55 new cameras are all created; none lack data they were never given', () => {
  const plan = planBulkImport(rows(55), []);
  assert.equal(plan.create.length, 55);
  assert.equal(plan.update.length + plan.unchanged + plan.invalid + plan.duplicatesInBatch, 0);
  assert.equal(plan.withoutLocation, 55, 'no coordinates supplied → all 55 reported as unmappable');
});

test('plan: coordinates in the rows mean no "without location" warning', () => {
  const plan = planBulkImport(rows(3, { lat: '23.02', lng: '72.57' }), []);
  assert.equal(plan.withoutLocation, 0);
});

test('plan: re-running the same import changes nothing (idempotent)', () => {
  const existing: ExistingCameraLike[] = rows(50).map((r, i) => ({ id: `id${i}`, name: r.name, remoteStreamUrl: r.remoteStreamUrl }));
  const plan = planBulkImport(rows(50), existing);
  assert.deepEqual([plan.create.length, plan.update.length, plan.unchanged], [0, 0, 50]);
});

test('plan: URL matching ignores case and surrounding whitespace', () => {
  const existing: ExistingCameraLike[] = [{ id: 'x', name: 'Cam', remoteStreamUrl: '  HTTPS://CCTV.corp8.cloud/cam01/index.m3u8 ' }];
  const plan = planBulkImport([row(1)], existing);
  assert.equal(plan.create.length, 0);
});

test('plan: existing cameras gain missing details but nothing already set is overwritten', () => {
  const existing: ExistingCameraLike[] = [
    { id: 'a', name: 'Renamed by user', remoteStreamUrl: row(1).remoteStreamUrl, department: 'Traffic Police' },
    { id: 'b', name: 'Cam 2', remoteStreamUrl: row(2).remoteStreamUrl, location: { lat: 1, lng: 2 } },
  ];
  const plan = planBulkImport([
    row(1, { department: 'Home Dept', ownership: 'GSRTC', lat: '23.02', lng: '72.57', name: 'Catalogue name' }),
    row(2, { lat: '9', lng: '9' }),
  ], existing);
  assert.equal(plan.update.length, 1);
  const u = plan.update[0];
  assert.equal(u.id, 'a');
  assert.deepEqual(u.fields, { ownership: 'GSRTC', location: { lat: 23.02, lng: 72.57 } }, 'department kept, name never touched');
  assert.equal(plan.unchanged, 1, 'camera b already has a location');
});

test('plan: invalid, in-file duplicate, and URL-less rows', () => {
  const plan = planBulkImport([
    { name: '  ', remoteStreamUrl: 'u1' },
    row(1), row(1, { name: 'again' }),
    { name: 'Simulated A' }, { name: 'Simulated B' },
  ], []);
  assert.equal(plan.invalid, 1);
  assert.equal(plan.duplicatesInBatch, 1);
  assert.equal(plan.create.length, 3, 'cameras without a URL are separate simulated cameras');
});

test('chunk splits into Firestore-sized groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  const groups = chunk(Array.from({ length: 1234 }, (_, i) => i), 200);
  assert.equal(groups.length, 7);
  assert.ok(groups.every(g => g.length <= 200));
});

test('summary text is plain and flags unmappable cameras', () => {
  const text = describeSummary(summarizePlan(planBulkImport(rows(50), [])));
  assert.match(text, /^50 added\./);
  assert.match(text, /50 cameras have no map location/);
  const clean = describeSummary({ created: 1, updated: 2, unchanged: 3, invalid: 0, duplicatesInBatch: 0, withoutLocation: 0 });
  assert.equal(clean, '1 added, 2 updated with missing details, 3 already up to date.');
});

// ---- catalogue parsing ----

test('catalogue: array shape with coordinates, department and live flag', () => {
  const entries = parseCatalogue([
    { id: 'cam01', location: 'Chiman bhai Bridge', live: true, lat: 23.03, lng: 72.58, department: 'Police' },
    { id: 'cam02', name: 'Janpath', status: 'offline' },
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { name: 'cam01 Chiman bhai Bridge', remoteStreamUrl: 'https://cctv.corp8.cloud/cam01/index.m3u8', isLive: true, lat: 23.03, lng: 72.58, department: 'Police' });
  assert.equal(entries[1].isLive, false);
  assert.equal('lat' in entries[1], false, 'no coordinates offered → none invented');
});

test('catalogue: wrapper keys, id-keyed objects, nested location objects', () => {
  assert.equal(parseCatalogue({ cameras: [{ id: 'cam01' }] }).length, 1);
  const keyed = parseCatalogue({ cam01: { name: 'A' }, cam02: { name: 'B', location: { latitude: '23.1', longitude: '72.1' } } });
  assert.deepEqual(keyed.map(e => e.remoteStreamUrl), ['https://cctv.corp8.cloud/cam01/index.m3u8', 'https://cctv.corp8.cloud/cam02/index.m3u8']);
  assert.deepEqual([keyed[1].lat, keyed[1].lng], [23.1, 72.1]);
  assert.equal(parseCatalogue({ data: { cam01: { name: 'A' } } }).length, 1);
});

test('catalogue: bad coordinates are dropped, duplicate ids and id-less entries skipped, 60 entries survive', () => {
  const entries = parseCatalogue([
    { id: 'cam01', lat: 'x', lng: 'y' }, { id: 'CAM01' }, { name: 'no id' },
    ...Array.from({ length: 59 }, (_, i) => ({ id: `cam${String(i + 2).padStart(2, '0')}`, name: `Site ${i + 2}` })),
  ]);
  assert.equal(entries.length, 60);
  assert.equal('lat' in entries[0], false);
  assert.deepEqual(extractCameraArray('nonsense'), []);
  assert.deepEqual(extractCameraArray({}), []);
});

test('catalogue fetch reports whether the server substituted its built-in list', async () => {
  const realFetch = globalThis.fetch;
  try {
    const respond = (source?: string) => (async () => new Response(JSON.stringify([{ id: 'cam01', name: 'A' }]), { status: 200, headers: source ? { 'X-Catalogue-Source': source } : {} })) as unknown as typeof fetch;
    globalThis.fetch = respond('bundled-fallback');
    assert.equal((await fetchSentinelCatalogue('pw', 'e@x.com')).source, 'bundled-fallback');
    globalThis.fetch = respond();
    assert.equal((await fetchSentinelCatalogue('pw', 'e@x.com')).source, 'live');
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(fetchSentinelCatalogue('pw'), /Catalogue request failed \(500\)/);
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(fetchSentinelCatalogue('pw'), /no usable cameras/);
  } finally { globalThis.fetch = realFetch; }
});
