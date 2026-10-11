/**
 * Statewide vehicle trail (gap A18): where a plate was read, in order, across every camera and department the viewer may see, with the legs
 * between cameras (distance, time, speed) and the legs that cannot be right (a speed no vehicle reaches, two cameras far apart at the same
 * moment: a misread, or two vehicles).
 *
 * It works on the shared event store (every `plate.read` the analysis worker, the gateways, the department systems and the webhooks produced),
 * so a plate read by the traffic department's system and by a police camera is one trail. The route maths is the same pure code the
 * single-user tracker uses (`src/lib/plateTracking.ts`).
 *
 * Visibility follows the rest of the platform: a viewer's trail is built from the events they may see. A department they do not cover appears
 * only as a count of reads of that plate ("N reads in Police"), never where or when. Possible look-alike plates (OCR confusions) are
 * suggested, and the person decides which to add (`also`).
 */
import {
  buildRoute, findPossibleMatches, normalizePlate, type PlateSighting, type PossibleMatch, type Route, type RouteOptions, type RouteSighting,
} from '../../src/lib/plateTracking';
import type { PlatformEvent } from '../events/schema';
import type { AlertStore } from '../events/store';

export interface TrailScope { userId: string; departments?: string[]; all?: boolean }
export interface TrailDeps {
  events: Pick<AlertStore, 'queryEvents' | 'countEvents'>;
  /** Names of every department (for the counts of those the viewer does not cover); may be absent. */
  departments?: () => Promise<Array<{ name: string }>>;
}
export interface TrailOptions {
  from: Date;
  to: Date;
  /** Plates the person confirmed as the same vehicle (look-alikes); read as the searched plate. At most 5. */
  also?: string[];
  /** Edits away that count as a possible look-alike (default 1). */
  maxDistance?: number;
  maxEvents?: number;
  route?: RouteOptions;
}

export interface PlateSummary { plate: string; reads: number; cameras: number; departments: string[]; lastSeen: string }

export interface Trail {
  plate: string;
  window: { from: string; to: string };
  /** Reads of this plate (and the confirmed look-alikes) the viewer may see. */
  reads: number;
  route: Route;
  departments: string[];
  /** Other plates in view that are probably this plate misread, for a person to confirm or ignore. */
  possible: Array<Omit<PossibleMatch, 'lastSeen'> & { lastSeen?: string }>;
  confirmed: string[];
  /** Departments the viewer does not cover that also read this plate: a count, nothing else. */
  elsewhere: Array<{ department: string; reads: number }>;
  truncated: boolean;
  notes: string[];
}

export const querySightingEvents = (scope: TrailScope, from: Date, to: Date, after?: { ts: string; id: string }) => ({
  ...(scope.all ? { userId: scope.userId, all: true as const } : scope.departments?.length ? { userId: scope.userId, departments: scope.departments } : { userId: scope.userId }),
  types: ['plate.read'], from, to, after, limit: 500,
});

/** Every plate read the viewer may see in the period, newest first, up to `cap`. */
export async function collectReads(deps: Pick<TrailDeps, 'events'>, scope: TrailScope, from: Date, to: Date, cap = 20_000): Promise<{ events: PlatformEvent[]; truncated: boolean }> {
  const events: PlatformEvent[] = [];
  let after: { ts: string; id: string } | undefined;
  for (;;) {
    const page = await deps.events.queryEvents(querySightingEvents(scope, from, to, after));
    events.push(...page);
    if (page.length < 500) break;
    if (events.length >= cap) return { events: events.slice(0, cap), truncated: true };
    const last = page[page.length - 1]; after = { ts: last.ts, id: last.id };
  }
  return { events: events.length > cap ? events.slice(0, cap) : events, truncated: events.length > cap };
}

const plateOf = (e: PlatformEvent): string => normalizePlate(typeof e.data?.plate === 'string' ? (e.data.plate as string) : '');

/** One event as a sighting. A department system's read carries no confidence of its own, so it is null rather than invented. */
export function sightingOf(e: PlatformEvent, matchedAs: RouteSighting['matchedAs'] = 'exact'): RouteSighting {
  const conf = typeof e.confidence === 'number' ? e.confidence : typeof e.data?.confidence === 'number' ? (e.data.confidence as number) : null;
  const by = e.data?.readBy;
  const source: PlateSighting['source'] = by === 'gemini' || by === 'gemini-fallback' ? by : 'anpr';
  return {
    id: e.id, plate: plateOf(e), cameraId: e.cameraId, cameraName: e.cameraName, department: e.department, location: e.location,
    timestamp: new Date(e.ts), confidence: conf, source, matchedAs,
  };
}

