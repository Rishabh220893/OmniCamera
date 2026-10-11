import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { adminApi, type DepartmentRow, type RecordKind, type RecordRow } from '../lib/adminApi';

const KINDS: Array<{ id: RecordKind; label: string; empty: string }> = [
  { id: 'faces', label: 'Faces', empty: 'No registered faces.' }, { id: 'watchlist', label: 'Watchlist plates', empty: 'No watchlist plates.' }, { id: 'logs', label: 'Analysis logs', empty: 'No logs.' },
];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Settings > Everything, across departments (administrators): the faces, watchlist plates and analysis logs of every department in one place,
 * with a department filter. The app itself loads only a person's own and their departments' (so an administrator would otherwise see none of
 * the others'). Names, plates and summaries only: a face's picture is never sent here.
 */
export default function AllDepartmentsPanel() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<RecordKind>('faces');
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await adminApi.records(kind, department)); setError(null); } catch (e) { setError(errText(e)); setRows(null); } finally { setLoading(false); }
  }, [kind, department]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => { if (open) adminApi.departments().then((d) => setDepartments(Array.isArray(d) ? d : [])).catch(() => setDepartments([])); }, [open]);

  const meta = KINDS.find((k) => k.id === kind)!;
  return (
    <div className="card overflow-hidden" data-testid="all-departments-panel">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 p-5 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Eye className="w-4 h-4 text-accent" strokeWidth={1.75} />
        <span className="font-display font-bold text-ink">Faces, plates and logs of every department</span>
        <span className="text-xs text-ink-muted ml-auto">{open ? '' : 'for administrators'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-4 border-t border-border pt-5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {KINDS.map((k) => <button key={k.id} onClick={() => setKind(k.id)} className={cn('btn-ghost !py-1.5 !px-3 text-xs', kind === k.id && 'bg-surface-hover font-semibold')} aria-pressed={kind === k.id}>{k.label}</button>)}
            <select value={department} onChange={(e) => setDepartment(e.target.value)} className="input !py-1.5 text-xs w-auto ml-2" aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button onClick={() => void load()} className="btn-ghost !p-2 ml-auto" aria-label="Refresh"><RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} /></button>
          </div>
          {error && <p className="text-xs text-critical" role="alert">{error}</p>}
          {rows && rows.length === 0 && !error && <p className="text-xs text-ink-muted">{meta.empty}</p>}
          {rows && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-ink-muted"><th className="py-1 pr-3">{kind === 'faces' ? 'Name' : kind === 'watchlist' ? 'Plate' : 'Summary'}</th><th className="pr-3">Department</th>{kind === 'logs' && <><th className="pr-3">Camera</th><th className="pr-3">When</th></>}<th>Owner</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-border align-top">
                      <td className={cn('py-1.5 pr-3', kind === 'watchlist' && 'font-mono', r.unusual && 'text-critical font-semibold')}>{r.title || '—'}</td>
                      <td className="pr-3">{r.departmentId ?? <span className="text-ink-muted">personal</span>}</td>
                      {kind === 'logs' && <><td className="pr-3">{r.cameraName}</td><td className="pr-3 whitespace-nowrap">{r.at ? new Date(r.at).toLocaleString() : ''}</td></>}
                      <td className="text-ink-muted font-mono">{r.ownerUserId.slice(0, 8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-ink-muted mt-2">Showing up to 200. Personal entries (no department) are listed too.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
