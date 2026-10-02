import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area
} from 'recharts';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Users, Truck } from 'lucide-react';
import { cn, sentimentEmoji } from '../lib/utils';
import { LogEntry, RoutePoint, TabId } from '../types';
import { PlateSighting } from '../lib/plateTracking';
import VehicleTracker from './VehicleTracker';

const ROWS_PER_PAGE = 25;

interface AnalyticsTabProps {
  logs: LogEntry[];
  onChangeTab: (tab: TabId) => void;
  onExport: () => void;
  onShowRoute: (plate: string, points: RoutePoint[]) => void;
  activeRoutePlate: string | null;
  userId: string | null;
  decidedBy: string;
  localSightings: PlateSighting[];
  /** Set when a chart point elsewhere was clicked — jumps to and briefly
   *  highlights that specific reading instead of leaving the chart and this
   *  table as two disconnected views of the same data. */
  highlightLogId?: string | null;
  onHighlightHandled?: () => void;
}

export default function AnalyticsTab({ logs, onChangeTab, onExport, onShowRoute, activeRoutePlate, userId, decidedBy, localSightings, highlightLogId, onHighlightHandled }: AnalyticsTabProps) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(logs.length / ROWS_PER_PAGE));
  // Clamp rather than reset to 0 — new entries stream into page 1 (index 0)
  // continuously during active capture, and forcing the viewer back there
  // on every new row would make browsing older pages impossible.
  const safePage = Math.min(page, totalPages - 1);
  const pageLogs = logs.slice(safePage * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE + ROWS_PER_PAGE);

  useEffect(() => {
    if (!highlightLogId) return;
    const idx = logs.findIndex(l => l.id === highlightLogId);
    if (idx === -1) return;
    setPage(Math.floor(idx / ROWS_PER_PAGE));
    const scrollTimer = setTimeout(() => {
      document.getElementById(`log-row-${highlightLogId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    const clearTimer = setTimeout(() => onHighlightHandled?.(), 3000);
    return () => { clearTimeout(scrollTimer); clearTimeout(clearTimer); };
  }, [highlightLogId, logs, onHighlightHandled]);

  const statsData = [...logs].reverse().map(log => ({
    time: log.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    people: log.counts.people,
    vehicles: log.counts.vehicles,
  })).slice(-20);


  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
      key="analytics" className="space-y-8"
    >
      <div className="space-y-1">
        <h2 className="text-xl font-bold font-display text-ink">Logs</h2>
        <p className="text-sm text-ink-muted">Analytics, plate search, and the full event archive.</p>
      </div>

      <div className="grid xl:grid-cols-2 gap-6">
        <section className="card p-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-base font-bold font-display text-ink">Crowd density</h3>
              <p className="text-xs text-ink-muted">Headcount trend across the session</p>
            </div>
            <Users className="w-5 h-5 text-accent" strokeWidth={1.75} />
          </div>
          <div className="h-[300px]">
            {statsData.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-ink-muted gap-2 panel border-dashed">
                <Users className="w-8 h-8 text-ink-muted/40" strokeWidth={1.5} />
                <p className="text-xs font-semibold text-ink">No headcount data collected yet</p>
                <p className="text-[10px] text-ink-muted">Active camera observations will populate the density timeline</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={statsData}>
                  <defs>
                    <linearGradient id="colorPeople" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="time" stroke="var(--color-ink-muted)" fontSize={9} tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--color-ink-muted)" fontSize={9} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '12px', color: 'var(--color-ink)' }} itemStyle={{ fontSize: 12, fontWeight: 600, color: 'var(--color-ink)' }} labelStyle={{ fontSize: 10, color: 'var(--color-ink-muted)' }} />
                  <Area type="stepAfter" dataKey="people" stroke="var(--color-accent)" fillOpacity={1} fill="url(#colorPeople)" strokeWidth={2.5} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        <section className="card p-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-base font-bold font-display text-ink">Traffic volume</h3>
              <p className="text-xs text-ink-muted">Vehicle identification history</p>
            </div>
            <Truck className="w-5 h-5 text-success" strokeWidth={1.75} />
          </div>
          <div className="h-[300px]">
            {statsData.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-ink-muted gap-2 panel border-dashed">
                <Truck className="w-8 h-8 text-ink-muted/40" strokeWidth={1.5} />
                <p className="text-xs font-semibold text-ink">No vehicle records logged yet</p>
                <p className="text-[10px] text-ink-muted">Vehicle counts from camera scans will appear in this volume chart</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={statsData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="time" stroke="var(--color-ink-muted)" fontSize={9} tickLine={false} axisLine={false} />
                  <YAxis stroke="var(--color-ink-muted)" fontSize={9} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: '12px', color: 'var(--color-ink)' }} itemStyle={{ fontSize: 12, fontWeight: 600, color: 'var(--color-ink)' }} labelStyle={{ fontSize: 10, color: 'var(--color-ink-muted)' }} />
                  <Line type="monotone" dataKey="vehicles" stroke="var(--color-success)" strokeWidth={3} dot={{ r: 4, fill: 'var(--color-success)', strokeWidth: 0 }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      <VehicleTracker userId={userId} decidedBy={decidedBy} localSightings={localSightings} activeRoutePlate={activeRoutePlate} onShowRoute={onShowRoute} />

      <div className="card overflow-hidden">
        <div className="p-6 border-b border-border flex flex-wrap items-center justify-between bg-surface-muted gap-4">
          <div className="flex items-center gap-3">
            <button onClick={() => onChangeTab('monitor')} className="btn-secondary !p-2.5 !rounded-xl" title="Back to monitor">
              <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <h3 className="font-bold font-display text-ink text-sm">Archive registry</h3>
          </div>
          <button onClick={onExport} className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap">
            <Download className="w-3.5 h-3.5" strokeWidth={1.75} /> Export logs
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted whitespace-nowrap">Camera</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted whitespace-nowrap">Timestamp</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Summary</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted text-center whitespace-nowrap">Sentiment</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted text-right whitespace-nowrap">Vehicles</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted text-right whitespace-nowrap">People</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pageLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-8 py-12 text-center text-ink-muted">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Clock className="w-6 h-6 text-ink-muted/60" strokeWidth={1.5} />
                      <p className="text-sm font-semibold text-ink">No archive logs recorded</p>
                      <p className="text-xs text-ink-muted max-w-sm">Event snapshots, plate scans, and crowd detections will appear here automatically.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                pageLogs.map((log) => (
                  <tr
                    key={log.id} id={`log-row-${log.id}`}
                    className={cn(
                      'hover:bg-surface-muted transition-colors',
                      log.isWatchlistMatch && 'bg-critical-soft/40',
                      log.id === highlightLogId && 'bg-accent-soft ring-2 ring-inset ring-accent'
                    )}
                  >
                    <td className="px-8 py-5 text-xs font-bold text-ink whitespace-nowrap">{log.cameraName}</td>
                    <td className="px-8 py-5 text-xs font-mono text-ink-muted whitespace-nowrap">{log.timestamp.toLocaleString()}</td>
                    <td className="px-8 py-5 min-w-[280px]">
                      <p className="text-sm text-ink">{log.summary}</p>
                      {log.alerts.length > 0 && <span className="text-[10px] text-critical font-semibold mt-1 block">{log.alerts.join(', ')}</span>}
                    </td>
                    <td className="px-8 py-5 text-center text-lg whitespace-nowrap" title={log.sentiment || 'neutral'}>{sentimentEmoji(log.sentiment)}</td>
                    <td className="px-8 py-5 text-right text-sm font-bold text-success whitespace-nowrap">{log.counts.vehicles}</td>
                    <td className="px-8 py-5 text-right text-sm font-bold text-accent whitespace-nowrap">{log.counts.people}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="p-5 border-t border-border flex items-center justify-between gap-4 flex-wrap">
          <p className="text-xs text-ink-muted whitespace-nowrap">
            {logs.length === 0 ? 'No entries yet.' : `Showing ${safePage * ROWS_PER_PAGE + 1}-${Math.min(logs.length, (safePage + 1) * ROWS_PER_PAGE)} of ${logs.length}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="btn-ghost !p-2 !rounded-lg border border-border disabled:opacity-30 disabled:cursor-not-allowed min-w-[38px] min-h-[38px] flex items-center justify-center active:scale-95"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <span className="text-xs font-semibold text-ink-muted px-1 whitespace-nowrap">Page {safePage + 1} of {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="btn-ghost !p-2 !rounded-lg border border-border disabled:opacity-30 disabled:cursor-not-allowed min-w-[38px] min-h-[38px] flex items-center justify-center active:scale-95"
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
