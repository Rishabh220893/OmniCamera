/**
 * Face matching by embedding (gap A17): an enrolled face is a vector (from a face-embedding model on the inference service); a face in a frame is
 * matched by the closest enrolled vector (cosine similarity) above a threshold. Brute force over a few thousand faces takes a millisecond or two;
 * beyond tens of thousands per search the same interface needs a vector index (HNSW, pgvector), which is not built.
 *
 * Matching faces is the most error-prone, and most sensitive, thing this platform can do: a threshold that is too low names the wrong person. The
 * default is strict, the result carries its score, and a match is a pointer for a person to check, not an identification. Whether and where it may be
 * used is a legal question for the State (docs/federation-plan.md, section 2); this module only does the arithmetic.
 */
export interface EnrolledFace { id: string; name: string; embedding: number[] }
export interface FaceMatch { id: string; name: string; score: number }

export interface FaceIndex {
  size(): number;
  /** The best enrolled face at or above the threshold, or null. Ties go to the first enrolled. */
  match(embedding: number[], threshold?: number): FaceMatch | null;
  /** The best few, for a person to look at. */
  nearest(embedding: number[], k?: number): FaceMatch[];
}

/** Cosine similarity of two vectors of the same length; 0 when either has no length or the sizes differ. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function createFaceIndex(faces: EnrolledFace[], o: { threshold?: number } = {}): FaceIndex {
  const threshold = o.threshold ?? 0.6;
  // Unit-length copies, so a search is one dot product each.
  const unit = faces.filter((f) => f.embedding.length > 0 && f.embedding.every(Number.isFinite)).map((f) => {
    const n = Math.sqrt(f.embedding.reduce((s, v) => s + v * v, 0));
    return { id: f.id, name: f.name, v: Float32Array.from(f.embedding, (x) => (n === 0 ? 0 : x / n)) };
  });
  const score = (q: Float32Array, v: Float32Array) => { if (q.length !== v.length) return 0; let d = 0; for (let i = 0; i < q.length; i++) d += q[i] * v[i]; return d; };
  const prep = (e: number[]) => { const n = Math.sqrt(e.reduce((s, v) => s + v * v, 0)); return Float32Array.from(e, (x) => (n === 0 ? 0 : x / n)); };
  return {
    size: () => unit.length,
    nearest(embedding, k = 3) {
      if (!embedding.length || !embedding.every(Number.isFinite)) return [];
      const q = prep(embedding);
      return unit.map((f) => ({ id: f.id, name: f.name, score: score(q, f.v) })).sort((a, b) => b.score - a.score).slice(0, k);
    },
    match(embedding, t = threshold) {
      const best = this.nearest(embedding, 1)[0];
      return best && best.score >= t ? best : null;
    },
  };
}
