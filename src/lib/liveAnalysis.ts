/**
 * The AI view of a camera opened full screen describes the picture every 10 seconds. Each description that matters is saved as a log entry
 * (so it is in the Logs section and in the camera's history), but a quiet scene would otherwise add six identical entries a minute.
 * So an answer is saved when it is the first, when what it reports has changed, when it is flagged unusual and the previous one was not, and otherwise at most
 * once a minute.
 */

export interface LiveAnswerFacts { people: number; vehicles: number; plates: string[]; alerts: string[]; unusual: boolean }
export interface LiveMark { at: number; key: string; unusual: boolean }

/** What an answer reports, without its wording (a model words the same scene differently every time). */
export function factsKey(f: LiveAnswerFacts): string {
  return [f.people, f.vehicles, [...f.plates].sort().join(','), [...f.alerts].map((a) => a.toLowerCase()).sort().join(','), f.unusual ? 'U' : ''].join('|');
}

export const HEARTBEAT_MS = 60_000;

export function shouldRecord(prev: LiveMark | null, facts: LiveAnswerFacts, now: number, heartbeatMs = HEARTBEAT_MS): boolean {
  if (!prev) return true;
  if (facts.unusual && !prev.unusual) return true;
  if (factsKey(facts) !== prev.key) return true;
  return now - prev.at >= heartbeatMs;
}

export function markOf(facts: LiveAnswerFacts, now: number): LiveMark { return { at: now, key: factsKey(facts), unusual: facts.unusual }; }

/** The facts in a frame-analysis answer (tolerant of missing fields). */
export function factsFromAnswer(d: Record<string, unknown>): LiveAnswerFacts {
  const counts = (d.counts ?? {}) as { people?: unknown; vehicles?: unknown };
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return { people: Number(counts.people) || 0, vehicles: Number(counts.vehicles) || 0, plates: strs(d.detected_plates), alerts: strs(d.alerts), unusual: !!d.isUnusual };
}
