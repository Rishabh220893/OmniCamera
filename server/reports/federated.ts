/**
 * The federated analytics report (gap A26): what the departments' systems reported over a period, side by side, and what only shows when they
 * are looked at together (one plate in several departments, incidents that cross departments, which systems report and which are quiet).
 *
 * Visibility follows the rest of the platform. A caller sees full detail for the departments they cover; an organisation-wide administrator sees
 * every department. A caller who covers only some departments sees the other departments as a name and an event count, nothing more, and plates
 * seen across departments are named only when every department involved is one they cover.
 *
 * It is computed on request from the event and incident stores, newest first, up to `maxEvents` events; a longer period says it was cut short.
 * Nothing here is stored.
 */
import type { PlatformEvent, Severity } from '../events/schema';
import { SEVERITIES } from '../events/schema';
import type { AlertStore } from '../events/store';
import type { Incident, IncidentStore } from '../incidents/store';

export interface ReportScope { userId: string; departments?: string[]; all?: boolean }
export interface DepartmentInfo { name: string; retentionDays?: number; storage?: string }

export interface ReportOptions {
  from: Date;
  to: Date;
  /** Narrow the detail to one department the caller covers. */
  department?: string;
  /** Most events read. Default 20,000. */
  maxEvents?: number;
  /** Minutes the local clock is ahead of UTC, for the hour-of-day chart. Default 330 (India). */
  tzMinutes?: number;
  now?: Date;
}

export type SeverityCounts = Record<Severity, number>;
export interface Ranked { key: string; name?: string; events: number }

export interface DepartmentSection {
  name: string;
  events: number;
  bySeverity: SeverityCounts;
  topTypes: Ranked[];
  topCameras: Ranked[];
  cameras: number;
  plateReads: number;
  sources: Array<{ source: string; events: number; lastAt: string }>;
  lastEventAt: string | null;
  retentionDays?: number;
  storage?: string;
  /** Events in the period that are older than the department's retention: the video behind them is probably no longer held. */
  eventsPastRetention?: number;
}

export interface FederatedReport {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  viewer: 'organisation' | 'departments' | 'own';
  coveredDepartments: string[];
  /** Events were read newest first and the cap was reached: the figures cover the newest part of the period only. */
  truncated: boolean;
  eventsRead: number;
  totals: { events: number; bySeverity: SeverityCounts; topTypes: Ranked[]; cameras: number; sources: number };
  departments: DepartmentSection[];
  /** Events with no department (own cameras not given to one). */
  unassigned: { events: number };
  /** Departments the caller does not cover: how many events they reported, nothing else. */
  otherDepartments: Array<{ name: string; events: number }>;
  crossDepartment: {
    incidents: { total: number; open: number; crossDepartment: number; byKind: Record<string, number> };
    /** Plates read by systems of more than one department. `plate` is null when a department involved is not one the caller covers. */
    plates: { sharedCount: number; examples: Array<{ plate: string | null; departments: string[]; reads: number }> };
  };
  sources: Array<{ source: string; events: number; departments: string[]; lastAt: string }>;
  hours: number[];
  days: Array<{ date: string; events: number }>;
  notes: string[];
}

const zero = (): SeverityCounts => ({ info: 0, notice: 0, warning: 0, critical: 0 });
const rank = (m: Map<string, { n: number; name?: string }>, top: number): Ranked[] =>
  [...m.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, top).map(([key, v]) => ({ key, name: v.name, events: v.n }));
const bump = (m: Map<string, { n: number; name?: string }>, key: string, name?: string) => { const c = m.get(key); if (c) c.n++; else m.set(key, { n: 1, name }); };
const dayKey = (ms: number, tzMinutes: number) => new Date(ms + tzMinutes * 60_000).toISOString().slice(0, 10);

export interface BuildInput {
  events: PlatformEvent[];
  incidents: Incident[];
  scope: ReportScope;
  departmentInfo: DepartmentInfo[];
  /** Counts for departments the caller does not cover (name -> events), already fetched. */
  otherCounts: Array<{ name: string; events: number }>;
  truncated: boolean;
}

