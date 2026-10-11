/**
 * Why a zone or line drawn for the local detector might never raise anything. The detector runs on the SERVER, on pictures it takes itself, so three
 * things must be true besides the drawing being saved: the camera has a stream address the server can reach, the server's analysis is switched on for it,
 * and the pictures come often enough to catch movement (it compares one picture with the next; a car that crosses the zone between two pictures a minute
 * apart is seen only if it is in one of them).
 */
import type { CameraConfig } from '../types';

export interface LocalWatchProblem {
  id: 'no-stream' | 'worker-missing' | 'server-off' | 'slow-interval';
  text: string;
  fix?: { label: string; patch: Partial<CameraConfig> };
}

/** Pictures further apart than this make movement easy to miss. */
export const GOOD_INTERVAL_SECONDS = 10;
export const FAST_INTERVAL_SECONDS = 5;

export function localWatchProblems(c: Pick<CameraConfig, 'serverAnalysis' | 'interval' | 'useRemoteFeed' | 'remoteStreamUrl'>, serverAnalysisAvailable: boolean): LocalWatchProblem[] {
  const out: LocalWatchProblem[] = [];
  if (!c.useRemoteFeed || !c.remoteStreamUrl) out.push({ id: 'no-stream', text: 'This camera has no stream address, so the server has nothing to watch. Give it a remote stream address first.' });
  if (!serverAnalysisAvailable) out.push({ id: 'worker-missing', text: "The server's analysis is not running (it is off on this server), so nothing is watched whatever is drawn." });
  else if (!c.serverAnalysis) out.push({ id: 'server-off', text: 'Server analysis is OFF for this camera, so the zone is not being watched at all.', fix: { label: 'Turn on server analysis', patch: { serverAnalysis: true } } });
  if ((c.interval || 60) > GOOD_INTERVAL_SECONDS) out.push({
    id: 'slow-interval',
    text: `The server takes a picture every ${c.interval || 60} s. Movement is found by comparing one picture with the next, so a car that crosses the zone in between is missed. For movement use ${FAST_INTERVAL_SECONDS} to ${GOOD_INTERVAL_SECONDS} seconds.`,
    fix: { label: `Check every ${FAST_INTERVAL_SECONDS} seconds`, patch: { interval: FAST_INTERVAL_SECONDS } },
  });
  return out;
}
