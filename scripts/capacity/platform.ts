/**
 * Measures what the platform's own code costs for the parts added since `controlPlane.ts` (gap A24): the event pipeline, event search, the trail and report
 * builders, the anomaly detector, the federation quota checks, the evidence cryptography. Everything is in-process and in memory: no network, no database, no
 * media server, no real cameras. It says how fast OUR code is on THIS machine; it says nothing about Postgres, Redis, Kafka, disks or links.
 *
 *   node --import tsx scripts/capacity/platform.ts            (about a minute; writes scripts/capacity/results/platform.json)
 *   node --import tsx scripts/capacity/platform.ts --quick    (a few seconds, smaller sizes)
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createMemoryBus } from '../../server/bus/memoryBus';
import { createEventPipeline } from '../../server/events/pipeline';
import { createAlertEngine } from '../../server/events/alertEngine';
import { createChannelRegistry, createLogChannel } from '../../server/events/channels';
import { createMemoryAlertStore } from '../../server/events/store';
import { validateRule } from '../../server/events/rules';
import { makeEvent, type PlatformEvent } from '../../server/events/schema';
import { federatedReport } from '../../server/reports/federated';
import { buildTrail, collectReads, summarisePlates } from '../../server/trail/trail';
import { createAnomalyDetector } from '../../server/analytics/anomaly';
import { createBaseline } from '../../server/analytics/baseline';
import { createMemoryUsageStore } from '../../server/federation/usageStore';
import { createMemoryIncidentStore } from '../../server/incidents/store';
import { encryptFile, decryptFile } from '../../server/recording/exportCrypto';
import { generateEvidenceKey, signManifest, signingKeyFromEnv, verifyManifest } from '../../server/recording/evidence';

const quick = process.argv.includes('--quick');
const N = quick ? { events: 5_000, search: 20_000, reads: 5_000, anomaly: 20_000, quota: 20_000, mb: 20 } : { events: 50_000, search: 200_000, reads: 20_000, anomaly: 200_000, quota: 200_000, mb: 200 };
const now = new Date('2026-10-11T12:00:00Z');
const out: Record<string, unknown> = { machine: { cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 1e9), node: process.version }, sizes: N, quick };
const t = async <T>(fn: () => Promise<T> | T) => { const s = performance.now(); const r = await fn(); return { ms: performance.now() - s, r }; };
const rate = (n: number, ms: number) => Math.round(n / (ms / 1000));

const DEPTS = ['Traffic', 'Police', 'Municipal', 'Excise', 'Water'];
const cam = (i: number) => ({ id: `cam${i % 2000}`, name: `Camera ${i % 2000}`, userId: 'owner', department: DEPTS[i % DEPTS.length], location: { lat: 22 + (i % 100) / 50, lng: 72 + (i % 100) / 50 } });
let seq = 0;
const ev = (i: number, type = 'person.seen', data: Record<string, unknown> = { count: 3 }, ts = new Date(now.getTime() - (i % 86_400) * 1000)): PlatformEvent => makeEvent({ type, summary: `${type} ${i}`, data, dedupeKey: `${type}-${i}-${seq++}` }, { source: 'bench', camera: cam(i), ts });

async function main() {
  // 1. The event path: bus -> alerting consumer -> alert engine with rules -> memory store.
  {
    const store = createMemoryAlertStore({ maxEvents: N.events + 10, maxAlerts: 1_000_000 });
    const engine = createAlertEngine({ store, channels: createChannelRegistry([createLogChannel({ warn() {} })]) });
    for (let i = 0; i < 20; i++) await store.saveRule(validateRule({ name: `rule ${i}`, match: { types: [i % 2 ? 'plate.*' : 'person.seen'], ...(i % 3 === 0 ? { minSeverity: 'info' } : {}) }, channels: [{ type: 'log' }], throttle: { windowMs: 60_000, by: ['camera'] } }, { userId: 'owner', id: `r${i}`, now }));
    const bus = createMemoryBus({ log: { warn() {} } });
    let handled = 0;
    const pipeline = await createEventPipeline({ bus, ingest: async (es) => { await engine.ingest(es); handled += es.length; }, batch: 100 });
    const events = Array.from({ length: N.events }, (_, i) => ev(i, i % 4 === 0 ? 'plate.read' : 'person.seen', i % 4 === 0 ? { plate: `GJ05AB${1000 + (i % 9000)}` } : { count: 2 }));
    const s = performance.now();
    for (let i = 0; i < events.length; i += 100) await pipeline.publish(events.slice(i, i + 100));
    while (handled < events.length) await new Promise((r) => setTimeout(r, 5));
    const ms = performance.now() - s;
    out.eventPipeline = { events: events.length, rules: 20, ms: Math.round(ms), eventsPerSecond: rate(events.length, ms), note: 'bus (memory) -> alert engine (20 rules, memory store) -> alerts; no database' };
    await pipeline.stop(); await bus.close();
  }

  // 2. Event search in the memory store (a linear scan: the Postgres store uses indexes, which are not measured here).
  const store = createMemoryAlertStore({ maxEvents: N.search + 10 });
  {
    const all = Array.from({ length: N.search }, (_, i) => ev(i, i % 5 === 0 ? 'plate.read' : 'person.seen', i % 5 === 0 ? { plate: `GJ05AB${1000 + (i % 9000)}` } : { count: 2 }));
    for (let i = 0; i < all.length; i += 5000) await store.saveEvents(all.slice(i, i + 5000));
    const run = async (label: string, q: Parameters<typeof store.queryEvents>[0]) => { const a = await t(() => store.queryEvents(q)); return { label, ms: Math.round(a.ms * 10) / 10, rows: a.r.length }; };
    out.search = {
      storedEvents: N.search, store: 'memory (linear scan)',
      queries: [
        await run('newest 100, everyone', { userId: '', all: true, limit: 100 }),
        await run('one department, 100', { userId: '', departments: ['Police'], limit: 100 }),
        await run('plate reads of one plate', { userId: '', all: true, types: ['plate.read'], plate: 'GJ05AB1005', limit: 100 }),
        await run('free text', { userId: '', all: true, text: 'plate.read 4', limit: 100 }),
        await run('last hour, one camera', { userId: '', all: true, cameraId: 'cam7', from: new Date(now.getTime() - 3_600_000), limit: 100 }),
      ],
    };
  }

  // 3. The trail and the report over the same store.
  {
    const reads = await t(() => collectReads({ events: store }, { userId: '', all: true }, new Date(now.getTime() - 86_400_000 * 2), now, N.reads));
    const trail = await t(() => buildTrail(reads.r.events, 'GJ05AB1005', { from: new Date(now.getTime() - 86_400_000 * 2), to: now, truncated: reads.r.truncated }));
    const plates = await t(() => summarisePlates(reads.r.events));
    const report = await t(() => federatedReport({ events: store, incidents: createMemoryIncidentStore(), departments: async () => DEPTS.map((name) => ({ name, retentionDays: 7 })) }, { userId: '', all: true }, { from: new Date(now.getTime() - 86_400_000), to: now, now, maxEvents: N.reads }));
    out.trailAndReport = {
      plateReadsRead: reads.r.events.length, readMs: Math.round(reads.ms), trailBuildMs: Math.round(trail.ms * 10) / 10, plateListMs: Math.round(plates.ms * 10) / 10,
      reportEvents: report.r.eventsRead, reportMs: Math.round(report.ms), note: 'reading pages of 500 from the memory store, then aggregating in JS; the Postgres store adds its own query time',
    };
  }

  // 4. The anomaly detector.
  {
    const det = createAnomalyDetector({ baseline: createBaseline({ minSamples: 12 }) });
    const events = Array.from({ length: N.anomaly }, (_, i) => ev(i, i % 2 ? 'person.seen' : 'vehicle.seen', { count: 5 + (i % 7) }, new Date(now.getTime() - (i % 5000) * 60_000)));
    const a = await t(() => { let raised = 0; for (let i = 0; i < events.length; i += 100) raised += det.handle(events.slice(i, i + 100)).length; return raised; });
    out.anomaly = { events: events.length, eventsPerSecond: rate(events.length, a.ms), anomaliesRaised: a.r, buckets: det.baseline.size() };
  }

  // 5. Federation quota and session checks (memory store).
  {
    const s = createMemoryUsageStore();
    const q = await t(async () => { for (let i = 0; i < N.quota; i++) await s.reserveEvents(`c${i % 200}`, 1, { perMinute: 1e9, perDay: 1e9 }, now.getTime() + i); });
    const l = await t(async () => { for (let i = 0; i < N.quota / 10; i++) { const r = await s.acquire({ id: `l${i}`, clientId: `c${i % 200}`, department: DEPTS[i % 5], what: 'wall' }, { client: 1e9 }, now.getTime(), 60_000); if (r.ok) await s.release(`c${i % 200}`, `l${i}`); } });
    out.federation = { quotaChecksPerSecond: rate(N.quota, q.ms), sessionTakeAndReleasePerSecond: rate(N.quota / 10, l.ms), note: 'in-memory store; the Redis store adds one round trip per call (not measured)' };
  }

  // 6. Evidence cryptography and hashing.
  {
    const dir = mkdtempSync(join(tmpdir(), 'cap-crypto-'));
    try {
      const plain = join(dir, 'clip.mp4'), enc = join(dir, 'clip.enc'), back = join(dir, 'back.mp4');
      const mb = N.mb;
      writeFileSync(plain, Buffer.alloc(0));
      const fs = await import('node:fs');
      const fd = fs.openSync(plain, 'w'); const chunk = randomBytes(1_000_000); for (let i = 0; i < mb; i++) fs.writeSync(fd, chunk); fs.closeSync(fd);
      const master = randomBytes(32);
      const e = await t(() => encryptFile(plain, enc, master));
      const d = await t(() => decryptFile(enc, back, master));
      const h = await t(async () => { const hh = createHash('sha256'); for await (const c of fs.createReadStream(plain)) hh.update(c as Buffer); return hh.digest('hex'); });
      const key = signingKeyFromEnv({ EVIDENCE_SIGNING_KEY: generateEvidenceKey().privatePem })!;
      const manifest = { id: 'x', segments: Array.from({ length: 200 }, (_, i) => ({ name: `s${i}.mp4`, sha256: 'a'.repeat(64) })) };
      const sg = await t(() => { let sig; for (let i = 0; i < 500; i++) sig = signManifest(manifest, key); return sig!; });
      const vf = await t(() => { let ok = true; for (let i = 0; i < 500; i++) ok = verifyManifest(manifest, sg.r, key.publicPem) && ok; return ok; });
      out.crypto = {
        fileMB: mb, encryptMBps: Math.round(mb / (e.ms / 1000)), decryptMBps: Math.round(mb / (d.ms / 1000)), sha256MBps: Math.round(mb / (h.ms / 1000)),
        encryptedBytesOverhead: statSync(enc).size - statSync(plain).size, manifestSignsPerSecond: rate(500, sg.ms), manifestVerifiesPerSecond: rate(500, vf.ms),
        note: 'a clip of 150 MB (10 minutes at 2 Mbit/s) takes this long to hash and to encrypt on this machine',
      };
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked */ } }
  }

  const dir = join(process.cwd(), 'scripts', 'capacity', 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, quick ? 'platform.quick.json' : 'platform.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
