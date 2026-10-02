/**
 * Firestore persistence for plate sightings, the distinct-plate index and the
 * user's decisions on possible matches. Sightings are append-only (see
 * firestore.rules); the server's analysis worker writes the same shapes via
 * the Admin SDK (server/sightingStore.ts).
 */
import { collection, doc, getDocs, limit, query, setDoc, deleteDoc, where, writeBatch, increment, Timestamp, DocumentData } from 'firebase/firestore';
import { db } from './firebase';
import { normalizePlate, pairKey, PlateCandidate, PlateSighting } from './plateTracking';

const MAX_SIGHTINGS_PER_QUERY = 2000;
const MAX_INDEX_PLATES = 5000;

const toDate = (v: unknown): Date => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : new Date(v as string));

/** Writes one frame's sightings plus the per-plate counters used to find look-alike plates. */
export async function recordSightings(userId: string, sightings: PlateSighting[]): Promise<void> {
  if (sightings.length === 0) return;
  const batch = writeBatch(db);
  for (const s of sightings) {
    const { id, ...fields } = s;
    batch.set(doc(db, 'plateSightings', id), { ...fields, userId });
    batch.set(doc(db, 'plateIndex', `${userId}__${s.plate}`), { userId, plate: s.plate, count: increment(1), lastSeen: s.timestamp }, { merge: true });
  }
  await batch.commit();
}

function docToSighting(id: string, d: DocumentData): PlateSighting {
  return {
    id, plate: d.plate, cameraId: d.cameraId, cameraName: d.cameraName || 'Unknown camera', department: d.department,
    location: d.location, timestamp: toDate(d.timestamp), confidence: typeof d.confidence === 'number' ? d.confidence : null,
    source: d.source || 'gemini', formatValid: d.formatValid, corrected: d.corrected,
  };
}

export async function fetchSightingsForPlate(userId: string, plate: string): Promise<PlateSighting[]> {
  // Two equality filters only — Firestore needs no composite index for that; sorted by the route builder.
  const snap = await getDocs(query(collection(db, 'plateSightings'), where('userId', '==', userId), where('plate', '==', normalizePlate(plate)), limit(MAX_SIGHTINGS_PER_QUERY)));
  return snap.docs.map((d) => docToSighting(d.id, d.data()));
}

/** Every distinct plate this user has ever seen, with sighting counts — the pool possible matches are drawn from. */
export async function fetchPlateIndex(userId: string): Promise<PlateCandidate[]> {
  const snap = await getDocs(query(collection(db, 'plateIndex'), where('userId', '==', userId), limit(MAX_INDEX_PLATES)));
  return snap.docs.map((d) => {
    const x = d.data();
    return { plate: x.plate as string, count: Number(x.count) || 0, lastSeen: x.lastSeen ? toDate(x.lastSeen) : undefined };
  });
}

export type MatchDecision = 'confirmed' | 'rejected';
export interface StoredDecision { pair: string; plates: [string, string]; decision: MatchDecision }

export async function fetchDecisions(userId: string): Promise<StoredDecision[]> {
  const snap = await getDocs(query(collection(db, 'plateMatchDecisions'), where('userId', '==', userId), limit(2000)));
  return snap.docs.map((d) => {
    const x = d.data();
    return { pair: pairKey(x.a, x.b), plates: [x.a, x.b] as [string, string], decision: x.decision as MatchDecision };
  });
}

export async function saveDecision(userId: string, a: string, b: string, decision: MatchDecision, decidedBy: string): Promise<void> {
  await setDoc(doc(db, 'plateMatchDecisions', `${userId}__${pairKey(a, b)}`), {
    userId, a: normalizePlate(a), b: normalizePlate(b), decision, decidedBy, decidedAt: new Date(),
  });
}

export async function clearDecision(userId: string, a: string, b: string): Promise<void> {
  await deleteDoc(doc(db, 'plateMatchDecisions', `${userId}__${pairKey(a, b)}`));
}
