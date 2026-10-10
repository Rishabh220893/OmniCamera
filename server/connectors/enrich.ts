/**
 * Turns plate reads into checks against the connected systems and the checks' findings into events, so the existing rules and alerts
 * (webhooks, throttling, acknowledgement) work on them without knowing a connector exists:
 *
 *   plate.read  ->  vehicle lookup      ->  plate.vehicle_flagged   (stolen, blacklisted, insurance/fitness expired)
 *               ->  wanted_vehicle      ->  plate.wanted            (named in an open FIR)
 *
 * It runs after the original events are already stored and alerted, never in front of them, so a slow or dead system cannot hold up
 * or lose a camera's own events. Derived events are made with the same ids on a retry, so they are stored once.
 */
import { makeEvent, type PlatformEvent } from '../events/schema';
import type { ConnectorHub } from './hub';
import { ConnectorError, normalisePlate, type ConnectorResult, type Flag, type Severity } from './types';

export interface EnrichOptions {
  hub: ConnectorHub;
  /** Receives the derived events (the alert engine's ingest). */
  emit(events: PlatformEvent[]): Promise<unknown>;
  /** Reads below this are not checked: a doubtful read would raise a false "stolen vehicle". Default 0.6. */
  minConfidence?: number;
  /** A plate on a camera is checked at most once per this many ms (the lookup cache also helps). Default 60 s. */
  perPlateIntervalMs?: number;
  log?: Pick<Console, 'warn'>;
  now?: () => number;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, notice: 1, warning: 2, critical: 3 };
const worst = (flags: Flag[]): Severity => flags.reduce<Severity>((w, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[w] ? f.severity : w), 'info');

export function createPlateEnricher(o: EnrichOptions) {
  const minConfidence = o.minConfidence ?? 0.6, interval = o.perPlateIntervalMs ?? 60_000, clock = o.now ?? Date.now;
  const log = o.log ?? console;
  const lastChecked = new Map<string, number>();
  const stats = { checked: 0, derived: 0, skippedLowConfidence: 0, skippedRecent: 0, lookupFailures: 0 };

  function derive(base: PlatformEvent, plate: string, r: ConnectorResult): PlatformEvent[] {
    if (!r.flags.length) return [];
    const camera = { id: base.cameraId, name: base.cameraName, userId: base.userId, department: base.department, location: base.location };
    const ts = new Date(base.ts);
    const common = { connector: r.connector, mock: r.mock, plate, queriedAt: r.queriedAt, ...(r.query === 'vehicle' ? { vehicle: r.data } : { record: r.data }) };
    const tags = ['connector', r.connector, ...(r.mock ? ['mock'] : [])];
    const prefix = r.mock ? '[MOCK] ' : '';
    if (r.query === 'wanted_vehicle') {
      return [makeEvent({
        type: 'plate.wanted', severity: 'critical', summary: `${prefix}Plate ${plate} is named in an open police record: ${r.flags.map((f) => f.text).join(' ')}`,
        dedupeKey: plate, data: { ...common, flags: r.flags }, tags: [...tags, 'wanted'], confidence: base.confidence,
      }, { source: `connector:${r.connector}`, camera, ts })];
    }
    return [makeEvent({
      type: 'plate.vehicle_flagged', severity: worst(r.flags), summary: `${prefix}Plate ${plate}: ${r.flags.map((f) => f.text).join(' ')}`,
      dedupeKey: plate, data: { ...common, flags: r.flags }, tags: [...tags, ...r.flags.map((f) => f.code)], confidence: base.confidence,
    }, { source: `connector:${r.connector}`, camera, ts })];
  }

  /** Checks the plate reads among `events` and sends what it finds to `emit`. Resolves when done; never rejects. */
  async function enrich(events: PlatformEvent[]): Promise<PlatformEvent[]> {
    const out: PlatformEvent[] = [];
    const jobs: Promise<void>[] = [];
    const seen = new Set<string>();
    for (const ev of events) {
      if (ev.type !== 'plate.read') continue;
      const plate = normalisePlate(String(ev.data.plate ?? ''));
      if (plate.length < 4) continue;
      if (typeof ev.confidence === 'number' && ev.confidence < minConfidence) { stats.skippedLowConfidence++; continue; }
      const key = `${ev.userId}\u0000${ev.cameraId}\u0000${plate}`;
      const now = clock();
      const last = lastChecked.get(key);
      if (seen.has(key) || (last !== undefined && last + interval > now)) { stats.skippedRecent++; continue; }
      seen.add(key); lastChecked.set(key, now);
      if (lastChecked.size > 20_000) lastChecked.delete(lastChecked.keys().next().value as string);
      for (const [connectors, type] of [[o.hub.answering('vehicle'), 'vehicle'], [o.hub.answering('wanted_vehicle'), 'wanted_vehicle']] as const) {
        for (const c of connectors) {
          stats.checked++;
          jobs.push(o.hub.lookup(c.id, { type, plate } as never).then((r) => { out.push(...derive(ev, plate, r)); }, (e) => {
            stats.lookupFailures++;
            // A circuit that is already open has been reported once; do not log it for every plate.
            if (!(e instanceof ConnectorError && (e.code === 'circuit_open' || e.code === 'unavailable'))) log.warn(`[CONNECTORS] ${c.id} lookup for ${plate} failed: ${e instanceof Error ? e.message : e}`);
            lastChecked.delete(key); // try again on the next sighting rather than waiting out the interval
          }));
        }
      }
    }
    await Promise.all(jobs);
    stats.derived += out.length;
    if (out.length) await o.emit(out).catch((e) => log.warn(`[CONNECTORS] could not record derived events: ${e instanceof Error ? e.message : e}`));
    return out;
  }

  return {
    enrich,
    stats: () => ({ ...stats }),
    /** Wraps an `emit` so the original events go first and the checks follow without holding it up. */
    wrapEmit(emit: (events: PlatformEvent[]) => Promise<unknown>): (events: PlatformEvent[]) => Promise<void> {
      return async (events) => {
        await emit(events);
        void enrich(events).catch((e) => log.warn(`[CONNECTORS] enrichment failed: ${e instanceof Error ? e.message : e}`));
      };
    },
  };
}
export type PlateEnricher = ReturnType<typeof createPlateEnricher>;
