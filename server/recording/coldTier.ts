/**
 * The cold tier: recorded segments in an S3-compatible object store (federation plan A15). The store (store.ts) sees only this
 * interface, so another backend (a different cloud, tape-library gateway) is one more implementation.
 *
 * Layout: `<camera>/<segment file name>`. A segment's duration is kept as object metadata (`x-amz-meta-duration`) when it is uploaded,
 * so listing a camera costs one list call plus one metadata read per object not seen before (remembered afterwards).
 */
import type { S3Client } from './s3';

export interface ColdObject { name: string; bytes: number; durationSec: number | null }

export interface ColdTier {
  cameras(): Promise<string[]>;
  list(cameraId: string): Promise<ColdObject[]>;
  /** Uploads and checks the object is there with the right size before returning, so the caller may delete its local copy. */
  put(cameraId: string, name: string, file: string, durationSec: number | null, bytes: number): Promise<void>;
  download(cameraId: string, name: string, dest: string): Promise<void>;
  remove(cameraId: string, name: string): Promise<void>;
}

export function createS3ColdTier(client: S3Client, o: { concurrency?: number } = {}): ColdTier {
  const durations = new Map<string, number | null>();
  const concurrency = Math.max(1, o.concurrency ?? 8);
  const key = (cam: string, name: string) => `${cam}/${name}`;

  async function pool<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
    }));
    return out;
  }

  return {
    async cameras() {
      const { folders } = await client.list('', { delimiter: true });
      return folders.map((f) => f.replace(/\/$/, '')).filter(Boolean).sort();
    },

    async list(cameraId) {
      const { objects } = await client.list(`${cameraId}/`);
      const files = objects.filter((x) => x.key.startsWith(`${cameraId}/`) && x.key.endsWith('.mp4'));
      return pool(files, async (x) => {
        const name = x.key.slice(cameraId.length + 1);
        const k = `${x.key}\u0000${x.size}`;
        if (!durations.has(k)) {
          const h = await client.head(x.key).catch(() => null);
          const d = Number(h?.metadata.duration);
          durations.set(k, Number.isFinite(d) && d > 0 ? d : null);
          if (durations.size > 100_000) durations.delete(durations.keys().next().value as string);
        }
        return { name, bytes: x.size, durationSec: durations.get(k) ?? null };
      });
    },

    async put(cameraId, name, file, durationSec, bytes) {
      await client.put(key(cameraId, name), file, { metadata: durationSec ? { duration: durationSec.toFixed(3) } : {}, contentType: 'video/mp4' });
      const h = await client.head(key(cameraId, name));
      if (!h || h.size !== bytes) throw new Error(`The object store holds ${h?.size ?? 0} of ${bytes} bytes for ${name}; the local copy was kept.`);
      durations.set(`${key(cameraId, name)}\u0000${bytes}`, durationSec);
    },

    download: async (cameraId, name, dest) => { await client.download(key(cameraId, name), dest); },
    remove: (cameraId, name) => client.remove(key(cameraId, name)),
  };
}
