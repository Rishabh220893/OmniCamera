/**
 * Runs the synthetic camera lab: ffmpeg generates a stream per camera type with one fault injected, and the probe and
 * decision table must reach the recipe each one deserves. No cameras, no credentials. See tests/lab/cameraLab.ts.
 *
 *   node --import tsx scripts/camera-lab.ts                       all cases (about a minute: each is read in real time)
 *   node --import tsx scripts/camera-lab.ts --only h265,long_gop
 *   node --import tsx scripts/camera-lab.ts --keep                keep the generated clips in .demo-logs/lab
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLab, SAMPLE_SEC } from '../tests/lab/cameraLab';

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : undefined;
const keep = argv.includes('--keep');
const dir = keep ? path.join('.demo-logs', 'lab') : mkdtempSync(path.join(tmpdir(), 'camera-lab-'));

console.log(`Camera lab: ${SAMPLE_SEC}s real-time sample per case\n`);
const { results, skipped } = await runLab(dir, { only });
console.log('case            recipe  first  maxGap  flags');
for (const r of results) {
  const s = r.report.sample;
  console.log([
    r.case.name.padEnd(15), r.recipe.padEnd(7), (s?.timeToFirstFrameMs != null ? (s.timeToFirstFrameMs / 1000).toFixed(1) + 's' : '-').padEnd(6),
    (s && s.frames > 0 ? Math.max(s.keyframeIntervalSec?.max ?? 0, s.sinceLastKeyframeSec).toFixed(1) + 's' : '-').padEnd(7),
    r.report.flags.join(',') || r.report.failure || '-',
  ].join(' '));
}
for (const k of skipped) console.log(`skipped ${k.name}: ${k.why}`);
const bad = results.filter((r) => r.problems.length);
for (const r of bad) console.log(`\nFAIL ${r.case.name} (${r.case.what}):\n  - ${r.problems.join('\n  - ')}`);
console.log(bad.length ? `\n${bad.length} of ${results.length} cases differ from what they should be.` : `\nAll ${results.length} cases give the recipe they should.`);
if (!keep) rmSync(dir, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
