import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, Pencil, Play, RefreshCw, Search, ServerCog, Square } from 'lucide-react';
import { cn } from '../lib/utils';
import { profilesApi } from '../lib/cameraProfiles';
import {
  FLAG_LABEL, RECIPE_CODES, RECIPE_LABEL, ageLabel, filterViews, measuredLine, recipeTone,
  type MediaApplyResponse, type ProfilesResponse, type RecipeCode,
} from '../lib/cameraProfileView';

const PAGE_SIZE = 20;

interface Props {
  isAdmin: boolean;
  /** Grid camera ids found in the registry (cam01 ...), used as the default list to probe. */
  registryGridIds: string[];
  site?: string;
}

/**
 * Registry > Playback profiles: what the probe measured for each camera, the way it will be played and why, and a manual
 * override. Also starts a probe and applies the result to the media server. See docs/camera-onboarding-plan.md.
 */
export default function CameraProfilesPanel({ isAdmin, registryGridIds, site = 'grid' }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProfilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recipeFilter, setRecipeFilter] = useState<RecipeCode | 'all' | 'override'>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string; recipe: RecipeCode | 'auto'; reason: string } | null>(null);
  const [media, setMedia] = useState<MediaApplyResponse | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [page, setPage] = useState(0);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    try { setData(await profilesApi.list(site)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the profiles.'); }
  }, [site]);

  useEffect(() => {
    if (!open || !isAdmin) return;
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [open, isAdmin, load]);

  // While a probe runs, refresh every few seconds so the progress and the new results show up.
  const running = data?.probe.state === 'running';
  useEffect(() => {
    if (!open || !running) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [open, running, load]);
  useEffect(() => {
    if (wasRunning.current && !running) setNotice('Probe finished. The profiles below are up to date.');
    wasRunning.current = running;
  }, [running]);

  const views = data?.views ?? [];
  const filtered = useMemo(() => filterViews(views, { recipe: recipeFilter, query }), [views, recipeFilter, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = useMemo(() => filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE), [filtered, current]);
  const knownIds = useMemo(() => Array.from(new Set([...registryGridIds, ...views.map((v) => v.cameraId)])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [registryGridIds, views]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name); setNotice(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(null); }
  };

  const doImport = () => act('import', async () => {
    const r = await profilesApi.importSaved(site);
    setNotice(`Loaded ${r.imported} camera${r.imported === 1 ? '' : 's'} from ${r.files} saved probe run${r.files === 1 ? '' : 's'}.`);
    await load();
  });
  const doProbe = (ids: string[]) => act('probe', async () => {
    await profilesApi.probe(site, ids);
    setNotice(`Probing ${ids.length} camera${ids.length === 1 ? '' : 's'}: about 30 seconds each, two at a time.`);
    await load();
  });
  const doStop = () => act('stop', async () => { await profilesApi.stopProbe(site); await load(); });
  const saveOverride = () => act('override', async () => {
    if (!editing) return;
    const recipe = editing.recipe === 'auto' ? null : editing.recipe;
    await profilesApi.setOverride(site, editing.id, recipe, recipe ? editing.reason : null);
    setEditing(null);
    await load();
  });
  const doMedia = (dryRun: boolean) => act(dryRun ? 'preview' : 'apply', async () => {
    setConfirmApply(false);
    setMedia(await profilesApi.applyMedia(site, dryRun));
  });

  if (!isAdmin) return null;
  const summary = data?.summary;
  const probe = data?.probe;
  const mediaChanges = media ? media.add.length + media.replace.length + media.remove.length : 0;

  return (
    <div className="card overflow-hidden" data-testid="camera-profiles">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full p-6 flex items-center justify-between gap-4 text-left hover:bg-surface-muted transition-colors"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-bold font-display text-ink">Playback profiles</h3>
          <p className="text-xs text-ink-muted mt-1">How each camera is played in the browser, chosen from what the cameras were measured to do.</p>
        </div>
        <span className="flex items-center gap-3 shrink-0">
          {summary && !open && <span className="text-xs text-ink-muted hidden sm:inline">{summary.total} cameras · {summary.needSlots} re-encoded</span>}
          {open ? <ChevronDown className="w-4 h-4 text-ink-muted" strokeWidth={1.75} /> : <ChevronRight className="w-4 h-4 text-ink-muted" strokeWidth={1.75} />}
        </span>
      </button>

      {open && (
        <div className="border-t border-border p-6 space-y-5">
          {error && (
            <div role="alert" className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-xs font-semibold bg-warning-soft text-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.75} /><span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="underline font-bold shrink-0">Dismiss</button>
            </div>
          )}
          {notice && (
            <div role="status" className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-xs font-semibold bg-success-soft text-success">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.75} /><span className="flex-1">{notice}</span>
              <button onClick={() => setNotice(null)} className="underline font-bold shrink-0">Dismiss</button>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => doProbe(knownIds)} disabled={!!busy || running || knownIds.length === 0} className="btn-primary !py-2 !px-4 text-xs whitespace-nowrap"
              title="Watches each camera for about 30 seconds and records what it does. Counts against the camera account's watch time.">
              {busy === 'probe' ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} /> : <Play className="w-3.5 h-3.5" strokeWidth={1.75} />}
              Probe {knownIds.length || ''} camera{knownIds.length === 1 ? '' : 's'}
            </button>
            {running && <button onClick={doStop} disabled={busy === 'stop'} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap"><Square className="w-3.5 h-3.5" strokeWidth={1.75} /> Stop</button>}
            <button onClick={doImport} disabled={!!busy || running} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap"
              title="Loads the results saved by scripts/probe-cameras.ts (the .demo-logs folder on the server) so you do not have to probe again.">
              {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} /> : <Download className="w-3.5 h-3.5" strokeWidth={1.75} />} Load saved probe runs
            </button>
            <button onClick={() => { void load(); }} disabled={loading} className="btn-ghost !py-2 !px-3 text-xs whitespace-nowrap" aria-label="Refresh"><RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} strokeWidth={1.75} /></button>
          </div>

          {/* Probe progress */}
          {probe && probe.state !== 'idle' && (
            <div className="rounded-xl bg-surface-muted p-4 space-y-2" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-semibold text-ink">
                  {probe.state === 'running' ? `Probing ${probe.done} of ${probe.total}` : probe.state === 'finished' ? `Probed ${probe.done} of ${probe.total}` : `Stopped after ${probe.done} of ${probe.total}`}
                </span>
                <span className="text-ink-muted">{probe.ok} with video · {probe.failed} without{probe.current.length ? ` · now ${probe.current.join(', ')}` : ''}</span>
              </div>
              <div className="h-1.5 rounded-full bg-border overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${probe.total ? (probe.done / probe.total) * 100 : 0}%` }} /></div>
              {probe.message && <p className="text-xs text-warning">{probe.message}</p>}
            </div>
          )}

          {/* Summary */}
          {summary && summary.total > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by playback path">
                <button onClick={() => { setRecipeFilter('all'); setPage(0); }} className={cn('badge', recipeFilter === 'all' ? 'badge-accent' : 'badge-neutral')}>All {summary.total}</button>
                {RECIPE_CODES.filter((c) => summary.counts[c] > 0).map((c) => (
                  <button key={c} onClick={() => { setRecipeFilter(recipeFilter === c ? 'all' : c); setPage(0); }} title={RECIPE_LABEL[c].long}
                    className={cn('badge', recipeFilter === c ? 'badge-accent' : recipeTone(c))}>{RECIPE_LABEL[c].short} {summary.counts[c]}</button>
                ))}
                {summary.overrides > 0 && <button onClick={() => { setRecipeFilter(recipeFilter === 'override' ? 'all' : 'override'); setPage(0); }} className={cn('badge', recipeFilter === 'override' ? 'badge-accent' : 'badge-neutral')}>Overridden {summary.overrides}</button>}
              </div>
              <p className="text-xs text-ink-muted">
                {summary.needSlots === 0 ? 'No camera needs re-encoding.' : (
                  <><span className="font-semibold text-ink">{summary.needSlots} cameras</span> need re-encoding while they are watched, and this machine fits about <span className="font-semibold text-ink">{summary.slots}</span> at once
                    {data?.encoder === 'none' ? ' (no hardware encoder: they show snapshots instead).' : ', so the others show snapshots until a slot is free.'}</>
                )}
              </p>
            </div>
          )}

          {/* Empty state */}
          {data && views.length === 0 && (
            <div className="text-center py-10 space-y-2">
              <p className="text-sm font-semibold text-ink">No cameras have been measured yet</p>
              <p className="text-xs text-ink-muted max-w-md mx-auto">Probe the cameras to find out how each one should be played, or load the results of an earlier run saved on the server.</p>
            </div>
          )}

          {/* List */}
          {views.length > 0 && (
            <>
              <div className="relative">
                <Search className="w-4 h-4 text-ink-muted absolute left-3.5 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
                <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder="Search camera, codec, problem or reason..." aria-label="Search playback profiles" className="input !pl-10 !pr-4 !py-2.5 text-sm" />
              </div>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {shown.map((v) => {
                  const isEditing = editing?.id === v.cameraId;
                  return (
                    <li key={v.cameraId} className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <span className="text-sm font-semibold text-ink font-mono">{v.cameraId}</span>
                          <span className={cn('badge whitespace-nowrap', recipeTone(v.recipe))} title={RECIPE_LABEL[v.recipe].long}>{RECIPE_LABEL[v.recipe].short}</span>
                          {v.override && <span className="badge badge-warning whitespace-nowrap" title={`The measurements chose ${RECIPE_LABEL[v.naturalRecipe].short}`}>Overridden</span>}
                          {v.recipe !== 'F' && v.recipe !== 'G' && !v.gridLive && <span className="badge badge-neutral whitespace-nowrap" title="The first picture takes over 30 seconds, so the grid shows snapshots and this camera goes live only when you focus it.">Snapshot in grid</span>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-ink-muted" title={v.probedAt ?? undefined}>probed {ageLabel(v.probedAt)}</span>
                          <button onClick={() => setEditing(isEditing ? null : { id: v.cameraId, recipe: v.override ?? 'auto', reason: v.overrideReason ?? '' })}
                            className="btn-ghost !p-2 min-w-[36px] min-h-[36px] flex items-center justify-center" aria-label={`Change how ${v.cameraId} is played`} title="Override the recommendation"><Pencil className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
                        </div>
                      </div>
                      <p className="text-xs text-ink" title={v.reason}>{v.cause}</p>
                      <p className="text-xs text-ink-muted">{measuredLine(v)}</p>
                      {v.failure && v.failureDetail && <p className="text-xs text-critical break-words">{v.failureDetail}</p>}
                      {v.notes.map((n) => <p key={n} className="text-[11px] text-ink-muted">{n}</p>)}
                      {v.flags.length > 0 && <div className="flex flex-wrap gap-1.5">{v.flags.map((f) => <span key={f} className="badge badge-neutral">{FLAG_LABEL[f] ?? f}</span>)}</div>}
                      {v.override && !isEditing && <p className="text-xs text-warning">Override reason: {v.overrideReason}</p>}
                      {isEditing && editing && (
                        <div className="rounded-xl bg-surface-muted p-3 flex flex-wrap items-end gap-3">
                          <label className="text-xs font-semibold text-ink space-y-1">
                            <span className="block">Play this camera</span>
                            <select value={editing.recipe} onChange={(e) => setEditing({ ...editing, recipe: e.target.value as RecipeCode | 'auto' })} className="input !py-2 !px-3 !w-auto text-sm cursor-pointer">
                              <option value="auto">As measured ({RECIPE_LABEL[v.naturalRecipe].short})</option>
                              {RECIPE_CODES.map((c) => <option key={c} value={c}>{RECIPE_LABEL[c].short} — {RECIPE_LABEL[c].long}</option>)}
                            </select>
                          </label>
                          {editing.recipe !== 'auto' && (
                            <label className="text-xs font-semibold text-ink space-y-1 flex-1 min-w-[200px]">
                              <span className="block">Why (kept with the change)</span>
                              <input value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value })} maxLength={300} placeholder="e.g. keep it direct, the big screen needs low delay" className="input !py-2 text-sm" />
                            </label>
                          )}
                          <div className="flex gap-2">
                            <button onClick={saveOverride} disabled={busy === 'override' || (editing.recipe !== 'auto' && !editing.reason.trim())} className="btn-primary !py-2 !px-4 text-xs">Save</button>
                            <button onClick={() => setEditing(null)} className="btn-ghost !py-2 !px-3 text-xs">Cancel</button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
                {shown.length === 0 && <li className="p-8 text-center text-xs text-ink-muted">No cameras match.</li>}
              </ul>
              {pages > 1 && (
                <div className="flex items-center justify-between text-xs text-ink-muted">
                  <span>{current * PAGE_SIZE + 1}–{Math.min(filtered.length, (current + 1) * PAGE_SIZE)} of {filtered.length}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPage(current - 1)} disabled={current === 0} className="btn-secondary !py-1.5 !px-3 text-xs">Previous</button>
                    <span>Page {current + 1} of {pages}</span>
                    <button onClick={() => setPage(current + 1)} disabled={current >= pages - 1} className="btn-secondary !py-1.5 !px-3 text-xs">Next</button>
                  </div>
                </div>
              )}

              {/* Apply to the media server */}
              <div className="rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <ServerCog className="w-4 h-4 text-ink-muted mt-0.5 shrink-0" strokeWidth={1.75} />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-ink">Apply to the media server</p>
                    <p className="text-xs text-ink-muted">
                      {data?.canApplyMedia
                        ? 'Changes the running media server to match these profiles without restarting it. Cameras that did not change keep playing; changed ones reconnect.'
                        : "The media server is not on this machine, so this server cannot change it. Run scripts/media-config.ts on the machine where the media server runs."}
                    </p>
                  </div>
                </div>
                {data?.canApplyMedia && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => doMedia(true)} disabled={!!busy} className="btn-secondary !py-2 !px-4 text-xs">
                      {busy === 'preview' && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />} Preview changes
                    </button>
                    {!confirmApply
                      ? <button onClick={() => setConfirmApply(true)} disabled={!!busy || !media || mediaChanges === 0} className="btn-primary !py-2 !px-4 text-xs" title={!media ? 'Preview the changes first' : undefined}>Apply…</button>
                      : (
                        <>
                          <span className="text-xs text-ink">Change {mediaChanges} camera{mediaChanges === 1 ? '' : 's'} on the media server?</span>
                          <button onClick={() => doMedia(false)} disabled={!!busy} className="btn-primary !py-2 !px-4 text-xs">{busy === 'apply' && <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />} Yes, apply</button>
                          <button onClick={() => setConfirmApply(false)} className="btn-ghost !py-2 !px-3 text-xs">Cancel</button>
                        </>
                      )}
                  </div>
                )}
                {media && (
                  <div className="text-xs space-y-1" aria-live="polite">
                    <p className="font-semibold text-ink">
                      {media.dryRun ? 'Would change' : 'Changed'}: {media.add.length} added, {media.replace.length} replaced, {media.remove.length} removed, {media.unchanged.length} unchanged
                    </p>
                    {media.add.length > 0 && <p className="text-ink-muted">Added: {media.add.join(', ')}</p>}
                    {media.replace.length > 0 && <p className="text-ink-muted">Replaced (viewers reconnect): {media.replace.join(', ')}</p>}
                    {media.remove.length > 0 && <p className="text-ink-muted">Removed: {media.remove.join(', ')}</p>}
                    {media.skipped.map((s) => <p key={s.cameraId} className="text-warning">{s.cameraId} skipped: {s.why}</p>)}
                    {media.errors.map((e) => <p key={e} className="text-critical">{e}</p>)}
                    {!media.dryRun && media.fileWritten && <p className="text-ink-muted">Saved for the next restart of the media server.</p>}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
