/**
 * Reads saved probe results and prints them as one table, without touching the grid.
 * Flags are recomputed from the saved measurements with the current rules, so a rule change applies to old runs.
 *
 *   node --import tsx scripts/probe-report.ts                      the newest .demo-logs/profile-*.json
 *   node --import tsx scripts/probe-report.ts a.json b.json        several files merged; a camera in a later file wins
 *   node --import tsx scripts/probe-report.ts --all                every file in .demo-logs, oldest first (the newest result per camera wins)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { deriveFlags, type ProbeReport } from '../server/cameraProfile';
import { allocateSlots, decide } from '../server/cameraRecipe';

const args = process.argv.slice(2);
const dir = '.demo-logs';
const all = readdirSync(dir).filter((f) => /^profile-.*\.json$/.test(f)).sort().map((f) => `${dir}/${f}`);
const files = args.includes('--all') ? all : args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : all.slice(-1);
if (files.length === 0) { console.error('No profile-*.json files in .demo-logs. Run scripts/probe-cameras.ts first.'); process.exit(1); }

const byCamera = new Map<string, ProbeReport>();
for (const f of files) {
  const data = JSON.parse(readFileSync(f, 'utf8')) as { reports: ProbeReport[] };
  for (const r of data.reports) {
    const prev = byCamera.get(r.cameraId);
    // A failure never replaces a good result from an earlier file.
    if (!prev || !r.failure || prev.failure) byCamera.set(r.cameraId, r);
  }
}
console.log(`Files: ${files.join(', ')}\n`);
const slots = Number(args.includes('--slots') ? args[args.indexOf('--slots') + 1] : 6);
console.log('camera  result      codec  size       first   maxGap  reorder  bad/100f  tsErr  recipe  flags');
const rows = [...byCamera.values()].sort((a, b) => a.cameraId.localeCompare(b.cameraId));
for (const r of rows) {
  const s = r.sample;
  const flags = s || r.describe ? deriveFlags(r.describe, s) : [];
  const dec = decide({ ...r, flags });
  const has = !!s && s.frames > 0;
  console.log([
    r.cameraId.padEnd(7), (r.failure ?? 'ok').padEnd(11), (r.describe?.codec ?? '-').padEnd(6),
    (r.describe?.width ? `${r.describe.width}x${r.describe.height}` : '-').padEnd(10),
    (s?.timeToFirstFrameMs != null ? (s.timeToFirstFrameMs / 1000).toFixed(1) + 's' : '-').padEnd(7),
    (has && s.keyframeCount !== undefined ? Math.max(s.keyframeIntervalSec?.max ?? 0, s.sinceLastKeyframeSec ?? 0).toFixed(1) + 's' : '-').padEnd(7),
    (has && s.maxReorderSec !== undefined ? s.maxReorderSec.toFixed(2) + 's' : '-').padEnd(8),
    (has ? ((s.corruptErrors / s.frames) * 100).toFixed(0) : '-').padEnd(9),
    String(s?.timestampErrors ?? '-').padEnd(6), `${dec.recipe}${dec.gridLive || dec.recipe === 'G' ? '' : '*'}`.padEnd(7), flags.join(',') || (r.failureDetail ?? '').slice(0, 60),
  ].join(' '));
}
const decisions = rows.map((r) => ({ cameraId: r.cameraId, decision: decide({ ...r, flags: deriveFlags(r.describe, r.sample) }), priority: 1 }));
const count = (rec: string) => decisions.filter((d) => d.decision.recipe === rec).length;
console.log(`\nRecipes: A pass-through ${count('A')}, B re-encode ${count('B')}, C H.265 ${count('C')}, D downscale ${count('D')}, F snapshot ${count('F')}, G unsupported ${count('G')}   (* = first picture over 30 s: snapshots in the grid)`);
const wantSlot = decisions.filter((d) => d.decision.transcode).length;
const live = allocateSlots(decisions, slots).filter((a) => a.decision.transcode && a.live).length;
console.log(`${wantSlot} cameras need a transcode slot; with ${slots} slots (--slots N) ${live} can be live at once, so the rest show snapshots until a slot frees up.`);
const ok = rows.filter((r) => !r.failure).length;
console.log(`\n${ok}/${rows.length} cameras gave video. Failed: ${rows.filter((r) => r.failure).map((r) => `${r.cameraId} (${r.failure})`).join(', ') || 'none'}`);
