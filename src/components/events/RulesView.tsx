import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { eventsApi, ruleInputOf, SEVERITIES, type RuleInput, type RuleRow, type Severity } from '../../lib/eventsApi';
import { ErrorBox, errText } from './shared';

const REDACTED = '********';
const csv = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
const THROTTLE_BY = [
  { value: 'event', label: 'the same thing (e.g. same plate)' }, { value: 'camera', label: 'the same camera' },
  { value: 'type', label: 'the same event type' }, { value: 'rule', label: 'anything this rule matches' },
] as const;

interface Draft {
  id?: string; name: string; types: string; minSeverity: '' | Severity; tags: string; department: string; windowMin: number;
  by: typeof THROTTLE_BY[number]['value']; channel: 'log' | 'webhook'; url: string; secret: string; enabled: boolean;
}
const blank = (): Draft => ({ name: '', types: 'plate.watchlist_match', minSeverity: '', tags: '', department: '', windowMin: 10, by: 'event', channel: 'log', url: '', secret: '', enabled: true });

function toDraft(r: RuleRow): Draft {
  const hook = r.channels.find((c): c is Extract<typeof c, { type: 'webhook' }> => c.type === 'webhook');
  return {
    id: r.id, name: r.name, types: (r.match.types ?? []).join(', '), minSeverity: r.match.minSeverity ?? '', tags: (r.match.tags ?? []).join(', '), department: r.department ?? '',
    windowMin: Math.round(r.throttle.windowMs / 60_000), by: r.throttle.by[0] ?? 'event', channel: hook ? 'webhook' : 'log', url: hook?.url ?? '', secret: hook?.secret ?? '', enabled: r.enabled,
  };
}

/** Creating a rule: only what a person needs. Conditions on event details and schedules are left as they are on an edit. */
function toInput(d: Draft, existing?: RuleRow): RuleInput {
  const match = { ...(existing?.match ?? {}), types: csv(d.types), tags: csv(d.tags) } as RuleInput['match'];
  if (d.minSeverity) match.minSeverity = d.minSeverity; else delete match.minSeverity;
  if (!match.tags?.length) delete match.tags;
  const channels: RuleInput['channels'] = d.channel === 'webhook' ? [{ type: 'webhook', url: d.url.trim(), ...(d.secret ? { secret: d.secret } : {}) }] : [{ type: 'log' }];
  return {
    name: d.name.trim(), enabled: d.enabled, match, throttle: { windowMs: Math.max(0, d.windowMin) * 60_000, by: [d.by] }, channels,
    ...(existing?.schedule ? { schedule: existing.schedule } : {}), ...(!d.id && d.department.trim() ? { department: d.department.trim() } : {}),
  };
}

