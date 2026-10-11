/**
 * The arithmetic behind docs/load-test-report.md for what cannot be run here (gap A24): video storage and bandwidth at the 80,000-camera scale, the event
 * firehose, index and search sizing, and the clip-fetch link. Every function is a formula over stated inputs; nothing in this file is a measurement. The
 * measured parts (what the platform's own code costs) come from `platform.ts` and `controlPlane.ts`; `docs/load-test-report.md` keeps the two apart.
 */

const GB = 1e9, TB = 1e12, PB = 1e15;
export const SECONDS_PER_DAY = 86_400;

/** Video stored per day, in bytes. `mbps` is the recorded stream's bitrate in megabits per second. */
export const videoBytesPerDay = (cameras: number, mbps: number) => cameras * mbps * 1e6 / 8 * SECONDS_PER_DAY;

export interface StorageTier { days: number; /** Raw bytes stored per byte of video: 1 for none, 3 for three copies, 1.5 for 4+2 erasure coding, ... */ overhead: number }
export interface StoragePlan { cameras: number; mbps: number; hot: StorageTier; warm?: StorageTier; cold?: StorageTier }

/** Logical video and raw capacity (after replication or erasure coding) per tier, and in total. */
export function storagePlan(p: StoragePlan) {
  const perDay = videoBytesPerDay(p.cameras, p.mbps);
  const row = (t?: StorageTier) => (t ? { days: t.days, logical: perDay * t.days, raw: perDay * t.days * t.overhead } : { days: 0, logical: 0, raw: 0 });
  const hot = row(p.hot), warm = row(p.warm), cold = row(p.cold);
  return { perDay, hot, warm, cold, totalLogical: hot.logical + warm.logical + cold.logical, totalRaw: hot.raw + warm.raw + cold.raw };
}

/** Erasure coding k data + m parity shards stores (k+m)/k bytes per byte and survives losing any m shards. */
export const erasureOverhead = (k: number, m: number) => (k + m) / k;

/** Sustained network, in megabits per second. */
export const mbpsIn = (cameras: number, mbps: number) => cameras * mbps;

/** Wall-clock hours to move `bytes` over a link of `linkMbps` at a given efficiency (TCP, protocol, sharing): 0.7 is a sensible default. */
export const transferHours = (bytes: number, linkMbps: number, efficiency = 0.7) => (bytes * 8) / (linkMbps * 1e6 * efficiency) / 3600;

export interface ClipFetchModel { clipMinutes: number; mbps: number; linkMbps: number; /** Clips being fetched at the same time through this link. */ concurrent: number }
/** Time to bring one clip from an edge to the centre over a shared link, and the share of the link a burst of requests takes. */
export function clipFetch(m: ClipFetchModel, efficiency = 0.7) {
  const bytes = m.clipMinutes * 60 * m.mbps * 1e6 / 8;
  const perClipMbps = (m.linkMbps * efficiency) / Math.max(1, m.concurrent);
  return { bytes, seconds: (bytes * 8) / (perClipMbps * 1e6), perClipMbps };
}

/** The event firehose. */
export interface EventLoad { cameras: number; intervalS: number; gatePassRate: number; eventsPerAnalysis: number; /** Events from department systems and webhooks per camera per hour (motion, plates, alarms). */ pushedPerCameraHour: number; avgEventBytes: number }
export function eventLoad(l: EventLoad) {
  const analysed = (l.cameras / l.intervalS) * l.gatePassRate * l.eventsPerAnalysis;
  const pushed = (l.cameras * l.pushedPerCameraHour) / 3600;
  const perSecond = analysed + pushed;
  return { analysedPerSecond: analysed, pushedPerSecond: pushed, perSecond, perDay: perSecond * SECONDS_PER_DAY, bytesPerDay: perSecond * SECONDS_PER_DAY * l.avgEventBytes };
}

/** Postgres rows and rough index overhead: each index is about `indexFactor` of the row data (a conservative 0.4 for the five indexes on `platform_events`). */
export function eventStorage(perDay: number, avgRowBytes: number, days: number, indexFactor = 1.4) {
  const rows = perDay * days;
  return { rows, dataBytes: rows * avgRowBytes, withIndexesBytes: rows * avgRowBytes * (1 + indexFactor) };
}

/** Whether a search by (department, time) is served by an index: it is when the rows scanned are bounded by the page, not the table. */
export function searchRowsTouched(opts: { tableRows: number; matchingFraction: number; pageSize: number; indexed: boolean }) {
  return opts.indexed ? Math.min(opts.tableRows, Math.ceil(opts.pageSize / Math.max(opts.matchingFraction, 1e-9))) : opts.tableRows;
}

/** A bus (Kafka partition, Redis stream) carrying `perSecond` messages of `bytes` each: MB/s, and the partitions or shards needed at `perPartitionMBps`. */
export function busLoad(perSecond: number, bytes: number, perPartitionMBps = 10) {
  const mbps = (perSecond * bytes) / 1e6;
  return { MBps: mbps, partitions: Math.max(1, Math.ceil(mbps / perPartitionMBps)) };
}

/** Compares a sustained rate with a measured per-process capacity: how many processes it takes (headroom 0.6). */
export const processesFor = (perSecond: number, capacityPerProcess: number, headroom = 0.6) => Math.max(1, Math.ceil(perSecond / (capacityPerProcess * headroom)));

export const fmtBytes = (b: number): string => (b >= PB ? `${(b / PB).toFixed(2)} PB` : b >= TB ? `${(b / TB).toFixed(1)} TB` : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`);
