/**
 * The no-AI detector: motion, intrusion into a zone and activity across a line, from the 64x36 greyscale fingerprint of two
 * consecutive frames. It is what a camera gets when "AI analysis" is switched off for it, and it needs no model call and no key.
 *
 * It is approximate by design. The fingerprint is tiny and frames arrive seconds apart, so it cannot tell a person from a vehicle
 * or a branch in the wind, and it cannot follow an object between frames. It raises the same event types a recorder would
 * (`vms.motion`, `vms.intrusion`, `vms.line_crossing`), so a rule written for those works with either source.
 *
 * Zones and lines are optional per-camera settings (camera.analyzers['local-detector']), in fractions of the picture (0..1):
 *   { zone: { x, y, w, h }, line: { x1, y1, x2, y2 }, motionPercent?: number }
 */
import { diffFingerprints, ffmpegFingerprint, FINGERPRINT_H, FINGERPRINT_W, type Fingerprint } from '../frameGate';
import type { EventDraft } from '../events/schema';
import type { Analyzer, AnalyzerCamera } from './types';

export interface Zone { x: number; y: number; w: number; h: number }
export interface Line { x1: number; y1: number; x2: number; y2: number }
export interface LocalDetectorConfig {
  zone?: Zone;
  line?: Line;
  /** Share of the picture (percent) that must change to count as motion. Default 1.5. */
  motionPercent: number;
}

export const LOCAL_DETECTOR_ID = 'local-detector';
const PIXEL_DELTA = 24;
/** More than this much of the picture changing at once is a light switching or a camera change, not something moving. */
const GLOBAL_CHANGE = 0.6;
/** Share of the zone's pixels that must change for an intrusion. */
const ZONE_FRACTION = 0.08;
/** A changed pixel this close (in fingerprint pixels) to the line counts as touching it. */
const LINE_REACH = 2.5;
const LINE_MIN_PIXELS = 2;

const frac = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Reads the camera's settings; anything malformed is ignored rather than failing the frame. */
export function configOf(camera: AnalyzerCamera): LocalDetectorConfig {
  const raw = (camera.analyzers?.[LOCAL_DETECTOR_ID] ?? {}) as Record<string, unknown>;
  const cfg: LocalDetectorConfig = { motionPercent: 1.5 };
  const z = raw.zone as Record<string, unknown> | undefined;
  if (z && frac(z.x) && frac(z.y) && frac(z.w) && frac(z.h) && z.w > 0 && z.h > 0) cfg.zone = { x: z.x, y: z.y, w: z.w, h: z.h };
  const l = raw.line as Record<string, unknown> | undefined;
  if (l && frac(l.x1) && frac(l.y1) && frac(l.x2) && frac(l.y2) && (l.x1 !== l.x2 || l.y1 !== l.y2)) cfg.line = { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 };
  if (typeof raw.motionPercent === 'number' && raw.motionPercent > 0 && raw.motionPercent <= 50) cfg.motionPercent = raw.motionPercent;
  return cfg;
}

/** Compares two fingerprints and says what moved. Pure, so it is tested without ffmpeg. */
export function detectLocal(prev: Fingerprint, cur: Fingerprint, cfg: LocalDetectorConfig): EventDraft[] {
  if (prev.length !== cur.length || prev.length !== FINGERPRINT_W * FINGERPRINT_H) return [];
  const { changedFraction } = diffFingerprints(prev, cur, PIXEL_DELTA);
  if (changedFraction >= GLOBAL_CHANGE) return [];
  const out: EventDraft[] = [];
  const percent = Math.round(changedFraction * 1000) / 10;
  const changed = (i: number) => Math.abs(prev[i] - cur[i]) > PIXEL_DELTA;

  if (changedFraction * 100 >= cfg.motionPercent) {
    out.push({ type: 'vms.motion', summary: `Movement in the picture (${percent}% changed)`, data: { changedPercent: percent, detector: 'frame-difference' }, tags: ['local'], dedupeKey: 'motion' });
  }

  if (cfg.zone) {
    const x0 = Math.floor(cfg.zone.x * FINGERPRINT_W), x1 = Math.min(FINGERPRINT_W, Math.ceil((cfg.zone.x + cfg.zone.w) * FINGERPRINT_W));
    const y0 = Math.floor(cfg.zone.y * FINGERPRINT_H), y1 = Math.min(FINGERPRINT_H, Math.ceil((cfg.zone.y + cfg.zone.h) * FINGERPRINT_H));
    let n = 0, hit = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; if (changed(y * FINGERPRINT_W + x)) hit++; }
    if (n > 0 && hit / n >= ZONE_FRACTION) {
      out.push({ type: 'vms.intrusion', severity: 'warning', summary: `Movement inside the watched zone (${Math.round((hit / n) * 100)}% of it changed)`, data: { zoneChangedPercent: Math.round((hit / n) * 100), detector: 'frame-difference' }, tags: ['local', 'zone'], dedupeKey: 'zone' });
    }
  }

  if (cfg.line) {
    const ax = cfg.line.x1 * FINGERPRINT_W, ay = cfg.line.y1 * FINGERPRINT_H, bx = cfg.line.x2 * FINGERPRINT_W, by = cfg.line.y2 * FINGERPRINT_H;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let sideA = 0, sideB = 0;
    for (let y = 0; y < FINGERPRINT_H; y++) for (let x = 0; x < FINGERPRINT_W; x++) {
      if (!changed(y * FINGERPRINT_W + x)) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const dist = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (dist > LINE_REACH) continue;
      // Which side of the line the pixel is on (sign of the cross product).
      if (dx * (y - ay) - dy * (x - ax) >= 0) sideA++; else sideB++;
    }
    if (sideA >= LINE_MIN_PIXELS && sideB >= LINE_MIN_PIXELS) {
      out.push({ type: 'vms.line_crossing', severity: 'notice', summary: 'Movement across the watched line', data: { detector: 'frame-difference' }, tags: ['local', 'line'], dedupeKey: 'line' });
    }
  }
  return out;
}

export function createLocalDetectorAnalyzer(deps: { fingerprint?: (jpeg: Buffer) => Promise<Fingerprint | null> } = {}): Analyzer {
  const fingerprint = deps.fingerprint ?? ((jpeg: Buffer) => ffmpegFingerprint(jpeg));
  // The last frame seen per camera. Lost on a restart or when another worker takes the camera: the first frame then only sets the baseline.
  const last = new Map<string, Fingerprint>();
  return {
    id: LOCAL_DETECTOR_ID,
    label: 'Local detector (no AI)',
    description: 'Motion, movement in a zone and movement across a line, from the difference between two frames. Runs when AI analysis is off for the camera.',
    timeoutMs: 6000,
    appliesTo: (camera) => camera.aiAnalysis === false,
    async analyze({ camera, frame }) {
      const fp = await fingerprint(frame.jpeg);
      if (!fp) return {};
      const prev = last.get(camera.id);
      last.set(camera.id, fp);
      if (!prev) return { fields: { summary: 'Local detection (AI analysis is off): watching' } };
      const events = detectLocal(prev, fp, configOf(camera));
      return {
        fields: { summary: events.length ? `Local detection (AI analysis is off): ${events.map((e) => e.summary).join('; ')}` : 'Local detection (AI analysis is off): nothing moved' },
        events,
      };
    },
  };
}
