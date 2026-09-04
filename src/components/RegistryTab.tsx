import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Search, Upload, Download, Plus, Trash2, MapPin, Building2, ShieldAlert,
  AlertTriangle, Clock3, History, ChevronRight, Wrench, LayoutGrid
} from 'lucide-react';
import { cn } from '../lib/utils';
import { CameraConfig, RoutePoint, RegistryAuditEntry } from '../types';
import { GapAnalysisReport } from '../lib/registryReport';
import MapTab from './MapTab';

interface RegistryTabProps {
  cameras: CameraConfig[];
  activeCameraId: string;
  onSelectCamera: (id: string) => void;
  routePlate: string | null;
  routePoints: RoutePoint[];
  onClearRoute: () => void;
  isAdmin: boolean;
  onAddCamera: () => void;
  onRemoveCamera: (id: string) => void;
  onCsvUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onExportCsv: () => void;
  onLoadDemoGrid: () => void;
  gapReport: GapAnalysisReport;
  auditTrail: RegistryAuditEntry[];
}

const STATUS_BADGE: Record<string, string> = {
  online: 'badge-success', offline: 'badge-critical', degraded: 'badge-warning', unknown: 'badge-neutral',
};
const MAINTENANCE_BADGE: Record<string, string> = {
  operational: 'badge-success', needs_maintenance: 'badge-warning', decommissioned: 'badge-critical',
};

