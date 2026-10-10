/**
 * Several Firestore listeners shown as one list: a person's own documents plus the ones shared with each of their departments (one
 * equality query per department, because the security rules can prove an equality query is allowed and not an `in` list).
 * Kept free of Firebase imports so it can be tested; App.tsx wraps `onSnapshot` into a `Listen`.
 */
export type Listen<T> = (onItems: (items: Array<[string, T]>) => void, onError: (e: unknown) => void) => () => void;

/**
 * Calls `onChange` with the merged items (first source wins on a repeated id) once every source has answered, and again whenever one
 * changes. A source that fails is reported through `onError` and counts as empty, so the others still show.
 */
export function subscribeMerged<T>(listens: Array<Listen<T>>, onChange: (items: T[]) => void, onError: (e: unknown) => void): () => void {
  const parts = new Map<number, Array<[string, T]>>();
  const publish = () => {
    if (parts.size < listens.length) return;
    const merged = new Map<string, T>();
    for (let i = 0; i < listens.length; i++) for (const [id, item] of parts.get(i) ?? []) if (!merged.has(id)) merged.set(id, item);
    onChange([...merged.values()]);
  };
  const unsubs = listens.map((listen, i) => listen(
    (items) => { parts.set(i, items); publish(); },
    (e) => { onError(e); parts.set(i, []); publish(); },
  ));
  if (listens.length === 0) onChange([]);
  return () => unsubs.forEach((u) => u());
}
