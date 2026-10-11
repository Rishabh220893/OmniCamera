import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, Loader2, RefreshCw } from 'lucide-react';
import { reportApi, type FederatedReport, type SeverityCounts } from '../../lib/reportApi';
import { ErrorBox, ago, errText } from './shared';

const PERIODS = [{ days: 1, label: '24 hours' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];
const SEVERITIES: Array<keyof SeverityCounts> = ['critical', 'warning', 'notice', 'info'];
const VIEWER_TEXT = { organisation: 'All departments', departments: 'Your departments', own: 'Your own cameras' };

const Sev = ({ s }: { s: SeverityCounts }) => <span className="text-ink-muted">{SEVERITIES.map((k) => `${k} ${s[k]}`).join(' · ')}</span>;

/** The federated analytics report (gap A26): every department side by side, and what only shows when they are looked at together. */
export default function ReportView() {
  const [days, setDays] = useState(7);
  const [department, setDepartment] = useState('');
  const [report, setReport] = useState<FederatedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setReport(await reportApi.federated(days, department)); setError(null); } catch (e) { setError(errText(e)); } finally { setLoading(false); }
  }, [days, department]);
  useEffect(() => { void load(); }, [load]);

  const doExport = async (format: 'csv' | 'html') => {
    setExporting(format);
    try { await reportApi.open(format, days, department); setError(null); } catch (e) { setError(errText(e)); } finally { setExporting(null); }
  };

  const max = Math.max(1, ...(report?.hours ?? [0]));
  const names = report ? [...new Set([...report.departments.map((d) => d.name), ...(department ? [department] : [])])] : [];

  return (
    <div className="space-y-5" data-testid="report-view">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs flex items-center gap-2"><span className="text-ink-muted font-semibold">Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input !py-1.5 text-xs w-auto" aria-label="Period">
            {PERIODS.map((p) => <option key={p.days} value={p.days}>Last {p.label}</option>)}
          </select></label>
        {names.length > 1 && (
          <label className="text-xs flex items-center gap-2"><span className="text-ink-muted font-semibold">Department</span>
            <select value={department} onChange={(e) => setDepartment(e.target.value)} className="input !py-1.5 text-xs w-auto" aria-label="Department">
              <option value="">All I can see</option>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select></label>
        )}
        <button className="btn-ghost !p-2" onClick={() => void load()} aria-label="Refresh report">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" strokeWidth={1.75} />}</button>
        <span className="ml-auto flex items-center gap-2">
          <button className="btn-ghost !py-1.5 !px-3 text-xs flex items-center gap-1.5" onClick={() => void doExport('html')} disabled={!!exporting || !report}><FileText className="w-3.5 h-3.5" />{exporting === 'html' ? 'Opening…' : 'Printable report'}</button>
          <button className="btn-ghost !py-1.5 !px-3 text-xs flex items-center gap-1.5" onClick={() => void doExport('csv')} disabled={!!exporting || !report}><Download className="w-3.5 h-3.5" />{exporting === 'csv' ? 'Preparing…' : 'Download CSV'}</button>
        </span>
      </div>

      {error && <ErrorBox title="The report could not be shown" error={error} />}
      {!report && !error && <p className="text-xs text-ink-muted">Making the report…</p>}

      {report && (<>
        <p className="text-xs text-ink-muted">{VIEWER_TEXT[report.viewer]} · {new Date(report.window.from).toLocaleDateString()} to {new Date(report.window.to).toLocaleDateString()} · made {ago(report.generatedAt)}{report.truncated && <b className="text-warning"> · newest {report.eventsRead} events only (period too long)</b>}</p>

        <div className="grid sm:grid-cols-4 gap-3">
          {[['Events', report.totals.events], ['Cameras reporting', report.totals.cameras], ['Systems reporting', report.totals.sources], ['Incidents', report.crossDepartment.incidents.total]].map(([label, n]) => (
            <div key={label as string} className="card p-4"><div className="text-2xl font-bold font-display text-ink">{n}</div><div className="text-xs text-ink-muted">{label}</div></div>
          ))}
        </div>
        <p className="text-xs"><Sev s={report.totals.bySeverity} /></p>

        <section className="space-y-2">
          <h3 className="text-sm font-bold text-ink">Departments</h3>
          <div className="overflow-x-auto card">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-muted"><th className="p-3">Department</th><th>Events</th><th>By severity</th><th>Cameras</th><th>Plate reads</th><th>Last event</th><th>Video held</th></tr></thead>
              <tbody>
                {report.departments.length === 0 && <tr><td colSpan={7} className="p-3 text-ink-muted">No department events in this period.</td></tr>}
                {report.departments.map((d) => (
                  <tr key={d.name} className="border-t border-border align-top">
                    <td className="p-3 font-semibold">{d.name}<div className="font-normal text-ink-muted">{d.topTypes.slice(0, 3).map((t) => `${t.key} ${t.events}`).join(' · ')}</div></td>
                    <td>{d.events}</td><td><Sev s={d.bySeverity} /></td><td>{d.cameras}</td><td>{d.plateReads}</td><td className="whitespace-nowrap">{ago(d.lastEventAt)}</td>
                    <td>{d.retentionDays !== undefined ? <>{d.retentionDays} days{d.storage ? `, ${d.storage}` : ''}{d.eventsPastRetention ? <span className="text-warning"> · {d.eventsPastRetention} events older</span> : null}</> : <span className="text-ink-muted">not stated</span>}</td>
                  </tr>
                ))}
                {report.otherDepartments.map((d) => (
                  <tr key={d.name} className="border-t border-border text-ink-muted"><td className="p-3">{d.name}</td><td>{d.events}</td><td colSpan={5}>Count only (not your department)</td></tr>
                ))}
                {report.unassigned.events > 0 && <tr className="border-t border-border text-ink-muted"><td className="p-3">No department</td><td>{report.unassigned.events}</td><td colSpan={5} /></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid md:grid-cols-2 gap-4">
          <div className="card p-4 space-y-2">
            <h3 className="text-sm font-bold text-ink">Across departments</h3>
            <p className="text-xs">Incidents: <b>{report.crossDepartment.incidents.total}</b> ({report.crossDepartment.incidents.open} open, {report.crossDepartment.incidents.crossDepartment} involving more than one department)</p>
            <p className="text-xs">Plates read by more than one department: <b>{report.crossDepartment.plates.sharedCount}</b></p>
            {report.crossDepartment.plates.examples.length > 0 && (
              <ul className="text-xs space-y-1">{report.crossDepartment.plates.examples.map((p, i) => (
                <li key={i}><span className="font-mono">{p.plate ?? 'hidden (another department)'}</span> <span className="text-ink-muted">· {p.departments.join(', ')} · {p.reads} reads</span></li>
              ))}</ul>
            )}
          </div>
          <div className="card p-4 space-y-2">
            <h3 className="text-sm font-bold text-ink">Events by hour of day</h3>
            <div className="flex items-end gap-0.5 h-24" role="img" aria-label="Events by hour of day">
              {report.hours.map((n, h) => <div key={h} className="flex-1 bg-accent/70 rounded-t" style={{ height: `${Math.max(2, Math.round((n / max) * 100))}%` }} title={`${h}:00 — ${n} events`} />)}
            </div>
            <div className="flex justify-between text-[10px] text-ink-muted"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-bold text-ink">Systems reporting</h3>
          <div className="overflow-x-auto card">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-ink-muted"><th className="p-3">System</th><th>Events</th><th>Departments</th><th>Last event</th></tr></thead>
              <tbody>{report.sources.map((s) => <tr key={s.source} className="border-t border-border"><td className="p-3 font-mono">{s.source}</td><td>{s.events}</td><td>{s.departments.join(', ') || '—'}</td><td>{ago(s.lastAt)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="text-sm font-bold text-ink">What this report cannot say</h3>
          <ul className="text-xs text-ink-muted list-disc pl-5 space-y-0.5">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      </>)}
    </div>
  );
}
