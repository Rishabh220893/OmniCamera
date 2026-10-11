/**
 * Prints the model tables of docs/load-test-report.md (markdown) from `platformModels.ts`, plus the measured platform figures from results/platform.json.
 *   node --import tsx scripts/capacity/platformReport.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { busLoad, clipFetch, erasureOverhead, eventLoad, eventStorage, fmtBytes, mbpsIn, processesFor, storagePlan, transferHours, videoBytesPerDay } from './platformModels';

const row = (...c: Array<string | number>) => `| ${c.join(' | ')} |`;
const n = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 1 });
const out: string[] = [];

out.push('### Video storage (arithmetic from the bitrate)', '', row('Cameras', 'Bitrate', 'Per day', '7 days', '30 days'), row('---:', '---:', '---:', '---:', '---:'));
for (const [c, m] of [[1_000, 2], [5_000, 2], [20_000, 2], [80_000, 1], [80_000, 2], [80_000, 4]] as const) out.push(row(n(c), `${m} Mbps`, fmtBytes(videoBytesPerDay(c, m)), fmtBytes(videoBytesPerDay(c, m) * 7), fmtBytes(videoBytesPerDay(c, m) * 30)));

out.push('', '### Raw capacity for a tiered plan (80,000 cameras, 1 Mbps sub stream; hot 3 days x3 copies, warm 4 days 4+2 erasure coding, cold 23 days 8+3)', '', row('Tier', 'Days', 'Logical', 'Overhead', 'Raw'), row('---', '---:', '---:', '---:', '---:'));
const p = storagePlan({ cameras: 80_000, mbps: 1, hot: { days: 3, overhead: 3 }, warm: { days: 4, overhead: erasureOverhead(4, 2) }, cold: { days: 23, overhead: erasureOverhead(8, 3) } });
out.push(row('hot', 3, fmtBytes(p.hot.logical), 'x3', fmtBytes(p.hot.raw)), row('warm', 4, fmtBytes(p.warm.logical), 'x1.5', fmtBytes(p.warm.raw)), row('cold', 23, fmtBytes(p.cold.logical), 'x1.375', fmtBytes(p.cold.raw)), row('**total**', 30, `**${fmtBytes(p.totalLogical)}**`, '', `**${fmtBytes(p.totalRaw)}**`));

out.push('', '### Bandwidth into one place', '', row('Cameras', 'Bitrate', 'Sustained', 'Time to move one day of it over 100 Gbit/s'), row('---:', '---:', '---:', '---:'));
for (const [c, m] of [[1_000, 2], [20_000, 2], [80_000, 1], [80_000, 2]] as const) out.push(row(n(c), `${m} Mbps`, `${n(mbpsIn(c, m) / 1000)} Gbit/s`, `${n(transferHours(videoBytesPerDay(c, m), 100_000))} h`));

out.push('', '### Fetching a clip from an edge (what edge recording costs the link)', '', row('Clip', 'Camera', 'Link', 'At once', 'One clip takes', 'Bytes'), row('---', '---:', '---:', '---:', '---:', '---:'));
for (const [min, mbps, link, k] of [[10, 2, 20, 1], [10, 2, 20, 4], [60, 2, 20, 1], [10, 2, 100, 1], [10, 4, 10, 1]] as const) { const f = clipFetch({ clipMinutes: min, mbps, linkMbps: link, concurrent: k }); out.push(row(`${min} min`, `${mbps} Mbps`, `${link} Mbit/s`, k, f.seconds < 120 ? `${Math.round(f.seconds)} s` : `${n(f.seconds / 60)} min`, fmtBytes(f.bytes))); }

out.push('', '### Events: rate, bus and storage (60 s interval, 25% pass the gate, 3 events per analysis, 12 pushed events per camera per hour, 390 B per event, 450 B per row)', '', row('Cameras', 'Events/s', 'Events/day', 'Bus MB/s', 'Rows in 30 days', 'Postgres, 30 days (data / with indexes)'), row('---:', '---:', '---:', '---:', '---:', '---:'));
for (const c of [500, 5_000, 20_000, 80_000]) {
  const l = eventLoad({ cameras: c, intervalS: 60, gatePassRate: 0.25, eventsPerAnalysis: 3, pushedPerCameraHour: 12, avgEventBytes: 390 });
  const s = eventStorage(l.perDay, 450, 30);
  out.push(row(n(c), n(l.perSecond), n(l.perDay), busLoad(l.perSecond, 390).MBps.toFixed(2), n(s.rows), `${fmtBytes(s.dataBytes)} / ${fmtBytes(s.withIndexesBytes)}`));
}

const f = 'scripts/capacity/results/platform.json';
if (existsSync(f)) {
  const m = JSON.parse(readFileSync(f, 'utf8'));
  const perProc = m.eventPipeline.eventsPerSecond as number;
  out.push('', '### What the measured event path implies', '', `One process of our event path (bus, alert engine with 20 rules, memory store; **no database**) handled ${n(perProc)} events/s on the test machine (a 1.1 GHz Celeron).`, '', row('Cameras', 'Events/s needed', 'Processes of that speed (60% headroom)'), row('---:', '---:', '---:'));
  for (const c of [500, 5_000, 20_000, 80_000]) { const l = eventLoad({ cameras: c, intervalS: 60, gatePassRate: 0.25, eventsPerAnalysis: 3, pushedPerCameraHour: 12, avgEventBytes: 390 }); out.push(row(n(c), n(l.perSecond), processesFor(l.perSecond, perProc))); }
}
console.log(out.join('\n'));
