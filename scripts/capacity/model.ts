/**
 * Capacity arithmetic used by docs/capacity.md. Everything here is a formula over inputs; the inputs that come from a measurement
 * are named as such in the benchmark scripts, and the ones that are assumptions are passed in explicitly.
 */

export interface Fleet {
  cameras: number;
  /** Seconds between two analyses of a camera. */
  intervalS: number;
  /** Share of captured frames the frame gate lets through to the analyzers (1 = no gating). */
  gatePassRate: number;
}

export interface Costs {
  /** CPU-seconds one frame capture takes (ffmpeg pulling one frame from the stream). Measured. */
  captureCpuS: number;
  /** CPU-seconds of platform code per analysed frame (scheduling, pipeline merge, log, events, alerting). Measured. */
  platformCpuS: number;
  /** CPU-seconds of the frame-gate fingerprint (one short ffmpeg run) per captured frame. Measured. */
  gateCpuS: number;
}

export const SECONDS_PER_DAY = 86_400;

/** Frames captured per second across the fleet. */
export const capturesPerSecond = (f: Fleet) => f.cameras / f.intervalS;

/** Frames that reach the (expensive) analyzers per second. */
export const analysesPerSecond = (f: Fleet) => capturesPerSecond(f) * f.gatePassRate;

/** Model calls per day if each analysed frame is one Gemini call. */
export const modelCallsPerDay = (f: Fleet) => Math.round(analysesPerSecond(f) * SECONDS_PER_DAY);

/** CPU cores kept busy on capture, gate and platform work (excluding the model call itself, which is remote). */
export function coresNeeded(f: Fleet, c: Costs, headroom = 0.6): number {
  const busy = capturesPerSecond(f) * (c.captureCpuS + c.gateCpuS) + analysesPerSecond(f) * c.platformCpuS;
  return busy / headroom;
}

/** How many cameras one core can serve at a given interval and gate rate. */
export function camerasPerCore(intervalS: number, gatePassRate: number, c: Costs, headroom = 0.6): number {
  const perCamera = (c.captureCpuS + c.gateCpuS) / intervalS + (gatePassRate * c.platformCpuS) / intervalS;
  return Math.floor(headroom / perCamera);
}

/** Wall time to probe a whole fleet once. A probe is real time: it takes as long as its sample. */
export function probeCampaignHours(cameras: number, sampleSec: number, overheadSec: number, concurrency: number): number {
  return (cameras * (sampleSec + overheadSec)) / concurrency / 3600;
}

/** Concurrency needed to re-probe the whole fleet once every `everyHours` hours. */
export function probeConcurrencyFor(cameras: number, sampleSec: number, overheadSec: number, everyHours: number): number {
  return Math.ceil((cameras * (sampleSec + overheadSec)) / (everyHours * 3600));
}

export interface Rows {
  /** Bytes of one stored event as JSON (measured from real event objects). */
  eventBytes: number;
  /** Bytes of one stored log document as JSON (measured). */
  logBytes: number;
  /** Events a typical analysed frame produces (assumption, e.g. 1 plate read + 0.1 notable). */
  eventsPerAnalysis: number;
  /** Share of log documents that are "notable" (unusual, watchlist, alerts). Assumption. */
  notableShare: number;
}

export type FirestoreLogMode = 'all' | 'notable' | 'none';

/** Daily storage and write counts for the event path. Writes are counted, not priced. */
export function dailyWrites(f: Fleet, r: Rows, firestoreLogMode: FirestoreLogMode) {
  const analyses = analysesPerSecond(f) * SECONDS_PER_DAY;
  const postgresLogRows = analyses;
  const postgresEventRows = analyses * r.eventsPerAnalysis;
  const firestoreLogWrites = firestoreLogMode === 'all' ? analyses : firestoreLogMode === 'notable' ? analyses * r.notableShare : 0;
  return {
    analysesPerDay: Math.round(analyses),
    postgresLogRows: Math.round(postgresLogRows),
    postgresEventRows: Math.round(postgresEventRows),
    firestoreLogWrites: Math.round(firestoreLogWrites),
    postgresGBPerDay: (postgresLogRows * r.logBytes + postgresEventRows * r.eventBytes) / 1e9,
    writesPerSecondPeak: (postgresLogRows + postgresEventRows) / SECONDS_PER_DAY,
  };
}

/** Bandwidth into a media server or out of a region. */
export const videoMbps = (streams: number, bitrateKbps: number) => (streams * bitrateKbps) / 1000;

/** What a gateway sends to the centre instead of video: events, logs and heartbeats, in kilobits per second. */
export function gatewayUplinkKbps(cameras: number, intervalS: number, gatePassRate: number, r: Rows, heartbeatBytes = 600, heartbeatEveryS = 15): number {
  const perSecond = (cameras / intervalS) * gatePassRate * (r.logBytes + r.eventsPerAnalysis * r.eventBytes) + heartbeatBytes / heartbeatEveryS;
  return (perSecond * 8) / 1000;
}
