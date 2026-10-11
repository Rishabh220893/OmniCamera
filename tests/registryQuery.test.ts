/** Registry API filters and exports (Model 1): search, filter by department/status/type/bounding box/age, GeoJSON and CSV. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FilterError, filterCameras, parseFilter, toCsv, toGeoJson, type RegistryCamera } from '../server/registry/query.ts';

const cams: RegistryCamera[] = [
  { id: '1', name: 'MG Road', department: 'Traffic Police', ownership: 'Municipal', cameraType: 'ptz', connectivityStatus: 'online', installDate: '2023-06-15', storageDetails: 'NVR, 30 days', location: { lat: 12.97, lng: 77.59 } },
  { id: '2', name: 'Bus Gate', department: 'Transport', cameraType: 'dome', connectivityStatus: 'offline', installDate: '2015-01-02', location: { lat: 12.98, lng: 77.57 } },
  { id: '3', name: '=cmd|"x"', department: 'Transport', cameraType: 'dome', maintenanceStatus: 'needs_maintenance' },
];
const ids = (f: Record<string, unknown>) => filterCameras(cams, parseFilter(f)).map((c) => c.id);

test('filters: text, department (any case), status, type, maintenance and age combine', () => {
  assert.deepEqual(ids({}), ['1', '2', '3']);
  assert.deepEqual(ids({ q: 'road' }), ['1']);
  assert.deepEqual(ids({ department: 'transport' }), ['2', '3']);
  assert.deepEqual(ids({ status: 'offline' }), ['2']);
  assert.deepEqual(ids({ status: 'unknown' }), ['3'], 'a camera with no status counts as unknown');
  assert.deepEqual(ids({ type: 'dome', maintenance: 'needs_maintenance' }), ['3']);
  assert.deepEqual(ids({ installedBefore: '2020-01-01' }), ['2'], 'ageing: installed before a date; no install date is not "old"');
  assert.deepEqual(ids({ department: 'Transport', status: 'online' }), []);
});

test('bounding box keeps located cameras inside it; unlocated cameras are never inside', () => {
  assert.deepEqual(ids({ bbox: '77.58,12.96,77.60,12.99' }), ['1']);
  assert.deepEqual(ids({ bbox: '77.0,12.0,78.0,13.0' }), ['1', '2']);
});

test('bad filters are errors, not silently ignored', () => {
  for (const bad of [{ bbox: '1,2,3' }, { bbox: 'a,b,c,d' }, { bbox: '78,13,77,12' }, { bbox: '0,-95,1,0' }, { installedBefore: 'yesterday' }]) assert.throws(() => parseFilter(bad), FilterError);
});

test('GeoJSON: longitude first, only located cameras; CSV: same columns as the bulk import, formulas kept as text, quotes escaped', () => {
  const g = toGeoJson(cams);
  assert.equal(g.type, 'FeatureCollection');
  assert.equal(g.features.length, 2);
  assert.deepEqual(g.features[0].geometry.coordinates, [77.59, 12.97]);
  assert.equal(g.features[0].properties.department, 'Traffic Police');
  const csv = toCsv(cams);
  assert.ok(csv.startsWith('id,name,department,ownership,cameraType,connectivityStatus,maintenanceStatus,installDate,storageDetails,lat,lng\r\n'));
  assert.ok(csv.includes('"\'=cmd|""x"""'), 'a name starting with = is quoted and prefixed');
  assert.ok(csv.includes('"NVR, 30 days"'));
});
