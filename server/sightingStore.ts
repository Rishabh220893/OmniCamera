import { FieldValue, Firestore } from 'firebase-admin/firestore';
import type { PlateSighting } from '../src/lib/plateTracking';

/**
 * Admin-SDK twin of src/lib/plateStore.ts#recordSightings — same documents,
 * written by the server's analysis worker (which bypasses the client rules).
 */
export async function writeSightings(db: Firestore, userId: string, sightings: PlateSighting[]): Promise<void> {
  if (sightings.length === 0) return;
  const batch = db.batch();
  for (const s of sightings) {
    const { id, ...fields } = s;
    batch.set(db.collection('plateSightings').doc(id), { ...fields, userId });
    batch.set(db.collection('plateIndex').doc(`${userId}__${s.plate}`), { userId, plate: s.plate, count: FieldValue.increment(1), lastSeen: s.timestamp }, { merge: true });
  }
  await batch.commit();
}
