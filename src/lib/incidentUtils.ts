import { LogEntry } from '../types';

/**
 * High-priority security and physical threat keywords.
 * If these keywords appear in log alerts or unusual reasons, they indicate
 * an actual critical incident requiring immediate operator intervention.
 */
export const CRITICAL_SECURITY_KEYWORDS: readonly string[] = [
  'weapon', 'firearm', 'gun', 'knife', 'blade', 'armed',
  'fire', 'smoke', 'explosion', 'hazard', 'arson', 'flames',
  'break-in', 'forced entry', 'intruder', 'intrusion', 'trespass',
  'burglary', 'robbery', 'theft', 'stolen', 'shoplift',
  'assault', 'violence', 'fight', 'physical altercation', 'struggle',
  'vandalism', 'property damage', 'sabotage',
  'breach', 'perimeter breach', 'fence climbing',
  'unauthorized access', 'unauthorized entry',
  'emergency', 'sos', 'panic', 'distress',
  'hostile', 'malicious activity',
  '[critical]', 'severity: critical', 'threat: critical', 'priority: critical'
];

/**
 * Tightened harness to determine whether a log entry qualifies as an
 * ACTUAL critical alert for the bottom alert window and urgent operator escalation.
 *
 * Excludes routine observations such as:
 * - General crowd size / headcount threshold counts
 * - General vehicle threshold observations
 * - Unknown person with normal/routine behaviour
 * - Brand or clothing detections
 * - Non-threatening advisory notices
 */
export function isActualCriticalIncident(log: LogEntry): boolean {
  if (!log) return false;

  // 1. Explicit critical threat sentiment rated by Gemini Vision
  if (log.sentiment === 'critical') {
    return true;
  }

  // 2. High-priority vehicle watchlist / blacklisted plate match
  if (log.isWatchlistMatch) {
    return true;
  }

  // 3. Scan alerts and unusualReason for genuine critical physical or security threats
  const textCorpus = [
    ...(log.alerts || []),
    log.unusualReason || '',
  ].filter(Boolean).map((t) => t.toLowerCase());

  if (textCorpus.length === 0) {
    return false;
  }

  const hasCriticalKeyword = textCorpus.some((text) =>
    CRITICAL_SECURITY_KEYWORDS.some((kw) => text.includes(kw))
  );

  return hasCriticalKeyword;
}
