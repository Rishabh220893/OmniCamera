/** Cameras reported by a department system become Registry cameras with the same id its events carry (server/connectors/vms/registrySync.ts). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistrySync, type RegistryDb } from '../server/connectors/vms/registrySync.ts';
import type { VmsCamera, VmsSystemConfig } from '../server/connectors/vms/types.ts';

function fakeDb() {
  const docs = new Map<string, Record<string, any>>();
  const db: RegistryDb = {
    collection: () => ({
      doc: (id) => ({
        get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
        set: async (data, opts) => { docs.set(id, opts?.merge ? { ...(docs.get(id) ?? {}), ...data } : { ...data }); },
      }),
      where: (field, _op, value) => ({ get: async () => ({ docs: [...docs.entries()].filter(([, d]) => d[field] === value).map(([id, d]) => ({ id, data: () => d })) }) }),
    }),
  };
  return { db, docs };
}
const system: VmsSystemConfig = { id: 'traffic-vms', kind: 'reference-json', baseUrl: 'http://x', ownerUserId: 'admin-1', department: 'Traffic' };
const cams = (...c: Array<Partial<VmsCamera> & { id: string }>): VmsCamera[] => c.map((x) => ({ name: `Camera ${x.id}`, online: true, ...x }));

test('new cameras: one Registry record each, with the id the events carry; no stream, no login, owned by the system\'s owner and its department', async () => {
  const { db, docs } = fakeDb();
  const sync = createRegistrySync({ db, timestamp: () => 'NOW' });
  const r = await sync.sync(system, cams({ id: '1', name: 'Gate', location: { lat: 23.02, lng: 72.57 }, group: 'North' }, { id: '2 b', online: false }));
  assert.deepEqual(r, { created: 2, updated: 0, unchanged: 0, markedMissing: 0 });
  assert.deepEqual([...docs.keys()].sort(), ['traffic-vms-1', 'traffic-vms-2_b'], 'ids match platformCameraId, which events use');
  const d = docs.get('traffic-vms-1')!;
  assert.deepEqual([d.name, d.userId, d.department, d.departmentId, d.useRemoteFeed, d.remoteStreamUrl, d.onboardedVia, d.vmsSystemId, d.vendorCameraId, d.connectivityStatus, d.location], ['Gate', 'admin-1', 'Traffic', 'Traffic', false, '', 'vms', 'traffic-vms', '1', 'online', { lat: 23.02, lng: 72.57 }]);
  assert.equal(d.serverAnalysis, false);
  assert.equal(docs.get('traffic-vms-2_b')!.connectivityStatus, 'offline');
  assert.equal(JSON.stringify(d).includes('password'), false);
});

test('again: nothing changes when nothing changed; only status and a missing position are refreshed; a person\'s edits are never overwritten', async () => {
  const { db, docs } = fakeDb();
  const sync = createRegistrySync({ db, timestamp: () => 'T2' });
  await sync.sync(system, cams({ id: '1' }));
  assert.deepEqual(await sync.sync(system, cams({ id: '1' })), { created: 0, updated: 0, unchanged: 1, markedMissing: 0 });
  // A person renamed it, moved it to another department and set its position.
  docs.set('traffic-vms-1', { ...docs.get('traffic-vms-1')!, name: 'Main gate', departmentId: 'Police', location: { lat: 1, lng: 2 } });
  const r = await sync.sync(system, cams({ id: '1', name: 'Vendor name', online: false, location: { lat: 9, lng: 9 } }));
  assert.equal(r.updated, 1);
  const d = docs.get('traffic-vms-1')!;
  assert.deepEqual([d.name, d.departmentId, d.location, d.connectivityStatus], ['Main gate', 'Police', { lat: 1, lng: 2 }, 'offline']);
  // A camera with no position gets the system's.
  docs.set('traffic-vms-1', { ...d, location: undefined });
  await sync.sync(system, cams({ id: '1', online: false, location: { lat: 9, lng: 9 } }));
  assert.deepEqual(docs.get('traffic-vms-1')!.location, { lat: 9, lng: 9 });
  // "online: null" (the system does not say) leaves the status alone.
  await sync.sync(system, cams({ id: '1', online: null }));
  assert.equal(docs.get('traffic-vms-1')!.connectivityStatus, 'offline');
});

test('a camera the system stops listing is marked missing (not deleted), and unmarked when it returns; another system\'s cameras are not touched', async () => {
  const { db, docs } = fakeDb();
  const sync = createRegistrySync({ db, timestamp: () => 'T' });
  await sync.sync(system, cams({ id: '1' }, { id: '2' }));
  await sync.sync({ ...system, id: 'other' }, cams({ id: '1' }));
  const r = await sync.sync(system, cams({ id: '1' }));
  assert.equal(r.markedMissing, 1);
  assert.equal(docs.get('traffic-vms-2')!.vmsMissing, true);
  assert.equal(docs.get('other-1')!.vmsMissing, undefined, 'the other system\'s camera was not marked');
  assert.equal((await sync.sync(system, cams({ id: '1' }))).markedMissing, 0, 'marked once');
  await sync.sync(system, cams({ id: '1' }, { id: '2' }));
  assert.equal(docs.get('traffic-vms-2')!.vmsMissing, false, 'back again');
});

test('a system with no department makes cameras with no department', async () => {
  const { db, docs } = fakeDb();
  await createRegistrySync({ db, timestamp: () => 'T' }).sync({ ...system, department: undefined }, cams({ id: '1' }));
  assert.equal('departmentId' in docs.get('traffic-vms-1')!, false);
});
