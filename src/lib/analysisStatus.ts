/**
 * What to tell a person about one camera's AI analysis, from the two facts the server worker writes on the camera
 * (lastAnalysisTime, lastAnalysisError). One place, so the Feed list, the "Ongoing context" panel and the Health tab agree.
 */
export type AnalysisState = 'off' | 'waiting' | 'ok' | 'paused' | 'failing';

export interface AnalysisFacts {
  lastAnalysisTime?: Date | string | null;
  lastAnalysisError?: string | null;
  /** Whether this camera is part of the analysis that is running (or flagged for the server). */
  selected: boolean;
}

export interface AnalysisSummary { state: AnalysisState; text: string; detail?: string; lastAt: Date | null }

/** The worker's own words turned into something a person can act on. Unknown errors are shown as they are. */
export function friendlyAnalysisError(message: string): string {
  if (/^Paused:|^Waiting its turn/i.test(message)) return message;
  if (/Could not capture a frame/i.test(message)) return 'No picture from this camera: the camera grid is not handing over a frame (it may be slow, or refusing the account\'s viewing-time limit).';
  if (/stored source is missing/i.test(message)) return 'This camera\'s stored login is missing; add the camera again.';
  if (/quota|429|rate/i.test(message)) return 'The AI service is limiting requests; it will retry.';
  if (/API key|permission|unauthori[sz]ed|403/i.test(message)) return 'The AI service refused the request (check the API key).';
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}

export function agoText(from: Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

const toDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function summariseAnalysis(f: AnalysisFacts, now = Date.now()): AnalysisSummary {
  const lastAt = toDate(f.lastAnalysisTime);
  const err = f.lastAnalysisError?.trim() || '';
  const since = lastAt ? `Last analysed ${agoText(lastAt, now)}` : 'Never analysed';
  if (err) {
    const paused = /^Paused:|^Waiting its turn/i.test(err);
    return { state: paused ? 'paused' : 'failing', text: paused ? 'Paused, resumes by itself' : 'Not working right now', detail: `${friendlyAnalysisError(err)} ${since}.`, lastAt };
  }
  if (lastAt) return { state: 'ok', text: `Analysed ${agoText(lastAt, now)}`, lastAt };
  if (f.selected) return { state: 'waiting', text: 'Waiting for its first analysis', lastAt };
  return { state: 'off', text: 'Not analysed', lastAt };
}
