/**
 * The known faces and plate watchlist an analysis uses for one camera: the owner's own, plus the ones shared with the camera's
 * department (documents carrying that `departmentId`). Used by the server's analysis worker and by regional gateways' context requests.
 */
export interface UserContext {
  knownFaces: Array<{ name: string; imageData: string }>;
  watchlist: string[];
}

interface DocLike { data(): Record<string, unknown> }
interface QueryLike { limit(n: number): QueryLike; get(): Promise<{ docs: DocLike[] }> }
/** The part of Firestore (Admin SDK) this needs; a small fake stands in for it in tests. */
export interface DocsLike { collection(name: string): { where(field: string, op: '==', value: unknown): QueryLike } }

/** At most this many reference faces reach the model (analyzeFrame cuts to 6 as well). */
export const MAX_FACES = 6;

export async function loadUserContext(db: DocsLike, userId: string, departmentId?: string): Promise<UserContext> {
  const own = (name: string, limit?: number) => { const q = db.collection(name).where('userId', '==', userId); return (limit ? q.limit(limit) : q).get(); };
  const shared = (name: string, limit?: number) => {
    if (!departmentId) return Promise.resolve({ docs: [] as DocLike[] });
    const q = db.collection(name).where('departmentId', '==', departmentId);
    return (limit ? q.limit(limit) : q).get();
  };
  const [ownFaces, deptFaces, ownWatch, deptWatch] = await Promise.all([own('faces', MAX_FACES), shared('faces', MAX_FACES), own('watchlist'), shared('watchlist')]);
  const face = (d: DocLike) => ({ name: d.data().name as string, imageData: d.data().imageData as string });
  const seen = new Set<string>();
  const knownFaces: UserContext['knownFaces'] = [];
  // The department's faces first: on its camera they matter most, and only MAX_FACES go to the model.
  for (const d of [...deptFaces.docs, ...ownFaces.docs]) {
    const f = face(d);
    const key = `${f.name}|${f.imageData?.length ?? 0}`;
    if (seen.has(key) || !f.name || !f.imageData) continue;
    seen.add(key);
    knownFaces.push(f);
    if (knownFaces.length >= MAX_FACES) break;
  }
  const watchlist = [...new Set([...deptWatch.docs, ...ownWatch.docs].map((d) => d.data().plate).filter((p): p is string => typeof p === 'string' && p.length > 0))];
  return { knownFaces, watchlist };
}
