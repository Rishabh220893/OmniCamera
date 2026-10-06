import { MutableRefObject, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Settings2, Maximize2, Minimize2, SwitchCamera, RefreshCw, Clock, Activity,
  AlertTriangle, Bell, ShieldCheck, ChevronRight, LayoutGrid, Rows3, Search, Loader2, Sparkles,
  Grid2X2
} from 'lucide-react';
import { cn, sentimentEmoji } from '../lib/utils';
import { hasCachedSnapshot } from '../lib/snapshotCache';
import { sortByGridHealth } from '../lib/cameraHealth';
import { useMediaConfig, mediaFailedCameras, gridCamId } from '../lib/mediaServer';
import { CameraConfig, LogEntry, CameraMediaRefs, TabId, ViewMode } from '../types';
import CameraFeed, { FeedStatus } from './CameraFeed';
import CameraTrendChart from './CameraTrendChart';

// 6 tiles per page: every one of them plays live. Only about six grid cameras stream cleanly (the others lose
// packets at the grid itself, see src/lib/cameraHealth.ts), and the healthiest are listed first, so page 1 is
// the six that work. A page of 24 left most tiles waiting for a live slot that never came.
const GRID_PAGE_SIZE = 6;

function formatLastAnalysisTime(lat: unknown): string {
  if (!lat) return '';
  let d: Date;
  if (lat instanceof Date) d = lat;
  else if (typeof lat === 'object' && lat !== null && 'seconds' in lat) d = new Date((lat as { seconds: number }).seconds * 1000);
  else d = new Date(lat as string | number);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

function getProtocolBadge(camera: CameraConfig): { label: string; color: string } {
  if (!camera.useRemoteFeed) {
    if (camera.useSimulatedFeed) return { label: 'SIM', color: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' };
    return { label: 'LOCAL', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' };
  }
  const url = (camera.remoteStreamUrl || '').toLowerCase();
  if (url.includes('.m3u8')) return { label: 'HLS', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
  if (url.startsWith('webrtc') || url.includes('/whep')) return { label: 'WHEP', color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' };
  if (url.startsWith('rtsp')) return { label: 'RTSP', color: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' };
  return { label: 'STREAM', color: 'bg-slate-500/20 text-slate-300 border-slate-500/30' };
}

interface CameraTileProps {
  camera: CameraConfig;
  cameraIndex?: number;
  layout: 'grid' | 'focus';
  isActive: boolean;
  isSelectedForAnalysis: boolean;
  isCapturing: boolean;
  isAnalyzing: boolean;
  latestLog?: LogEntry;
  mediaRefs: MutableRefObject<Map<string, CameraMediaRefs>>;
  onCameraError?: (msg: string | null) => void;
  onFallbackToSimulated?: () => void;
  streamAccessPassword: string;
  streamAccessEmail: string;
  onSelect: () => void;
  onToggleAnalysis: () => void;
  onStatusChange: (cameraId: string, status: FeedStatus) => void;
  cameraError: string | null;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleCameraFacing: () => void;
  hidden?: boolean;
  className?: string;
}

// One persistent tile per connected camera — mounted once and restyled via
// the `layout` prop, rather than being two separate elements in the grid
// and focus render branches.
function CameraTile({
  camera, cameraIndex, layout, isActive, isSelectedForAnalysis, isCapturing, isAnalyzing, latestLog,
  mediaRefs, onCameraError, onFallbackToSimulated, streamAccessPassword, streamAccessEmail, onSelect, onToggleAnalysis,
  onStatusChange, cameraError, isFullscreen, onToggleFullscreen, onToggleCameraFacing, hidden, className
}: CameraTileProps) {
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [retryToken, setRetryToken] = useState(0);

  const shouldConnect = isActive || isSelectedForAnalysis || !hidden;
  const hasCached = hasCachedSnapshot(camera.id);
  const protocol = getProtocolBadge(camera);
  const isAnomaly = latestLog && (latestLog.sentiment === 'critical' || latestLog.isUnusual || latestLog.isWatchlistMatch);

  useEffect(() => {
    if (status !== 'error' || !shouldConnect) return;
    const timer = setTimeout(() => {
      setStatus('connecting');
      setRetryToken((t) => t + 1);
    }, 120_000);
    return () => clearTimeout(timer);
  }, [status, shouldConnect]);

  // Only the focused camera, the active one and anything selected for analysis decode live video. Every
  // other grid tile shows a periodically refreshed still: a browser (and the grid, which limits how much
  // each account can watch at once) cannot sustain dozens of live streams.
  // With a media server (which serves any number of viewers from one pull per camera) the first N grid tiles
  // play live as well; the rest stay stills. N is capped by what a browser can decode at once.
  const media = useMediaConfig();
  const mediaLive = !!media?.enabled && cameraIndex !== undefined && cameraIndex <= Math.max(media.maxLiveTiles ?? 12, GRID_PAGE_SIZE) && !!gridCamId(camera.remoteStreamUrl) && !mediaFailedCameras.has(camera.id);
  const liveVideo = layout === 'focus' || isActive || isSelectedForAnalysis || mediaLive;

  const feed = (
    <CameraFeed
      key={retryToken}
      camera={camera}
      isFocused={layout === 'focus'}
      isCapturing={isCapturing}
      reportRefs={isSelectedForAnalysis}
      shouldConnect={shouldConnect}
      liveVideo={liveVideo}
      mediaRefs={mediaRefs}
      onCameraError={onCameraError}
      onFallbackToSimulated={onFallbackToSimulated}
      streamAccessPassword={streamAccessPassword}
      streamAccessEmail={streamAccessEmail}
      onStatusChange={(s) => { setStatus(s); onStatusChange(camera.id, s); }}
    />
  );

  if (layout === 'focus') {
    return (
      <div className={cn('absolute inset-0', hidden && 'hidden', className)}>
        {/* Tactical Viewfinder Corner Reticles */}
        <div className="reticle-corner-tl" />
        <div className="reticle-corner-tr" />
        <div className="reticle-corner-bl" />
        <div className="reticle-corner-br" />

        {feed}
        {cameraError && (
          <div className="absolute inset-0 z-50 bg-surface/95 backdrop-blur-sm flex flex-col items-center justify-center p-10 text-center">
            <div className="w-16 h-16 rounded-2xl bg-critical-soft flex items-center justify-center mb-5">
              <AlertTriangle className="w-8 h-8 text-critical" strokeWidth={1.75} />
            </div>
            <h3 className="text-lg font-bold text-ink mb-2">Feed Connection Notice</h3>
            <p className="text-critical text-sm max-w-md mb-6">{cameraError}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => { setStatus('connecting'); setRetryToken((t) => t + 1); }}
                className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} /> Retry connection
              </button>
              {onFallbackToSimulated && (
                <button
                  onClick={onFallbackToSimulated}
                  className="btn-primary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95"
                >
                  Switch to simulated feed
                </button>
              )}
            </div>
          </div>
        )}
        {status === 'error' && !cameraError && (
          <div className="absolute inset-0 z-40 bg-surface/95 backdrop-blur-sm flex flex-col items-center justify-center p-10 text-center gap-3">
            <AlertTriangle className="w-8 h-8 text-critical" strokeWidth={1.75} />
            <h4 className="text-sm font-bold text-ink">Feed Connection Issue</h4>
            <p className="text-critical text-sm max-w-md">Timed out connecting to this camera feed or rejected by upstream origin.</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => { setStatus('connecting'); setRetryToken((t) => t + 1); }}
                className="btn-secondary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} /> Retry connection
              </button>
              {onFallbackToSimulated && (
                <button
                  onClick={onFallbackToSimulated}
                  className="btn-primary !py-2 !px-4 text-xs whitespace-nowrap active:scale-95"
                >
                  Switch to simulated feed
                </button>
              )}
            </div>
          </div>
        )}

        <div className="absolute inset-0 pointer-events-none">
          {isCapturing && <div className="absolute inset-x-0 top-0 h-0.5 bg-accent/60 animate-pulse" />}

          {/* Top-Left Telemetry Pill */}
          <div className="absolute top-5 left-5 flex flex-col gap-2 pointer-events-auto">
            <div className="bg-black/70 backdrop-blur-md rounded-lg border border-white/10 px-3 py-1.5 flex items-center gap-2.5 shadow-lg">
              <Activity className="w-3.5 h-3.5 text-success" strokeWidth={2} />
              <span className="text-[11px] font-mono font-bold text-white uppercase tracking-wider">
                {camera.name.replace(/\s+/g, '_')}
              </span>
              <span className={cn('px-1.5 py-0.2 rounded text-[8px] font-mono font-bold uppercase border', protocol.color)}>
                {protocol.label}
              </span>
            </div>
            {camera.lastAnalysisTime && (
              <div className="bg-black/70 backdrop-blur-md rounded-lg border border-white/10 px-3 py-1 flex items-center gap-2 text-white/90">
                <Clock className="w-3 h-3 text-accent" strokeWidth={2} />
                <span className="telemetry-tag text-[9px] text-white">SYNC: {formatLastAnalysisTime(camera.lastAnalysisTime)}</span>
              </div>
            )}
          </div>

          {/* Top-Right Status and Hotkey HUD */}
          <div className="absolute top-5 right-5 flex items-center gap-2 pointer-events-auto">
            {cameraIndex !== undefined && (
              <span className="px-2 py-1 rounded-md bg-black/70 backdrop-blur-md border border-white/10 text-white font-mono text-[10px] font-bold" title={`Press ${cameraIndex} to spotlight`}>
                KEY [{cameraIndex}]
              </span>
            )}
            <div className="bg-black/70 backdrop-blur-md rounded-md border border-white/10 px-2.5 py-1 flex items-center gap-1.5">
              <span className={cn('w-2 h-2 rounded-full', status === 'live' ? 'bg-success animate-pulse' : 'bg-warning')} />
              <span className="telemetry-tag text-[10px] text-white">
                {status === 'live' ? 'CONFIRMED STREAM' : status.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Bottom Controls Toolbar */}
          <div className="absolute bottom-5 right-5 flex gap-2 pointer-events-auto">
            <button
              onClick={onToggleFullscreen}
              title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-black/70 backdrop-blur-md border border-white/10 text-white hover:bg-black/90 transition-all active:scale-95"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" strokeWidth={2} /> : <Maximize2 className="w-4 h-4" strokeWidth={2} />}
            </button>
            <button
              onClick={onToggleCameraFacing}
              title="Switch Camera Facing"
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-black/70 backdrop-blur-md border border-white/10 text-white hover:bg-black/90 transition-all active:scale-95"
            >
              <SwitchCamera className="w-4 h-4" strokeWidth={2} />
            </button>
          </div>

          {/* AI Processing Status Indicator */}
          {isAnalyzing && (
            <div className="absolute inset-x-0 bottom-6 flex flex-col items-center pointer-events-none">
              <div className="flex items-center gap-2 bg-black/80 backdrop-blur-md border border-accent/40 px-4 py-1.5 rounded-full shadow-xl">
                <RefreshCw className="w-3.5 h-3.5 text-accent animate-spin" strokeWidth={2} />
                <span className="telemetry-tag text-white text-[10px] tracking-wider">
                  AI REASONING CYCLE ACTIVE
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={cn(
        'relative aspect-video rounded-xl overflow-hidden border text-left group cursor-pointer transition-all duration-200 bg-surface-muted',
        isActive ? 'border-accent ring-2 ring-accent/40 shadow-lg' : 'border-border hover:border-accent/40',
        isAnomaly && 'incident-pulse border-critical',
        className,
        hidden && 'hidden'
      )}
    >
      {/* Corner Viewfinder Reticles */}
      <div className={cn('reticle-corner-tl', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-75')} />
      <div className={cn('reticle-corner-tr', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-75')} />
      <div className={cn('reticle-corner-bl', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-75')} />
      <div className={cn('reticle-corner-br', isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-75')} />

      {feed}

      {status === 'connecting' && !hasCached && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-muted animate-pulse">
          <Loader2 className="w-5 h-5 text-ink-muted animate-spin" strokeWidth={1.75} />
          <span className="telemetry-tag text-[9px] text-ink-muted uppercase">Connecting…</span>
        </div>
      )}
      {status === 'connecting' && hasCached && (
        <div className="absolute top-2.5 right-12 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-md text-white/80 border border-white/10">
          <Loader2 className="w-2.5 h-2.5 animate-spin" strokeWidth={2} />
          <span className="telemetry-tag text-[8px] text-white">SYNCING</span>
        </div>
      )}
      {status === 'error' && !hasCached && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-surface-muted p-2 text-center">
          <AlertTriangle className="w-5 h-5 text-critical" strokeWidth={1.75} />
          <span className="telemetry-tag text-[9px] text-critical uppercase">Connection error</span>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={(e) => { e.stopPropagation(); setStatus('connecting'); setRetryToken((t) => t + 1); }}
              className="text-[9px] font-bold text-accent uppercase tracking-wide underline"
            >
              Retry
            </button>
            {onFallbackToSimulated && (
              <button
                onClick={(e) => { e.stopPropagation(); onFallbackToSimulated(); }}
                className="text-[9px] font-bold text-ink-muted hover:text-white uppercase tracking-wide underline"
              >
                Simulate
              </button>
            )}
          </div>
        </div>
      )}
      {status === 'error' && hasCached && (
        <div className="absolute top-2.5 right-12 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-md text-amber-400 border border-amber-500/20">
          <AlertTriangle className="w-2.5 h-2.5 text-amber-400" strokeWidth={2} />
          <span className="telemetry-tag text-[8px] text-amber-400">OFFLINE</span>
          <button
            onClick={(e) => { e.stopPropagation(); setStatus('connecting'); setRetryToken((t) => t + 1); }}
            className="ml-1 text-[8px] font-bold text-white underline hover:text-accent"
          >
            Retry
          </button>
        </div>
      )}

      {/* Top Header HUD overlay */}
      <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-none z-10">
        <div className="flex items-center gap-1.5 pointer-events-auto">
          {cameraIndex !== undefined && cameraIndex <= 9 && (
            <span className="w-5 h-5 rounded bg-black/70 backdrop-blur-md border border-white/15 flex items-center justify-center text-[10px] font-mono font-bold text-white shadow-sm" title={`Hotkey: Press ${cameraIndex}`}>
              {cameraIndex}
            </span>
          )}

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleAnalysis(); }}
            aria-pressed={isSelectedForAnalysis}
            title={isSelectedForAnalysis ? 'Included in AI guard' : 'Include in AI guard'}
            className={cn(
              'flex items-center gap-1 h-5 px-1.5 rounded backdrop-blur-md border transition-all text-[9px] font-mono font-bold uppercase',
              isSelectedForAnalysis ? 'bg-accent/90 border-accent text-white shadow-sm' : 'bg-black/60 border-white/10 text-white/70 hover:text-white'
            )}
          >
            <Sparkles className="w-2.5 h-2.5 shrink-0" strokeWidth={2.5} />
            <span>AI</span>
          </button>

          <span className={cn('px-1.5 py-0.5 rounded text-[8px] font-mono font-bold uppercase border backdrop-blur-md', protocol.color)}>
            {protocol.label}
          </span>
        </div>

        <div className="flex items-center gap-1.5 pointer-events-auto">
          {latestLog && (
            <span className="text-xs drop-shadow" title={latestLog.sentiment || 'neutral'}>
              {sentimentEmoji(latestLog.sentiment)}
            </span>
          )}

          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-md border border-white/10">
            <span className={cn('w-1.5 h-1.5 rounded-full', status === 'live' ? 'bg-success animate-pulse' : 'bg-warning')} />
            <span className="telemetry-tag text-[8px] text-white">
              {status === 'live' ? 'LIVE' : status.toUpperCase()}
            </span>
          </div>
        </div>
      </div>

      {/* Critical anomaly banner */}
      {isAnomaly && (
        <div className="absolute top-10 inset-x-2.5 z-10 px-2 py-1 rounded bg-critical/90 backdrop-blur-md border border-critical/40 text-white flex items-center justify-between gap-1 shadow-md">
          <div className="flex items-center gap-1.5 truncate">
            <AlertTriangle className="w-3 h-3 shrink-0 animate-bounce" />
            <span className="text-[9px] font-mono font-bold uppercase tracking-wider truncate">
              {latestLog?.isWatchlistMatch ? 'Watchlist Hit' : 'Anomaly Alert'}
            </span>
          </div>
        </div>
      )}

      {/* Bottom Telemetry Bar */}
      <div className="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black/90 via-black/55 to-transparent flex items-center justify-between gap-2 z-10">
        <div className="flex flex-col min-w-0">
          <span className="text-[11px] font-mono font-bold text-white uppercase tracking-wider truncate">
            {camera.name}
          </span>
          {latestLog?.counts && (
            <div className="flex items-center gap-2 text-[9px] font-mono text-white/80 mt-0.5">
              {latestLog.counts.people > 0 && (
                <span className="flex items-center gap-1 text-emerald-400">
                  <span className="w-1 h-1 rounded-full bg-emerald-400" />
                  {latestLog.counts.people}P
                </span>
              )}
              {latestLog.counts.vehicles > 0 && (
                <span className="flex items-center gap-1 text-amber-400">
                  <span className="w-1 h-1 rounded-full bg-amber-400" />
                  {latestLog.counts.vehicles}V
                </span>
              )}
              {latestLog.detectedPlates && latestLog.detectedPlates.length > 0 && (
                <span className="text-accent font-semibold truncate max-w-[90px]">
                  {latestLog.detectedPlates[0]}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Hover Spotlight Action */}
        <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <span className="px-2 py-1 rounded bg-white/20 hover:bg-white/30 text-white text-[9px] font-mono font-bold backdrop-blur-md border border-white/20">
            FOCUS
          </span>
        </div>
      </div>
    </div>
  );
}

interface MonitorTabProps {
  cameras: CameraConfig[];
  activeCameraId: string;
  onSelectCamera: (id: string) => void;
  onAddCamera: () => void;
  isCapturing: boolean;
  cameraError: string | null;
  analysisError: string | null;
  logs: LogEntry[];
  viewMode: ViewMode;
  onChangeViewMode: (mode: ViewMode) => void;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleCameraFacing: () => void;
  mediaRefs: MutableRefObject<Map<string, CameraMediaRefs>>;
  onCameraError: (msg: string | null) => void;
  onFallbackToSimulated: () => void;
  onChangeTab: (tab: TabId) => void;
  streamAccessPassword: string;
  streamAccessEmail: string;
  /** Cameras currently running the capture/analysis loop — always includes
   *  the active camera; grid-view checkboxes add more on top of it. */
  analysisCameraIds: Set<string>;
  analyzingCameraIds: Set<string>;
  onToggleAnalysisCamera: (id: string) => void;
  onJumpToLog: (logId: string) => void;
  onCameraStatusChange: (cameraId: string, status: FeedStatus) => void;
}

export default function MonitorTab({
  cameras, activeCameraId, onSelectCamera, onAddCamera, isCapturing,
  cameraError, analysisError, logs, viewMode, onChangeViewMode, containerRef,
  isFullscreen, onToggleFullscreen, onToggleCameraFacing, mediaRefs, onCameraError,
  onFallbackToSimulated, onChangeTab, streamAccessPassword, streamAccessEmail,
  analysisCameraIds, analyzingCameraIds, onToggleAnalysisCamera, onJumpToLog, onCameraStatusChange
}: MonitorTabProps) {
  const activeCamera = cameras.find(c => c.id === activeCameraId) || cameras[0];
  const [gridFilter, setGridFilter] = useState('');
  const filteredCameras = useMemo(() => {
    const q = gridFilter.trim().toLowerCase();
    // Most reliable demo-grid cameras first, so page 1 is the one that actually plays.
    const ordered = sortByGridHealth(cameras);
    if (!q) return ordered;
    return ordered.filter(c => c.name.toLowerCase().includes(q) || c.location?.toString().toLowerCase().includes(q) || c.department?.toLowerCase().includes(q));
  }, [cameras, gridFilter]);
  const latestLogByCamera = useMemo(() => {
    const map = new Map<string, LogEntry>();
    for (const log of logs) if (!map.has(log.cameraId)) map.set(log.cameraId, log);
    return map;
  }, [logs]);

  // A registry that scales to tens of thousands of cameras can't have every
  // one of them mounted as a live React component at once either
  const [gridPage, setGridPage] = useState(0);
  const totalGridPages = Math.max(1, Math.ceil(filteredCameras.length / GRID_PAGE_SIZE));
  const clampedGridPage = Math.min(gridPage, totalGridPages - 1);
  const pagedCameras = useMemo(
    () => filteredCameras.slice(clampedGridPage * GRID_PAGE_SIZE, (clampedGridPage + 1) * GRID_PAGE_SIZE),
    [filteredCameras, clampedGridPage]
  );
  const handleGridFilterChange = (value: string) => { setGridFilter(value); setGridPage(0); };

  const matrixCameras = useMemo(() => {
    const primary = cameras.find(c => c.id === activeCameraId) || cameras[0];
    const companions = cameras.filter(c => c.id !== primary?.id).slice(0, 5);
    return primary ? [primary, ...companions] : companions;
  }, [cameras, activeCameraId]);

  const pagedIds = useMemo(() => new Set(pagedCameras.map(c => c.id)), [pagedCameras]);
  const mountedCameras = useMemo(() => {
    if (viewMode === 'focus') {
      return cameras.filter(c => analysisCameraIds.has(c.id));
    }
    if (viewMode === 'matrix') {
      const matrixIds = new Set(matrixCameras.map(c => c.id));
      const offMatrixAnalysisTargets = cameras.filter(c => analysisCameraIds.has(c.id) && !matrixIds.has(c.id));
      return [...matrixCameras, ...offMatrixAnalysisTargets];
    }
    const offPageAnalysisTargets = cameras.filter(c => analysisCameraIds.has(c.id) && !pagedIds.has(c.id));
    return [...pagedCameras, ...offPageAnalysisTargets];
  }, [viewMode, cameras, analysisCameraIds, matrixCameras, pagedCameras, pagedIds]);

  // Watchlist hits float to the top regardless of age
  const alertItems = useMemo(() => {
    const items = logs.flatMap(log => log.alerts.map((alert, idx) => ({ log, alert, key: `${log.id}-${idx}` })));
    return items.sort((a, b) => (a.log.isWatchlistMatch === b.log.isWatchlistMatch ? 0 : a.log.isWatchlistMatch ? -1 : 1));
  }, [logs]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      key="monitor" className="space-y-6"
    >
      <div className="space-y-1">
        <h2 className="text-xl font-bold text-ink">Feed</h2>
        <p className="text-sm text-ink-muted">Live camera monitoring and AI analysis.</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-8">
      <div className="min-w-0 xl:col-span-3 space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 custom-scrollbar lg:hidden">
            {cameras.slice(0, 50).map(cam => (
              <button
                key={cam.id}
                onClick={() => onSelectCamera(cam.id)}
                className={cn('px-4 py-2 rounded-xl text-[10px] font-bold uppercase whitespace-nowrap border transition-all active:scale-95', activeCameraId === cam.id ? 'bg-accent border-accent text-white shadow-xs' : 'bg-surface border-border text-ink-muted hover:border-ink-muted/40')}
              >
                {cam.name}
              </button>
            ))}
            <button onClick={onAddCamera} className="btn-ghost !p-2 border border-dashed border-border !rounded-xl" title="Camera settings"><Settings2 className="w-4 h-4" strokeWidth={1.75} /></button>
          </div>
          {viewMode === 'grid' && (
            <div className="relative w-full sm:w-64 order-last sm:order-none">
              <Search className="w-3.5 h-3.5 text-ink-muted absolute left-3.5 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
              <input
                value={gridFilter}
                onChange={(e) => handleGridFilterChange(e.target.value)}
                placeholder="Filter by camera name or location"
                className="input !py-2 !px-4 !pl-9 text-xs"
              />
            </div>
          )}
          <div className="ml-auto flex items-center gap-1 panel !p-1 bg-surface-muted border border-border rounded-xl">
            <button
              onClick={() => onChangeViewMode('focus')}
              className={cn('btn-ghost !px-3 !py-1.5 !rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95 whitespace-nowrap', viewMode === 'focus' ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink')}
              title="Focused Spotlight View (Hotkey: G)"
            >
              <Rows3 className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">Focus</span>
            </button>
            <button
              onClick={() => onChangeViewMode('matrix')}
              className={cn('btn-ghost !px-3 !py-1.5 !rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95 whitespace-nowrap', viewMode === 'matrix' ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink')}
              title="1+5 CCTV Matrix View (Hotkey: G)"
            >
              <Grid2X2 className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">1+5 Matrix</span>
            </button>
            <button
              onClick={() => onChangeViewMode('grid')}
              className={cn('btn-ghost !px-3 !py-1.5 !rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all active:scale-95 whitespace-nowrap', viewMode === 'grid' ? 'bg-surface text-ink shadow-xs' : 'text-ink-muted hover:text-ink')}
              title="Full Video Wall Grid (Hotkey: G)"
            >
              <LayoutGrid className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">Wall Grid</span>
            </button>
          </div>
        </div>

        {viewMode === 'grid' && filteredCameras.length === 0 && (
          <div className="card p-12 text-center text-xs text-ink-muted flex flex-col items-center justify-center gap-2">
            <Search className="w-6 h-6 text-ink-muted/50" strokeWidth={1.5} />
            <p className="text-sm font-semibold text-ink">No cameras match "{gridFilter}"</p>
            <p className="text-xs text-ink-muted max-w-xs">Try searching by a different name, department, or location.</p>
          </div>
        )}

        <div
          ref={containerRef}
          className={cn(
            viewMode === 'grid' && filteredCameras.length > 0 && 'grid sm:grid-cols-2 lg:grid-cols-3 gap-4',
            viewMode === 'matrix' && 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4',
            viewMode === 'focus' && cn('relative rounded-2xl overflow-hidden bg-surface-muted border border-border transition-all duration-300', isFullscreen ? 'rounded-none border-none h-screen w-screen' : 'aspect-video')
          )}
        >
          {mountedCameras.map((cam, idx) => {
            const isPrimaryInMatrix = viewMode === 'matrix' && cam.id === activeCameraId;
            const isCompanionInMatrix = viewMode === 'matrix' && matrixCameras.some(m => m.id === cam.id);

            return (
              <CameraTile
                key={cam.id}
                camera={cam}
                cameraIndex={idx + 1}
                layout={viewMode === 'focus' ? 'focus' : (isPrimaryInMatrix ? 'focus' : 'grid')}
                className={cn(
                  viewMode === 'matrix' && isPrimaryInMatrix && 'lg:col-span-2 lg:row-span-2 aspect-video min-h-[360px] !relative'
                )}
                hidden={
                  viewMode === 'focus'
                    ? cam.id !== activeCameraId
                    : viewMode === 'matrix'
                      ? !isCompanionInMatrix
                      : !pagedIds.has(cam.id)
                }
                isActive={cam.id === activeCameraId}
                isSelectedForAnalysis={analysisCameraIds.has(cam.id)}
                isCapturing={isCapturing}
                isAnalyzing={analyzingCameraIds.has(cam.id)}
                latestLog={latestLogByCamera.get(cam.id)}
                mediaRefs={mediaRefs}
                onCameraError={cam.id === activeCameraId ? onCameraError : undefined}
                onFallbackToSimulated={() => onFallbackToSimulated(cam.id)}
                streamAccessPassword={streamAccessPassword}
                streamAccessEmail={streamAccessEmail}
                onSelect={() => onSelectCamera(cam.id)}
                onToggleAnalysis={() => onToggleAnalysisCamera(cam.id)}
                onStatusChange={onCameraStatusChange}
                cameraError={cam.id === activeCameraId ? cameraError : null}
                isFullscreen={isFullscreen}
                onToggleFullscreen={onToggleFullscreen}
                onToggleCameraFacing={onToggleCameraFacing}
              />
            );
          })}
        </div>

        {viewMode === 'grid' && filteredCameras.length > GRID_PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 text-xs flex-wrap">
            <span className="text-ink-muted whitespace-nowrap">
              Showing {clampedGridPage * GRID_PAGE_SIZE + 1}–{Math.min((clampedGridPage + 1) * GRID_PAGE_SIZE, filteredCameras.length)} of {filteredCameras.length} cameras
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setGridPage(Math.max(0, clampedGridPage - 1))}
                disabled={clampedGridPage === 0}
                className="btn-secondary !py-2 !px-4 text-xs min-h-[36px] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap active:scale-95"
              >
                Previous
              </button>
              <span className="text-ink-muted font-medium whitespace-nowrap">Page {clampedGridPage + 1} of {totalGridPages}</span>
              <button
                onClick={() => setGridPage(Math.min(totalGridPages - 1, clampedGridPage + 1))}
                disabled={clampedGridPage >= totalGridPages - 1}
                className="btn-secondary !py-2 !px-4 text-xs min-h-[36px] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap active:scale-95"
              >
                Next
              </button>
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
            (the view every reported screenshot has actually been in). Lists every
            camera currently selected for analysis (not just the active one) —
            picking logs[0], the single most-recent log across ALL cameras, used to
            show whichever camera's cycle happened to finish last under a header
            naming a different camera entirely once more than one was selected. */}
        <div className="card p-7 flex flex-col gap-5">
          <h3 className="text-xs font-bold text-ink-muted uppercase tracking-widest">
            Ongoing context{analysisCameraIds.size > 1 ? ` — ${analysisCameraIds.size} cameras` : ` — ${activeCamera.name}`}
          </h3>
          <div className="flex flex-col gap-4">
            {cameras.filter(cam => analysisCameraIds.has(cam.id)).map(cam => {
              const latest = logs.find(l => l.cameraId === cam.id);
              return (
                <div key={cam.id} className="flex flex-col gap-1.5 max-w-xl">
                  {analysisCameraIds.size > 1 && (
                    <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wide">{cam.name}</span>
                  )}
                  {latest ? (
                    <p className="text-base text-ink">{latest.summary}</p>
                  ) : !isCapturing ? (
                    <p className="text-base text-ink-muted italic">Activate guard to begin analysis.</p>
                  ) : analyzingCameraIds.has(cam.id) ? (
                    <div className="flex items-center gap-2 text-sm text-ink-muted">
                      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" strokeWidth={1.75} />
                      Analyzing the first frame…
                    </div>
                  ) : (
                    // A visible "this is actually working" signal for the gap
                    // between Activate Guard and the first result landing —
                    // without it, up to a full sync-interval of silence reads
                    // as broken rather than as working-but-not-done-yet.
                    <div className="space-y-1.5">
                      <p className="text-sm text-ink-muted">Waiting for the first analysis — results appear roughly every {Math.max(5, cam.interval)}s.</p>
                      <div className="h-1 rounded-full bg-surface-muted overflow-hidden max-w-xs">
                        <div key={`${cam.id}-${cam.interval}`} className="h-full bg-accent progress-fill" style={{ animationDuration: `${Math.max(5, cam.interval)}s` }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <CameraTrendChart camera={activeCamera} logs={logs} onPointClick={onJumpToLog} />
      </div>

      <div className="space-y-6 flex flex-col h-full">
        <div className="hidden lg:block space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Cameras</h3>
            <button onClick={onAddCamera} className="btn-ghost !p-1.5 border border-border !rounded-lg"><Settings2 className="w-3.5 h-3.5" strokeWidth={1.75} /></button>
          </div>
          <div className="space-y-2">
            {/* Same page as the grid, not the full registry — see
                mountedCameras above for why an unbounded list here doesn't
                scale either. */}
            {pagedCameras.map(cam => (
              // A div, not <button> — it hosts a nested <label><input> for
              // the analysis checkbox, and interactive-in-interactive is
              // invalid HTML (see the matching note on CameraTile above).
              <div
                key={cam.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectCamera(cam.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectCamera(cam.id); } }}
                className={cn('w-full p-3.5 rounded-xl border text-left flex items-center gap-3 cursor-pointer transition-all duration-150 active:scale-[0.98]', activeCameraId === cam.id ? 'bg-accent border-accent text-white shadow-xs' : 'bg-surface border-border hover:border-accent/40')}
              >
                <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', isCapturing && analysisCameraIds.has(cam.id) ? (activeCameraId === cam.id ? 'bg-white' : 'bg-success') + ' animate-pulse' : 'bg-ink-muted/40')} />
                <div className="flex flex-col flex-1 min-w-0">
                  <span className={cn('text-xs font-bold truncate', activeCameraId === cam.id ? 'text-white' : 'text-ink')}>{cam.name}</span>
                  <span className={cn('text-[9px] font-medium', activeCameraId === cam.id ? 'text-white/70' : 'text-ink-muted')}>
                    {cam.useRemoteFeed ? 'RTSP / IP feed' : cam.useSimulatedFeed ? 'Simulated' : 'Local device'}
                  </span>
                </div>
                <label
                  onClick={(e) => e.stopPropagation()}
                  title="Include in AI analysis"
                  className={cn('w-6 h-6 rounded-lg flex items-center justify-center cursor-pointer shrink-0 transition-all hover:scale-105 active:scale-95', activeCameraId === cam.id ? 'bg-white/15' : 'bg-surface-muted')}
                >
                  <input type="checkbox" checked={analysisCameraIds.has(cam.id)} onChange={() => onToggleAnalysisCamera(cam.id)} className="w-3.5 h-3.5 accent-accent cursor-pointer rounded" />
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 card flex flex-col overflow-hidden">
          <div className="p-6 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-bold font-display uppercase tracking-widest text-ink">Alert center</h2>
            <Bell className="w-4 h-4 text-ink-muted" strokeWidth={1.75} />
          </div>
          <div className="flex-1 p-5 space-y-3 overflow-y-auto custom-scrollbar">
            {alertItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-ink-muted px-6 text-center">
                <ShieldCheck className="w-9 h-9 mb-3 opacity-20" strokeWidth={1.5} />
                <p className="text-xs font-semibold">No critical events detected</p>
              </div>
            ) : (
              alertItems.map(({ log, alert, key }, i) => (
                <motion.div
                  initial={{ x: 12, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
                  key={key}
                  className={cn(
                    'p-3.5 rounded-xl flex items-start gap-3 border',
                    log.isWatchlistMatch ? 'bg-critical-soft border-critical/30' : 'bg-warning-soft border-transparent',
                    i === 0 && log.isWatchlistMatch && 'animate-pulse'
                  )}
                >
                  <div className={cn('p-1.5 rounded-lg shrink-0', log.isWatchlistMatch ? 'bg-critical/15' : 'bg-warning/15')}>
                    <AlertTriangle className={cn('w-3.5 h-3.5', log.isWatchlistMatch ? 'text-critical' : 'text-warning')} strokeWidth={1.75} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[9px] font-mono text-ink-muted uppercase">{log.timestamp.toLocaleTimeString()}</span>
                      <span className="text-[9px] font-bold text-ink-muted">{log.cameraName}</span>
                      {log.isWatchlistMatch && <span className="badge badge-critical !py-0.5 whitespace-nowrap">Watchlist hit</span>}
                    </div>
                    <p className="text-xs font-semibold leading-tight text-ink">{alert}</p>
                  </div>
                </motion.div>
              ))
            )}
          </div>
          <div className="p-5 bg-surface-muted border-t border-border">
            <button onClick={() => onChangeTab('analytics')} className="btn-secondary w-full !py-2.5 !px-5 text-xs whitespace-nowrap active:scale-95 flex items-center justify-center gap-2">
              View full archive <ChevronRight className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>
      </div>
    </motion.div>
  );
}
