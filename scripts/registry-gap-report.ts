/**
 * Makes a gap-analysis report from a registry CSV (the same columns as the bulk import) and prints it as Markdown, or CSV with --csv.
 *
 *   npm run registry-gap-report -- docs/sample-cameras.csv > docs/sample-gap-report.md
 *   npm run registry-gap-report -- docs/sample-cameras.csv --csv > gap.csv
 *   options: --radius 300 (metres a camera is taken to cover)  --ageing-years 5  --as-of 2026-10-11 (a fixed date, so the report is repeatable)
 */
import { readFileSync } from 'node:fs';
import { parseCsv } from '../src/lib/csv.ts';
import { computeGapAnalysis, gapReportToCsv } from '../src/lib/registryReport.ts';
import type { CameraConfig } from '../src/types.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d/.test(a));
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
if (!file) { console.error('Usage: registry-gap-report <cameras.csv> [--csv] [--radius 300] [--ageing-years 5] [--as-of YYYY-MM-DD]'); process.exit(2); }

const asOf = opt('as-of');
if (asOf) { const fixed = new Date(`${asOf}T12:00:00Z`).getTime(); const RealDate = Date; (globalThis as any).Date = class extends RealDate { constructor(...a: any[]) { if (a.length === 0) super(fixed); else super(...(a as [any])); } static now() { return fixed; } }; }

const rows = parseCsv(readFileSync(file, 'utf8'));
const cams: CameraConfig[] = rows.map((r, i) => {
  const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
  return {
    id: `row-${i + 1}`, name: r.name || `Camera ${i + 1}`, department: r.department || undefined, ownership: r.ownership || undefined, cameraType: (r.cameraType || undefined) as never,
    connectivityStatus: (r.connectivityStatus || undefined) as never, maintenanceStatus: (r.maintenanceStatus || undefined) as never, installDate: r.installDate || undefined, storageDetails: r.storageDetails || undefined,
    location: Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined,
  } as unknown as CameraConfig;
});
const report = computeGapAnalysis(cams, { coverageRadiusMeters: opt('radius') ? Number(opt('radius')) : undefined, ageingYears: opt('ageing-years') ? Number(opt('ageing-years')) : undefined });

if (args.includes('--csv')) { process.stdout.write(gapReportToCsv(report)); process.exit(0); }

const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '- none');
const out: string[] = [];
out.push(`# Sample gap-analysis report`, '',
  `Generated ${report.generatedAt.toISOString().slice(0, 10)} from \`${file.split('\\').join('/')}\` (${cams.length} cameras) by \`npm run registry-gap-report\`. A sample: the data is the sample dataset, not a real deployment.`, '',
  '## Summary', '',
  '| Finding | Count |', '|---|---|',
  `| Cameras in the registry | ${cams.length} |`,
  `| Without coordinates (not on the map) | ${report.unlocated.length} |`,
  `| Offline or degraded | ${report.offlineOrDegraded.length} |`,
  `| Ageing (installed more than ${opt('ageing-years') ?? 5} years ago) | ${report.ageing.length} |`,
  `| With incomplete metadata | ${report.incompleteMetadata.length} |`,
  `| Uncovered squares (no camera within ${report.coverage.radiusMeters} m) | ${report.coverage.uncoveredTotal} of ${report.coverage.cellsChecked} (${(100 - report.coverage.coveredPercent).toFixed(1)}%) |`, '',
  '## Cameras by department (fewest first)', '', '| Department | Cameras |', '|---|---|', ...report.departmentCoverage.map((d) => `| ${d.department} | ${d.count} |`), '',
  '## Not on the map', '', list(report.unlocated.map((c) => `${c.name} (${c.department ?? 'Unassigned'})`)), '',
  '## Offline or degraded', '', list(report.offlineOrDegraded.map((c) => `${c.name}: ${c.connectivityStatus}${c.maintenanceStatus ? `, ${c.maintenanceStatus}` : ''}`)), '',
  '## Ageing infrastructure', '', list(report.ageing.map((c) => `${c.name}: installed ${c.installDate}`)), '',
  '## Incomplete metadata', '', list(report.incompleteMetadata.map((m) => `${m.cameraName} (${m.department}): missing ${m.missing.join(', ')}`)), '',
  '## Uncovered zones', '',
  report.coverage.cellsChecked === 0 ? 'Needs at least 3 cameras with coordinates.' : `The area the located cameras span (their bounding box plus one radius) was cut into ${report.coverage.cellsChecked} squares of ${report.coverage.cellMeters} m; ${report.coverage.coveredPercent}% are within ${report.coverage.radiusMeters} m of a camera. The ${Math.min(10, report.uncoveredZones.length)} emptiest uncovered squares (centre, and the distance to the nearest camera):`,
  '', list(report.uncoveredZones.slice(0, 10).map((z) => `${z.lat}, ${z.lng}: ${z.nearestMeters} m from the nearest camera`)), '',
  '## What this report cannot say', '',
  '- It shows where the registry has **no camera**, not where a camera is needed: roads, buildings, crowds and risk are not in the data.',
  '- Coverage is a circle of fixed radius around each camera; real fields of view depend on lens, mounting height and obstructions.',
  '- A camera with no coordinates cannot be counted as covering anything.',
  '- Connectivity status here is what the registry record says, not a live check (see the Feed for live state).', '');
console.log(out.join('\n'));