/** Which events raise alerts, how often, and where they are sent. */
export default function RulesView() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setRules(await eventsApi.rules()); setError(null); }
    catch (e) { setError(errText(e)); setRules([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (okText: string, fn: () => Promise<unknown>) => {
    setBusy(true); setNotice(null);
    try { await fn(); setNotice({ kind: 'ok', text: okText }); await load(); return true; }
    catch (e) { setNotice({ kind: 'error', text: errText(e) }); return false; }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!draft) return;
    const existing = rules.find((r) => r.id === draft.id);
    const input = toInput(draft, existing);
    const ok = await run(draft.id ? `'${input.name}' saved.` : `'${input.name}' created.`, () => (draft.id ? eventsApi.updateRule(draft.id, input) : eventsApi.createRule(input)));
    if (ok) setDraft(null);
  };
  const test = async (r: RuleRow) => {
    setBusy(true); setNotice(null);
    try {
      const d = await eventsApi.testRule(r.id);
      const bad = d.filter((x) => !x.ok);
      setNotice(bad.length ? { kind: 'error', text: `Test failed: ${bad.map((x) => `${x.channel}${x.error ? ` (${x.error})` : ''}`).join(', ')}` } : { kind: 'ok', text: `Test sent through ${d.length} channel${d.length === 1 ? '' : 's'}.` });
    } catch (e) { setNotice({ kind: 'error', text: errText(e) }); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" data-testid="rules-view">
      <div className="flex items-center gap-2">
        <p className="text-xs text-ink-muted flex-1">A rule raises an alert when an event matches it. Repeats of the same thing are folded into one alert for the time you choose.</p>
        <button className="btn-primary !py-2 !px-4 text-xs flex items-center gap-1.5" onClick={() => setDraft(blank())}><Plus className="w-4 h-4" /> New rule</button>
      </div>
      {notice && <div role="status" className={`${notice.kind === 'ok' ? 'badge-success' : 'badge-critical'} rounded-xl px-4 py-2 !inline-block w-full !normal-case text-xs font-semibold`}>{notice.text}</div>}
      {error && <ErrorBox title="Could not load rules." error={error} hint="Sign in with an account (guest mode has no rules)." />}

      {draft && (
        <form className="card p-5 grid sm:grid-cols-2 gap-3 text-xs" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="rule-form">
          <h3 className="sm:col-span-2 text-sm font-bold text-ink">{draft.id ? 'Edit rule' : 'New rule'}</h3>
          <label className="space-y-1 sm:col-span-2"><span className="text-ink-muted">Name</span>
            <input className="input w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} required aria-label="Rule name" /></label>
          <label className="space-y-1"><span className="text-ink-muted">Event types (comma separated; plate.* means every plate event; empty means any)</span>
            <input className="input w-full" value={draft.types} onChange={(e) => setDraft({ ...draft, types: e.target.value })} aria-label="Event types" /></label>
          <label className="space-y-1"><span className="text-ink-muted">Minimum severity</span>
            <select className="input w-full" value={draft.minSeverity} onChange={(e) => setDraft({ ...draft, minSeverity: e.target.value as Severity | '' })} aria-label="Minimum severity">
              <option value="">Any</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label className="space-y-1"><span className="text-ink-muted">Only events with these tags (optional)</span>
            <input className="input w-full" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} aria-label="Tags" /></label>
          <label className="space-y-1"><span className="text-ink-muted">Department (blank = just your own cameras)</span>
            <input className="input w-full" value={draft.department} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, department: e.target.value })} maxLength={64} aria-label="Department" /></label>
          <label className="space-y-1"><span className="text-ink-muted">Fold repeats of</span>
            <select className="input w-full" value={draft.by} onChange={(e) => setDraft({ ...draft, by: e.target.value as Draft['by'] })} aria-label="Fold repeats of">
              {THROTTLE_BY.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select></label>
          <label className="space-y-1"><span className="text-ink-muted">...for this many minutes (0 = alert every time)</span>
            <input className="input w-full" type="number" min={0} max={10080} value={draft.windowMin} onChange={(e) => setDraft({ ...draft, windowMin: Number(e.target.value) })} aria-label="Minutes" /></label>
          <label className="space-y-1"><span className="text-ink-muted">Send to</span>
            <select className="input w-full" value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value as Draft['channel'] })} aria-label="Channel">
              <option value="log">The alert list only</option><option value="webhook">A web address (webhook)</option></select></label>
          {draft.channel === 'webhook' && (
            <>
              <label className="space-y-1"><span className="text-ink-muted">Webhook address</span>
                <input className="input w-full" type="url" placeholder="https://..." value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} required aria-label="Webhook address" /></label>
              <label className="space-y-1 sm:col-span-2"><span className="text-ink-muted">Signing secret (optional){draft.secret === REDACTED ? ' - kept as it is until you type a new one' : ''}</span>
                <input className="input w-full" type="password" autoComplete="new-password" value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} aria-label="Signing secret" /></label>
            </>
          )}
          <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Rule is on</label>
          <div className="sm:col-span-2 flex gap-2">
            <button className="btn-primary !py-2 !px-5 text-xs" disabled={busy || !draft.name.trim() || (draft.channel === 'webhook' && !draft.url.trim())}>{draft.id ? 'Save changes' : 'Create rule'}</button>
            <button type="button" className="btn-secondary !py-2 !px-5 text-xs" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      )}

      {!error && !loading && rules.length === 0 && !draft && <p className="card p-8 text-center text-sm text-ink-muted">No rules yet. Create one to be alerted when something matters.</p>}
      <ul className="space-y-2">
        {rules.map((r) => (
          <li key={r.id} className={`card p-4 flex flex-wrap items-center gap-3 ${r.enabled ? '' : 'opacity-60'}`}>
            <div className="flex-1 min-w-[14rem]">
              <p className="text-sm font-semibold text-ink">{r.name}{r.department && <span className="badge badge-accent !text-[10px] ml-2">{r.department}</span>}</p>
              <p className="text-[11px] text-ink-muted">
                {(r.match.types?.length ? r.match.types.join(', ') : 'any event')}{r.match.minSeverity ? ` · ${r.match.minSeverity}+` : ''}{r.match.tags?.length ? ` · tagged ${r.match.tags.join(', ')}` : ''}
                {' '}&middot; {r.throttle.windowMs ? `repeats folded for ${Math.round(r.throttle.windowMs / 60_000)} min` : 'alerts every time'} &middot; to {r.channels.map((c) => (c.type === 'webhook' ? 'webhook' : 'alert list')).join(', ')}
              </p>
            </div>
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={r.enabled} disabled={busy} onChange={() => void run(`'${r.name}' ${r.enabled ? 'switched off' : 'switched on'}.`, () => eventsApi.updateRule(r.id, ruleInputOf(r, { enabled: !r.enabled })))} aria-label={`${r.name} is on`} /> On</label>
            <button className="btn-ghost !p-2" title="Send a test" aria-label={`Test ${r.name}`} disabled={busy} onClick={() => void test(r)}><Send className="w-4 h-4" strokeWidth={1.75} /></button>
            <button className="btn-ghost !p-2" title="Edit" aria-label={`Edit ${r.name}`} disabled={busy} onClick={() => setDraft(toDraft(r))}><Pencil className="w-4 h-4" strokeWidth={1.75} /></button>
            <button className="btn-ghost !p-2 text-critical" title="Delete" aria-label={`Delete ${r.name}`} disabled={busy} onClick={() => { if (window.confirm(`Delete the rule '${r.name}'?`)) void run(`'${r.name}' deleted.`, () => eventsApi.deleteRule(r.id)); }}><Trash2 className="w-4 h-4" strokeWidth={1.75} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}