/** Pure: events and incidents in, the report out. */
export function buildReport(input: BuildInput, o: ReportOptions): FederatedReport {
  const { events, incidents, scope } = input;
  const tz = o.tzMinutes ?? 330;
  const now = o.now ?? new Date();
  const info = new Map(input.departmentInfo.map((d) => [d.name, d]));
  const covers = (d: string) => scope.all === true || (scope.departments ?? []).includes(d);

  const totalsSev = zero();
  const totalTypes = new Map<string, { n: number }>(), totalCams = new Set<string>(), totalSources = new Set<string>();
  const hours = Array.from({ length: 24 }, () => 0);
  const dayCounts = new Map<string, number>();
  const sections = new Map<string, {
    sev: SeverityCounts; types: Map<string, { n: number }>; cams: Map<string, { n: number; name?: string }>; plateReads: number; last: string | null; past: number;
    sources: Map<string, { n: number; last: string }>; events: number;
  }>();
  const sourceAgg = new Map<string, { n: number; deps: Set<string>; last: string }>();
  const plates = new Map<string, { deps: Set<string>; reads: number }>();
  let unassigned = 0;

  for (const e of events) {
    const at = Date.parse(e.ts);
    totalsSev[e.severity] = (totalsSev[e.severity] ?? 0) + 1;
    bump(totalTypes, e.type); totalCams.add(e.cameraId); totalSources.add(e.source);
    hours[new Date(at + tz * 60_000).getUTCHours()]++;
    const dk = dayKey(at, tz); dayCounts.set(dk, (dayCounts.get(dk) ?? 0) + 1);

    const dep = e.department ?? '';
    const s = sourceAgg.get(e.source) ?? { n: 0, deps: new Set<string>(), last: e.ts };
    s.n++; if (dep) s.deps.add(dep); if (e.ts > s.last) s.last = e.ts; sourceAgg.set(e.source, s);

    const plate = e.type.startsWith('plate.') && typeof e.data?.plate === 'string' ? (e.data.plate as string).replace(/\s+/g, '').toUpperCase() : null;
    if (plate && dep) { const p = plates.get(plate) ?? { deps: new Set<string>(), reads: 0 }; p.deps.add(dep); p.reads++; plates.set(plate, p); }

    if (!dep) { unassigned++; continue; }
    let sec = sections.get(dep);
    if (!sec) { sec = { sev: zero(), types: new Map(), cams: new Map(), plateReads: 0, last: null, past: 0, sources: new Map(), events: 0 }; sections.set(dep, sec); }
    sec.events++; sec.sev[e.severity]++;
    bump(sec.types, e.type); bump(sec.cams, e.cameraId, e.cameraName);
    if (plate) sec.plateReads++;
    if (!sec.last || e.ts > sec.last) sec.last = e.ts;
    const src = sec.sources.get(e.source) ?? { n: 0, last: e.ts }; src.n++; if (e.ts > src.last) src.last = e.ts; sec.sources.set(e.source, src);
    const ret = info.get(dep)?.retentionDays;
    if (ret !== undefined && now.getTime() - at > ret * 86_400_000) sec.past++;
  }

  const departments: DepartmentSection[] = [...sections.entries()]
    .filter(([name]) => covers(name) && (!o.department || name === o.department))
    .map(([name, s]) => {
      const d = info.get(name);
      const sec: DepartmentSection = {
        name, events: s.events, bySeverity: s.sev, topTypes: rank(s.types, 5), topCameras: rank(s.cams, 5), cameras: s.cams.size, plateReads: s.plateReads,
        sources: [...s.sources.entries()].map(([source, v]) => ({ source, events: v.n, lastAt: v.last })).sort((a, b) => b.events - a.events),
        lastEventAt: s.last,
      };
      if (d?.retentionDays !== undefined) { sec.retentionDays = d.retentionDays; sec.eventsPastRetention = s.past; }
      if (d?.storage) sec.storage = d.storage;
      return sec;
    })
    .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name));

  const shared = [...plates.entries()].filter(([, p]) => p.deps.size >= 2).sort((a, b) => b[1].reads - a[1].reads || a[0].localeCompare(b[0]));
  const byKind: Record<string, number> = {};
  for (const i of incidents) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;

  const days = Math.max(1, Math.round((o.to.getTime() - o.from.getTime()) / 86_400_000));
  const viewer = scope.all ? 'organisation' : (scope.departments?.length ?? 0) > 0 ? 'departments' : 'own';
  const notes = [
    'Counts are of events the platform stored, not of everything the cameras saw. A system that sends nothing shows as quiet whatever it sees.',
    'Departments run their own video systems; this report is about metadata (events), not recordings.',
    ...(viewer === 'departments' ? ['Departments you do not cover are shown as an event count only. Plates are named only when every department that read them is one you cover.'] : []),
    ...(viewer === 'own' ? ['You see events from your own cameras only. Departments are shown when your cameras have been given to one.'] : []),
    ...(input.truncated ? [`The period has more events than the ${o.maxEvents ?? 20000} read; the figures cover the newest part of it only.`] : []),
  ];

  return {
    generatedAt: now.toISOString(),
    window: { from: o.from.toISOString(), to: o.to.toISOString(), days },
    viewer, coveredDepartments: scope.all ? ['*'] : scope.departments ?? [],
    truncated: input.truncated, eventsRead: events.length,
    totals: { events: events.length, bySeverity: totalsSev, topTypes: rank(totalTypes, 10), cameras: totalCams.size, sources: totalSources.size },
    departments,
    unassigned: { events: unassigned },
    otherDepartments: input.otherCounts.filter((d) => !covers(d.name)).sort((a, b) => b.events - a.events),
    crossDepartment: {
      incidents: { total: incidents.length, open: incidents.filter((i) => i.state === 'open').length, crossDepartment: incidents.filter((i) => i.crossDepartment).length, byKind },
      plates: {
        sharedCount: shared.length,
        examples: shared.slice(0, 10).map(([plate, p]) => {
          const deps = [...p.deps].sort();
          return { plate: deps.every(covers) ? plate : null, departments: deps.filter(covers).length === deps.length ? deps : [...deps.filter(covers), `${deps.filter((d) => !covers(d)).length} other`], reads: p.reads };
        }),
      },
    },
    sources: [...sourceAgg.entries()].map(([source, v]) => ({ source, events: v.n, departments: [...v.deps].filter(covers).sort(), lastAt: v.last })).sort((a, b) => b.events - a.events),
    hours,
    days: [...dayCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, events]) => ({ date, events })),
    notes,
  };
}

