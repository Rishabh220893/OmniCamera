import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { incidentsApi, type EventRow, type IncidentRow } from '../../lib/eventsApi';
import { ErrorBox, SeverityBadge, ago, errText, useInterval, when } from './shared';

const STATES: Array<{ value: IncidentRow['state'] | ''; label: string }> = [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }, { value: '', label: 'All' }];
const KIND: Record<IncidentRow['kind'], string> = { plate_trail: 'Vehicle on several cameras', watchlist: 'Watchlist vehicle', multi_source: 'Confirmed by two systems' };

/** Events that belong together (one vehicle on several cameras, a watchlist hit, two systems agreeing), shown as one thing to follow up. */
export default function IncidentsView({ onCount }: { onCount?: (open: number) => void }) {
  const [state, setState] = useState<IncidentRow['state'] | ''>('open');
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await incidentsApi.list(state || undefined);
      setIncidents(list); setError(null);
      if (state === 'open') onCount?.(list.length);
    } catch (e) { setError(errText(e)); setIncidents([]); }
    finally { setLoading(false); }
  }, [state, onCount]);
  useEffect(() => { setLoading(true); void load(); }, [load]);
  useInterval(() => void load(), 30_000);

  return (
    <div className="space-y-4" data-testid="incidents-view">
      <div className="flex flex-wrap items-center gap-2">
        {STATES.map((s) => (
          <button key={s.label} className={state === s.value ? 'btn-primary !py-1.5 !px-4 text-xs' : 'btn-secondary !py-1.5 !px-4 text-xs'} onClick={() => setState(s.value)}>{s.label}</button>
        ))}
        <button className="btn-ghost !p-2 ml-auto" onClick={() => void load()} aria-label="Refresh incidents"><RefreshCw className="w-4 h-4" strokeWidth={1.75} /></button>
      </div>
      <p className="text-xs text-ink-muted">An incident groups events that belong together: the same vehicle on two or more cameras within an hour, a watchlist vehicle, or two different systems reporting activity on one camera within minutes.</p>
      {error && <ErrorBox title="Could not load incidents." error={error} hint="Sign in with an account (guest mode has no incidents)." />}
      {!error && !loading && incidents.length === 0 && <p className="card p-8 text-center text-sm text-ink-muted">{state === 'open' ? 'No open incidents. One appears when related events show up on more than one camera or system.' : 'No incidents here.'}</p>}
      <ul className="space-y-2">
        {incidents.map((i) => (
          <IncidentRowView key={i.id} incident={i} expanded={open === i.id} onToggle={() => setOpen(open === i.id ? null : i.id)}
            onChanged={(u) => setIncidents((prev) => prev.map((p) => (p.id === u.id ? u : p)))} onReload={load} />
        ))}
      </ul>
    </div>
  );
}

function IncidentRowView({ incident: i, expanded, onToggle, onChanged, onReload }: { incident: IncidentRow; expanded: boolean; onToggle: () => void; onChanged: (i: IncidentRow) => void; onReload: () => Promise<void> }) {
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let live = true;
    incidentsApi.detail(i.id).then((d) => { if (live) { setEvents(d.events); setHidden(d.hiddenEvents); } }).catch((e) => { if (live) setErr(errText(e)); });
    return () => { live = false; };
  }, [expanded, i.id, i.eventCount]);

  const run = async (fn: () => Promise<IncidentRow>) => {
    setBusy(true); setErr(null);
    try { onChanged(await fn()); setNote(''); await onReload(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  return (
    <li className={`card ${i.state === 'closed' ? 'opacity-70' : ''}`}>
      <button className="w-full p-4 flex flex-wrap items-center gap-3 text-left" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? <ChevronDown className="w-4 h-4 text-ink-muted" /> : <ChevronRight className="w-4 h-4 text-ink-muted" />}
        <div className="flex-1 min-w-[14rem]">
          <p className="text-sm font-semibold text-ink">{i.title}</p>
          <p className="text-[11px] text-ink-muted">{KIND[i.kind]} &middot; {i.eventCount} event{i.eventCount === 1 ? '' : 's'} &middot; {i.cameraIds.length} camera{i.cameraIds.length === 1 ? '' : 's'} &middot; last {ago(i.lastAt)}</p>
        </div>
        {i.crossDepartment && <span className="badge badge-warning !text-[10px] !normal-case">{i.departments.length} departments</span>}
        <SeverityBadge severity={i.severity} />
        {i.state === 'closed' && <span className="badge badge-neutral !text-[10px]">closed</span>}
      </button>
      {expanded && (
        <div className="border-t border-border p-4 space-y-3 text-xs">
          {err && <ErrorBox title="Something went wrong." error={err} />}
          <div className="grid sm:grid-cols-3 gap-3">
            <div><p className="text-ink-muted">Cameras</p><p className="text-ink">{i.cameraNames.join(', ')}</p></div>
            <div><p className="text-ink-muted">Departments</p><p className="text-ink">{i.departments.length ? i.departments.join(', ') : '-'}</p></div>
            <div><p className="text-ink-muted">Between</p><p className="text-ink">{when(i.firstAt)} and {when(i.lastAt)}</p></div>
          </div>
          <div>
            <p className="text-ink-muted mb-1">Timeline</p>
            {events === null ? <p className="text-ink-muted">Loading...</p> : (
              <ol className="space-y-1">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-3">
                    <span className="text-ink-muted whitespace-nowrap">{when(e.ts)}</span>
                    <span className="text-ink">{e.summary}</span>
                    <span className="text-ink-muted">{e.cameraName}{e.department ? ` (${e.department})` : ''} &middot; {e.source}</span>
                  </li>
                ))}
              </ol>
            )}
            {hidden > 0 && <p className="text-ink-muted mt-1">{hidden} more event{hidden === 1 ? '' : 's'} came from another department's systems: you are told they exist, not what they recorded.</p>}
          </div>
          {i.notes.length > 0 && (
            <div>
              <p className="text-ink-muted mb-1">Notes</p>
              <ul className="space-y-1">{i.notes.map((n, k) => <li key={k}><span className="text-ink-muted">{when(n.at)} &middot; {n.by}: </span><span className="text-ink">{n.text}</span></li>)}</ul>
            </div>
          )}
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void run(() => incidentsApi.addNote(i.id, note.trim())); }}>
            <input className="input flex-1 min-w-[12rem] !py-1.5 !text-xs" placeholder="Add a note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-label="New note" />
            <button className="btn-secondary !py-1.5 !px-3 text-xs" disabled={busy || !note.trim()}>Add note</button>
            {i.state === 'open'
              ? <button type="button" className="btn-primary !py-1.5 !px-3 text-xs" disabled={busy} onClick={() => void run(() => incidentsApi.close(i.id))}>Close incident</button>
              : <button type="button" className="btn-secondary !py-1.5 !px-3 text-xs" disabled={busy} onClick={() => void run(() => incidentsApi.reopen(i.id))}>Reopen</button>}
          </form>
        </div>
      )}
    </li>
  );
}
