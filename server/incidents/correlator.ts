/**
 * The correlation engine (docs/incidents.md): turns events that belong together into one incident. Three rules, all deterministic:
 *
 *   plate_trail   the same plate on two or more different cameras within the trail window (a vehicle that moved between cameras,
 *                 possibly between departments)
 *   watchlist     a watchlist or wanted plate was seen: an incident from the first sighting, kept open while it keeps being seen
 *   multi_source  two or more different sources (a department system and the AI, two analyzers) reported activity on the same camera
 *                 within the burst window: the report is confirmed, not a single sensor's guess
 *
 * It reads the other events from the event store, not from its own memory, so it also works when several server processes each see
 * some of the events. Calling `observe` again with the same events changes nothing (an incident holds an event once).
 * Two processes handling the first two events of a trail at the same moment can each open an incident for it; the next event folds
 * into the newer one. Not made airtight because the cost is a duplicate that an operator can close.
 */
import { randomUUID } from 'node:crypto';
import type { PlatformEvent, Severity } from '../events/schema';
import { severityRank } from '../events/schema';
import type { AlertStore } from '../events/store';
import type { Incident, IncidentKind, IncidentStore } from './store';

export const PLATE_TYPES = ['plate.read', 'plate.watchlist_match', 'plate.wanted', 'plate.vehicle_flagged'] as const;
const HIT_TYPES = new Set(['plate.watchlist_match', 'plate.wanted']);
/** Findings that say "something happened", as opposed to bookkeeping (counts, reads, health). */
const SIGNAL = (type: string) => type.startsWith('vms.') || type === 'person.unknown' || type === 'scene.unusual' || type === 'scene.alert' || type === 'camera.tamper' || HIT_TYPES.has(type);
const MAX_EVENT_IDS = 500;
const MAX_NOTES = 50;

export const normalisePlate = (p: unknown): string => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const plateOf = (e: PlatformEvent) => normalisePlate((e.data as { plate?: unknown } | undefined)?.plate);
const maxSeverity = (list: Severity[], floor: Severity = 'info'): Severity => list.reduce((a, b) => (severityRank(b) > severityRank(a) ? b : a), floor);
const uniq = (list: Array<string | undefined>) => [...new Set(list.filter((x): x is string => !!x))];

export interface CorrelatorOptions {
  /** Where the other events are read from (the same store the alert engine writes to). */
  events: Pick<AlertStore, 'queryEvents'>;
  store: IncidentStore;
  /** A plate counts as one trail while sightings are this close together (default 60 minutes). */
  trailWindowMs?: number;
  /** Reports on one camera count as one burst within this time (default 3 minutes). */
  burstWindowMs?: number;
  /** An open multi-source incident on a camera keeps absorbing new reports for this long (default 30 minutes). */
  burstFoldMs?: number;
  now?: () => Date;
  newId?: () => string;
  log?: Pick<Console, 'warn'>;
}

export interface Correlator {
  /** Looks at newly stored events and opens or extends incidents. Returns the incidents that were created or changed. */
  observe(events: PlatformEvent[]): Promise<Incident[]>;
}

interface Spec { kind: IncidentKind; key: string; title: string; events: PlatformEvent[]; floor: Severity; windowMs: number }

