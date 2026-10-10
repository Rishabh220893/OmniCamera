import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCheck, RefreshCw } from 'lucide-react';
import { eventsApi, type AlertRow } from '../../lib/eventsApi';
import { ErrorBox, SeverityBadge, ago, errText, useInterval, when } from './shared';

const STATES: Array<{ value: AlertRow['state'] | ''; label: string }> = [
  { value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'resolved', label: 'Resolved' }, { value: '', label: 'All' },
];

/** Alerts raised by the rules: acknowledge when you are on it, resolve when it is done. */
export default function AlertsView({ onCount }: { onCount?: (open: number) => void }) {
  const [state, setState] = useState<AlertRow['state'] | ''>('open');
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await eventsApi.alerts(state || undefined);
      setAlerts(list); setError(null);
      if (state === 'open') onCount?.(list.length);
    } catch (e) { setError(errText(e)); setAlerts([]); }
    finally { setLoading(false); }
  }, [state, onCount]);
  useEffect(() => { setLoading(true); void load(); }, [load]);
  useInterval(() => void load(), 30_000);

  const act = async (a: AlertRow, kind: 'acknowledge' | 'resolve') => {
    setBusyId(a.id); setNotice(null);
    try {
      await (kind === 'acknowledge' ? eventsApi.acknowledge(a.id) : eventsApi.resolve(a.id));
      setNotice(`'${a.title}' ${kind === 'acknowledge' ? 'acknowledged' : 'resolved'}.`);
      await load();
    } catch (e) { setError(errText(e)); }
    finally { setBusyId(null); }
  };

  return (
    <div className="space-y-4" data-testid="alerts-view">
      <div className="flex flex-wrap items-center gap-2">
        {STATES.map((s) => (
          <button key={s.label} className={state === s.value ? 'btn-primary !py-1.5 !px-4 text-xs' : 'btn-secondary !py-1.5 !px-4 text-xs'} onClick={() => setState(s.value)}>{s.label}</button>
        ))}
        <button className="btn-ghost !p-2 ml-auto" onClick={() => void load()} aria-label="Refresh alerts"><RefreshCw className="w-4 h-4" strokeWidth={1.75} /></button>
      </div>
      {notice && <div role="status" className="badge-success rounded-xl px-4 py-2 !inline-block w-full !normal-case text-xs font-semibold">{notice}</div>}
      {error && <ErrorBox title="Could not load alerts." error={error} hint="Sign in with an account (guest mode has no alerts)." />}
      {!error && !loading && alerts.length === 0 && <p className="card p-8 text-center text-sm text-ink-muted">{state === 'open' ? 'No open alerts. Rules raise one when a matching event arrives.' : 'No alerts here.'}</p>}
      <ul className="space-y-2">
        {alerts.map((a) => {
          const failed = a.deliveries.filter((d) => !d.ok);
          return (
            <li key={a.id} className="card p-4 flex flex-wrap items-center gap-3">
              <SeverityBadge severity={a.severity} />
              <div className="flex-1 min-w-[14rem]">
                <p className="text-sm font-semibold text-ink">{a.title}</p>
                <p className="text-[11px] text-ink-muted">
                  {a.cameraName}{a.department ? ` · ${a.department}` : ''} &middot; rule '{a.ruleName}' &middot; {a.eventCount} event{a.eventCount === 1 ? '' : 's'} &middot; last {ago(a.lastEventAt)} ({when(a.lastEventAt)})
                </p>
                {failed.length > 0 && <p className="text-[11px] text-critical mt-0.5">Delivery failed: {failed.map((d) => `${d.channel}${d.error ? ` (${d.error})` : ''}`).join(', ')}</p>}
                {(a.ackBy || a.resolvedBy) && <p className="text-[10px] text-ink-muted">{a.resolvedBy ? `Resolved by ${a.resolvedBy}` : `Acknowledged by ${a.ackBy}`}</p>}
              </div>
              <span className={`badge ${a.state === 'open' ? 'badge-critical' : a.state === 'acknowledged' ? 'badge-warning' : 'badge-success'} !text-[10px]`}>{a.state}</span>
              <div className="flex gap-2">
                {a.state === 'open' && <button className="btn-secondary !py-1.5 !px-3 text-xs flex items-center gap-1.5" disabled={busyId === a.id} onClick={() => void act(a, 'acknowledge')}><Check className="w-3.5 h-3.5" /> Acknowledge</button>}
                {a.state !== 'resolved' && <button className="btn-primary !py-1.5 !px-3 text-xs flex items-center gap-1.5" disabled={busyId === a.id} onClick={() => void act(a, 'resolve')}><CheckCheck className="w-3.5 h-3.5" /> Resolve</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
