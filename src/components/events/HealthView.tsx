import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { eventsApi, gridApi, type AlertRow, type GatewayRow, type GridStatusRow, type VmsSystemRow } from '../../lib/eventsApi';
import { summariseAnalysis, type AnalysisState } from '../../lib/analysisStatus';
import type { CameraConfig } from '../../types';
import { ago, errText, useInterval } from './shared';

/** One section can be refused (a viewer cannot see gateways) without hiding the others. */
type Part<T> = { data: T | null; error: string | null };
const attempt = async <T,>(fn: () => Promise<T>): Promise<Part<T>> => { try { return { data: await fn(), error: null }; } catch (e) { return { data: null, error: errText(e) }; } };

const STATE_CLASS: Record<string, string> = { online: 'badge-success', ok: 'badge-success', degraded: 'badge-warning', offline: 'badge-critical', down: 'badge-critical', auth_failed: 'badge-critical' };
const stateClass = (s: string) => STATE_CLASS[s] ?? 'badge-neutral';

/** Is everything that feeds the platform reporting? Alerts, regional gateways and department systems at a glance. */
export default function HealthView({ cameras = [] }: { cameras?: CameraConfig[] }) {
  const [alerts, setAlerts] = useState<Part<AlertRow[]>>({ data: null, error: null });
  const [gateways, setGateways] = useState<Part<GatewayRow[]>>({ data: null, error: null });
  const [systems, setSystems] = useState<Part<VmsSystemRow[]>>({ data: null, error: null });
  const [grid, setGrid] = useState<Part<GridStatusRow>>({ data: null, error: null });
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [a, g, s, gr] = await Promise.all([attempt(() => eventsApi.alerts('open')), attempt(() => eventsApi.gateways()), attempt(() => eventsApi.vmsSystems()), attempt(() => gridApi.status())]);
    setAlerts(a); setGateways(g); setSystems(s); setGrid(gr); setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useInterval(() => void load(), 30_000);

  const open = alerts.data ?? [];
  const bySeverity = (s: string) => open.filter((a) => a.severity === s).length;
  const gwBad = (gateways.data ?? []).filter((g) => g.state === 'degraded' || g.state === 'offline').length;
  const vmsBad = (systems.data ?? []).filter((s) => s.status && ['degraded', 'down', 'auth_failed'].includes(s.status.state)).length;

  return (
    <div className="space-y-4" data-testid="health-view">
      <div className="flex items-center"><p className="text-xs text-ink-muted flex-1">Refreshes every 30 seconds.</p>
        <button className="btn-ghost !p-2" onClick={() => void load()} aria-label="Refresh health"><RefreshCw className="w-4 h-4" strokeWidth={1.75} /></button></div>

      <div className="grid sm:grid-cols-3 gap-3">
        <Tile label="Open alerts" value={alerts.error ? '?' : String(open.length)} sub={alerts.error ? 'unavailable' : `${bySeverity('critical')} critical, ${bySeverity('warning')} warning`} bad={bySeverity('critical') > 0} />
        <Tile label="Regional gateways needing attention" value={gateways.error ? '?' : String(gwBad)} sub={gateways.error ? 'administrators only' : `of ${gateways.data?.length ?? 0}`} bad={gwBad > 0} />
        <Tile label="Department systems needing attention" value={systems.error ? '?' : String(vmsBad)} sub={systems.error ? 'not available to you' : `of ${systems.data?.length ?? 0}`} bad={vmsBad > 0} />
      </div>

      <section className="card p-5 space-y-3" data-testid="ai-analysis-health">
        <h3 className="text-sm font-bold text-ink">AI analysis and the camera grid</h3>
        {grid.error ? <p className="text-xs text-ink-muted">{grid.error}</p> : !grid.data ? <p className="text-xs text-ink-muted">Loading...</p> : (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className={`badge ${grid.data.blocked ? 'badge-critical' : 'badge-success'} !text-[10px]`}>{grid.data.blocked ? 'grid refusing the account' : 'grid account ok'}</span>
            <span className="text-ink">{grid.data.blocked
              ? `Analysis is paused and resumes by itself in about ${Math.ceil(grid.data.retryAfterSec / 60)} min. Reason given: ${grid.data.message || 'viewing-time limit'}.`
              : `${grid.data.grabsLastMinute} of ${grid.data.limitPerMinute} grabs allowed per minute in use, ${grid.data.grabsLastHour} in the last hour.`}</span>
            {grid.data.refusals > 0 && <span className="text-ink-muted">Refused {grid.data.refusals} time{grid.data.refusals === 1 ? '' : 's'}{grid.data.lastRefusalAt ? `, last ${ago(grid.data.lastRefusalAt)}` : ''}.</span>}
          </div>
        )}
        <CameraAnalysisTable cameras={cameras} />
      </section>

      <section className="card p-5 space-y-2">
        <h3 className="text-sm font-bold text-ink">Regional gateways</h3>
        {gateways.error ? <p className="text-xs text-ink-muted">{gateways.error}</p> : !loaded ? <p className="text-xs text-ink-muted">Loading...</p> : (gateways.data ?? []).length === 0 ? <p className="text-xs text-ink-muted">No gateways are set up.</p> : (
          <table className="w-full text-xs"><thead><tr className="text-left text-ink-muted uppercase tracking-wider text-[10px]"><th className="py-2 pr-3">Gateway</th><th className="pr-3">Region</th><th className="pr-3">State</th><th className="pr-3">Last heard</th><th className="pr-3">Cameras</th><th>Problems</th></tr></thead>
            <tbody className="divide-y divide-border">{(gateways.data ?? []).map((g) => (
              <tr key={g.id}><td className="py-2 pr-3 font-semibold text-ink">{g.name}</td><td className="pr-3">{g.region}</td><td className="pr-3"><span className={`badge ${stateClass(g.state)} !text-[10px]`}>{g.state}</span></td>
                <td className="pr-3 text-ink-muted">{ago(g.lastHeartbeatAt)}</td><td className="pr-3">{g.assignedCameras ?? '-'}</td><td className="text-ink-muted">{g.problems.join('; ') || '-'}</td></tr>
            ))}</tbody></table>
        )}
      </section>

      <section className="card p-5 space-y-2">
        <h3 className="text-sm font-bold text-ink">Department video systems</h3>
        {systems.error ? <p className="text-xs text-ink-muted">{systems.error}</p> : !loaded ? <p className="text-xs text-ink-muted">Loading...</p> : (systems.data ?? []).length === 0 ? <p className="text-xs text-ink-muted">No department systems are connected.</p> : (
          <table className="w-full text-xs"><thead><tr className="text-left text-ink-muted uppercase tracking-wider text-[10px]"><th className="py-2 pr-3">System</th><th className="pr-3">Department</th><th className="pr-3">State</th><th className="pr-3">Last good contact</th><th className="pr-3">Cameras</th><th className="pr-3">Events</th><th>Last error</th></tr></thead>
            <tbody className="divide-y divide-border">{(systems.data ?? []).map((s) => (
              <tr key={s.id}><td className="py-2 pr-3 font-semibold text-ink">{s.label ?? s.id}<span className="block text-[10px] text-ink-muted font-normal">{s.kind}</span></td><td className="pr-3">{s.department ?? '-'}</td>
                <td className="pr-3"><span className={`badge ${stateClass(s.status?.state ?? 'unknown')} !text-[10px]`}>{s.status?.state ?? 'not started'}</span></td>
                <td className="pr-3 text-ink-muted">{ago(s.status?.lastOkAt)}</td><td className="pr-3">{s.status?.cameras ?? '-'}</td><td className="pr-3">{s.status?.eventsForwarded ?? '-'}</td><td className="text-ink-muted">{s.status?.lastError ?? '-'}</td></tr>
            ))}</tbody></table>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, sub, bad }: { label: string; value: string; sub: string; bad: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-[10px] uppercase tracking-wider text-ink-muted font-semibold">{label}</p>
      <p className={`text-3xl font-bold font-display mt-1 ${bad ? 'text-critical' : 'text-ink'}`}>{value}</p>
      <p className="text-[11px] text-ink-muted">{sub}</p>
    </div>
  );
}

const ANALYSIS_BADGE: Record<AnalysisState, string> = { ok: 'badge-success', waiting: 'badge-neutral', paused: 'badge-warning', failing: 'badge-critical', off: 'badge-neutral' };
const ANALYSIS_ORDER: Record<AnalysisState, number> = { failing: 0, paused: 1, waiting: 2, ok: 3, off: 4 };

/** Every camera that is, or was, analysed: when it was last analysed and, if not working, why. Read from the camera records the worker updates. */
function CameraAnalysisTable({ cameras }: { cameras: CameraConfig[] }) {
  const rows = cameras
    .filter((c) => c.serverAnalysis || c.lastAnalysisTime || c.lastAnalysisError)
    .map((c) => ({ camera: c, s: summariseAnalysis({ lastAnalysisTime: c.lastAnalysisTime, lastAnalysisError: c.lastAnalysisError, selected: !!c.serverAnalysis }) }))
    .sort((a, b) => ANALYSIS_ORDER[a.s.state] - ANALYSIS_ORDER[b.s.state] || a.camera.name.localeCompare(b.camera.name));
  if (rows.length === 0) return <p className="text-xs text-ink-muted">No camera has been analysed yet. Tick cameras in the Feed and press Analyze.</p>;
  const count = (st: AnalysisState) => rows.filter((r) => r.s.state === st).length;
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-muted">{count('ok')} working, {count('waiting')} waiting for a first analysis, {count('paused')} paused, {count('failing')} not working.</p>
      <table className="w-full text-xs"><thead><tr className="text-left text-ink-muted uppercase tracking-wider text-[10px]"><th className="py-2 pr-3">Camera</th><th className="pr-3">State</th><th className="pr-3">Last analysed</th><th>Detail</th></tr></thead>
        <tbody className="divide-y divide-border">{rows.map(({ camera, s }) => (
          <tr key={camera.id}><td className="py-2 pr-3 font-semibold text-ink">{camera.name}</td>
            <td className="pr-3"><span className={`badge ${ANALYSIS_BADGE[s.state]} !text-[10px]`}>{s.state === 'ok' ? 'working' : s.state === 'failing' ? 'not working' : s.state}</span></td>
            <td className="pr-3 text-ink-muted">{s.lastAt ? ago(s.lastAt.toISOString()) : 'never'}</td><td className="text-ink-muted">{s.detail ?? '-'}</td></tr>
        ))}</tbody></table>
    </div>
  );
}