export function createCorrelator(o: CorrelatorOptions): Correlator {
  const trailMs = o.trailWindowMs ?? 60 * 60_000;
  const burstMs = o.burstWindowMs ?? 3 * 60_000;
  const foldMs = o.burstFoldMs ?? 30 * 60_000;
  const now = o.now ?? (() => new Date());
  const newId = o.newId ?? randomUUID;
  const log = o.log ?? console;

  const summarise = (events: PlatformEvent[]) => {
    const ts = events.map((e) => e.ts).sort();
    const cameraIds = uniq(events.map((e) => e.cameraId));
    const names = new Map(events.map((e) => [e.cameraId, e.cameraName]));
    const departments = uniq(events.map((e) => e.department));
    return { first: ts[0], last: ts[ts.length - 1], cameraIds, cameraNames: cameraIds.map((c) => names.get(c) ?? c), departments, userIds: uniq(events.map((e) => e.userId)) };
  };

  /** Opens the incident, or adds the events to the open one with the same kind and key. Returns it if anything changed. */
  async function upsert(s: Spec): Promise<Incident | null> {
    if (s.events.length === 0) return null;
    const sum = summarise(s.events);
    const open = await o.store.findOpen(s.kind, s.key, new Date(sum.last).getTime() - s.windowMs);
    if (!open) {
      const incident: Incident = {
        id: newId(), kind: s.kind, key: s.key, title: s.title, state: 'open',
        severity: maxSeverity(s.events.map((e) => e.severity), s.floor), eventIds: [...new Set(s.events.map((e) => e.id))].slice(-MAX_EVENT_IDS), eventCount: new Set(s.events.map((e) => e.id)).size,
        cameraIds: sum.cameraIds, cameraNames: sum.cameraNames, departments: sum.departments, userIds: sum.userIds, crossDepartment: sum.departments.length > 1,
        firstAt: sum.first, lastAt: sum.last, createdAt: now().toISOString(), notes: [],
      };
      if (incident.crossDepartment) incident.severity = maxSeverity([incident.severity], 'warning');
      await o.store.save(incident);
      return incident;
    }
    const have = new Set(open.eventIds);
    const added = s.events.filter((e) => !have.has(e.id));
    if (added.length === 0) return null;
    const all = summarise(added);
    open.eventIds = [...open.eventIds, ...new Set(added.map((e) => e.id))].slice(-MAX_EVENT_IDS);
    open.eventCount += new Set(added.map((e) => e.id)).size;
    for (const c of all.cameraIds) if (!open.cameraIds.includes(c)) { open.cameraIds.push(c); open.cameraNames.push(all.cameraNames[all.cameraIds.indexOf(c)]); }
    open.departments = uniq([...open.departments, ...all.departments]);
    open.userIds = uniq([...open.userIds, ...all.userIds]);
    open.crossDepartment = open.departments.length > 1;
    if (all.first < open.firstAt) open.firstAt = all.first;
    if (all.last > open.lastAt) open.lastAt = all.last;
    open.severity = maxSeverity([open.severity, ...added.map((e) => e.severity)], open.crossDepartment ? 'warning' : s.floor);
    await o.store.save(open);
    return open;
  }

  async function sightings(plate: string, at: string): Promise<PlatformEvent[]> {
    const from = new Date(new Date(at).getTime() - trailMs);
    const rows = await o.events.queryEvents({ userId: '', all: true, types: PLATE_TYPES.map((t) => t), text: plate, from, limit: 200 });
    return rows.filter((e) => plateOf(e) === plate && e.ts >= from.toISOString());
  }

  async function plateRules(e: PlatformEvent, out: Incident[]) {
    const plate = plateOf(e);
    if (!plate) return;
    const near = await sightings(plate, e.ts);
    const events = near.some((x) => x.id === e.id) ? near : [...near, e];
    if (HIT_TYPES.has(e.type)) {
      const hit = events.filter((x) => HIT_TYPES.has(x.type));
      const i = await upsert({ kind: 'watchlist', key: `hit:${plate}`, title: `Watchlist vehicle ${plate} seen`, events: hit.length ? hit : [e], floor: 'critical', windowMs: trailMs });
      if (i) out.push(i);
    }
    const cameras = new Set(events.map((x) => x.cameraId));
    if (cameras.size >= 2) {
      const i = await upsert({ kind: 'plate_trail', key: `trail:${plate}`, title: `Vehicle ${plate} seen on ${cameras.size} cameras`, events, floor: 'notice', windowMs: trailMs });
      if (i) { i.title = `Vehicle ${plate} seen on ${i.cameraIds.length} cameras${i.crossDepartment ? ` in ${i.departments.length} departments` : ''}`; await o.store.save(i); out.push(i); }
    }
  }

  async function burstRule(e: PlatformEvent, out: Incident[]) {
    if (!SIGNAL(e.type)) return;
    const from = new Date(new Date(e.ts).getTime() - burstMs);
    const rows = await o.events.queryEvents({ userId: '', all: true, cameraId: e.cameraId, from, limit: 100 });
    const events = (rows.some((x) => x.id === e.id) ? rows : [...rows, e]).filter((x) => SIGNAL(x.type) && x.ts >= from.toISOString());
    const sources = new Set(events.map((x) => x.source));
    if (sources.size < 2) return;
    const i = await upsert({ kind: 'multi_source', key: `cam:${e.cameraId}`, title: `Activity at ${e.cameraName} reported by ${sources.size} systems`, events, floor: 'warning', windowMs: foldMs });
    if (i) out.push(i);
  }

  return {
    async observe(events) {
      const changed = new Map<string, Incident>();
      const ordered = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      for (const e of ordered) {
        const out: Incident[] = [];
        try { await plateRules(e, out); await burstRule(e, out); }
        catch (err) { log.warn(`[INCIDENTS] Could not correlate event ${e.id}:`, err instanceof Error ? err.message : err); }
        for (const i of out) changed.set(i.id, i);
      }
      return [...changed.values()];
    },
  };
}


/** Adds a note (kept to the newest 50). */
export function withNote(i: Incident, text: string, by: string, at: Date): Incident {
  return { ...i, notes: [...i.notes, { text: text.slice(0, 1000), by, at: at.toISOString() }].slice(-MAX_NOTES) };
}