/** The distinct plates in a set of reads, busiest first. */
export function summarisePlates(events: PlatformEvent[]): PlateSummary[] {
  const m = new Map<string, { reads: number; cams: Set<string>; deps: Set<string>; last: string }>();
  for (const e of events) {
    const p = plateOf(e);
    if (!p) continue;
    const c = m.get(p) ?? { reads: 0, cams: new Set<string>(), deps: new Set<string>(), last: e.ts };
    c.reads++; c.cams.add(e.cameraId); if (e.department) c.deps.add(e.department); if (e.ts > c.last) c.last = e.ts;
    m.set(p, c);
  }
  return [...m.entries()].map(([plate, c]) => ({ plate, reads: c.reads, cameras: c.cams.size, departments: [...c.deps].sort(), lastSeen: c.last }))
    .sort((a, b) => b.reads - a.reads || a.plate.localeCompare(b.plate));
}

/** Pure: reads in, trail out. `elsewhere` is added by `trailFor`, which can count what the viewer cannot see. */
export function buildTrail(events: PlatformEvent[], plateRaw: string, o: TrailOptions & { truncated?: boolean }): Trail {
  const plate = normalizePlate(plateRaw);
  const also = [...new Set((o.also ?? []).map(normalizePlate).filter((p) => p && p !== plate))].slice(0, 5);
  const sightings: RouteSighting[] = [];
  for (const e of events) {
    const p = plateOf(e);
    if (p === plate) sightings.push(sightingOf(e, 'exact'));
    else if (also.includes(p)) sightings.push(sightingOf(e, 'confirmed'));
  }
  const route = buildRoute(sightings, o.route);
  const counts = summarisePlates(events);
  const possible = findPossibleMatches(plate, counts.map((c) => ({ plate: c.plate, count: c.reads, lastSeen: new Date(c.lastSeen) })), o.maxDistance ?? 1)
    .filter((c) => !also.includes(c.plate))
    .map((c) => ({ ...c, lastSeen: c.lastSeen?.toISOString() }));
  const departments = [...new Set(sightings.map((s) => s.department).filter((d): d is string => !!d))].sort();
  const notes = [
    'A trail is built from plate reads the platform stored. A camera that did not read the plate, or a system that is not connected, leaves a gap, not a proof of absence.',
    'Plate reads can be wrong. A flagged leg (a speed no vehicle reaches, two distant cameras at the same moment) usually means a misread or two vehicles: check the pictures.',
    ...(o.truncated ? ['The period has more plate reads than were read; the trail covers the newest part of it only.'] : []),
    ...(route.segments.some((s) => !s.location) ? ['Some cameras have no position, so the distance to and from them is unknown.'] : []),
  ];
  return {
    plate, window: { from: o.from.toISOString(), to: o.to.toISOString() }, reads: sightings.length, route, departments, possible, confirmed: also,
    elsewhere: [], truncated: o.truncated === true, notes,
  };
}

/** Reads what the viewer may see, builds the trail, and counts the reads of the same plate in departments they may not see. */
export async function trailFor(deps: TrailDeps, scope: TrailScope, plateRaw: string, o: TrailOptions): Promise<Trail> {
  const { events, truncated } = await collectReads(deps, scope, o.from, o.to, o.maxEvents);
  const t = buildTrail(events, plateRaw, { ...o, truncated });
  if (!scope.all && deps.departments) {
    const mine = new Set(scope.departments ?? []);
    const others = (await deps.departments().catch(() => [])).filter((d) => !mine.has(d.name));
    const probe = [t.plate, ...t.confirmed];
    const counted = await Promise.all(others.map(async (d) => {
      let n = 0;
      for (const p of probe) n += await deps.events.countEvents({ userId: scope.userId, all: true, types: ['plate.read'], department: d.name, plate: p, from: o.from, to: o.to });
      return { department: d.name, reads: n };
    }));
    t.elsewhere = counted.filter((c) => c.reads > 0).sort((a, b) => b.reads - a.reads);
    if (t.elsewhere.length) t.notes.push('Other departments also read this plate; you can see how many reads, not where or when. Ask them, or an administrator, for the rest.');
  }
  return t;
}
