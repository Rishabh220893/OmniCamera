import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { eventsApi, ruleInputOf, SEVERITIES, type RuleInput, type RuleRow, type Severity } from '../../lib/eventsApi';
import { ErrorBox, errText } from './shared';
import { EVENT_TYPE_OPTIONS, KNOWN_EVENT_TYPES, useDepartmentNames } from './options';

const REDACTED = '********';
const csv = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
const THROTTLE_BY = [
  { value: 'event', label: 'the same thing (e.g. same plate)' }, { value: 'camera', label: 'the same camera' },
  { value: 'type', label: 'the same event type' }, { value: 'rule', label: 'anything this rule matches' },
] as const;

interface Draft {
  id?: string; name: string; types: string; minSeverity: '' | Severity; tags: string; plates: string; department: string; windowMin: number;
  by: typeof THROTTLE_BY[number]['value']; hook: boolean; url: string; secret: string; email: string; sms: string; hold: boolean; holdBefore: number; holdAfter: number; enabled: boolean;
}

/** The ways an alert can be delivered, in the order they are offered. The alert list itself is always kept. */
const CHANNEL_NOTE: Record<string, string> = { email: 'E-mail is not set up on this server (an administrator sets SMTP_URL).', sms: 'SMS is not set up on this server (an administrator sets SMS_GATEWAY_URL).', 'recording-hold': 'Recording is not on for this server.' };
/** Plates are stored upper case without spaces or dashes; a rule's plate list is compared the same way. */
const normPlate = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');
const PLATE_FIELD = 'data.plate';
const plateCond = (r?: RuleRow) => (r?.match.where ?? []).find((c) => c.field === PLATE_FIELD);

const blank = (): Draft => ({ name: '', types: 'plate.watchlist_match', minSeverity: '', tags: '', plates: '', department: '', windowMin: 10, by: 'event', hook: false, url: '', secret: '', email: '', sms: '', hold: false, holdBefore: 5, holdAfter: 10, enabled: true });

function toDraft(r: RuleRow): Draft {
  const hook = r.channels.find((c): c is Extract<typeof c, { type: 'webhook' }> => c.type === 'webhook');
  const mail = r.channels.find((c): c is Extract<typeof c, { type: 'email' }> => c.type === 'email');
  const text = r.channels.find((c): c is Extract<typeof c, { type: 'sms' }> => c.type === 'sms');
  const hold = r.channels.find((c): c is Extract<typeof c, { type: 'recording-hold' }> => c.type === 'recording-hold');
  return {
    id: r.id, name: r.name, types: (r.match.types ?? []).join(', '), minSeverity: r.match.minSeverity ?? '', tags: (r.match.tags ?? []).join(', '), plates: (() => { const c = plateCond(r); return c ? [c.value].flat().map(String).join(', ') : ''; })(), department: r.department ?? '',
    windowMin: Math.round(r.throttle.windowMs / 60_000), by: r.throttle.by[0] ?? 'event', hook: !!hook, url: hook?.url ?? '', secret: hook?.secret ?? '', email: (mail?.to ?? []).join(', '), sms: (text?.to ?? []).join(', '),
    hold: !!hold, holdBefore: hold?.beforeMinutes ?? 5, holdAfter: hold?.afterMinutes ?? 10, enabled: r.enabled,
  };
}

