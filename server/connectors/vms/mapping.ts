/** Turns a department system's events into the platform's events (server/events/schema.ts), so rules, alerts and search treat them like any other. */
import { makeEvent, type EventDraft, type PlatformEvent } from '../../events/schema';
import { platformCameraId, type VmsCamera, type VmsEvent, type VmsEventKind, type VmsSystemConfig } from './types';

const TYPE: Record<VmsEventKind, { type: string; severity: 'info' | 'notice' | 'warning' | 'critical'; summary: (e: VmsEvent) => string }> = {
  motion: { type: 'vms.motion', severity: 'info', summary: () => 'Motion reported by the department system' },
  plate: { type: 'plate.read', severity: 'info', summary: (e) => `Plate ${String(e.data.plate ?? '?')} read by the department system` },
  tamper: { type: 'camera.tamper', severity: 'warning', summary: () => 'The department system reports the camera is covered or tampered with' },
  line_crossing: { type: 'vms.line_crossing', severity: 'notice', summary: () => 'Line crossing reported by the department system' },
  intrusion: { type: 'vms.intrusion', severity: 'warning', summary: () => 'Intrusion reported by the department system' },
  alarm: { type: 'vms.alarm', severity: 'notice', summary: (e) => String(e.data.text ?? `Alarm ${e.vendorCode} from the department system`) },
};

/** The source name events carry: the system, so a rule can say "only from the traffic department's VMS". */
export const vmsSource = (system: VmsSystemConfig) => `vms:${system.id}`;

export function draftFromVmsEvent(system: VmsSystemConfig, ev: VmsEvent): EventDraft {
  const t = TYPE[ev.kind];
  const data: Record<string, unknown> = { ...ev.data, vendorCode: ev.vendorCode, vendorEventId: ev.id, system: system.id };
  const tags = ['vms', system.id];
  const draft: EventDraft = { type: t.type, severity: t.severity, summary: t.summary(ev), data, tags, dedupeKey: `${system.id}:${ev.id}`, source: vmsSource(system) };
  if (ev.kind === 'plate') {
    // Same shape the platform's own plate events have, so plate search, watchlists and the connector checks apply unchanged.
    const plate = String(ev.data.plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    data.plate = plate;
    data.readBy = vmsSource(system);
    if (typeof ev.data.confidence === 'number') draft.confidence = ev.data.confidence;
  }
  return draft;
}

export function platformEventFromVms(system: VmsSystemConfig, camera: Pick<VmsCamera, 'id' | 'name' | 'location'> | undefined, ev: VmsEvent): PlatformEvent {
  const vendorId = camera?.id ?? ev.cameraId;
  return makeEvent(draftFromVmsEvent(system, ev), {
    source: vmsSource(system),
    camera: { id: platformCameraId(system.id, vendorId), name: camera?.name ?? vendorId, userId: system.ownerUserId, department: system.department, location: camera?.location },
    ts: ev.at,
  });
}

/** A camera that went offline or came back, as an event (the system's own state, polled). */
export function cameraStateEvent(system: VmsSystemConfig, camera: VmsCamera, online: boolean, at: Date): PlatformEvent {
  return makeEvent({
    type: online ? 'camera.online' : 'camera.offline', severity: online ? 'info' : 'warning',
    summary: `${camera.name} is ${online ? 'back online' : 'offline'} according to the department system`, data: { system: system.id, vendorCameraId: camera.id },
    tags: ['vms', system.id], dedupeKey: `${system.id}:${camera.id}:${online ? 'on' : 'off'}`, source: vmsSource(system),
  }, { source: vmsSource(system), camera: { id: platformCameraId(system.id, camera.id), name: camera.name, userId: system.ownerUserId, department: system.department, location: camera.location }, ts: at });
}
