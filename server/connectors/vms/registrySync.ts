/**
 * Puts the cameras a department's system reports into the Registry (Firestore `cameras`), so the people, the map, the trail and the incidents that
 * name a camera by id find a camera record behind it. The document id is the same id the system's events carry (`platformCameraId`), which is the
 * whole point: an event, an alert and a Registry camera now line up.
 *
 * These are *event-only* cameras: the platform has the department's events about them, not their video (the department's system stays the video
 * store in Profile 3), so the record has no stream and its tile stays empty. A record is made once; after that only what the system knows better
 * than a person is refreshed (online or offline, its position when none was set). A name, a department allotment or anything else a person
 * changed is never overwritten. A camera the system stops listing is marked, not deleted.
 *
 * Off unless `VMS_REGISTRY_SYNC=true`, because it writes to the Registry.
 */
import { platformCameraId, type VmsCamera, type VmsSystemConfig } from './types';

interface DocLike { exists: boolean; data(): Record<string, unknown> | undefined }
export interface RegistryDb {
  collection(name: string): {
    doc(id: string): { get(): Promise<DocLike>; set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown> };
    where(field: string, op: '==', value: unknown): { get(): Promise<{ docs: Array<{ id: string; data(): Record<string, unknown> }> }> };
  };
}

export interface RegistrySyncResult { created: number; updated: number; unchanged: number; markedMissing: number }

const status = (online: boolean | null) => (online === true ? 'online' : online === false ? 'offline' : 'unknown');

export function createRegistrySync(o: { db: RegistryDb; timestamp: () => unknown; log?: Pick<Console, 'warn' | 'info'> }) {
  const log = o.log ?? console;
  return {
    async sync(system: VmsSystemConfig, cameras: VmsCamera[]): Promise<RegistrySyncResult> {
      const res: RegistrySyncResult = { created: 0, updated: 0, unchanged: 0, markedMissing: 0 };
      const col = o.db.collection('cameras');
      const listed = new Set<string>();
      for (const c of cameras) {
        const id = platformCameraId(system.id, c.id);
        listed.add(id);
        const ref = col.doc(id);
        const snap = await ref.get();
        const now = o.timestamp();
        if (!snap.exists) {
          await ref.set({
            name: (c.name || c.id).slice(0, 120), userId: system.ownerUserId,
            ...(system.department ? { department: system.department, departmentId: system.department } : {}),
            useRemoteFeed: false, remoteStreamUrl: '', facingMode: 'user', useSimulatedFeed: false, interval: 60, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2,
            webhookUrl: '', suspiciousRules: '', serverAnalysis: false, aiAnalysis: false, maintenanceStatus: 'operational',
            connectivityStatus: status(c.online), cameraType: 'IP', onboardedVia: 'vms', vmsSystemId: system.id, vendorCameraId: c.id,
            ...(c.group ? { storageDetails: `Group: ${c.group}` } : {}), ...(c.location ? { location: c.location } : {}),
            createdAt: now, updatedAt: now,
          });
          res.created++;
          continue;
        }
        const d = snap.data() ?? {};
        const patch: Record<string, unknown> = {};
        const st = status(c.online);
        if (c.online !== null && d.connectivityStatus !== st) patch.connectivityStatus = st;
        if (c.location && !d.location) patch.location = c.location;
        if (d.vmsMissing) patch.vmsMissing = false;
        if (Object.keys(patch).length === 0) { res.unchanged++; continue; }
        await ref.set({ ...patch, updatedAt: now }, { merge: true });
        res.updated++;
      }
      // Cameras this system made before that it no longer lists.
      try {
        const before = await col.where('vmsSystemId', '==', system.id).get();
        for (const d of before.docs) {
          if (!listed.has(d.id) && !d.data().vmsMissing) { await col.doc(d.id).set({ vmsMissing: true, connectivityStatus: 'unknown', updatedAt: o.timestamp() }, { merge: true }); res.markedMissing++; }
        }
      } catch (e) { log.warn(`[VMS] could not check for cameras ${system.id} stopped listing: ${e instanceof Error ? e.message : e}`); }
      return res;
    },
  };
}
export type RegistrySync = ReturnType<typeof createRegistrySync>;
