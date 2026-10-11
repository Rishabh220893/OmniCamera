import { auth } from './firebase';
import { call } from './adminApi';

export type SeverityCounts = { info: number; notice: number; warning: number; critical: number };
export interface Ranked { key: string; name?: string; events: number }
export interface DepartmentSection {
  name: string; events: number; bySeverity: SeverityCounts; topTypes: Ranked[]; topCameras: Ranked[]; cameras: number; plateReads: number;
  sources: Array<{ source: string; events: number; lastAt: string }>; lastEventAt: string | null; retentionDays?: number; storage?: string; eventsPastRetention?: number;
}
export interface FederatedReport {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  viewer: 'organisation' | 'departments' | 'own';
  coveredDepartments: string[];
  truncated: boolean;
  eventsRead: number;
  totals: { events: number; bySeverity: SeverityCounts; topTypes: Ranked[]; cameras: number; sources: number };
  departments: DepartmentSection[];
  unassigned: { events: number };
  otherDepartments: Array<{ name: string; events: number }>;
  crossDepartment: {
    incidents: { total: number; open: number; crossDepartment: number; byKind: Record<string, number> };
    plates: { sharedCount: number; examples: Array<{ plate: string | null; departments: string[]; reads: number }> };
  };
  sources: Array<{ source: string; events: number; departments: string[]; lastAt: string }>;
  hours: number[];
  days: Array<{ date: string; events: number }>;
  notes: string[];
}

const query = (days: number, department: string) => `days=${days}${department ? `&department=${encodeURIComponent(department)}` : ''}&tz=${-new Date().getTimezoneOffset()}`;

export const reportApi = {
  federated: (days: number, department = '') => call<FederatedReport>(`/api/reports/federated?${query(days, department)}`),
  /** The CSV or printable page, fetched with the sign-in (a plain link cannot carry it) and handed to the browser as a file or a tab. */
  async open(format: 'csv' | 'html', days: number, department = ''): Promise<void> {
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
    const res = await fetch(`/api/reports/federated?${query(days, department)}&format=${format}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || `The server answered ${res.status}.`);
    const url = URL.createObjectURL(await res.blob());
    if (format === 'html') { window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); return; }
    const a = document.createElement('a');
    a.href = url; a.download = `federated-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};
