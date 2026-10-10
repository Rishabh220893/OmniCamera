/**
 * Creates and removes the Registry (Firestore `cameras`) documents of cameras onboarded through adapters. Written through the Admin SDK,
 * which is how API onboarding already works. The document carries no login: the camera is found by `sourceId`, a media-server path whose
 * address and login live only in the sealed source record (server/sources/store.ts).
 */
import type { NewRegistryCamera, RegistryWriter } from './onboard';

interface CollectionLike {
  add(data: Record<string, unknown>): Promise<{ id: string }>;
  doc(id: string): { delete(): Promise<unknown> };
}
export interface FirestoreLike { collection(name: string): CollectionLike }

export interface FirestoreRegistryDeps {
  db: FirestoreLike;
  /** `FieldValue.serverTimestamp()`. */
  timestamp(): unknown;
  /** Called after a camera is created, for the Registry audit trail. */
  audit?(entry: { cameraId: string; cameraName: string; action: 'create' | 'delete'; userId: string }): Promise<void>;
}

/** The fields of a new camera document; the same defaults the Registry API and the app give a camera. */
export function registryDocument(cam: NewRegistryCamera, stamp: unknown): Record<string, unknown> {
  return {
    name: cam.name, userId: cam.ownerUid, ...(cam.departmentId ? { departmentId: cam.departmentId } : {}),
    useRemoteFeed: true, remoteStreamUrl: cam.streamUrl, facingMode: 'user', useSimulatedFeed: false,
    interval: 60, sensitivity: 5, peopleThreshold: 5, vehicleThreshold: 2, webhookUrl: '', suspiciousRules: '',
    serverAnalysis: false, connectivityStatus: 'unknown', maintenanceStatus: 'operational',
    ...(cam.location ? { location: cam.location } : {}),
    cameraType: 'IP', onboardedVia: 'adapter', adapter: cam.adapter, sourceId: cam.sourceId,
    ...(cam.device?.manufacturer ? { deviceMake: cam.device.manufacturer } : {}), ...(cam.device?.model ? { deviceModel: cam.device.model } : {}),
    createdAt: stamp, updatedAt: stamp,
  };
}

export function createFirestoreRegistryWriter(deps: FirestoreRegistryDeps): RegistryWriter {
  const owners = new Map<string, { name: string; uid: string }>();
  return {
    async create(cam) {
      const ref = await deps.db.collection('cameras').add(registryDocument(cam, deps.timestamp()));
      owners.set(ref.id, { name: cam.name, uid: cam.ownerUid });
      await deps.audit?.({ cameraId: ref.id, cameraName: cam.name, action: 'create', userId: cam.ownerUid }).catch(() => undefined);
      return ref.id;
    },
    async remove(registryId) {
      await deps.db.collection('cameras').doc(registryId).delete();
      const o = owners.get(registryId);
      await deps.audit?.({ cameraId: registryId, cameraName: o?.name ?? registryId, action: 'delete', userId: o?.uid ?? 'system' }).catch(() => undefined);
      owners.delete(registryId);
    },
  };
}
