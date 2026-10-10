import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/adminApi';

/** Event types a person can pick, in plain words. The code is what the server matches on. */
export const EVENT_TYPE_OPTIONS: { group: string; items: { value: string; label: string }[] }[] = [
  { group: 'Vehicles and plates', items: [
    { value: 'vehicle.seen', label: 'Vehicle seen (needs AI analysis)' }, { value: 'plate.read', label: 'Any plate read' }, { value: 'plate.watchlist_match', label: 'Plate on the watchlist' },
    { value: 'plate.vehicle_flagged', label: 'Vehicle flagged by a records check' }, { value: 'plate.wanted', label: 'Wanted vehicle' },
  ] },
  { group: 'People', items: [{ value: 'person.seen', label: 'Person seen (needs AI analysis)' }, { value: 'person.unknown', label: 'Unknown person' }, { value: 'person.known', label: 'Known person' }] },
  { group: 'Scene', items: [{ value: 'scene.unusual', label: 'Unusual activity' }, { value: 'scene.alert', label: 'Scene alert' }] },
  { group: 'Department systems', items: [
    { value: 'vms.motion', label: 'Motion' }, { value: 'vms.line_crossing', label: 'Line crossing' }, { value: 'vms.intrusion', label: 'Intrusion' }, { value: 'vms.alarm', label: 'Alarm' },
  ] },
  { group: 'Camera status', items: [
    { value: 'camera.tamper', label: 'Camera tampered' }, { value: 'camera.offline', label: 'Camera went offline' }, { value: 'camera.online', label: 'Camera back online' },
  ] },
  { group: 'System', items: [
    { value: 'gateway.offline', label: 'Gateway offline' }, { value: 'gateway.degraded', label: 'Gateway degraded' }, { value: 'gateway.online', label: 'Gateway online' },
    { value: 'analyzer.failed', label: 'Analyzer failed' }, { value: 'system.test', label: 'Test event' },
  ] },
];
export const KNOWN_EVENT_TYPES = new Set(EVENT_TYPE_OPTIONS.flatMap((g) => g.items.map((i) => i.value)));

/** Department names for a dropdown. Only admins may list them; for anyone else `names` stays null and the caller keeps a text box. */
export function useDepartmentNames(): string[] | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    adminApi.departments().then((d) => { if (live) setNames(d.map((x) => x.name)); }).catch(() => { if (live) setNames(null); });
    return () => { live = false; };
  }, []);
  return names;
}
