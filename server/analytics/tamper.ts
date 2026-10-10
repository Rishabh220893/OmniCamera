/**
 * A camera that has been covered, spray-painted, switched to a dark room or blinded by light looks like a very flat picture.
 * This analyzer measures that from the 64x36 greyscale fingerprint (no model call), so it is cheap enough to run on every frame
 * and shows that an analyzer does not have to be AI.
 *
 * It sees only frames the frame gate lets through (a covered camera is a change once, then "unchanged"), so a blocked camera is
 * re-checked at the gate's heartbeat (10 minutes by default).
 */
import { ffmpegFingerprint, type Fingerprint } from '../frameGate';
import type { Analyzer } from './types';

export interface TamperThresholds {
  /** Mean brightness (0-255) at or below this is "dark"; at or above `brightMean` is "overexposed". */
  darkMean: number;
  brightMean: number;
  /** Brightness spread (standard deviation) below this means there is no picture detail to speak of. */
  flatStdDev: number;
  /** A dark or bright picture only counts as covered or blinded when it is also this flat; a night scene with lights has more spread. */
  extremeStdDev: number;
}

export const DEFAULT_TAMPER: TamperThresholds = { darkMean: 12, brightMean: 243, flatStdDev: 4, extremeStdDev: 10 };

export type TamperVerdict = { state: 'ok' } | { state: 'dark' | 'overexposed' | 'blocked'; mean: number; stdDev: number };

export function judgeFingerprint(fp: Fingerprint, t: TamperThresholds = DEFAULT_TAMPER): TamperVerdict {
  if (fp.length === 0) return { state: 'ok' };
  let sum = 0;
  for (const v of fp) sum += v;
  const mean = sum / fp.length;
  let sq = 0;
  for (const v of fp) sq += (v - mean) ** 2;
  const stdDev = Math.sqrt(sq / fp.length);
  const round = (n: number) => Math.round(n * 10) / 10;
  // Dark and overexposed are told apart first: a covered lens is dark AND flat, and "dark" is the more useful word than "blocked".
  if (mean <= t.darkMean && stdDev < t.extremeStdDev) return { state: 'dark', mean: round(mean), stdDev: round(stdDev) };
  if (mean >= t.brightMean && stdDev < t.extremeStdDev) return { state: 'overexposed', mean: round(mean), stdDev: round(stdDev) };
  if (stdDev < t.flatStdDev) return { state: 'blocked', mean: round(mean), stdDev: round(stdDev) };
  return { state: 'ok' };
}

const SUMMARY = {
  dark: 'The picture is almost black (lens covered, lights off or camera failure)',
  overexposed: 'The picture is almost all white (lens blinded or camera failure)',
  blocked: 'The picture has no detail (lens covered or painted over)',
} as const;

export function createTamperAnalyzer(deps: { fingerprint?: (jpeg: Buffer) => Promise<Fingerprint | null>; thresholds?: Partial<TamperThresholds> } = {}): Analyzer {
  const fingerprint = deps.fingerprint ?? ((jpeg: Buffer) => ffmpegFingerprint(jpeg));
  const t = { ...DEFAULT_TAMPER, ...deps.thresholds };
  return {
    id: 'camera-tamper',
    label: 'Camera blocked or dark',
    description: 'Flags a picture with no detail, an almost black or almost white picture, from pixel statistics alone (no model call).',
    timeoutMs: 6000,
    async analyze({ frame }) {
      const fp = await fingerprint(frame.jpeg);
      if (!fp) return {};
      const v = judgeFingerprint(fp, t);
      if (v.state === 'ok') return {};
      return {
        events: [{ type: `camera.${v.state}`, severity: 'warning', summary: SUMMARY[v.state], data: { mean: v.mean, stdDev: v.stdDev }, tags: ['tamper'] }],
      };
    },
  };
}
