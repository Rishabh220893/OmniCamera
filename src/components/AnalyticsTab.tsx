import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area
} from 'recharts';
import { ArrowLeft, Download, Users, Truck, Search, Navigation } from 'lucide-react';
import { cn } from '../lib/utils';
import { LogEntry, TabId } from '../types';

interface AnalyticsTabProps {
  logs: LogEntry[];
  onChangeTab: (tab: TabId) => void;
  onExport: () => void;
  onShowRoute: (plate: string) => void;
  activeRoutePlate: string | null;
}

export default function AnalyticsTab({ logs, onChangeTab, onExport, onShowRoute, activeRoutePlate }: AnalyticsTabProps) {
  const [plateQuery, setPlateQuery] = useState('');

  const statsData = [...logs].reverse().map(log => ({
    time: log.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    people: log.counts.people,
    vehicles: log.counts.vehicles,
  })).slice(-20);

  const plateMatches = useMemo(() => {
    const q = plateQuery.trim().toUpperCase();
    if (!q) return [];
    return logs
      .filter(l => l.detectedPlates?.some(p => p.toUpperCase().includes(q)))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }, [logs, plateQuery]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
      key="analytics" className="space-y-8"
    >
      <div className="grid xl:grid-cols-2 gap-6">
        <section className="card p-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-base font-bold text-ink">Crowd density</h3>
              <p className="text-xs text-ink-muted">Headcount trend across the session</p>
            </div>
            <Users className="w-5 h-5 text-accent" strokeWidth={1.75} />
          </div>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={statsData}>
                <defs>
                  <linearGradient id="colorPeople" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2f5fdd" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#2f5fdd" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e7eb" vertical={false} />
                <XAxis dataKey="time" stroke="#5c6572" fontSize={9} tickLine={false} axisLine={false} />
                <YAxis stroke="#5c6572" fontSize={9} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e4e7eb', borderRadius: '12px' }} itemStyle={{ fontSize: 12, fontWeight: 600 }} labelStyle={{ fontSize: 10, color: '#5c6572' }} />
                <Area type="stepAfter" dataKey="people" stroke="#2f5fdd" fillOpacity={1} fill="url(#colorPeople)" strokeWidth={2.5} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card p-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="text-base font-bold text-ink">Traffic volume</h3>
              <p className="text-xs text-ink-muted">Vehicle identification history</p>
            </div>
            <Truck className="w-5 h-5 text-success" strokeWidth={1.75} />
          </div>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={statsData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e7eb" vertical={false} />
                <XAxis dataKey="time" stroke="#5c6572" fontSize={9} tickLine={false} axisLine={false} />
                <YAxis stroke="#5c6572" fontSize={9} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e4e7eb', borderRadius: '12px' }} itemStyle={{ fontSize: 12, fontWeight: 600 }} />
                <Line type="monotone" dataKey="vehicles" stroke="#1f8a5f" strokeWidth={3} dot={{ r: 4, fill: '#1f8a5f', strokeWidth: 0 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="card p-8">
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent">
              <Search className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <div>
              <h3 className="text-base font-bold text-ink">Vehicle search</h3>
              <p className="text-xs text-ink-muted">Look up a plate and trace its route across cameras</p>
            </div>
          </div>
          <div className="relative w-full sm:w-64">
            <input
              value={plateQuery}
              onChange={(e) => setPlateQuery(e.target.value)}
              placeholder="Search a plate, e.g. GJ01AB1234"
              className="input !py-2.5 text-sm font-mono uppercase"
            />
          </div>
        </div>

        {plateQuery.trim() && (
          plateMatches.length === 0 ? (
            <p className="text-xs text-ink-muted py-6 text-center">No sightings found for "{plateQuery}".</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-ink-muted">{plateMatches.length} sighting{plateMatches.length !== 1 ? 's' : ''} found</p>
                {activeRoutePlate === plateQuery.trim().toUpperCase() ? (
                  <span className="badge badge-accent">Route shown on Map</span>
                ) : (
                  <button onClick={() => onShowRoute(plateQuery.trim().toUpperCase())} className="btn-secondary !py-1.5 !px-3 text-xs">
                    <Navigation className="w-3.5 h-3.5" strokeWidth={1.75} /> Show route on map
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {plateMatches.map(log => (
                  <div key={log.id} className="panel p-3.5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-mono text-ink-muted">{log.timestamp.toLocaleString()}</span>
                      <span className="text-xs font-bold text-ink">{log.cameraName}</span>
                    </div>
                    {log.isWatchlistMatch && <span className="badge badge-critical">Watchlist hit</span>}
                  </div>
                ))}
              </div>
            </div>
          )
        )}
      </section>

      <div className="card overflow-hidden">
        <div className="p-6 border-b border-border flex flex-wrap items-center justify-between bg-surface-muted gap-4">
          <div className="flex items-center gap-3">
            <button onClick={() => onChangeTab('monitor')} className="btn-secondary !p-2.5 !rounded-xl">
              <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <h3 className="font-bold text-ink text-sm">Archive registry</h3>
          </div>
          <button onClick={onExport} className="btn-secondary !py-2 text-xs">
            <Download className="w-3.5 h-3.5" strokeWidth={1.75} /> Export logs
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Timeline</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Summary</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Units</th>
                <th className="px-8 py-4 text-[10px] font-bold uppercase tracking-widest text-ink-muted text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-surface-muted transition-colors">
                  <td className="px-8 py-5 text-xs font-mono text-ink-muted">{log.timestamp.toLocaleTimeString()}</td>
                  <td className="px-8 py-5">
                    <p className="text-sm text-ink">{log.summary}</p>
                    {log.alerts.length > 0 && <span className="text-[10px] text-critical font-semibold mt-1 block">{log.alerts.join(', ')}</span>}
                  </td>
                  <td className="px-8 py-5">
                    <div className="flex gap-3">
                      <div className="flex items-center gap-1.5 px-2 py-1 bg-accent-soft rounded-lg">
                        <Users className="w-3 h-3 text-accent" strokeWidth={1.75} />
                        <span className="text-[11px] font-bold text-accent">{log.counts.people}</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-2 py-1 bg-success-soft rounded-lg">
                        <Truck className="w-3 h-3 text-success" strokeWidth={1.75} />
                        <span className="text-[11px] font-bold text-success">{log.counts.vehicles}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-5 text-right">
                    <span className={cn('badge', log.isWatchlistMatch ? 'badge-critical' : log.isUnusual ? 'badge-warning' : 'badge-success')}>
                      {log.isWatchlistMatch ? 'Watchlist hit' : log.isUnusual ? 'Suspicious' : 'Clean'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </motion.div>
  );
}
