import type { Firestore } from 'firebase-admin/firestore';

/**
 * Shared per-camera lease, so several server instances can run the analysis
 * worker without analysing the same camera twice.
 *
 * One document per camera in `analysisLeases` (Admin SDK only — the client
 * rules deny it). Before analysing, an instance claims the camera in a
 * transaction; it succeeds only if (a) nobody else holds an unexpired lease
 * and (b) the camera is actually due. When finished the holder releases and
 * records when the camera is next due. A holder that crashes simply stops
 * renewing: its lease expires and another instance takes over.
 *
 * Instances compare their own clocks against `until`/`nextDueAt`, so clocks
 * should be within a few seconds of each other (any normal host with NTP is).
 */
export interface LeaseDoc {
  owner: string | null;
  /** Epoch ms at which the current lease expires. */
  until: number;
  /** Epoch ms before which nobody should analyse this camera again. */
  nextDueAt: number;
}

export type ClaimResult = { claimed: true } | { claimed: false; retryAt: number };

/** How soon to look again when another instance is mid-run on a camera. */
export const HELD_RETRY_MS = 5_000;

export function decideClaim(existing: Partial<LeaseDoc> | undefined, owner: string, now: number, leaseMs: number): { result: ClaimResult; write?: LeaseDoc } {
  const ex = { owner: existing?.owner ?? null, until: existing?.until ?? 0, nextDueAt: existing?.nextDueAt ?? 0 };
  if (ex.owner && ex.owner !== owner && ex.until > now) {
    return { result: { claimed: false, retryAt: now + HELD_RETRY_MS } };
  }
  if (ex.nextDueAt > now) {
    return { result: { claimed: false, retryAt: ex.nextDueAt } };
  }
  return { result: { claimed: true }, write: { owner, until: now + leaseMs, nextDueAt: ex.nextDueAt } };
}

/** null = don't write: the lease isn't ours any more (it expired and another instance took it). */
export function decideRelease(existing: Partial<LeaseDoc> | undefined, owner: string, nextDueAt: number): LeaseDoc | null {
  if (!existing || existing.owner !== owner) return null;
  return { owner: null, until: 0, nextDueAt };
}

export interface Leases {
  claim(cameraId: string, now: number, leaseMs: number): Promise<ClaimResult>;
  release(cameraId: string, nextDueAt: number): Promise<void>;
}

export function createFirestoreLeases(db: Pick<Firestore, 'collection' | 'runTransaction'>, owner: string): Leases {
  const ref = (cameraId: string) => db.collection('analysisLeases').doc(cameraId);
  return {
    claim: (cameraId, now, leaseMs) => db.runTransaction(async (tx) => {
      const snap = await tx.get(ref(cameraId));
      const { result, write } = decideClaim(snap.exists ? (snap.data() as Partial<LeaseDoc>) : undefined, owner, now, leaseMs);
      if (write) tx.set(ref(cameraId), write);
      return result;
    }),
    release: (cameraId, nextDueAt) => db.runTransaction(async (tx) => {
      const snap = await tx.get(ref(cameraId));
      const write = decideRelease(snap.exists ? (snap.data() as Partial<LeaseDoc>) : undefined, owner, nextDueAt);
      if (write) tx.set(ref(cameraId), write);
    }),
  };
}
