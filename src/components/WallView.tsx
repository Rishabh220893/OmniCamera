import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Hand, Loader2, MonitorPlay, Plus, RefreshCw, Save, Square, Users } from 'lucide-react';
import { cn } from '../lib/utils';
import { CameraConfig } from '../types';
import { PRESET_LABEL, WALL_PRESETS, camerasOf, cellCount, gridOf, visibleCells, type WallLayoutSpec, type WallPreset } from '../lib/wallLayout';
import { WallBusy, wallApi, type WallLayoutRow, type WallStateRow } from '../lib/wallApi';
import { useMediaConfig } from '../lib/mediaServer';
import CameraFeed from './CameraFeed';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HEARTBEAT_MS = 15_000;
const EMPTY: WallLayoutSpec = { preset: '2x2', cells: [null, null, null, null] };

/** The same cameras in a different preset: kept in order, extra ones dropped, new cells empty. */
function reshape(spec: WallLayoutSpec, preset: WallPreset): WallLayoutSpec {
  const custom = preset === 'custom' ? { cols: spec.cols ?? 3, rows: spec.rows ?? 2 } : undefined;
  const n = cellCount(preset, custom);
  const kept = spec.cells.filter((c): c is string => !!c).slice(0, n);
  return { preset, ...(custom ?? {}), cells: Array.from({ length: n }, (_, i) => kept[i] ?? null), ...(spec.tour ? { tour: spec.tour } : {}) };
}

interface Props {
  cameras: CameraConfig[];
  streamAccessEmail: string;
  streamAccessPassword: string;
  isAdmin: boolean;
}

/**
 * Feed > Control Wall (gap A10): a named wall display with a layout (1x1 to 4x4, 1+5, 1+7, 2+8, custom, or a tour through many cameras),
 * any number of viewers and one controller at a time. Everyone attached sees what the controller sets. See docs/video-wall.md.
 */
