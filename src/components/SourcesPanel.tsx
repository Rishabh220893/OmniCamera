import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Plug, RefreshCw, Search, ServerCog, Trash2, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';
import { adminApi, type DepartmentRow } from '../lib/adminApi';
import {
  sourcesApi, type AdapterInfo, type ChannelRow, type DiscoveredDevice, type JobStatus, type OnboardResponse, type SourceCamera, type SourceRow,
} from '../lib/sourcesApi';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PATH_LABEL: Record<string, string> = { pull: 'plain pull', 're-encode': 're-encode', none: 'no path' };

/** One line for a result of adding a camera. */
function resultLine(r: OnboardResponse): { ok: boolean; text: string } {
  if (r.ok === false) return { ok: false, text: r.error };
  const warn = r.warnings.length ? ` ${r.warnings.join(' ')}` : '';
  return { ok: true, text: `Added "${r.name}" (recipe ${r.recipe}, ${PATH_LABEL[r.pathKind] ?? r.pathKind}).${warn}` };
}

/**
 * Registry > Add cameras from a device or recorder: ONVIF devices, Hikvision and Dahua recorders (every channel at once) and plain RTSP
 * addresses become Registry cameras that play through the media server. The login is sent to the server, stored sealed, and never shown again.
 * See docs/adapters.md ("Onboarding").
 */
