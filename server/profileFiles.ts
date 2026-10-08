import { readdirSync, readFileSync, existsSync } from 'node:fs';
import type { ProbeReport } from './cameraProfile';

/** The saved probe runs (scripts/probe-cameras.ts) in a folder, oldest first. */
export function profileFiles(dir = '.demo-logs'): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^profile-.*\.json$/.test(f)).sort().map((f) => `${dir}/${f}`);
}

/**
 * One report per camera from several runs: a later run wins, but a failure never replaces an earlier good result
 * (the grid sometimes refuses or times out a camera that played a minute before).
 */
export function mergeProfileFiles(files: string[]): ProbeReport[] {
  const byCamera = new Map<string, ProbeReport>();
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8')) as { reports: ProbeReport[] };
    for (const r of data.reports) {
      const prev = byCamera.get(r.cameraId);
      if (!prev || !r.failure || prev.failure) byCamera.set(r.cameraId, r);
    }
  }
  return [...byCamera.values()].sort((a, b) => a.cameraId.localeCompare(b.cameraId));
}