export interface CollectDeps {
  events: Pick<AlertStore, 'queryEvents' | 'countEvents'>;
  incidents: Pick<IncidentStore, 'list'>;
  /** Names and retention of the departments; may be empty (no directory). */
  departments?: () => Promise<DepartmentInfo[]>;
}

/** Reads what the report needs (within the caller's scope) and builds it. */
export async function federatedReport(deps: CollectDeps, scope: ReportScope, o: ReportOptions): Promise<FederatedReport> {
  const cap = o.maxEvents ?? 20_000;
  const q = scope.all ? { userId: scope.userId, all: true as const } : (scope.departments?.length ? { userId: scope.userId, departments: scope.departments } : { userId: scope.userId });
  const events: PlatformEvent[] = [];
  let after: { ts: string; id: string } | undefined;
  let truncated = false;
  for (;;) {
    const page = await deps.events.queryEvents({ ...q, from: o.from, to: o.to, department: o.department, after, limit: 500 });
    events.push(...page);
    if (page.length < 500) break;
    if (events.length >= cap) { truncated = true; break; }
    const last = page[page.length - 1]; after = { ts: last.ts, id: last.id };
  }
  if (events.length > cap) truncated = true;
  const info = (await deps.departments?.().catch(() => [])) ?? [];
  const covered = new Set(scope.all ? [] : scope.departments ?? []);
  // Departments the caller does not cover: how many events each reported (a count, never the events).
  const others = scope.all || o.department ? [] : info.filter((d) => !covered.has(d.name));
  const otherCounts = await Promise.all(others.map(async (d) => ({ name: d.name, events: await deps.events.countEvents({ userId: scope.userId, all: true, department: d.name, from: o.from, to: o.to }) })));
  const incidents = (await deps.incidents.list({ ...(scope.all ? { all: true } : scope.departments?.length ? { departments: scope.departments } : { userId: scope.userId }), limit: 200 }))
    .filter((i) => i.lastAt >= o.from.toISOString() && i.firstAt <= o.to.toISOString());
  return buildReport({ events: events.slice(0, cap), incidents, scope, departmentInfo: info, otherCounts: otherCounts.filter((c) => c.events > 0), truncated }, { ...o, maxEvents: cap });
}

