/**
 * Key rotation for sealed logins (`SOURCE_SECRET_KEY`). Two places hold sealed values: the camera sources (`camera_sources`) and the
 * department systems file (`vms-systems.json`, `sealedCredentials`). A rotation re-seals each value with the newest key of the ring,
 * after which the older keys can be removed from the environment.
 *
 * Safe to repeat and to interrupt: a value already sealed with the newest key is left alone, one that no key opens is reported (never
 * overwritten), and a dry run changes nothing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretBox } from './secretBox';
import { SOURCES_SITE, type SourceStore } from './store';

export interface RotateResult { checked: number; resealed: number; alreadyCurrent: number; unreadable: string[] }
const empty = (): RotateResult => ({ checked: 0, resealed: 0, alreadyCurrent: 0, unreadable: [] });

/** Whether a sealed value needs sealing again: true when it was sealed with an older key (or, for a plain one-key box, never). */
const stale = (box: SecretBox, sealed: string) => (box.isStale ? box.isStale(sealed) : false);

export async function rotateSources(o: { sources: SourceStore; box: SecretBox; dryRun?: boolean }): Promise<RotateResult> {
  const out = empty();
  for (const rec of await o.sources.list(SOURCES_SITE)) {
    if (!rec.sealed) continue;
    out.checked++;
    try {
      const plain = o.box.open(rec.sealed);
      if (!stale(o.box, rec.sealed)) { out.alreadyCurrent++; continue; }
      if (!o.dryRun) await o.sources.put({ ...rec, sealed: o.box.seal(plain), updatedAt: new Date().toISOString() });
      out.resealed++;
    } catch { out.unreadable.push(rec.cameraId); }
  }
  return out;
}

/** The department systems file: seals logins still in clear text and re-seals those sealed with an older key. */
export async function rotateSystemsFile(o: { file: string; box: SecretBox; dryRun?: boolean }): Promise<RotateResult> {
  const out = empty();
  let list: Array<Record<string, unknown>>;
  try { list = JSON.parse(await fs.readFile(o.file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out; throw e; }
  let changed = false;
  const next = list.map((s) => {
    const id = String(s.id ?? '?');
    if (typeof s.sealedCredentials === 'string') {
      out.checked++;
      try {
        const plain = o.box.open(s.sealedCredentials);
        if (!stale(o.box, s.sealedCredentials)) { out.alreadyCurrent++; return s; }
        changed = true; out.resealed++;
        return { ...s, sealedCredentials: o.box.seal(plain) };
      } catch { out.unreadable.push(id); return s; }
    }
    if (s.credentials && typeof s.credentials === 'object') {
      out.checked++; out.resealed++; changed = true;
      const { credentials, ...rest } = s;
      return { ...rest, sealedCredentials: o.box.seal(JSON.stringify(credentials)) };
    }
    return s;
  });
  if (changed && !o.dryRun) {
    const tmp = `${o.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.mkdir(path.dirname(o.file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(tmp, o.file);
  }
  return out;
}
