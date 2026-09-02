import { MutableRefObject, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Settings2, Maximize2, Minimize2, SwitchCamera, RefreshCw, Clock, Activity,
  AlertTriangle, Bell, ShieldCheck, ChevronRight, LayoutGrid, Rows3, Search, Loader2
} from 'lucide-react';
import { cn, sentimentEmoji } from '../lib/utils';
import { useInViewport } from '../lib/useInViewport';
import { CameraConfig, LogEntry, CameraMediaRefs, TabId } from '../types';
import CameraFeed, { FeedStatus } from './CameraFeed';
import CameraTrendChart from './CameraTrendChart';

function formatLastAnalysisTime(lat: unknown): string {
  if (!lat) return '';
  let d: Date;
  if (lat instanceof Date) d = lat;
  else if (typeof lat === 'object' && lat !== null && 'seconds' in lat) d = new Date((lat as { seconds: number }).seconds * 1000);
  else d = new Date(lat as string | number);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

interface CameraTileProps {
  camera: CameraConfig;
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
  onSelect: () => void;
  onToggleAnalysis: () => void;
  onStatusChange: (cameraId: string, status: FeedStatus) => void;
  cameraError: string | null;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleCameraFacing: () => void;
  hidden?: boolean;
}

// One persistent tile per connected camera — mounted once and restyled via
// the `layout` prop, rather than being two separate elements in the grid
// and focus render branches. That used to mean switching view modes
// unmounted whichever CameraFeed wasn't in the active branch, tearing down
// a perfectly good HLS connection and restarting it from zero.
function CameraTile({
  camera, layout, isActive, isSelectedForAnalysis, isCapturing, isAnalyzing, latestLog,
  mediaRefs, onCameraError, onFallbackToSimulated, streamAccessPassword, onSelect, onToggleAnalysis,
  onStatusChange, cameraError, isFullscreen, onToggleFullscreen, onToggleCameraFacing, hidden
}: CameraTileProps) {
  const [status, setStatus] = useState<FeedStatus>('connecting');
  // Bumping this remounts CameraFeed (via the key below), forcing a full
  // fresh attempt — nothing auto-retries a failed remote connection on its
  // own, so without this the tile would sit on "error" forever.
  const [retryToken, setRetryToken] = useState(0);

  // Decoding all 30 grid cameras' live video at once was observed
  // saturating the browser badly enough that tiles which HAD connected
  // successfully would lose frames and drop — a hard client-side decode
  // ceiling, not a networking problem. Only a tile actually scrolled into
  // view (plus a margin, so it's ready just before it's visible) connects;
  // this replaces the old manual "click to load" — nothing needs a click,
  // it just activates automatically as the camera comes into view, and
  // disconnects again once genuinely scrolled away (useInViewport debounces
  // that exit so a tile sitting at the boundary doesn't thrash) — keeping
  // the total simultaneous decode load bounded to roughly what's on screen
  // instead of growing to all 30 the moment someone scrolls through the
  // whole grid once. The active camera and anything selected for analysis
  // always connect regardless of scroll position: analysis reads live
  // frames off cameras that may not currently be visible on screen.
  const containerRef = useRef<HTMLDivElement>(null);
  const inViewport = useInViewport(containerRef);
  const shouldConnect = isActive || isSelectedForAnalysis || inViewport;
  // Live (persistent) video is reserved for the camera actually being
  // watched or analyzed — everything else runs as a rotating snapshot
  // (see CameraFeed's `liveVideo` prop doc). That's the difference between
  // a grid that scales to a handful of cameras and one that scales to
  // however many are in the registry: a handful of live decodes is a
  // constant cost regardless of total camera count, while N live decodes
  // for N visible tiles is not.
  const liveVideo = layout === 'focus' || isActive || isSelectedForAnalysis;

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
      onStatusChange={(s) => { setStatus(s); onStatusChange(camera.id, s); }}
    />
  );

  if (layout === 'focus') {
    return (
      <div ref={containerRef} className={cn('absolute inset-0', hidden && 'hidden')}>
        {feed}
        {cameraError && (
          <div className="absolute inset-0 z-50 bg-surface/95 backdrop-blur-sm flex flex-col items-center justify-center p-10 text-center">
            <div className="w-16 h-16 rounded-2xl bg-critical-soft flex items-center justify-center mb-5">
              <AlertTriangle className="w-8 h-8 text-critical" strokeWidth={1.75} />
            </div>
            <h3 className="text-lg font-bold text-ink mb-2">Camera access error</h3>
            <p className="text-critical text-sm max-w-md mb-6">{cameraError}</p>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 z-40 bg-surface/95 backdrop-blur-sm flex flex-col items-center justify-center p-10 text-center gap-3">
            <AlertTriangle className="w-8 h-8 text-critical" strokeWidth={1.75} />
            <p className="text-critical text-sm max-w-md">Timed out connecting to this feed.</p>
            <button
              onClick={() => { setStatus('connecting'); setRetryToken((t) => t + 1); }}
              className="btn-secondary !py-2 text-xs"
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} /> Retry connection
            </button>
          </div>
        )}
        <div className="absolute inset-0 pointer-events-none">
          {isCapturing && <div className="absolute inset-x-0 top-0 h-px bg-accent/40" />}
          <div className="absolute top-6 left-6 flex flex-col gap-2 pointer-events-auto">
            <div className="bg-black/55 backdrop-blur-md rounded-xl px-3.5 py-1.5 flex items-center gap-2.5">
              <Activity className="w-3.5 h-3.5 text-success" strokeWidth={1.75} />
              <span className="text-[10px] font-mono font-bold text-white uppercase">{camera.name.replace(/\s+/g, '_')}</span>
            </div>
            {camera.lastAnalysisTime && (
              <div className="bg-black/55 backdrop-blur-md rounded-xl px-3.5 py-1.5 flex items-center gap-2.5">
                <Clock className="w-3.5 h-3.5 text-accent" strokeWidth={1.75} />
                <span className="text-[10px] font-mono font-bold text-white uppercase">Last sync: {formatLastAnalysisTime(camera.lastAnalysisTime)}</span>
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
    );
  }

  return (
    // A plain div, not <button> — this tile hosts a real nested <button>
    // (the retry/load actions) and a <label><input> (the checkbox), and
    // nesting interactive elements inside a <button> is invalid HTML that
    // browsers silently "fix" by restructuring the DOM, breaking clicks in
    // unpredictable ways. role/tabIndex/onKeyDown keep it keyboard-operable.
    <div
      ref={containerRef}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={cn(
        'relative aspect-video rounded-2xl overflow-hidden border text-left group cursor-pointer',
        isActive ? 'border-accent ring-2 ring-accent/30' : 'border-border',
        hidden && 'hidden'
      )}
    >
      {feed}

      {status === 'connecting' && !shouldConnect && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-muted">
          <span className="text-[9px] font-bold text-ink-muted uppercase tracking-wide">Scroll into view to connect</span>
        </div>
      )}
      {status === 'connecting' && shouldConnect && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-muted animate-pulse">
          <Loader2 className="w-5 h-5 text-ink-muted animate-spin" strokeWidth={1.75} />
          <span className="text-[9px] font-bold text-ink-muted uppercase tracking-wide">Connecting…</span>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-muted">
          <AlertTriangle className="w-5 h-5 text-critical" strokeWidth={1.75} />
          <span className="text-[9px] font-bold text-critical uppercase tracking-wide">Connection failed</span>
          <button
            onClick={(e) => { e.stopPropagation(); setStatus('connecting'); setRetryToken((t) => t + 1); }}
            className="text-[9px] font-bold text-accent uppercase tracking-wide underline"
          >
            Retry
          </button>
        </div>
      )}

      <label
        onClick={(e) => e.stopPropagation()}
        title="Include this camera in AI analysis"
        className="absolute top-2.5 left-2.5 w-6 h-6 rounded-md bg-black/55 backdrop-blur-md flex items-center justify-center cursor-pointer"
      >
        <input
          type="checkbox"
          checked={isSelectedForAnalysis}
          onChange={onToggleAnalysis}
          className="w-3.5 h-3.5 accent-accent cursor-pointer"
        />
      </label>

      <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
        {latestLog && <span className="text-sm leading-none drop-shadow" title={latestLog.sentiment || 'neutral'}>{sentimentEmoji(latestLog.sentiment)}</span>}
        {status === 'live' && (isCapturing && isSelectedForAnalysis) && (
          <span className={cn('w-2 h-2 rounded-full bg-success', isAnalyzing ? 'animate-pulse' : '')} title="Live — analysis active" />
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 p-2.5 bg-gradient-to-t from-black/70 to-transparent">
        <span className="text-[10px] font-bold text-white uppercase tracking-wide">{camera.name}</span>
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
  viewMode: 'focus' | 'grid';
  onChangeViewMode: (mode: 'focus' | 'grid') => void;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onToggleCameraFacing: () => void;
  mediaRefs: MutableRefObject<Map<string, CameraMediaRefs>>;
  onCameraError: (msg: string | null) => void;
  onFallbackToSimulated: () => void;
  onChangeTab: (tab: TabId) => void;
  streamAccessPassword: string;
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
  onFallbackToSimulated, onChangeTab, streamAccessPassword,
  analysisCameraIds, analyzingCameraIds, onToggleAnalysisCamera, onJumpToLog, onCameraStatusChange
}: MonitorTabProps) {
  const activeCamera = cameras.find(c => c.id === activeCameraId) || cameras[0];
  const [gridFilter, setGridFilter] = useState('');
  const filteredCameras = useMemo(() => {
    const q = gridFilter.trim().toLowerCase();
    if (!q) return cameras;
    return cameras.filter(c => c.name.toLowerCase().includes(q) || c.location?.toString().toLowerCase().includes(q) || c.department?.toLowerCase().includes(q));
  }, [cameras, gridFilter]);
  const latestLogByCamera = useMemo(() => {
    const map = new Map<string, LogEntry>();
    for (const log of logs) if (!map.has(log.cameraId)) map.set(log.cameraId, log);
    return map;
  }, [logs]);

  // A registry that scales to tens of thousands of cameras can't have every
  // one of them mounted as a live React component at once either — that's
  // a DOM/memory ceiling on top of the decode ceiling snapshot mode already
  // addresses. Grid view only ever mounts one page's worth of tiles;
  // switching pages mounts/unmounts freely, which is cheap for a snapshot
  // tile (worst case it just starts a fresh capture cycle) in a way it
  // never was for a live one. Search narrows the underlying set first, so
  // "page 1 of 3,200" only ever happens for a genuinely broad browse, not
  // for someone who already knows which camera they want.
  const GRID_PAGE_SIZE = 24;
  const [gridPage, setGridPage] = useState(0);
  const totalGridPages = Math.max(1, Math.ceil(filteredCameras.length / GRID_PAGE_SIZE));
  const clampedGridPage = Math.min(gridPage, totalGridPages - 1);
  const pagedCameras = useMemo(
    () => filteredCameras.slice(clampedGridPage * GRID_PAGE_SIZE, (clampedGridPage + 1) * GRID_PAGE_SIZE),
    [filteredCameras, clampedGridPage]
  );
  const handleGridFilterChange = (value: string) => { setGridFilter(value); setGridPage(0); };

  // What actually gets a CameraTile mounted: the current grid page (or just
  // the active camera in focus view — the rest of the registry has no
  // reason to be in the DOM until it's paged into view), plus every camera
  // selected for analysis even if it's off-page or a different view mode is
  // active — analysis reads live frames through mediaRefs, which only
  // exist while a camera's tile is actually mounted.
  const pagedIds = useMemo(() => new Set(pagedCameras.map(c => c.id)), [pagedCameras]);
  const mountedCameras = useMemo(() => {
    if (viewMode === 'focus') {
      return cameras.filter(c => analysisCameraIds.has(c.id)); // already always includes activeCameraId
    }
    const offPageAnalysisTargets = cameras.filter(c => analysisCameraIds.has(c.id) && !pagedIds.has(c.id));
    return [...pagedCameras, ...offPageAnalysisTargets];
  }, [viewMode, cameras, analysisCameraIds, pagedCameras, pagedIds]);

  // Watchlist hits float to the top regardless of age — a rare, severe event
  // shouldn't scroll off-screen under a run of routine suspicious-activity
  // alerts. Within each tier, newest first (logs already arrive that way).
  const alertItems = useMemo(() => {
    const items = logs.flatMap(log => log.alerts.map((alert, idx) => ({ log, alert, key: `${log.id}-${idx}` })));
    return items.sort((a, b) => (a.log.isWatchlistMatch === b.log.isWatchlistMatch ? 0 : a.log.isWatchlistMatch ? -1 : 1));
  }, [logs]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
      key="monitor" className="grid xl:grid-cols-4 gap-8"
    >
      <div className="xl:col-span-3 space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {/* A mobile quick-switch strip, not the primary way to find a
              camera at scale — Registry's search is. Capped so a registry
              of thousands doesn't render thousands of pill buttons here
              too; anything beyond the cap is still reachable via search. */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 custom-scrollbar lg:hidden">
            {cameras.slice(0, 50).map(cam => (
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
          {viewMode === 'grid' && (
            <div className="relative w-full sm:w-64 order-last sm:order-none">
              <Search className="w-3.5 h-3.5 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
              <input
                value={gridFilter}
                onChange={(e) => handleGridFilterChange(e.target.value)}
                placeholder="Filter by camera name or location"
                className="input !py-2 !pl-8 text-xs"
              />
            </div>
          )}
          <div className="ml-auto flex items-center gap-1 panel !p-1">
            <button onClick={() => onChangeViewMode('focus')} className={cn('btn-ghost !p-2 !rounded-lg', viewMode === 'focus' && 'bg-surface !text-ink shadow-sm')} title="Focused view">
              <Rows3 className="w-4 h-4" strokeWidth={1.75} />
            </button>
            <button onClick={() => onChangeViewMode('grid')} className={cn('btn-ghost !p-2 !rounded-lg', viewMode === 'grid' && 'bg-surface !text-ink shadow-sm')} title="Grid / video wall">
              <LayoutGrid className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {viewMode === 'grid' && filteredCameras.length === 0 && (
          <div className="card p-10 text-center text-xs text-ink-muted">No cameras match "{gridFilter}".</div>
        )}

        {/* The active camera (and anything selected for analysis) keeps its
            same CameraTile identity across view-mode switches and page
            changes — see mountedCameras above — so a live connection is
            never torn down just because the operator glanced at another
            page. Everything else is only ever mounted for the current grid
            page; in focus mode this is a single "focus box" showing just
            the active camera, in grid mode a normal CSS grid of tiles. */}
        <div
          ref={containerRef}
          className={cn(
            (viewMode === 'grid' && filteredCameras.length > 0)
              ? 'grid sm:grid-cols-2 lg:grid-cols-3 gap-4'
              : viewMode === 'focus'
                ? cn('relative rounded-[2rem] overflow-hidden bg-surface-muted border border-border transition-all duration-300', isFullscreen ? 'rounded-none border-none h-screen w-screen' : 'aspect-video')
                : 'hidden'
          )}
        >
          {mountedCameras.map(cam => (
            <CameraTile
              key={cam.id}
              camera={cam}
              layout={viewMode === 'grid' ? 'grid' : 'focus'}
              hidden={viewMode === 'focus' ? cam.id !== activeCameraId : !pagedIds.has(cam.id)}
              isActive={cam.id === activeCameraId}
              isSelectedForAnalysis={analysisCameraIds.has(cam.id)}
              isCapturing={isCapturing}
              isAnalyzing={analyzingCameraIds.has(cam.id)}
              latestLog={latestLogByCamera.get(cam.id)}
              mediaRefs={mediaRefs}
              onCameraError={cam.id === activeCameraId ? onCameraError : undefined}
              onFallbackToSimulated={cam.id === activeCameraId ? onFallbackToSimulated : undefined}
              streamAccessPassword={streamAccessPassword}
              onSelect={() => onSelectCamera(cam.id)}
              onToggleAnalysis={() => onToggleAnalysisCamera(cam.id)}
              onStatusChange={onCameraStatusChange}
              cameraError={cam.id === activeCameraId ? cameraError : null}
              isFullscreen={isFullscreen}
              onToggleFullscreen={onToggleFullscreen}
              onToggleCameraFacing={onToggleCameraFacing}
            />
          ))}
        </div>

        {viewMode === 'grid' && filteredCameras.length > GRID_PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-ink-muted">
              Showing {clampedGridPage * GRID_PAGE_SIZE + 1}–{Math.min((clampedGridPage + 1) * GRID_PAGE_SIZE, filteredCameras.length)} of {filteredCameras.length} cameras
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setGridPage(Math.max(0, clampedGridPage - 1))}
                disabled={clampedGridPage === 0}
                className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-ink-muted font-medium">Page {clampedGridPage + 1} of {totalGridPages}</span>
              <button
                onClick={() => setGridPage(Math.min(totalGridPages - 1, clampedGridPage + 1))}
                disabled={clampedGridPage >= totalGridPages - 1}
                className="btn-secondary !py-1.5 !px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
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
                <div key={cam.id} className="flex flex-col gap-1 max-w-xl">
                  {analysisCameraIds.size > 1 && (
                    <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wide">{cam.name}</span>
                  )}
                  <p className="text-base text-ink">
                    {latest?.summary || 'No active summary. Activate guard to begin analysis.'}
                  </p>
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
            <h3 className="text-[10px] font-bold text-ink-muted uppercase tracking-widest">Active nodes</h3>
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
                className={cn('w-full p-3.5 rounded-2xl border text-left flex items-center gap-3 cursor-pointer', activeCameraId === cam.id ? 'bg-accent border-accent text-white' : 'bg-surface border-border')}
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
                  className={cn('w-5 h-5 rounded-md flex items-center justify-center cursor-pointer shrink-0', activeCameraId === cam.id ? 'bg-white/15' : 'bg-surface-muted')}
                >
                  <input type="checkbox" checked={analysisCameraIds.has(cam.id)} onChange={() => onToggleAnalysisCamera(cam.id)} className="w-3 h-3 accent-accent cursor-pointer" />
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 card flex flex-col overflow-hidden">
          <div className="p-6 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-widest text-ink">Alert center</h2>
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
                      {log.isWatchlistMatch && <span className="badge badge-critical !py-0.5">Watchlist hit</span>}
                    </div>
                    <p className="text-xs font-semibold leading-tight text-ink">{alert}</p>
                  </div>
                </motion.div>
              ))
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
