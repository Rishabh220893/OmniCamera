import { MutableRefObject } from 'react';
import { motion } from 'motion/react';
import {
  Settings2, Maximize2, Minimize2, SwitchCamera, RefreshCw, Clock, Activity,
  AlertTriangle, Users, Truck, Bell, ShieldCheck, ChevronRight, LayoutGrid, Rows3
} from 'lucide-react';
import { cn } from '../lib/utils';
import { CameraConfig, LogEntry, CameraMediaRefs, TabId } from '../types';
import CameraFeed from './CameraFeed';

interface MonitorTabProps {
  cameras: CameraConfig[];
  activeCameraId: string;
  onSelectCamera: (id: string) => void;
  onAddCamera: () => void;
  isCapturing: boolean;
  isAnalyzing: boolean;
  cameraError: string | null;
  analysisError: string | null;
  logs: LogEntry[];
  viewMode: 'focus' | 'grid';
  onChangeViewMode: (mode: 'focus' | 'grid') => void;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleCameraFacing: () => void;
  mediaRefs: MutableRefObject<CameraMediaRefs>;
  onCameraError: (msg: string | null) => void;
  onFallbackToSimulated: () => void;
  onChangeTab: (tab: TabId) => void;
  streamAccessPassword: string;
}

function formatLastAnalysisTime(lat: unknown): string {
  if (!lat) return '';
  let d: Date;
  if (lat instanceof Date) d = lat;
  else if (typeof lat === 'object' && lat !== null && 'seconds' in lat) d = new Date((lat as { seconds: number }).seconds * 1000);
  else d = new Date(lat as string | number);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

export default function MonitorTab({
  cameras, activeCameraId, onSelectCamera, onAddCamera, isCapturing, isAnalyzing,
  cameraError, analysisError, logs, viewMode, onChangeViewMode, containerRef,
  isFullscreen, onToggleFullscreen, onToggleCameraFacing, mediaRefs, onCameraError,
  onFallbackToSimulated, onChangeTab, streamAccessPassword
}: MonitorTabProps) {
  const activeCamera = cameras.find(c => c.id === activeCameraId) || cameras[0];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      key="monitor" className="grid xl:grid-cols-4 gap-8"
    >
      <div className="xl:col-span-3 space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 custom-scrollbar lg:hidden">
            {cameras.map(cam => (
              <button
                key={cam.id}
                onClick={() => onSelectCamera(cam.id)}
                className={cn('px-3.5 py-2 rounded-lg text-[10px] font-bold uppercase whitespace-nowrap border', activeCameraId === cam.id ? 'bg-accent border-accent text-white' : 'bg-surface border-border text-ink-muted')}
              >
                {cam.name}
              </button>
            ))}
            <button onClick={onAddCamera} className="btn-ghost !p-2 border border-dashed border-border !rounded-lg"><Settings2 className="w-4 h-4" strokeWidth={1.75} /></button>
          </div>
          <div className="ml-auto flex items-center gap-1 panel !p-1">
            <button onClick={() => onChangeViewMode('focus')} className={cn('btn-ghost !p-2 !rounded-lg', viewMode === 'focus' && 'bg-surface !text-ink shadow-sm')} title="Focused view">
              <Rows3 className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <button onClick={() => onChangeViewMode('grid')} className={cn('btn-ghost !p-2 !rounded-lg', viewMode === 'grid' && 'bg-surface !text-ink shadow-sm')} title="Grid / video wall">
              <LayoutGrid className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {viewMode === 'grid' ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {cameras.map(cam => (
              <button
                key={cam.id}
                onClick={() => onSelectCamera(cam.id)}
                className={cn('relative aspect-video rounded-2xl overflow-hidden border text-left', cam.id === activeCameraId ? 'border-accent ring-2 ring-accent/30' : 'border-border')}
              >
                <CameraFeed
                  camera={cam}
                  isFocused={false}
                  isCapturing={isCapturing}
                  reportRefs={cam.id === activeCameraId}
                  mediaRefs={mediaRefs}
                  onCameraError={cam.id === activeCameraId ? onCameraError : undefined}
                  onFallbackToSimulated={cam.id === activeCameraId ? onFallbackToSimulated : undefined}
                  streamAccessPassword={streamAccessPassword}
                />
                <div className="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black/70 to-transparent">
                  <span className="text-[10px] font-bold text-white uppercase tracking-wide">{cam.name}</span>
                </div>
                {isCapturing && cam.id === activeCameraId && (
                  <span className="absolute top-2.5 right-2.5 w-2 h-2 rounded-full bg-success animate-pulse" />
                )}
              </button>
            ))}
          </div>
        ) : (
          <div
            ref={containerRef}
            className={cn(
              'relative rounded-[2rem] overflow-hidden bg-surface-muted border border-border group transition-all duration-300',
              isFullscreen ? 'rounded-none border-none h-screen w-screen' : 'aspect-video'
            )}
          >
              <CameraFeed
                camera={activeCamera}
                isFocused
                isCapturing={isCapturing}
                reportRefs
                mediaRefs={mediaRefs}
                onCameraError={onCameraError}
                onFallbackToSimulated={onFallbackToSimulated}
                streamAccessPassword={streamAccessPassword}
              />

              {cameraError && (
                <div className="absolute inset-0 z-50 bg-surface/95 backdrop-blur-sm flex flex-col items-center justify-center p-10 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-critical-soft flex items-center justify-center mb-5">
                    <AlertTriangle className="w-8 h-8 text-critical" strokeWidth={1.75} />
                  </div>
                  <h3 className="text-lg font-bold text-ink mb-2">Camera access error</h3>
                  <p className="text-critical text-sm max-w-md mb-6">{cameraError}</p>
                </div>
              )}

              <div className="absolute inset-0 pointer-events-none">
                {isCapturing && <div className="absolute inset-x-0 top-0 h-px bg-accent/40" />}

                <div className="absolute top-6 left-6 flex flex-col gap-2 pointer-events-auto">
                  <div className="bg-black/55 backdrop-blur-md rounded-xl px-3.5 py-1.5 flex items-center gap-2.5">
                    <Activity className="w-3.5 h-3.5 text-success" strokeWidth={1.75} />
                    <span className="text-[10px] font-mono font-bold text-white uppercase">{activeCamera.name.replace(/\s+/g, '_')}</span>
                  </div>
                  {activeCamera.lastAnalysisTime && (
                    <div className="bg-black/55 backdrop-blur-md rounded-xl px-3.5 py-1.5 flex items-center gap-2.5">
                      <Clock className="w-3.5 h-3.5 text-accent" strokeWidth={1.75} />
                      <span className="text-[10px] font-mono font-bold text-white uppercase">Last sync: {formatLastAnalysisTime(activeCamera.lastAnalysisTime)}</span>
                    </div>
                  )}
                </div>

                <div className="absolute bottom-6 right-6 flex gap-3 pointer-events-auto">
                  <button onClick={onToggleFullscreen} className="w-11 h-11 flex items-center justify-center rounded-xl bg-black/55 backdrop-blur-md text-white">
                    {isFullscreen ? <Minimize2 className="w-4.5 h-4.5" strokeWidth={1.75} /> : <Maximize2 className="w-4.5 h-4.5" strokeWidth={1.75} />}
                  </button>
                  <button onClick={onToggleCameraFacing} className="w-11 h-11 flex items-center justify-center rounded-xl bg-black/55 backdrop-blur-md text-white">
                    <SwitchCamera className="w-4.5 h-4.5" strokeWidth={1.75} />
                  </button>
                </div>

                {isAnalyzing && (
                  <div className="absolute inset-x-0 bottom-0 flex flex-col items-center p-16">
                    <div className="flex items-center gap-2.5 bg-ink px-5 py-2 rounded-full">
                      <RefreshCw className="w-3.5 h-3.5 text-white animate-spin" strokeWidth={1.75} />
                      <span className="text-[10px] font-bold text-white uppercase tracking-wider">Processing stream...</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
        )}

        {analysisError && (
          <div className="card border-critical/30 p-6 space-y-2 text-xs">
            <div className="flex items-center gap-2 font-bold text-critical">
              <AlertTriangle className="w-4 h-4" strokeWidth={1.75} />
              <span className="text-sm">Frame analysis error</span>
            </div>
            <p className="text-ink-muted leading-relaxed">
              {analysisError}
            </p>
          </div>
        )}

        {/* Shown regardless of grid/focus view — previously focus-only, which meant
            Gemini's summary and live counts were invisible to anyone using the grid
            (the view every reported screenshot has actually been in). */}
        <div className="card p-7 flex flex-wrap items-center justify-between gap-6">
          <div className="flex flex-col gap-1 max-w-xl">
            <h3 className="text-xs font-bold text-ink-muted uppercase tracking-widest">Ongoing context — {activeCamera.name}</h3>
            <p className="text-base text-ink">
              {logs[0]?.summary || 'No active summary. Activate guard to begin analysis.'}
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-5">
          {[
            { label: 'Identified people', icon: Users, value: logs[0]?.counts.people || 0 },
            { label: 'Vehicles detected', icon: Truck, value: logs[0]?.counts.vehicles || 0 },
            { label: 'Anomalies (session)', icon: AlertTriangle, value: logs.filter(l => l.isUnusual).length }
          ].map((m, i) => (
            <div key={i} className="card p-5 flex items-center">
              <div className="w-12 h-12 rounded-xl bg-accent-soft flex items-center justify-center mr-4 text-accent">
                <m.icon className="w-6 h-6" strokeWidth={1.75} />
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] font-bold text-ink-muted uppercase">{m.label}</span>
                <span className="text-xl font-bold text-ink">{m.value}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-6 flex flex-col h-full">
        <div className="hidden lg:block space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Active nodes</h3>
            <button onClick={onAddCamera} className="btn-ghost !p-1.5 border border-border !rounded-lg"><Settings2 className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
          </div>
          <div className="space-y-2">
            {cameras.map(cam => (
              <button
                key={cam.id}
                onClick={() => onSelectCamera(cam.id)}
                className={cn('w-full p-3.5 rounded-2xl border text-left flex items-center gap-3', activeCameraId === cam.id ? 'bg-accent border-accent text-white' : 'bg-surface border-border')}
              >
                <div className={cn('w-1.5 h-1.5 rounded-full', isCapturing && activeCameraId === cam.id ? 'bg-white animate-pulse' : 'bg-ink-muted/40')} />
                <div className="flex flex-col">
                  <span className={cn('text-xs font-bold', activeCameraId === cam.id ? 'text-white' : 'text-ink')}>{cam.name}</span>
                  <span className={cn('text-[9px] font-medium', activeCameraId === cam.id ? 'text-white/70' : 'text-ink-muted')}>
                    {cam.useRemoteFeed ? 'RTSP / IP feed' : cam.useSimulatedFeed ? 'Simulated' : 'Local device'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 card flex flex-col overflow-hidden">
          <div className="p-6 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-widest text-ink">Alert center</h2>
            <Bell className="w-4 h-4 text-ink-muted" strokeWidth={1.75} />
          </div>
          <div className="flex-1 p-5 space-y-3 overflow-y-auto custom-scrollbar">
            {logs.filter(l => l.alerts.length > 0).length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-ink-muted px-6 text-center">
                <ShieldCheck className="w-9 h-9 mb-3 opacity-20" strokeWidth={1.5} />
                <p className="text-xs font-semibold">No critical events detected</p>
              </div>
            ) : (
              logs.map(log => log.alerts.map((alert, idx) => (
                <motion.div
                  initial={{ x: 12, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
                  key={`${log.id}-${idx}`}
                  className={cn('p-3.5 rounded-xl flex items-start gap-3', log.isWatchlistMatch ? 'bg-critical-soft' : 'bg-warning-soft')}
                >
                  <div className={cn('p-1.5 rounded-lg shrink-0', log.isWatchlistMatch ? 'bg-critical/15' : 'bg-warning/15')}>
                    <AlertTriangle className={cn('w-3.5 h-3.5', log.isWatchlistMatch ? 'text-critical' : 'text-warning')} strokeWidth={1.75} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[9px] font-mono text-ink-muted uppercase">{log.timestamp.toLocaleTimeString()}</span>
                      <span className="text-[9px] font-bold text-ink-muted">{log.cameraName}</span>
                      {log.isWatchlistMatch && <span className="badge badge-critical !py-0.5">Watchlist hit</span>}
                    </div>
                    <p className="text-xs font-semibold leading-tight text-ink">{alert}</p>
                  </div>
                </motion.div>
              )))
            )}
          </div>
          <div className="p-5 bg-surface-muted border-t border-border">
            <button onClick={() => onChangeTab('analytics')} className="btn-secondary w-full !py-2.5">
              View full archive <ChevronRight className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
