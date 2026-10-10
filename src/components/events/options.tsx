import { useEffect, useMemo, useState } from 'react';
import { adminApi, type DepartmentRow } from '../../lib/adminApi';

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

/** The departments, with their video retention. Only admins may list them; for anyone else this stays null and callers keep a text box. */
export function useDepartments(): DepartmentRow[] | null {
  const [rows, setRows] = useState<DepartmentRow[] | null>(null);
  useEffect(() => {
    let live = true;
    adminApi.departments().then((d) => { if (live) setRows(d); }).catch(() => { if (live) setRows(null); });
    return () => { live = false; };
  }, []);
  return rows;
}

/** Department names for a dropdown. */
export function useDepartmentNames(): string[] | null {
  const rows = useDepartments();
  return useMemo(() => (rows ? rows.map((x) => x.name) : null), [rows]);
}