// ---- output formats --------------------------------------------------------------------------------------------------------------------

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per department (spreadsheet-safe: a cell that starts like a formula is prefixed). */
export function reportCsv(r: FederatedReport): string {
  const head = ['department', 'events', ...SEVERITIES, 'cameras', 'plate_reads', 'last_event', 'retention_days', 'storage', 'events_past_retention'];
  const rows = r.departments.map((d) => [d.name, d.events, ...SEVERITIES.map((s) => d.bySeverity[s]), d.cameras, d.plateReads, d.lastEventAt, d.retentionDays, d.storage, d.eventsPastRetention]);
  const others = r.otherDepartments.map((d) => [d.name, d.events]);
  return [head, ...rows, ...others].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const when = (iso: string | null) => (iso ? esc(iso.replace('T', ' ').slice(0, 16) + ' UTC') : 'never');

/** A self-contained page (no scripts, no outside files) that prints well: the same figures, for a person to read or keep. */
export function reportHtml(r: FederatedReport, title = 'Federated analytics report'): string {
  const max = Math.max(1, ...r.hours);
  const bars = r.hours.map((n, h) => `<div class="bar" title="${h}:00 — ${n}"><i style="height:${Math.round((n / max) * 100)}%"></i><span>${h}</span></div>`).join('');
  const sev = (s: SeverityCounts) => SEVERITIES.map((k) => `${k} ${s[k]}`).join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#111}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ccc}table{border-collapse:collapse;width:100%;margin:.5rem 0}th,td{text-align:left;padding:.3rem .6rem;border-bottom:1px solid #e3e3e3;vertical-align:top}th{color:#555;font-weight:600}.muted{color:#666}.cards{display:flex;gap:1rem;flex-wrap:wrap}.card{border:1px solid #ddd;border-radius:8px;padding:.6rem 1rem;min-width:120px}.card b{display:block;font-size:1.4rem}.chart{display:flex;align-items:flex-end;gap:2px;height:90px;margin:.5rem 0 1.4rem}.bar{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;font-size:9px;color:#666}.bar i{display:block;width:100%;background:#2f5fdd;min-height:1px}@media print{body{margin:0}h2{break-after:avoid}}</style></head><body>
<h1>${esc(title)}</h1>
<p class="muted">${esc(r.window.from.slice(0, 10))} to ${esc(r.window.to.slice(0, 10))} (${r.window.days} day${r.window.days === 1 ? '' : 's'}) · made ${when(r.generatedAt)} · ${r.viewer === 'organisation' ? 'all departments' : r.viewer === 'departments' ? 'your departments' : 'your own cameras'}${r.truncated ? ' · <b>newest events only (period too long)</b>' : ''}</p>
<div class="cards"><div class="card"><b>${r.totals.events}</b>events</div><div class="card"><b>${r.totals.cameras}</b>cameras reporting</div><div class="card"><b>${r.totals.sources}</b>systems reporting</div><div class="card"><b>${r.crossDepartment.incidents.total}</b>incidents (${r.crossDepartment.incidents.crossDepartment} across departments)</div></div>
<p class="muted">${esc(sev(r.totals.bySeverity))}</p>
<h2>Departments</h2>
<table><thead><tr><th>Department</th><th>Events</th><th>By severity</th><th>Cameras</th><th>Plate reads</th><th>Last event</th><th>Video held</th></tr></thead><tbody>
${r.departments.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.events}</td><td>${esc(sev(d.bySeverity))}</td><td>${d.cameras}</td><td>${d.plateReads}</td><td>${when(d.lastEventAt)}</td><td>${d.retentionDays !== undefined ? `${d.retentionDays} days${d.storage ? ', ' + esc(d.storage) : ''}${d.eventsPastRetention ? ` · ${d.eventsPastRetention} events older` : ''}` : '<span class="muted">not stated</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No department events in this period.</td></tr>'}
${r.otherDepartments.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.events}</td><td colspan="5" class="muted">Count only (not your department)</td></tr>`).join('')}
${r.unassigned.events ? `<tr><td class="muted">No department</td><td>${r.unassigned.events}</td><td colspan="5"></td></tr>` : ''}
</tbody></table>
${r.departments.map((d) => `<h2>${esc(d.name)}</h2><table><tbody><tr><th>Most common</th><td>${d.topTypes.map((t) => `${esc(t.key)} (${t.events})`).join(', ') || '—'}</td></tr><tr><th>Busiest cameras</th><td>${d.topCameras.map((c) => `${esc(c.name ?? c.key)} (${c.events})`).join(', ') || '—'}</td></tr><tr><th>Systems</th><td>${d.sources.map((s) => `${esc(s.source)} (${s.events}, last ${when(s.lastAt)})`).join(', ') || '—'}</td></tr></tbody></table>`).join('')}
<h2>Across departments</h2>
<p>Incidents: ${r.crossDepartment.incidents.total} (${r.crossDepartment.incidents.open} open, ${r.crossDepartment.incidents.crossDepartment} involving more than one department). ${esc(Object.entries(r.crossDepartment.incidents.byKind).map(([k, n]) => `${k} ${n}`).join(' · '))}</p>
<p>Plates read by more than one department: ${r.crossDepartment.plates.sharedCount}.</p>
${r.crossDepartment.plates.examples.length ? `<table><thead><tr><th>Plate</th><th>Departments</th><th>Reads</th></tr></thead><tbody>${r.crossDepartment.plates.examples.map((p) => `<tr><td>${esc(p.plate ?? 'hidden (another department)')}</td><td>${esc(p.departments.join(', '))}</td><td>${p.reads}</td></tr>`).join('')}</tbody></table>` : ''}
<h2>Systems reporting</h2>
<table><thead><tr><th>System</th><th>Events</th><th>Departments</th><th>Last event</th></tr></thead><tbody>${r.sources.map((s) => `<tr><td>${esc(s.source)}</td><td>${s.events}</td><td>${esc(s.departments.join(', '))}</td><td>${when(s.lastAt)}</td></tr>`).join('')}</tbody></table>
<h2>Events by hour of day</h2><div class="chart">${bars}</div>
<h2>Events by day</h2><table><tbody>${r.days.map((d) => `<tr><td>${esc(d.date)}</td><td>${d.events}</td></tr>`).join('')}</tbody></table>
<h2>What this report cannot say</h2><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</body></html>`;
}
