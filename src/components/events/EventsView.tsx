import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { eventsApi, SEVERITIES, type EventRow, type Severity } from '../../lib/eventsApi';
import { ErrorBox, SeverityBadge, errText, when } from './shared';

const GROUPS = [
  { value: '', label: 'All types' }, { value: 'plate.*', label: 'Plates' }, { value: 'person.*', label: 'People' }, { value: 'scene.*', label: 'Scene' },
  { value: 'vms.*', label: 'Department systems' }, { value: 'camera.*', label: 'Camera status' }, { value: 'gateway.*', label: 'Gateways' },
];
const RANGES = [{ label: 'Last hour', ms: 3_600_000 }, { label: 'Last 24 hours', ms: 86_400_000 }, { label: 'Last 7 days', ms: 7 * 86_400_000 }, { label: 'Any time', ms: 0 }];

/** Search the typed events the analyzers and connected systems produce, and tag them. */
export default function EventsView() {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('');
  const [minSeverity, setMinSeverity] = useState<'' | Severity>('');
  const [tag, setTag] = useState('');
  const [department, setDepartment] = useState('');
  const [rangeMs, setRangeMs] = useState(86_400_000);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [total, setTotal] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const filters = useMemo(() => ({
    q, types: group ? [group] : undefined, minSeverity: minSeverity || undefined, tag, department,
    from: rangeMs ? new Date(Date.now() - rangeMs) : undefined,
  }), [q, group, minSeverity, tag, department, rangeMs]);

  // `filters` changes on every keystroke: wait a moment so typing does not send a request per letter.
  const search = useCallback(async () => {
    setLoading(true);
    try {
      const r = await eventsApi.events({ ...filters, count: true });
      setEvents(r.events); setCursor(r.nextCursor); setTotal(r.total); setError(null);
    } catch (e) { setError(errText(e)); setEvents([]); setCursor(undefined); setTotal(undefined); }
    finally { setLoading(false); }
  }, [filters]);
  useEffect(() => { const id = setTimeout(() => void search(), 350); return () => clearTimeout(id); }, [search]);

  const more = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const r = await eventsApi.events({ ...filters, cursor });
      setEvents((prev) => [...prev, ...r.events.filter((e) => !prev.some((p) => p.id === e.id))]);
      setCursor(r.nextCursor); setError(null);
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  };

  const replace = (updated: EventRow) => setEvents((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
  const clear = () => { setQ(''); setGroup(''); setMinSeverity(''); setTag(''); setDepartment(''); };
  const filtered = q || group || minSeverity || tag || department;

  return (
    <div className="space-y-4" data-testid="events-view">
      <div className="card p-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <label className="relative lg:col-span-2">
          <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
          <input className="input !pl-9 w-full" placeholder="Search a plate, name, camera or text" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} aria-label="Search events" />
        </label>
        <select className="input" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Event type">{GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select>
        <select className="input" value={minSeverity} onChange={(e) => setMinSeverity(e.target.value as Severity | '')} aria-label="Minimum severity">
          <option value="">Any severity</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s} and above</option>)}
        </select>
        <input className="input" placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} aria-label="Tag" />
        <input className="input" placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} maxLength={64} aria-label="Department" />
        <select className="input" value={rangeMs} onChange={(e) => setRangeMs(Number(e.target.value))} aria-label="Time range">{RANGES.map((r) => <option key={r.label} value={r.ms}>{r.label}</option>)}</select>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-5 items-center text-xs text-ink-muted">
          <span>{loading ? 'Searching...' : total === undefined ? '' : `${total.toLocaleString()} matching event${total === 1 ? '' : 's'}`}</span>
          {filtered && <button className="btn-ghost !px-2 !py-1 text-[10px] font-bold flex items-center gap-1" onClick={clear}><X className="w-3 h-3" /> Clear filters</button>}
        </div>
        <button className="btn-secondary !py-2 !px-3 text-xs flex items-center justify-center gap-2" onClick={() => void search()} disabled={loading}><RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} /> Refresh</button>
      </div>

      {error && <ErrorBox title="Could not load events." error={error} hint="Sign in with an account (guest mode has no events). If you are signed in, the server may not have the events service switched on." />}

      {!error && !loading && events.length === 0 && (
        <p className="card p-8 text-center text-sm text-ink-muted">{filtered || rangeMs ? 'No events match. Widen the time range or clear a filter.' : 'No events yet.'}</p>
      )}

      {events.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-ink-muted uppercase tracking-wider text-[10px]"><th className="p-3 w-6" /><th className="p-3">Time</th><th className="p-3">Severity</th><th className="p-3">What</th><th className="p-3">Camera</th><th className="p-3">Department</th><th className="p-3">Tags</th></tr></thead>
            <tbody className="divide-y divide-border">
              {events.map((e) => (
                <EventRowView key={e.id} event={e} expanded={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} onChanged={replace} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor && <div className="text-center"><button className="btn-secondary !py-2 !px-6 text-xs" onClick={() => void more()} disabled={loading}>{loading ? 'Loading...' : 'Load more'}</button></div>}
    </div>
  );
}

function EventRowView({ event: e, expanded, onToggle, onChanged }: { event: EventRow; expanded: boolean; onToggle: () => void; onChanged: (e: EventRow) => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (tags: string[]) => {
    setBusy(true); setErr(null);
    try { onChanged(await eventsApi.setTags(e.id, tags)); setDraft(''); }
    catch (x) { setErr(errText(x)); }
    finally { setBusy(false); }
  };
  const add = () => { const t = draft.trim().toLowerCase(); if (t && !e.tags.includes(t)) void save([...e.tags, t]); };
  return (
    <>
      <tr className="hover:bg-surface-muted cursor-pointer" onClick={onToggle} aria-expanded={expanded}>
        <td className="p-3 text-ink-muted">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
        <td className="p-3 whitespace-nowrap text-ink-muted">{when(e.ts)}</td>
        <td className="p-3"><SeverityBadge severity={e.severity} /></td>
        <td className="p-3"><span className="font-semibold text-ink">{e.summary}</span><span className="block text-[10px] text-ink-muted">{e.type} &middot; {e.source}</span></td>
        <td className="p-3">{e.cameraName}</td>
        <td className="p-3">{e.department ?? <span className="text-ink-muted">-</span>}</td>
        <td className="p-3">{e.tags.map((t) => <span key={t} className="badge badge-neutral !text-[10px] !normal-case mr-1">{t}</span>)}</td>
      </tr>
      {expanded && (
        <tr className="bg-surface-muted">
          <td colSpan={7} className="p-4 space-y-3">
            <dl className="grid sm:grid-cols-4 gap-2 text-[11px]">
              <div><dt className="text-ink-muted">Event id</dt><dd className="font-mono break-all">{e.id}</dd></div>
              <div><dt className="text-ink-muted">Camera</dt><dd>{e.cameraName} <span className="font-mono text-ink-muted">({e.cameraId})</span></dd></div>
              <div><dt className="text-ink-muted">Confidence</dt><dd>{e.confidence === undefined ? 'not given' : `${Math.round(e.confidence * 100)}%`}</dd></div>
              <div><dt className="text-ink-muted">Source</dt><dd>{e.source}</dd></div>
            </dl>
            {Object.keys(e.data).length > 0 && <pre className="text-[11px] bg-surface rounded-xl p-3 overflow-x-auto">{JSON.stringify(e.data, null, 2)}</pre>}
            <div className="flex flex-wrap items-center gap-2" onClick={(x) => x.stopPropagation()}>
              <span className="text-[11px] font-semibold text-ink">Tags</span>
              {e.tags.map((t) => (
                <span key={t} className="badge badge-accent !text-[10px] !normal-case flex items-center gap-1">{t}
                  <button aria-label={`Remove tag ${t}`} disabled={busy} onClick={() => void save(e.tags.filter((x) => x !== t))}><X className="w-3 h-3" /></button>
                </span>
              ))}
              <form className="flex gap-1" onSubmit={(x) => { x.preventDefault(); add(); }}>
                <input className="input !py-1 !text-xs w-32" placeholder="Add a tag" value={draft} onChange={(x) => setDraft(x.target.value)} maxLength={40} aria-label="New tag" />
                <button className="btn-secondary !py-1 !px-3 text-xs" disabled={busy || !draft.trim()}>Add</button>
              </form>
              {err && <span className="text-critical text-[11px]" role="alert">{err}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