/** Creating a rule: only what a person needs. Conditions on event details and schedules are left as they are on an edit. */
function toInput(d: Draft, existing?: RuleRow): RuleInput {
  const match = { ...(existing?.match ?? {}), types: csv(d.types), tags: csv(d.tags) } as RuleInput['match'];
  if (d.minSeverity) match.minSeverity = d.minSeverity; else delete match.minSeverity;
  if (!match.tags?.length) delete match.tags;
  // Other conditions on an existing rule are kept; the plate condition is the one this screen owns.
  const where = (match.where ?? []).filter((c) => c.field !== PLATE_FIELD);
  const plates = [...new Set(csv(d.plates).map(normPlate).filter(Boolean))];
  if (plates.length) where.push({ field: PLATE_FIELD, op: 'in', value: plates });
  if (where.length) match.where = where; else delete match.where;
  const channels: RuleInput['channels'] = [{ type: 'log' }]; // the alert list is always kept
  if (d.hook) channels.push({ type: 'webhook', url: d.url.trim(), ...(d.secret ? { secret: d.secret } : {}) });
  if (csv(d.email).length) channels.push({ type: 'email', to: csv(d.email) });
  if (csv(d.sms).length) channels.push({ type: 'sms', to: csv(d.sms) });
  if (d.hold) channels.push({ type: 'recording-hold', beforeMinutes: Math.max(0, Math.round(d.holdBefore)), afterMinutes: Math.max(0, Math.round(d.holdAfter)) });
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
  const deptNames = useDepartmentNames();
  const [available, setAvailable] = useState<string[] | null>(null);
  useEffect(() => { eventsApi.channels().then(setAvailable).catch(() => setAvailable(null)); }, []);
  const has = (t: string) => available === null || available.includes(t);
  const toggleType = (t: string) => setDraft((d) => {
    if (!d) return d;
    const cur = csv(d.types);
    return { ...d, types: (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]).join(', ') };
  });

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
          <fieldset className="space-y-1 sm:col-span-2"><legend className="text-ink-muted">Which events (tick any; none ticked means every event)</legend>
            <div className="grid sm:grid-cols-3 gap-3 pt-1">
              {EVENT_TYPE_OPTIONS.map((g) => (
                <div key={g.group} className="space-y-1"><p className="font-semibold text-ink">{g.group}</p>
                  {g.items.map((i) => (
                    <label key={i.value} className="flex items-center gap-2"><input type="checkbox" checked={csv(draft.types).includes(i.value)} onChange={() => toggleType(i.value)} aria-label={i.label} /> {i.label}</label>
                  ))}
                </div>
              ))}
              {csv(draft.types).filter((t) => !KNOWN_EVENT_TYPES.has(t)).length > 0 && (
                <div className="space-y-1"><p className="font-semibold text-ink">Other (kept as set)</p>
                  {csv(draft.types).filter((t) => !KNOWN_EVENT_TYPES.has(t)).map((t) => (
                    <label key={t} className="flex items-center gap-2"><input type="checkbox" checked onChange={() => toggleType(t)} aria-label={t} /> {t}</label>
                  ))}
                </div>
              )}
            </div>
          </fieldset>
          <label className="space-y-1"><span className="text-ink-muted">Minimum severity</span>
            <select className="input w-full" value={draft.minSeverity} onChange={(e) => setDraft({ ...draft, minSeverity: e.target.value as Severity | '' })} aria-label="Minimum severity">
              <option value="">Any</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label className="space-y-1"><span className="text-ink-muted">Only for these plates (optional, comma separated; blank = any plate)</span>
            <input className="input w-full" value={draft.plates} onChange={(e) => setDraft({ ...draft, plates: e.target.value })} aria-label="Plates" placeholder="GJ05AB1234, GJ01XY9999" /></label>
          <label className="space-y-1"><span className="text-ink-muted">Only events with these tags (optional)</span>
            <input className="input w-full" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} aria-label="Tags" /></label>
          <label className="space-y-1"><span className="text-ink-muted">Department (blank = just your own cameras)</span>
            {deptNames ? (
              <select className="input w-full" value={draft.department} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, department: e.target.value })} aria-label="Department">
                <option value="">Just my own cameras</option>
                {[...new Set([...deptNames, ...(draft.department ? [draft.department] : [])])].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            ) : (
              <input className="input w-full" value={draft.department} disabled={!!draft.id} onChange={(e) => setDraft({ ...draft, department: e.target.value })} maxLength={64} aria-label="Department" />
            )}</label>
          <label className="space-y-1"><span className="text-ink-muted">Fold repeats of</span>
            <select className="input w-full" value={draft.by} onChange={(e) => setDraft({ ...draft, by: e.target.value as Draft['by'] })} aria-label="Fold repeats of">
              {THROTTLE_BY.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}</select></label>
          <label className="space-y-1"><span className="text-ink-muted">...for this many minutes (0 = alert every time)</span>
            <input className="input w-full" type="number" min={0} max={10080} value={draft.windowMin} onChange={(e) => setDraft({ ...draft, windowMin: Number(e.target.value) })} aria-label="Minutes" /></label>
          <fieldset className="space-y-2 sm:col-span-2" data-testid="rule-channels"><legend className="text-ink-muted">Tell people (the alert list always gets it)</legend>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.hook} onChange={(e) => setDraft({ ...draft, hook: e.target.checked })} aria-label="Send to a web address" /> Send to a web address (webhook)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!draft.email} disabled={!has('email')} onChange={(e) => setDraft({ ...draft, email: e.target.checked ? ' ' : '' })} aria-label="Send an e-mail" /> Send an e-mail</label>
            {!has('email') && <p className="text-[11px] text-ink-muted pl-6">{CHANNEL_NOTE.email}</p>}
            {draft.email !== '' && has('email') && <input className="input w-full" value={draft.email.trim() === '' ? '' : draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value || ' ' })} placeholder="chief@department.gov.in, control@department.gov.in (up to 5)" aria-label="E-mail addresses" />}
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!draft.sms} disabled={!has('sms')} onChange={(e) => setDraft({ ...draft, sms: e.target.checked ? ' ' : '' })} aria-label="Send an SMS" /> Send an SMS</label>
            {!has('sms') && <p className="text-[11px] text-ink-muted pl-6">{CHANNEL_NOTE.sms}</p>}
            {draft.sms !== '' && has('sms') && <input className="input w-full" value={draft.sms.trim() === '' ? '' : draft.sms} onChange={(e) => setDraft({ ...draft, sms: e.target.value || ' ' })} placeholder="+919876543210, +919812345678 (international form, up to 5)" aria-label="Phone numbers" />}
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.hold} disabled={!has('recording-hold')} onChange={(e) => setDraft({ ...draft, hold: e.target.checked })} aria-label="Keep the recording" /> Keep the recording around the event (so it is not deleted)</label>
            {!has('recording-hold') && <p className="text-[11px] text-ink-muted pl-6">{CHANNEL_NOTE['recording-hold']}</p>}
            {draft.hold && has('recording-hold') && (
              <div className="flex items-center gap-2 pl-6">from <input className="input w-20" type="number" min={0} max={120} value={draft.holdBefore} onChange={(e) => setDraft({ ...draft, holdBefore: Number(e.target.value) })} aria-label="Minutes before" /> minutes before to <input className="input w-20" type="number" min={0} max={240} value={draft.holdAfter} onChange={(e) => setDraft({ ...draft, holdAfter: Number(e.target.value) })} aria-label="Minutes after" /> minutes after</div>
            )}
          </fieldset>
          {draft.hook && (
            <>
              <label className="space-y-1"><span className="text-ink-muted">Webhook address</span>
                <input className="input w-full" type="url" placeholder="https://..." value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} required aria-label="Webhook address" /></label>
              <label className="space-y-1 sm:col-span-2"><span className="text-ink-muted">Signing secret (optional){draft.secret === REDACTED ? ' - kept as it is until you type a new one' : ''}</span>
                <input className="input w-full" type="password" autoComplete="new-password" value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} aria-label="Signing secret" /></label>
            </>
          )}
          <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Rule is on</label>
          <div className="sm:col-span-2 flex gap-2">
            <button className="btn-primary !py-2 !px-5 text-xs" disabled={busy || !draft.name.trim() || (draft.hook && !draft.url.trim()) || (draft.email !== '' && csv(draft.email).length === 0) || (draft.sms !== '' && csv(draft.sms).length === 0)}>{draft.id ? 'Save changes' : 'Create rule'}</button>
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
                {(r.match.types?.length ? r.match.types.join(', ') : 'any event')}{r.match.minSeverity ? ` · ${r.match.minSeverity}+` : ''}{r.match.tags?.length ? ` · tagged ${r.match.tags.join(', ')}` : ''}{plateCond(r) ? ` · plate ${[plateCond(r)!.value].flat().join(', ')}` : ''}
                {' '}&middot; {r.throttle.windowMs ? `repeats folded for ${Math.round(r.throttle.windowMs / 60_000)} min` : 'alerts every time'} &middot; to {r.channels.map((c) => ({ webhook: 'webhook', email: 'e-mail', sms: 'SMS', 'recording-hold': 'keeps the recording', log: 'alert list' } as Record<string, string>)[c.type] ?? c.type).join(', ')}
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
