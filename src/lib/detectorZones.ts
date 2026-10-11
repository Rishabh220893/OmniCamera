/**
 * Zones and lines for the local detector (docs/analytics.md): geometry for the editor screen, and the settings it saves.
 * Everything is in fractions of the picture (0..1), the form `server/analytics/localDetector.ts` reads. Pure: no DOM.
 */

export interface Point { x: number; y: number }
export interface Zone { x: number; y: number; w: number; h: number }
export interface Line { x1: number; y1: number; x2: number; y2: number }
export interface DetectorSettings { zone?: Zone; line?: Line; motionPercent?: number }

export const DETECTOR_ID = 'local-detector';
/** A drag shorter than this (fraction of the picture) is a click, not a shape. */
export const MIN_SHAPE = 0.02;
export const DEFAULT_MOTION_PERCENT = 1.5;
export const MOTION_MIN = 0.5;
export const MOTION_MAX = 20;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const round = (v: number) => Math.round(v * 1000) / 1000;

/** A point in the picture from a pointer position inside the picture's box. */
export function pointIn(box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): Point {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
  return { x: round(clamp01((clientX - box.left) / box.width)), y: round(clamp01((clientY - box.top) / box.height)) };
}

/** The rectangle between two corners, whichever way it was dragged; null when it is too small to mean anything. */
export function zoneFromDrag(a: Point, b: Point): Zone | null {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
  if (w < MIN_SHAPE || h < MIN_SHAPE) return null;
  return { x: round(clamp01(x)), y: round(clamp01(y)), w: round(Math.min(w, 1 - x)), h: round(Math.min(h, 1 - y)) };
}

/** The line between two points; null when they are (nearly) the same point. */
export function lineFromDrag(a: Point, b: Point): Line | null {
  if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_SHAPE) return null;
  return { x1: round(clamp01(a.x)), y1: round(clamp01(a.y)), x2: round(clamp01(b.x)), y2: round(clamp01(b.y)) };
}

/** What the camera document keeps. Empty settings are removed altogether, so a camera with nothing drawn has no `local-detector` entry. */
export function withDetector(analyzers: Record<string, unknown> | undefined, s: DetectorSettings): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(analyzers ?? {}) };
  const clean: Record<string, unknown> = {};
  if (s.zone) clean.zone = s.zone;
  if (s.line) clean.line = s.line;
  if (s.motionPercent !== undefined && s.motionPercent !== DEFAULT_MOTION_PERCENT) clean.motionPercent = Math.min(MOTION_MAX, Math.max(MOTION_MIN, s.motionPercent));
  if (Object.keys(clean).length) next[DETECTOR_ID] = clean; else delete next[DETECTOR_ID];
  return Object.keys(next).length ? next : undefined;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Reads the saved settings back the same strict way the server does (anything malformed is ignored), so the screen shows what the server will use. */
export function detectorOf(analyzers: Record<string, unknown> | undefined): DetectorSettings {
  const raw = (analyzers?.[DETECTOR_ID] ?? {}) as Record<string, unknown>;
  const out: DetectorSettings = {};
  const z = raw.zone as Record<string, unknown> | undefined;
  if (z && num(z.x) && num(z.y) && num(z.w) && num(z.h) && z.w > 0 && z.h > 0) out.zone = { x: z.x, y: z.y, w: z.w, h: z.h };
  const l = raw.line as Record<string, unknown> | undefined;
  if (l && num(l.x1) && num(l.y1) && num(l.x2) && num(l.y2) && (l.x1 !== l.x2 || l.y1 !== l.y2)) out.line = { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 };
  if (typeof raw.motionPercent === 'number' && raw.motionPercent > 0 && raw.motionPercent <= 50) out.motionPercent = raw.motionPercent;
  return out;
}

/** A sentence on how sensitive a motion setting is, for the slider. */
export function motionLabel(percent: number): string {
  if (percent <= 1) return 'Very sensitive: small movements count';
  if (percent <= 3) return 'Normal';
  if (percent <= 8) return 'Less sensitive: only larger movements count';
  return 'Low: only big changes count';
}
