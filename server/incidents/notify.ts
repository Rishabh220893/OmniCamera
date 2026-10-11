/**
 * Incident notifications. A new incident becomes an ordinary `incident.opened` event (one for each department it touches, or for its owner when
 * none), so alert rules, and through them the webhook, e-mail and SMS channels, handle it like anything else: a department writes one rule
 * ("type incident.opened, send to the control room") and is told when any incident reaches its cameras. Nothing new to configure.
 *
 * An incident is announced once (`notifiedAt` is saved on it), however many times it is later updated or the server restarts.
 */
import { makeEvent, type PlatformEvent } from '../events/schema';
import type { Incident, IncidentStore } from './store';

const KIND_TEXT: Record<Incident['kind'], string> = { plate_trail: 'A plate was seen on several cameras', watchlist: 'A watchlist or wanted plate was seen', multi_source: 'Several systems reported activity on one camera' };

/** The events that announce one incident: one per department involved (at most 5), else one for the owner. */
export function incidentOpenedEvents(i: Incident): PlatformEvent[] {
  const camId = i.cameraIds[0] ?? 'incident', camName = i.cameraNames[0] ?? 'Incident';
  const owners = i.departments.length ? i.departments.slice(0, 5).map((d) => ({ department: d as string | undefined })) : [{ department: undefined as string | undefined }];
  return owners.map(({ department }) => makeEvent({
    type: 'incident.opened', severity: i.severity,
    summary: `${i.title}${i.crossDepartment ? ' (more than one department)' : ''}`,
    data: { incidentId: i.id, kind: i.kind, key: i.key, what: KIND_TEXT[i.kind], departments: i.departments, crossDepartment: i.crossDepartment, cameras: i.cameraNames.slice(0, 10), eventCount: i.eventCount },
    tags: ['incident', i.kind], dedupeKey: `${i.id}:${department ?? ''}`,
  }, { source: 'incident-engine', camera: { id: camId, name: camName, userId: i.userIds[0] ?? 'system', department }, ts: new Date(i.createdAt) }));
}

/** Announces the incidents that have not been announced: marks each (so a restart or a second call does not repeat it), then emits. Returns how many. */
export async function announceIncidents(o: { store: Pick<IncidentStore, 'save'>; incidents: Incident[]; emit: (events: PlatformEvent[]) => Promise<unknown>; now?: () => Date; log?: Pick<Console, 'warn'> }): Promise<number> {
  let n = 0;
  for (const i of o.incidents) {
    if (i.notifiedAt || i.state !== 'open') continue;
    try {
      await o.store.save({ ...i, notifiedAt: (o.now ?? (() => new Date()))().toISOString() });
      await o.emit(incidentOpenedEvents(i));
      n++;
    } catch (e) { (o.log ?? console).warn(`[INCIDENTS] could not announce ${i.id}: ${e instanceof Error ? e.message : e}`); }
  }
  return n;
}