export default function RegistryTab({
  cameras, activeCameraId, onSelectCamera, routePlate, routePoints, onClearRoute,
  isAdmin, onAddCamera, onRemoveCamera, onCsvUpload, onExportCsv, onLoadDemoGrid, gapReport, auditTrail
}: RegistryTabProps) {
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [showReport, setShowReport] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [page, setPage] = useState(0);

  const departments = useMemo(() => Array.from(new Set(cameras.map(c => c.department).filter(Boolean))) as string[], [cameras]);
  const types = useMemo(() => Array.from(new Set(cameras.map(c => c.cameraType).filter(Boolean))) as string[], [cameras]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cameras.filter(c => {
      if (q && !`${c.name} ${c.department || ''} ${c.ownership || ''}`.toLowerCase().includes(q)) return false;
      if (departmentFilter !== 'all' && (c.department || '') !== departmentFilter) return false;
      if (statusFilter !== 'all' && (c.connectivityStatus || 'unknown') !== statusFilter) return false;
      if (typeFilter !== 'all' && (c.cameraType || '') !== typeFilter) return false;
      return true;
    });
  }, [cameras, search, departmentFilter, statusFilter, typeFilter]);

  // A table rendering every row of an 80,000-camera registry is its own
  // kind of hiccup, independent of anything video-related — search/filter
  // narrows the set, this bounds how much of it hits the DOM at once.
  const PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const pagedFiltered = useMemo(
    () => filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE),
    [filtered, clampedPage]
  );
  const resetToFirstPage = () => setPage(0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      key="registry" className="space-y-6"
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-ink">Registry</h2>
          <p className="text-sm text-ink-muted">The single source of truth for every camera you manage — location, ownership, status, and maintenance in one place.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <>
              <button onClick={onLoadDemoGrid} className="btn-secondary !py-2 text-xs" title="Add every camera from the Corp8 demo grid that isn't already registered">
                <LayoutGrid className="w-3.5 h-3.5" strokeWidth={1.75} /> Load demo grid
              </button>
              <div className="relative">
                <input type="file" id="registry-csv-upload" className="hidden" accept=".csv" onChange={onCsvUpload} />
                <label htmlFor="registry-csv-upload" className="btn-secondary !py-2 text-xs cursor-pointer">
                  <Upload className="w-3.5 h-3.5" strokeWidth={1.75} /> Bulk import CSV
                </label>
              </div>
            </>
          )}
          <button onClick={onExportCsv} className="btn-secondary !py-2 text-xs"><Download className="w-3.5 h-3.5" strokeWidth={1.75} /> Export CSV</button>
          <button onClick={onAddCamera} className="btn-primary !py-2 text-xs"><Plus className="w-3.5 h-3.5" strokeWidth={1.75} /> Add camera</button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-4 h-4 text-ink-muted absolute left-3.5 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
          <input value={search} onChange={e => { setSearch(e.target.value); resetToFirstPage(); }} placeholder="Search name, department, ownership..." className="input !pl-10 !py-2.5 text-sm" />
        </div>
        <select value={departmentFilter} onChange={e => { setDepartmentFilter(e.target.value); resetToFirstPage(); }} className="input !py-2.5 !w-auto text-sm">
          <option value="all">All departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); resetToFirstPage(); }} className="input !py-2.5 !w-auto text-sm">
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="degraded">Degraded</option>
          <option value="unknown">Unknown</option>
        </select>
        <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); resetToFirstPage(); }} className="input !py-2.5 !w-auto text-sm">
          <option value="all">All types</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {/* GIS map */}
      <MapTab
        cameras={filtered} activeCameraId={activeCameraId} onSelectCamera={onSelectCamera}
        routePlate={routePlate} routePoints={routePoints} onClearRoute={onClearRoute}
      />

      {/* Registry table */}
      <div className="card overflow-hidden">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-bold text-ink">Camera list</h3>
          <span className="text-xs text-ink-muted">{filtered.length} of {cameras.length} camera{cameras.length !== 1 ? 's' : ''}</span>
        </div>
        {/* A wide multi-column table has nowhere good to go on a phone —
            even with horizontal scroll, only ~2 columns show at once and
            there's no visible affordance that more exist off-screen. Below
            md this becomes a stacked card list instead (a standard
            "table becomes cards" responsive pattern), each one showing the
            same fields in a layout that actually fits a narrow screen. */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Name</th>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Department</th>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Ownership</th>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Type</th>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted" title="Declared in the registry record — set manually or by bulk import, not measured live. See the Feed tab for real-time connection status.">Registry status</th>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Maintenance</th>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted">Installed</th>
                <th className="px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-ink-muted text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pagedFiltered.map(c => (
                <tr key={c.id} className={cn('hover:bg-surface-muted transition-colors', c.id === activeCameraId && 'bg-accent-soft')}>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{c.name}</span>
                      {!c.location && <span title="Not located on the map"><MapPin className="w-3.5 h-3.5 text-ink-muted" strokeWidth={1.75} /></span>}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-xs text-ink-muted">{c.department || '—'}</td>
                  <td className="px-6 py-4 text-xs text-ink-muted">{c.ownership || '—'}</td>
                  <td className="px-6 py-4 text-xs text-ink-muted capitalize">{c.cameraType || '—'}</td>
                  <td className="px-6 py-4"><span className={cn('badge', STATUS_BADGE[c.connectivityStatus || 'unknown'])}>{c.connectivityStatus || 'unknown'}</span></td>
                  <td className="px-6 py-4"><span className={cn('badge', MAINTENANCE_BADGE[c.maintenanceStatus || 'operational'])}>{(c.maintenanceStatus || 'operational').replace('_', ' ')}</span></td>
                  <td className="px-6 py-4 text-xs font-mono text-ink-muted">{c.installDate || '—'}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => onSelectCamera(c.id)} className="btn-ghost !p-1.5" title="Focus in Monitor"><ChevronRight className="w-4 h-4" strokeWidth={1.75} /></button>
                      {isAdmin && cameras.length > 1 && (
                        <button onClick={() => onRemoveCamera(c.id)} className="btn-ghost !p-1.5 hover:!text-critical" title="Delete"><Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} className="px-6 py-10 text-center text-xs text-ink-muted">No cameras match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="md:hidden divide-y divide-border">
          {pagedFiltered.map(c => (
            <div
              key={c.id}
              onClick={() => onSelectCamera(c.id)}
              className={cn('p-4 flex flex-col gap-2.5 cursor-pointer', c.id === activeCameraId && 'bg-accent-soft')}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-semibold text-ink truncate">{c.name}</span>
                  {!c.location && <span title="Not located on the map" className="shrink-0"><MapPin className="w-3.5 h-3.5 text-ink-muted" strokeWidth={1.75} /></span>}
                </div>
                {isAdmin && cameras.length > 1 && (
                  <button onClick={(e) => { e.stopPropagation(); onRemoveCamera(c.id); }} className="btn-ghost !p-1.5 hover:!text-critical shrink-0" title="Delete">
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={cn('badge', STATUS_BADGE[c.connectivityStatus || 'unknown'])}>{c.connectivityStatus || 'unknown'}</span>
                <span className={cn('badge', MAINTENANCE_BADGE[c.maintenanceStatus || 'operational'])}>{(c.maintenanceStatus || 'operational').replace('_', ' ')}</span>
              </div>
              <p className="text-xs text-ink-muted truncate">
                {[c.department, c.ownership, c.cameraType].filter(Boolean).join(' · ') || 'No department, ownership, or type set'}
              </p>
              {c.installDate && <p className="text-[10px] font-mono text-ink-muted">Installed {c.installDate}</p>}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="px-6 py-10 text-center text-xs text-ink-muted">No cameras match these filters.</p>
          )}
        </div>
        {filtered.length > PAGE_SIZE && (
          <div className="px-6 py-4 border-t border-border flex items-center justify-between text-xs">
            <span className="text-ink-muted">
              Showing {clampedPage * PAGE_SIZE + 1}–{Math.min((clampedPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(Math.max(0, clampedPage - 1))}
                disabled={clampedPage === 0}
                className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-ink-muted font-medium">Page {clampedPage + 1} of {totalPages}</span>
              <button
                onClick={() => setPage(Math.min(totalPages - 1, clampedPage + 1))}
                disabled={clampedPage >= totalPages - 1}
                className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Gap analysis */}
      <div className="card p-6">
        <button onClick={() => setShowReport(v => !v)} className="w-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-warning-soft flex items-center justify-center text-warning">
              <AlertTriangle className="w-5 h-5" strokeWidth={1.75} />
            </div>
            <div className="text-left">
              <h3 className="text-sm font-bold text-ink">Gap analysis report</h3>
              <p className="text-xs text-ink-muted">Coverage gaps and ageing infrastructure, generated {gapReport.generatedAt.toLocaleTimeString()}</p>
            </div>
          </div>
          <ChevronRight className={cn('w-4 h-4 text-ink-muted transition-transform', showReport && 'rotate-90')} strokeWidth={1.75} />
        </button>

        {showReport && (
          <div className="mt-6 space-y-6">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { label: 'Unlocated cameras', icon: MapPin, count: gapReport.unlocated.length, items: gapReport.unlocated },
                { label: 'Offline / degraded', icon: ShieldAlert, count: gapReport.offlineOrDegraded.length, items: gapReport.offlineOrDegraded },
                { label: 'Ageing infrastructure', icon: Wrench, count: gapReport.ageing.length, items: gapReport.ageing },
                { label: 'Stale (no recent analysis)', icon: Clock3, count: gapReport.stale.length, items: gapReport.stale },
              ].map(card => (
                <div key={card.label} className="panel p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <card.icon className="w-4 h-4 text-warning" strokeWidth={1.75} />
                    <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wide">{card.label}</span>
                  </div>
                  <p className="text-2xl font-bold text-ink mb-2">{card.count}</p>
                  {card.items.length > 0 && (
                    <ul className="space-y-0.5 max-h-24 overflow-y-auto custom-scrollbar">
                      {card.items.slice(0, 6).map(c => <li key={c.id} className="text-[11px] text-ink-muted truncate">{c.name}</li>)}
                      {card.items.length > 6 && <li className="text-[11px] text-ink-muted italic">+{card.items.length - 6} more</li>}
                    </ul>
                  )}
                </div>
              ))}
            </div>

            <div>
              <h4 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest mb-2">Coverage by department (lowest first)</h4>
              <div className="space-y-1.5">
                {gapReport.departmentCoverage.map(d => (
                  <div key={d.department} className="flex items-center gap-3 text-xs">
                    <Building2 className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={1.75} />
                    <span className="text-ink-muted w-32 truncate">{d.department}</span>
                    <div className="flex-1 h-1.5 bg-surface-muted rounded-full overflow-hidden">
                      <div className="h-full bg-accent rounded-full" style={{ width: `${Math.min(100, (d.count / Math.max(...gapReport.departmentCoverage.map(x => x.count), 1)) * 100)}%` }} />
                    </div>
                    <span className="font-mono font-semibold text-ink w-6 text-right">{d.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Audit trail */}
      {isAdmin && (
        <div className="card p-6">
          <button onClick={() => setShowAudit(v => !v)} className="w-full flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent-soft flex items-center justify-center text-accent">
                <History className="w-5 h-5" strokeWidth={1.75} />
              </div>
              <div className="text-left">
                <h3 className="text-sm font-bold text-ink">Registry audit trail</h3>
                <p className="text-xs text-ink-muted">Every create, update, and delete on this registry, admin-only</p>
              </div>
            </div>
            <ChevronRight className={cn('w-4 h-4 text-ink-muted transition-transform', showAudit && 'rotate-90')} strokeWidth={1.75} />
          </button>

          {showAudit && (
            <div className="mt-5 space-y-1.5 max-h-80 overflow-y-auto custom-scrollbar">
              {auditTrail.length === 0 ? (
                <p className="text-xs text-ink-muted text-center py-6">No registry changes recorded yet.</p>
              ) : (
                auditTrail.map(entry => (
                  <div key={entry.id} className="panel p-3 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={cn('badge shrink-0', entry.action === 'create' ? 'badge-success' : entry.action === 'delete' ? 'badge-critical' : 'badge-accent')}>{entry.action}</span>
                      <span className="font-semibold text-ink truncate">{entry.cameraName}</span>
                      <span className="text-ink-muted shrink-0">via {entry.source.replace('_', ' ')}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-ink-muted">
                      <span className="truncate max-w-[140px]">{entry.performedBy}</span>
                      <span className="font-mono">{entry.timestamp.toLocaleString()}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