export default function WallView({ cameras, streamAccessEmail, streamAccessPassword, isAdmin }: Props) {
  const media = useMediaConfig();
  const [walls, setWalls] = useState<WallStateRow[]>([]);
  const [layouts, setLayouts] = useState<WallLayoutRow[]>([]);
  const [wallId, setWallId] = useState('');
  const [state, setState] = useState<WallStateRow | null>(null);
  const [controlId, setControlId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');
  const [tourSeconds, setTourSeconds] = useState(10);
  const [newWall, setNewWall] = useState({ id: '', name: '' });
  const [now, setNow] = useState(() => Date.now());
  const viewerRef = useRef<string | null>(null);
  const controlRef = useRef<string | null>(null);
  controlRef.current = controlId;

  const byId = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setNotice(null);
    try { await fn(); } catch (e) { setNotice({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  };

  const reload = useCallback(async () => {
    try {
      const [w, l] = await Promise.all([wallApi.walls(), wallApi.layouts()]);
      setWalls(w); setLayouts(l);
      setWallId((cur) => cur || w[0]?.wall.id || '');
      setNotice(null);
    } catch (e) { setNotice({ ok: false, text: errText(e) }); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Joining a wall as a viewer, keeping every session alive, and leaving when the wall changes or the view closes.
  useEffect(() => {
    if (!wallId) { setState(null); return; }
    let dead = false;
    viewerRef.current = null; setControlId(null);
    const id = wallId;
    (async () => {
      try {
        const s = await wallApi.attach(id, 'viewer');
        if (dead) { void wallApi.detach(id, s.sessionId, 'viewer').catch(() => undefined); return; }
        viewerRef.current = s.sessionId; setState(s.state); setNotice(null);
      } catch (e) { if (!dead) setNotice({ ok: false, text: errText(e) }); }
    })();
    const beat = setInterval(async () => {
      const calls: Array<Promise<void>> = [];
      if (viewerRef.current) calls.push(wallApi.heartbeat(id, viewerRef.current, 'viewer').then((s) => { if (!dead) setState(s); }).catch(async () => {
        // The viewer session ran out (a sleeping laptop, a long network gap): join again.
        try { const s = await wallApi.attach(id, 'viewer'); if (!dead) { viewerRef.current = s.sessionId; setState(s.state); } } catch { /* shown on the next try */ }
      }));
      if (controlRef.current) calls.push(wallApi.heartbeat(id, controlRef.current, 'controller').then((s) => { if (!dead) setState(s); }).catch(() => {
        if (!dead) { setControlId(null); setNotice({ ok: false, text: 'Your control of the wall ended (it ran out or an administrator took it).' }); }
      }));
      await Promise.all(calls);
    }, HEARTBEAT_MS);
    return () => {
      dead = true; clearInterval(beat);
      if (viewerRef.current) void wallApi.detach(id, viewerRef.current, 'viewer').catch(() => undefined);
      if (controlRef.current) void wallApi.detach(id, controlRef.current, 'controller').catch(() => undefined);
      viewerRef.current = null;
    };
  }, [wallId]);

  const take = (force: boolean) => run('take', async () => {
    try {
      const s = await wallApi.attach(wallId, 'controller', force);
      setControlId(s.sessionId); setState(s.state);
    } catch (e) {
      if (e instanceof WallBusy && isAdmin && !force && window.confirm(`${e.holder} is controlling this wall. Take control from them?`)) { const s = await wallApi.attach(wallId, 'controller', true); setControlId(s.sessionId); setState(s.state); return; }
      throw e;
    }
  });
  const release = () => run('release', async () => { if (controlId) await wallApi.detach(wallId, controlId, 'controller').catch(() => undefined); setControlId(null); const all = await wallApi.walls().catch(() => []); setState(all.find((w) => w.wall.id === wallId) ?? state); });
  const apply = (body: { layoutId: string } | { spec: WallLayoutSpec }) => run('layout', async () => { if (controlId) setState(await wallApi.setLayout(wallId, controlId, body)); });

  const spec = state?.spec ?? EMPTY;
  const grid = gridOf(spec.preset, spec.cols && spec.rows ? { cols: spec.cols, rows: spec.rows } : undefined);
  const shown = state ? visibleCells(spec, now, Date.parse(state.wall.tourStartedAt)) : spec.cells;
  const controlling = !!controlId;
  const maxLive = Math.min(state?.wall.maxLiveTiles ?? 12, media?.maxLiveTiles ?? 12);
  const setCell = (i: number, id: string) => { const cells = [...spec.cells]; cells[i] = id || null; void apply({ spec: { ...spec, cells } }); };
  const startTour = () => void apply({ spec: { ...spec, cells: spec.cells.map(() => null), tour: { intervalS: Math.min(3600, Math.max(5, tourSeconds)), cameraIds: cameras.slice(0, 500).map((c) => c.id) } } });
  const stopTour = () => { const { tour: _t, ...rest } = spec; void apply({ spec: { ...rest, cells: shown.map((c) => c) } }); };
  const saveLayout = () => run('save', async () => {
    const saved = await wallApi.saveLayout({ name: saveName.trim(), spec });
    setSaveName(''); setLayouts(await wallApi.layouts()); setNotice({ ok: true, text: `Saved “${saved.name}”.` });
  });
  const createWall = () => run('create', async () => {
    const s = await wallApi.createWall({ id: newWall.id.trim(), name: newWall.name.trim() || undefined });
    setNewWall({ id: '', name: '' }); await reload(); setWallId(s.wall.id);
  });

  let liveSeen = 0;
  return (
    <div className="space-y-4" data-testid="wall-view">
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <MonitorPlay className="w-4 h-4 text-accent" strokeWidth={1.75} />
        <select value={wallId} onChange={(e) => setWallId(e.target.value)} className="input !py-2 text-sm w-auto" aria-label="Wall" disabled={walls.length === 0}>
          {walls.length === 0 && <option value="">No walls yet</option>}
          {walls.map((w) => <option key={w.wall.id} value={w.wall.id}>{w.wall.name}{w.wall.department ? ` · ${w.wall.department}` : ''}</option>)}
        </select>
        <button onClick={() => void reload()} className="btn-ghost !py-1.5 !px-2 text-xs flex items-center gap-1.5" aria-label="Refresh walls"><RefreshCw className="w-3.5 h-3.5" /></button>
        {state && (
          <span className="text-xs text-ink-muted flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{state.viewers} watching</span>
            {controlling ? <span className="text-success font-semibold">You control this wall</span>
              : state.controller ? <span>{state.controller.uid} controls this wall</span> : <span>Nobody controls this wall</span>}
            {state.layoutName && <span>Layout: {state.layoutName}</span>}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {controlling
            ? <button onClick={release} disabled={!!busy} className="btn-ghost !py-1.5 !px-3 text-xs">Release control</button>
            : <button onClick={() => take(false)} disabled={!!busy || !state} className="btn-primary !py-1.5 !px-3 text-xs flex items-center gap-1.5"><Hand className="w-3.5 h-3.5" />Take control</button>}
        </span>
      </div>

      {notice && <p className={cn('text-xs flex items-start gap-2', notice.ok ? 'text-ink' : 'text-critical')} role={notice.ok ? 'status' : 'alert'}>{!notice.ok && <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}{notice.text}</p>}

      {walls.length === 0 && isAdmin && (
        <div className="card p-4 flex flex-wrap items-end gap-3">
          <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Wall name (letters, digits, - _)</span>
            <input value={newWall.id} onChange={(e) => setNewWall({ ...newWall, id: e.target.value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) })} className="input !py-2 text-sm font-mono" placeholder="control-room-1" /></label>
          <label className="text-xs space-y-1"><span className="text-ink-muted font-semibold">Title (optional)</span>
            <input value={newWall.name} onChange={(e) => setNewWall({ ...newWall, name: e.target.value })} className="input !py-2 text-sm" placeholder="Control room 1" /></label>
          <button onClick={createWall} disabled={!newWall.id || !!busy} className="btn-primary !py-2 !px-4 text-xs flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" />Create wall</button>
        </div>
      )}
      {walls.length === 0 && !isAdmin && <p className="text-xs text-ink-muted">No video walls have been set up for you. An administrator creates them.</p>}

      {controlling && (
        <div className="card p-4 space-y-3" data-testid="wall-controls">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-ink-muted">Layout</span>
            {WALL_PRESETS.filter((p) => p !== 'custom').map((p) => (
              <button key={p} onClick={() => void apply({ spec: reshape(spec, p) })} disabled={!!busy} className={cn('btn-ghost !py-1 !px-2.5 text-xs', spec.preset === p && 'bg-surface-hover font-semibold')}>{PRESET_LABEL[p]}</button>
            ))}
            {layouts.length > 0 && (
              <select aria-label="Saved layouts" value="" onChange={(e) => e.target.value && void apply({ layoutId: e.target.value })} className="input !py-1 text-xs w-auto ml-2">
                <option value="">Saved layouts…</option>
                {layouts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-ink-muted">Tour</span>
            <label className="flex items-center gap-1.5">every <input value={tourSeconds} onChange={(e) => setTourSeconds(Number(e.target.value.replace(/\D/g, '')) || 0)} inputMode="numeric" className="input !py-1 text-xs w-16" /> seconds</label>
            <button onClick={startTour} disabled={!!busy || cameras.length === 0} className="btn-ghost !py-1 !px-2.5 text-xs">Tour all {Math.min(cameras.length, 500)} cameras</button>
            {spec.tour && <button onClick={stopTour} disabled={!!busy} className="btn-ghost !py-1 !px-2.5 text-xs flex items-center gap-1"><Square className="w-3 h-3" />Stop tour</button>}
            <span className="ml-auto flex items-center gap-2">
              <input value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={80} placeholder="Name to save this layout" className="input !py-1 text-xs w-52" />
              <button onClick={saveLayout} disabled={!saveName.trim() || !!busy} className="btn-primary !py-1 !px-3 text-xs flex items-center gap-1.5">{busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save</button>
            </span>
          </div>
          <p className="text-[11px] text-ink-muted">At most {maxLive} cells play live at once on this wall; the others show refreshed pictures. Pick a camera for each cell with the menu in its corner{spec.tour ? ' (not while a tour is running)' : ''}.</p>
        </div>
      )}

      {state && (
        <div
          className="grid gap-2 rounded-2xl"
          style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }}
          data-testid="wall-grid"
        >
          {grid.cells.map((box, i) => {
            const id = shown[i] ?? null;
            const cam = id ? byId.get(id) : undefined;
            const live = !!cam && ++liveSeen <= maxLive;
            return (
              <div
                key={`${i}:${id ?? ''}`}
                className="relative bg-surface-muted border border-border rounded-xl overflow-hidden"
                style={{ gridColumn: `${box.col} / span ${box.colSpan}`, gridRow: `${box.row} / span ${box.rowSpan}`, aspectRatio: `${16 * box.colSpan} / ${9 * box.rowSpan}` }}
                data-testid="wall-cell"
              >
                {cam ? (
                  <CameraFeed camera={cam} isFocused={false} isCapturing={false} shouldConnect liveVideo={live} streamAccessEmail={streamAccessEmail} streamAccessPassword={streamAccessPassword} />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-muted text-center p-3">{id ? `Camera ${id} is not available to you` : 'Empty'}</div>
                )}
                {cam && <span className="absolute left-2 bottom-2 z-10 text-[10px] font-semibold px-2 py-0.5 rounded bg-black/60 text-white max-w-[80%] truncate">{cam.name}</span>}
                {controlling && !spec.tour && (
                  <select aria-label={`Camera for cell ${i + 1}`} value={id ?? ''} onChange={(e) => setCell(i, e.target.value)} className="absolute right-2 top-2 z-20 input !py-0.5 !px-1.5 text-[10px] w-32 bg-surface/90">
                    <option value="">Empty</option>
                    {cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}
      {state && spec.tour && <p className="text-[11px] text-ink-muted">Touring {camerasOf(spec).length} cameras, a new group every {spec.tour.intervalS} s, the same on every screen on this wall.</p>}
    </div>
  );
}
