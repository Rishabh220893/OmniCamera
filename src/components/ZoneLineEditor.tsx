import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Loader2, RefreshCw, Slash, Square } from 'lucide-react';
import { cn } from '../lib/utils';
import type { CameraConfig } from '../types';
import { gridCamId } from '../lib/mediaServer';
import {
  DEFAULT_MOTION_PERCENT, MOTION_MAX, MOTION_MIN, detectorOf, lineFromDrag, motionLabel, pointIn, withDetector, zoneFromDrag, type DetectorSettings, type Point,
} from '../lib/detectorZones';

interface Props {
  camera: CameraConfig;
  streamAccessEmail: string;
  streamAccessPassword: string;
  onChange: (analyzers: Record<string, unknown> | undefined) => void;
}

type Tool = 'zone' | 'line';

/**
 * Settings > a camera with AI off: draw the zone to watch and the line to watch across on a picture from the camera, and set how sensitive
 * motion is. Saved on the camera as `analyzers['local-detector']` (fractions of the picture) when the settings are saved, which is where
 * the server's local detector reads them. See docs/analytics.md.
 */
export default function ZoneLineEditor({ camera, streamAccessEmail, streamAccessPassword, onChange }: Props) {
  const settings = useMemo(() => detectorOf(camera.analyzers), [camera.analyzers]);
  const [tool, setTool] = useState<Tool>('zone');
  const [picture, setPicture] = useState<string | null>(null);
  const [pictureNote, setPictureNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // The drag lives in a ref as well as in state: pointer events can arrive faster than React renders, and the handlers must see the latest.
  const dragRef = useRef<{ from: Point; to: Point } | null>(null);
  const setDragBoth = (d: { from: Point; to: Point } | null) => { dragRef.current = d; setDrag(d); };

  // An empty object, not undefined: the camera save ignores undefined, which would leave the old zone on the server.
  const apply = useCallback((next: DetectorSettings) => onChange(withDetector(camera.analyzers, next) ?? {}), [camera.analyzers, onChange]);

  const loadPicture = useCallback(async () => {
    const camId = gridCamId(camera.remoteStreamUrl);
    if (!camera.useRemoteFeed || !camera.remoteStreamUrl) { setPicture(null); setPictureNote('This camera has no stream address, so there is no picture to draw on. The shapes still work: they are fractions of the picture.'); return; }
    setLoading(true); setPictureNote(null);
    try {
      const r = await fetch(`/api/camera-snapshot?camId=${encodeURIComponent(camId ?? '')}&url=${encodeURIComponent(camera.remoteStreamUrl)}`, { headers: { 'X-Stream-Password': streamAccessPassword, 'X-Stream-Email': streamAccessEmail } });
      if (!r.ok) throw new Error(`The camera did not give a picture (${r.status}).`);
      const url = URL.createObjectURL(await r.blob());
      setPicture((old) => { if (old) URL.revokeObjectURL(old); return url; });
    } catch (e) { setPicture(null); setPictureNote(`${e instanceof Error ? e.message : 'No picture.'} You can still draw on the grey frame.`); }
    finally { setLoading(false); }
  }, [camera.remoteStreamUrl, camera.useRemoteFeed, streamAccessEmail, streamAccessPassword]);
  useEffect(() => { void loadPicture(); return () => setPicture((old) => { if (old) URL.revokeObjectURL(old); return null; }); }, [camera.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (e: React.PointerEvent) => { const r = boxRef.current?.getBoundingClientRect(); return pointIn(r ?? { left: 0, top: 0, width: 1, height: 1 }, e.clientX, e.clientY); };
  const down = (e: React.PointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); const p = pos(e); setDragBoth({ from: p, to: p }); };
  const move = (e: React.PointerEvent) => { const d = dragRef.current; if (d) setDragBoth({ from: d.from, to: pos(e) }); };
  const up = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const to = pos(e); const from = d.from; setDragBoth(null);
    if (tool === 'zone') { const z = zoneFromDrag(from, to); if (z) apply({ ...settings, zone: z }); }
    else { const l = lineFromDrag(from, to); if (l) apply({ ...settings, line: l }); }
  };

  const live = drag ? (tool === 'zone' ? zoneFromDrag(drag.from, drag.to) : null) : null;
  const liveLine = drag && tool === 'line' ? { x1: drag.from.x, y1: drag.from.y, x2: drag.to.x, y2: drag.to.y } : null;
  const zone = live ?? settings.zone, line = liveLine ?? settings.line;
  const motion = settings.motionPercent ?? DEFAULT_MOTION_PERCENT;
  const pct = (v: number) => `${v * 100}%`;

  return (
    <div className="space-y-3" data-testid="zone-line-editor">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold text-ink">Watch area</span>
        <button type="button" onClick={() => setTool('zone')} className={cn('btn-ghost !py-1 !px-2.5 text-xs flex items-center gap-1.5', tool === 'zone' && 'bg-surface-hover font-semibold')} aria-pressed={tool === 'zone'}><Square className="w-3.5 h-3.5" />Draw zone</button>
        <button type="button" onClick={() => setTool('line')} className={cn('btn-ghost !py-1 !px-2.5 text-xs flex items-center gap-1.5', tool === 'line' && 'bg-surface-hover font-semibold')} aria-pressed={tool === 'line'}><Slash className="w-3.5 h-3.5" />Draw line</button>
        <button type="button" onClick={() => apply({ ...settings, zone: undefined })} disabled={!settings.zone} className="btn-ghost !py-1 !px-2.5 text-xs flex items-center gap-1.5"><Eraser className="w-3.5 h-3.5" />Clear zone</button>
        <button type="button" onClick={() => apply({ ...settings, line: undefined })} disabled={!settings.line} className="btn-ghost !py-1 !px-2.5 text-xs flex items-center gap-1.5"><Eraser className="w-3.5 h-3.5" />Clear line</button>
        <button type="button" onClick={() => void loadPicture()} disabled={loading} className="btn-ghost !py-1 !px-2.5 text-xs flex items-center gap-1.5 ml-auto" aria-label="Get a new picture">{loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}New picture</button>
      </div>

      <div
        ref={boxRef}
        className="relative aspect-video w-full max-w-2xl rounded-xl overflow-hidden bg-surface-muted border border-border touch-none select-none cursor-crosshair"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDragBoth(null)}
        role="img" aria-label="Camera picture to draw the zone and line on" data-testid="zone-canvas"
      >
        {picture && <img src={picture} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" draggable={false} />}
        {!picture && <div className="absolute inset-0 pointer-events-none opacity-40" style={{ backgroundImage: 'linear-gradient(var(--color-border,#8884) 1px, transparent 1px), linear-gradient(90deg, var(--color-border,#8884) 1px, transparent 1px)', backgroundSize: '12.5% 16.66%' }} />}
        {zone && <div className="absolute border-2 border-accent bg-accent/20 pointer-events-none" style={{ left: pct(zone.x), top: pct(zone.y), width: pct(zone.w), height: pct(zone.h) }} data-testid="zone-shape"><span className="absolute -top-5 left-0 text-[10px] font-bold text-accent">Zone</span></div>}
        {line && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none" data-testid="line-shape">
            <line x1={line.x1 * 100} y1={line.y1 * 100} x2={line.x2 * 100} y2={line.y2 * 100} stroke="#f59e0b" strokeWidth="0.8" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 3 }} />
            <circle cx={line.x1 * 100} cy={line.y1 * 100} r="1.2" fill="#f59e0b" /><circle cx={line.x2 * 100} cy={line.y2 * 100} r="1.2" fill="#f59e0b" />
          </svg>
        )}
      </div>
      {pictureNote && <p className="text-[11px] text-ink-muted">{pictureNote}</p>}
      <p className="text-[11px] text-ink-muted">Drag on the picture to draw. <b>Zone</b>: an alert when something moves inside it. <b>Line</b>: an alert when movement touches both sides of it. Without either, only general movement is reported. Press <b>Save settings</b> at the bottom of the page to keep them.</p>

      <label className="block text-xs space-y-1 max-w-md"><span className="font-bold text-ink">Motion sensitivity: {motion}% of the picture must change</span>
        <input type="range" min={MOTION_MIN} max={MOTION_MAX} step={0.5} value={motion} onChange={(e) => apply({ ...settings, motionPercent: Number(e.target.value) })} className="w-full" aria-label="Motion sensitivity" />
        <span className="text-ink-muted">{motionLabel(motion)}</span></label>
    </div>
  );
}
