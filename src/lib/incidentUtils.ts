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
 * How long an alert stays "live" on a camera tile and in the alert window. The app loads the stored logs when it starts, and the newest log of a
 * camera may be days old; an old flag is history (it stays in Logs), not something happening now, so it must not raise a banner or pulse a tile.
 */
export const ALERT_FRESH_MS = 15 * 60_000;

/** True when the log is recent enough to count as happening now. A log with no usable time is not fresh. */
export function isFreshLog(log: Pick<LogEntry, 'timestamp'> | null | undefined, now: number = Date.now(), windowMs: number = ALERT_FRESH_MS): boolean {
  if (!log) return false;
  const t = log.timestamp instanceof Date ? log.timestamp.getTime() : new Date(log.timestamp as unknown as string).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= windowMs && t - now < 5 * 60_000; // not older than the window, and not dated far in the future
}

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
