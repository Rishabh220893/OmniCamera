import type { PlateRead } from './anprClient';

export type PlateSource = 'anpr' | 'gemini' | 'gemini-fallback';

export interface MergedPlates {
  plates: string[];
  reads: Array<{ plate: string; confidence: number; formatValid: boolean; corrected: boolean }>;
  source: PlateSource;
}

const clean = (p: string) => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Decides which plates a frame reports.
 *
 * - ANPR configured and answered: its plates are the plates — even if that is
 *   none. A general vision model asked for plates will happily invent
 *   plausible-looking ones, which is exactly what a watchlist alert must not
 *   be built on.
 * - ANPR not configured: Gemini's plates, as before.
 * - ANPR configured but failed (service down / timeout): fall back to
 *   Gemini's plates and say so, rather than silently losing plate reads.
 */
export function mergePlates(geminiPlates: string[], anpr: { reads: PlateRead[] } | { error: unknown } | null): MergedPlates {
  if (anpr && 'reads' in anpr) {
    const reads = anpr.reads.map((r) => ({ plate: clean(r.text), confidence: r.confidence, formatValid: r.formatValid, corrected: r.corrected }));
    return { plates: [...new Set(reads.map((r) => r.plate).filter(Boolean))], reads, source: 'anpr' };
  }
  const plates = [...new Set(geminiPlates.map(clean).filter(Boolean))];
  return { plates, reads: [], source: anpr ? 'gemini-fallback' : 'gemini' };
}
