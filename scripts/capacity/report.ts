/**
 * Prints the sizing tables of docs/capacity.md from the measured results and the tested model (scripts/capacity/model.ts).
 *
 *   node --import tsx scripts/capacity/report.ts
 *
 * Measured inputs are read from scripts/capacity/results/*.json; the two OS-level costs (frame grab and frame-gate fingerprint) come from
 * scripts/capacity/os-costs.ps1 and are recorded in results/osCosts.json. Everything else is an explicit assumption, printed beside the table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { analysesPerSecond, camerasPerCore, capturesPerSecond, coresNeeded, dailyWrites, gatewayUplinkKbps, modelCallsPerDay, probeConcurrencyFor, videoMbps, type Costs, type Rows } from './model';

const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'results');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const cp = read('controlPlane.json'), os = read('osCosts.json'), media = read('media.json');
const big = cp.runs.at(-1);

const costs: Costs = { captureCpuS: os.grabCpuSeconds, gateCpuS: os.gateCpuSeconds, platformCpuS: big.platformCpuMsPerAnalysis / 1000 };
const rows: Rows = { eventBytes: big.eventBytesAvg, logBytes: big.logBytesAvg, eventsPerAnalysis: big.eventsPerAnalysis, notableShare: 0.1 };
const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

console.log(`Inputs (measured on ${os.machine}): capture ${costs.captureCpuS} CPU-s, gate ${costs.gateCpuS} CPU-s, platform ${(costs.platformCpuS * 1000).toFixed(2)} ms per analysis; log ${rows.logBytes} B, event ${rows.eventBytes} B, ${rows.eventsPerAnalysis} events per analysis.`);
console.log('Assumptions: 60% target CPU load; 25% of captured frames pass the frame gate; 10% of logs are "notable".\n');

const fleets = [500, 5_000, 20_000, 80_000];
console.log('| Cameras | Interval | Captures/s | Analyses/s | Model calls/day | Cores of this class | Cameras per core |');
console.log('|---:|---:|---:|---:|---:|---:|---:|');
for (const intervalS of [60, 300]) for (const cameras of fleets) {
  const f = { cameras, intervalS, gatePassRate: 0.25 };
  console.log(`| ${fmt(cameras)} | ${intervalS} s | ${fmt(capturesPerSecond(f), 1)} | ${fmt(analysesPerSecond(f), 1)} | ${fmt(modelCallsPerDay(f))} | ${fmt(coresNeeded(f, costs), 1)} | ${fmt(camerasPerCore(intervalS, 0.25, costs))} |`);
}

console.log('\n| Cameras (60 s, gate 25%) | Log rows/day | Event rows/day | Postgres GB/day (data only) | Writes/s | Firestore log writes/day: all | notable only |');
console.log('|---:|---:|---:|---:|---:|---:|---:|');
for (const cameras of fleets) {
  const f = { cameras, intervalS: 60, gatePassRate: 0.25 };
  const all = dailyWrites(f, rows, 'all'), notable = dailyWrites(f, rows, 'notable');
  console.log(`| ${fmt(cameras)} | ${fmt(all.postgresLogRows)} | ${fmt(all.postgresEventRows)} | ${fmt(all.postgresGBPerDay, 2)} | ${fmt(all.writesPerSecondPeak, 1)} | ${fmt(all.firestoreLogWrites)} | ${fmt(notable.firestoreLogWrites)} |`);
}

console.log('\n| Cameras in one region | Video if pulled to the centre (1.6 Mbps each) | Gateway uplink (results only) | Ratio |');
console.log('|---:|---:|---:|---:|');
for (const cameras of [100, 500, 2_000]) {
  const video = videoMbps(cameras, media.clip.bitrateKbps), up = gatewayUplinkKbps(cameras, 60, 0.25, rows);
  console.log(`| ${fmt(cameras)} | ${fmt(video, 0)} Mbps | ${fmt(up, 1)} kbps | ${fmt((video * 1000) / up)} to 1 |`);
}

console.log('\n| Re-probe the whole fleet every | Cameras | Probes running at once (30 s sample + 6 s set-up) |');
console.log('|---:|---:|---:|');
for (const cameras of [5_000, 80_000]) for (const hours of [24, 168]) console.log(`| ${hours === 24 ? 'day' : 'week'} | ${fmt(cameras)} | ${fmt(probeConcurrencyFor(cameras, 30, 6, hours))} |`);
