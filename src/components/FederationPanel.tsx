import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, KeyRound, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { adminApi, type DepartmentRow } from '../lib/adminApi';
import { FEDERATION_SCOPES, federationApi, type FederationClientRow, type FederationQuotas, type FederationScope } from '../lib/federationApi';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DEFAULTS: FederationQuotas = { eventsPerMinute: 600, eventsPerDay: 200000, maxSessions: 4 };
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

/**
 * Settings > Department and connector access (admins): the API-key identities of department systems and integrators, what each may do and
 * how much (events a minute / a day, live sessions), and their use. A new key is shown once. See docs/federation-service.md.
 */
export default function FederationPanel() {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<FederationClientRow[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [shownKey, setShownKey] = useState<{ id: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [id, setId] = useState('');
  const [department, setDepartment] = useState('');
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<FederationScope[]>(['events.push']);
  const [quotas, setQuotas] = useState<FederationQuotas>(DEFAULTS);
  const [editing, setEditing] = useState<{ id: string; q: FederationQuotas } | null>(null);

  const reload = useCallback(async () => {
    try { setClients(await federationApi.clients()); setLoadError(null); } catch (e) { setLoadError(errText(e)); }
  }, []);
  useEffect(() => {
    if (!open) return;
    void reload();
    adminApi.departments().then((d) => setDepartments(Array.isArray(d) ? d : [])).catch(() => setDepartments([]));
    const t = setInterval(() => void reload(), 15000);
    return () => clearInterval(t);
  }, [open, reload]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await fn(); } catch (e) { setNotice({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  };

  const create = () => run('create', async () => {
    const r = await federationApi.create({ id: id.trim(), department, label: label.trim() || undefined, scopes, quotas });
    setShownKey({ id: r.client.id, key: r.key }); setCopied(false);
    setId(''); setLabel(''); setQuotas(DEFAULTS);
    await reload();
  });
  const toggle = (c: FederationClientRow) => run(`on:${c.id}`, async () => { await federationApi.update(c.id, { enabled: !c.enabled }); await reload(); });
  const saveQuotas = () => editing && run(`q:${editing.id}`, async () => { await federationApi.update(editing.id, { quotas: editing.q }); setEditing(null); await reload(); });
  const rotate = (c: FederationClientRow) => {
    if (!window.confirm(`Make a new key for "${c.id}"? The old key stops working at once, so the department's system must be given the new one.`)) return;
    void run(`rot:${c.id}`, async () => { const r = await federationApi.rotate(c.id); setShownKey({ id: c.id, key: r.key }); setCopied(false); await reload(); });
  };
  const remove = (c: FederationClientRow) => {
    if (!window.confirm(`Remove "${c.id}"? Its key stops working and its live sessions end.`)) return;
    void run(`rm:${c.id}`, async () => { await federationApi.remove(c.id); await reload(); });
  };
  const copy = async () => { if (!shownKey) return; try { await navigator.clipboard.writeText(shownKey.key); setCopied(true); } catch { setCopied(false); } };

  const num = (v: string) => Math.max(0, Number(v.replace(/\D/g, '')) || 0);
  const canCreate = id.trim().length > 0 && department.length > 0 && scopes.length > 0 && !busy;

  return (
    <div className="card overflow-hidden" data-testid="federation-panel">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 p-5 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <KeyRound className="w-4 h-4 text-accent" strokeWidth={1.75} />
        <span className="font-display font-bold text-ink">Department and connector access</span>
        <span className="text-xs text-ink-muted ml-auto">{open ? `${clients.length} client(s)` : 'API keys, limits, live sessions'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-5 border-t border-border pt-5">
          <p className="text-[11px] text-ink-muted">Each department system or integrator that sends events or opens live sessions gets its own key. Everything it sends is filed under its department, whatever it says. Limits are per client.</p>
          {loadError && <p className="text-xs text-critical" role="alert">{loadError}</p>}
          {notice && <p className={cn('text-xs flex items-start gap-2', notice.ok ? 'text-ink' : 'text-critical')} role={notice.ok ? 'status' : 'alert'}>{notice.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-success shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}{notice.text}</p>}

          {shownKey && (
            <div className="panel p-3 space-y-2 border border-accent/40" role="status">
              <p className="text-xs font-semibold">Key for “{shownKey.id}” — shown only now. Give it to the department; if it is lost, make a new one.</p>
              <div className="flex items-center gap-2">
                <code className="text-xs font-mono break-all flex-1 select-all" data-testid="federation-key">{shownKey.key}</code>
                <button onClick={copy} className="btn-ghost !py-1.5 !px-3 text-xs flex items-center gap-1.5"><Copy className="w-3.5 h-3.5" />{copied ? 'Copied' : 'Copy'}</button>
                <button onClick={() => setShownKey(null)} className="btn-ghost !py-1.5 !px-3 text-xs">Done</button>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <p className="text-xs font-semibold">Add a client</p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Name (letters, digits, - _)</span>
                <input value={id} onChange={(e) => setId(e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40))} placeholder="police-nvr" className="input !py-2 text-sm font-mono" /></label>
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Department</span>
                <select value={department} onChange={(e) => setDepartment(e.target.value)} className="input !py-2 text-sm">
                  <option value="">Choose…</option>
                  {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                </select></label>
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Description (optional)</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="Police control room NVR" className="input !py-2 text-sm" /></label>
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Events per minute</span>
                <input value={quotas.eventsPerMinute} onChange={(e) => setQuotas({ ...quotas, eventsPerMinute: num(e.target.value) })} inputMode="numeric" className="input !py-2 text-sm" /></label>
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Events per day</span>
                <input value={quotas.eventsPerDay} onChange={(e) => setQuotas({ ...quotas, eventsPerDay: num(e.target.value) })} inputMode="numeric" className="input !py-2 text-sm" /></label>
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Live sessions at once</span>
                <input value={quotas.maxSessions} onChange={(e) => setQuotas({ ...quotas, maxSessions: num(e.target.value) })} inputMode="numeric" className="input !py-2 text-sm" /></label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              {FEDERATION_SCOPES.map((s) => (
                <label key={s.id} className="text-xs flex items-center gap-1.5" title={s.hint}>
                  <input type="checkbox" checked={scopes.includes(s.id)} onChange={() => setScopes((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))} />{s.label}
                </label>
              ))}
              <button onClick={create} disabled={!canCreate} className="btn-primary !py-2 !px-4 text-xs ml-auto">{busy === 'create' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Create and show key'}</button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold">Clients</p>
              <button onClick={() => void reload()} className="btn-ghost !py-1 !px-2 text-xs flex items-center gap-1.5" aria-label="Refresh"><RefreshCw className="w-3.5 h-3.5" />Refresh</button>
            </div>
            {clients.length === 0 ? <p className="text-xs text-ink-muted">No clients yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-ink-muted"><th className="py-1 pr-3">Client</th><th className="pr-3">Department</th><th className="pr-3">Events (min / day)</th><th className="pr-3">Sessions</th><th className="pr-3">Last seen</th><th className="pr-3">Refused</th><th /></tr></thead>
                  <tbody>
                    {clients.map((c) => (
                      <tr key={c.id} className={cn('border-t border-border align-top', !c.enabled && 'opacity-60')}>
                        <td className="py-2 pr-3"><span className="font-mono">{c.id}</span>{c.label && <span className="block text-ink-muted">{c.label}</span>}
                          <span className="block text-ink-muted">{c.scopes.map((s) => FEDERATION_SCOPES.find((x) => x.id === s)?.label ?? s).join(', ') || 'no permissions'}{!c.enabled && ' · switched off'}</span></td>
                        <td className="pr-3">{c.department}</td>
                        <td className="pr-3">{editing?.id === c.id ? (
                          <span className="flex flex-col gap-1">
                            <input aria-label="Events per minute" value={editing.q.eventsPerMinute} onChange={(e) => setEditing({ id: c.id, q: { ...editing.q, eventsPerMinute: num(e.target.value) } })} className="input !py-1 text-xs w-24" />
                            <input aria-label="Events per day" value={editing.q.eventsPerDay} onChange={(e) => setEditing({ id: c.id, q: { ...editing.q, eventsPerDay: num(e.target.value) } })} className="input !py-1 text-xs w-24" />
                          </span>
                        ) : `${c.usage.eventsLastMinute} / ${c.quotas.eventsPerMinute} · ${c.usage.eventsToday} / ${c.quotas.eventsPerDay}`}</td>
                        <td className="pr-3">{editing?.id === c.id
                          ? <input aria-label="Live sessions at once" value={editing.q.maxSessions} onChange={(e) => setEditing({ id: c.id, q: { ...editing.q, maxSessions: num(e.target.value) } })} className="input !py-1 text-xs w-16" />
                          : `${c.usage.activeSessions} / ${c.quotas.maxSessions}`}</td>
                        <td className="pr-3 whitespace-nowrap">{ago(c.usage.lastSeenAt)}</td>
                        <td className="pr-3" title={c.usage.lastError ?? undefined}>{c.usage.rejected}{c.usage.lastError ? ' ⓘ' : ''}</td>
                        <td className="py-2 whitespace-nowrap text-right space-x-1">
                          {editing?.id === c.id ? (<>
                            <button onClick={saveQuotas} disabled={!!busy} className="btn-primary !py-1 !px-2 text-xs">Save</button>
                            <button onClick={() => setEditing(null)} className="btn-ghost !py-1 !px-2 text-xs">Cancel</button>
                          </>) : (<>
                            <button onClick={() => setEditing({ id: c.id, q: { ...c.quotas } })} className="btn-ghost !py-1 !px-2 text-xs">Limits</button>
                            <button onClick={() => toggle(c)} disabled={!!busy} className="btn-ghost !py-1 !px-2 text-xs">{c.enabled ? 'Switch off' : 'Switch on'}</button>
                            <button onClick={() => rotate(c)} disabled={!!busy} className="btn-ghost !py-1 !px-2 text-xs">New key</button>
                            <button onClick={() => remove(c)} disabled={!!busy} className="btn-ghost !py-1 !px-2 text-xs text-critical" aria-label={`Remove ${c.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                          </>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