export default function SourcesPanel({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [canApply, setCanApply] = useState(false);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const [adapter, setAdapter] = useState('onvif');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [force, setForce] = useState(false);
  const [found, setFound] = useState<DiscoveredDevice[] | null>(null);
  const [channels, setChannels] = useState<ChannelRow[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [job, setJob] = useState<JobStatus | null>(null);
  const [preview, setPreview] = useState<{ add: string[]; replace: string[]; remove: string[]; skipped: Array<{ cameraId: string; why: string }> } | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const info = adapters.find((a) => a.kind === adapter);
  const usesUrl = adapter === 'rtsp' || adapter === 'http';

  const reload = useCallback(async () => {
    try {
      const [list, a] = await Promise.all([sourcesApi.list(), sourcesApi.adapters()]);
      setRows(list.sources ?? []); setKeyConfigured(list.keyConfigured !== false); setCanApply(!!list.canApplyMedia);
      setAdapters(a.filter((x) => ['onvif', 'hikvision', 'dahua', 'rtsp'].includes(x.kind)));
      setLoadError(null);
    } catch (e) { setLoadError(errText(e)); }
  }, []);
  useEffect(() => { if (isAdmin && open) { void reload(); adminApi.departments().then((d) => setDepartments(Array.isArray(d) ? d : [])).catch(() => setDepartments([])); } }, [isAdmin, open, reload]);
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const camera = useMemo((): SourceCamera => ({
    id: 'device', adapter, ...(usesUrl ? { url: url.trim() } : { host: host.trim(), ...(port ? { port: Number(port) } : {}) }),
    ...(user ? { credentials: { user, pass } } : {}), ...(name.trim() ? { name: name.trim() } : {}),
  }), [adapter, usesUrl, url, host, port, user, pass, name]);
  const ready = usesUrl ? url.trim().length > 0 : host.trim().length > 0;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await fn(); } catch (e) { setNotice({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  };

  const discover = () => run('discover', async () => { setFound(await sourcesApi.discover(adapter)); });
  const listChannels = () => run('channels', async () => {
    const c = await sourcesApi.channels(camera);
    setChannels(c); setPicked(new Set(c.filter((x) => x.online !== false).map((x) => x.channel)));
  });
  const addOne = () => run('add', async () => {
    const r = await sourcesApi.onboard({ camera, name: name.trim() || undefined, departmentId: dept || null, force });
    setNotice(resultLine(r));
    if (r.ok === true) { setPass(''); await reload(); }
  });
  const addChannels = () => run('addChannels', async () => {
    const { jobId } = await sourcesApi.onboardChannels({ camera, channels: [...picked], namePrefix: name.trim() || undefined, departmentId: dept || null, force });
    setJob({ id: jobId, state: 'running', total: picked.size, done: 0, results: [] });
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(() => {
      sourcesApi.job(jobId).then((j) => {
        setJob(j);
        if (j.state === 'done') { if (poll.current) clearInterval(poll.current); setPass(''); void reload(); }
      }).catch(() => { if (poll.current) clearInterval(poll.current); });
    }, 3000);
  });
  const reprobe = (id: string) => run(`re:${id}`, async () => { const r = await sourcesApi.reprobe(id); setNotice(r.ok ? { ok: !r.failure, text: r.failure ? `Probed again: ${r.failure}` : `Probed again: recipe ${r.recipe}.` } : { ok: false, text: r.error ?? 'Failed.' }); await reload(); });
  const remove = (r: SourceRow) => {
    if (!window.confirm(`Remove "${r.name}" from the Registry? Its media-server path is removed the next time you apply.`)) return;
    void run(`rm:${r.cameraId}`, async () => { await sourcesApi.remove(r.cameraId); await reload(); });
  };
  const apply = (dryRun: boolean) => run('apply', async () => {
    const r = await sourcesApi.applyMedia(dryRun);
    if (dryRun) { setPreview({ add: r.add, replace: r.replace, remove: r.remove, skipped: r.skipped }); return; }
    setPreview(null);
    setNotice({ ok: r.errors.length === 0, text: r.errors.length ? r.errors.join(' ') : `Applied: ${r.add.length} added, ${r.replace.length} changed, ${r.remove.length} removed.${r.gridInFile === false ? ' The generated file was left alone (no grid login here).' : ''}` });
  });

  if (!isAdmin) return null;
  return (
    <div className="card overflow-hidden" data-testid="sources-panel">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 p-5 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Plug className="w-4 h-4 text-accent" strokeWidth={1.75} />
        <span className="font-display font-bold text-ink">Add cameras from a device or recorder</span>
        <span className="text-xs text-ink-muted ml-auto">{rows.length > 0 ? `${rows.length} added this way` : 'ONVIF, Hikvision, Dahua, RTSP'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-5 border-t border-border pt-5">
          {loadError && <p className="text-xs text-critical" role="alert">{loadError}</p>}
          {!keyConfigured && <p className="text-xs text-ink-muted flex items-start gap-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />Logins are only stored when SOURCE_SECRET_KEY is set on the server. Without it only cameras that need no login can be added.</p>}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Kind</span>
              <select value={adapter} onChange={(e) => { setAdapter(e.target.value); setChannels(null); setFound(null); }} className="input !py-2 text-sm">
                {(adapters.length ? adapters : [{ kind: 'onvif', label: 'ONVIF' } as AdapterInfo]).map((a) => <option key={a.kind} value={a.kind}>{a.label}</option>)}
              </select></label>
            {usesUrl ? (
              <label className="text-xs space-y-1 sm:col-span-2"><span className="text-ink-muted font-semibold">Stream address</span>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtsp://192.168.1.64:554/stream1" className="input !py-2 text-sm font-mono" /></label>
            ) : (<>
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Device address</span>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.64" className="input !py-2 text-sm font-mono" /></label>
              <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Port (optional)</span>
                <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder={adapter === 'onvif' ? '80' : '80'} inputMode="numeric" className="input !py-2 text-sm font-mono" /></label>
            </>)}
            <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Login (if it needs one)</span>
              <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" placeholder="admin" className="input !py-2 text-sm" /></label>
            <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Password</span>
              <input value={pass} onChange={(e) => setPass(e.target.value)} type="password" autoComplete="new-password" className="input !py-2 text-sm" /></label>
            <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Name (recorder: prefix)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Gate camera" className="input !py-2 text-sm" /></label>
            <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Give to department</span>
              <select value={dept} onChange={(e) => setDept(e.target.value)} className="input !py-2 text-sm">
                <option value="">None (mine only)</option>
                {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select></label>
          </div>
          {info && <p className="text-[11px] text-ink-muted">{info.description}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={addOne} disabled={!!busy || !ready} className="btn-primary !py-2 !px-4 text-xs">{busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Add this camera'}</button>
            {info?.canListChannels && <button onClick={listChannels} disabled={!!busy || !ready} className="btn-ghost !py-2 !px-4 text-xs">{busy === 'channels' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'List the recorder’s channels'}</button>}
            {info?.canDiscover && <button onClick={discover} disabled={!!busy} className="btn-ghost !py-2 !px-4 text-xs flex items-center gap-1.5"><Search className="w-3.5 h-3.5" />{busy === 'discover' ? 'Looking...' : 'Find on this network'}</button>}
            <label className="text-xs flex items-center gap-1.5 text-ink-muted ml-auto"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />Add even if it cannot be reached now</label>
          </div>

          {notice && <p className={cn('text-xs flex items-start gap-2', notice.ok ? 'text-ink' : 'text-critical')} role={notice.ok ? 'status' : 'alert'}>{notice.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-success shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}{notice.text}</p>}

          {found && (
            <div className="panel p-3 text-xs space-y-1">
              {found.length === 0 ? <p className="text-ink-muted">No ONVIF device answered on this server's network segment.</p> : found.map((d) => (
                <button key={d.address + d.serviceUrls[0]} onClick={() => setHost(d.address)} className="block w-full text-left hover:bg-surface-hover rounded px-2 py-1">
                  <span className="font-mono">{d.address}</span> <span className="text-ink-muted">{[d.manufacturer, d.name ?? d.hardware].filter(Boolean).join(' ')}</span>
                </button>
              ))}
            </div>
          )}

          {channels && (
            <div className="panel p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold">{channels.length} channel(s); each takes about 20 seconds to check</span>
                <button onClick={addChannels} disabled={!!busy || picked.size === 0 || job?.state === 'running'} className="btn-primary !py-1.5 !px-3 text-xs">Add {picked.size} selected</button>
              </div>
              <div className="grid gap-1 sm:grid-cols-2 max-h-56 overflow-auto text-xs">
                {channels.map((c) => (
                  <label key={c.channel} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-hover">
                    <input type="checkbox" checked={picked.has(c.channel)} onChange={() => setPicked((p) => { const n = new Set(p); n.has(c.channel) ? n.delete(c.channel) : n.add(c.channel); return n; })} />
                    <span className="font-mono">#{c.channel}</span><span>{c.name ?? 'Unnamed'}</span>
                    {c.online === false && <span className="text-critical">offline</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {job && (
            <div className="panel p-3 text-xs space-y-1" aria-live="polite">
              <p className="font-semibold">{job.state === 'running' ? `Adding channels: ${job.done} of ${job.total}...` : `Finished: ${job.results.filter((r) => r.result.ok).length} added, ${job.results.filter((r) => !r.result.ok).length} not added.`}</p>
              {job.error && <p className="text-critical">{job.error}</p>}
              {job.results.map((r) => { const l = resultLine(r.result); return <p key={r.channel} className={l.ok ? 'text-ink-muted' : 'text-critical'}>#{r.channel} {r.name}: {l.text}</p>; })}
            </div>
          )}

          {rows.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-widest text-ink-muted">Added this way</h3>
                <div className="flex items-center gap-2">
                  <button onClick={() => { void reload(); }} className="btn-ghost !p-2" aria-label="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
                  {canApply && <button onClick={() => apply(true)} disabled={!!busy} className="btn-ghost !py-1.5 !px-3 text-xs flex items-center gap-1.5"><ServerCog className="w-3.5 h-3.5" />Put on the media server</button>}
                </div>
              </div>
              {preview && (
                <div className="panel p-3 text-xs space-y-2">
                  <p>Will add {preview.add.length}, change {preview.replace.length}, remove {preview.remove.length}.{preview.skipped.length ? ` Skipped: ${preview.skipped.map((s) => `${s.cameraId} (${s.why})`).join('; ')}.` : ''}</p>
                  <div className="flex gap-2"><button onClick={() => apply(false)} disabled={!!busy} className="btn-primary !py-1.5 !px-3 text-xs">Apply</button><button onClick={() => setPreview(null)} className="btn-ghost !py-1.5 !px-3 text-xs">Cancel</button></div>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-ink-muted"><th className="py-1 pr-3">Camera</th><th className="pr-3">Kind</th><th className="pr-3">Address</th><th className="pr-3">Department</th><th className="pr-3">Plays as</th><th /></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.cameraId} className="border-t border-border">
                        <td className="py-1.5 pr-3">{r.name}</td><td className="pr-3">{r.adapter}</td>
                        <td className="pr-3 font-mono">{r.host ?? '-'}{r.port ? `:${r.port}` : ''}</td><td className="pr-3">{r.departmentId ?? '-'}</td>
                        <td className="pr-3">{r.failure ? <span className="text-critical">{r.failure}</span> : r.recipe ? `${r.recipe} (${PATH_LABEL[r.pathKind ?? ''] ?? r.pathKind})` : 'not probed'}</td>
                        <td className="text-right whitespace-nowrap">
                          <button onClick={() => reprobe(r.cameraId)} disabled={!!busy} className="btn-ghost !p-1.5" aria-label={`Probe ${r.name} again`} title="Probe again">{busy === `re:${r.cameraId}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}</button>
                          <button onClick={() => remove(r)} disabled={!!busy} className="btn-ghost !p-1.5 hover:!text-critical" aria-label={`Remove ${r.name}`} title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
