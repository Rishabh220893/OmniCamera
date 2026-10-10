import { isSafeCameraUrl } from './cameraUrl';

/**
 * "Analyze" and "Analyze All" hand the cameras they target to the server worker (serverAnalysis: true in Firestore),
 * and "Stop analysis" takes them back. This decides which cameras to flag or unflag; App.tsx does the writes.
 *
 * The flags are saved in the database, so they outlive a session. Starting an analysis therefore makes the set of flagged cameras
 * EXACTLY the targets: a camera flagged by an earlier run (or by "Analyze on server" in Settings) that is not a target is released,
 * otherwise the worker would keep analysing cameras the person did not choose this time. Only an explicit Start or Stop does this;
 * merely opening the app never changes a flag.
 */
export interface GuardCamera {
  id: string;
  useRemoteFeed?: boolean;
  remoteStreamUrl: string;
  serverAnalysis?: boolean;
}

export interface GuardSyncInput {
  isCapturing: boolean;
  /** Cameras the guard currently targets (active / selected / all, depending on scope). */
  targetIds: Iterable<string>;
  cameras: GuardCamera[];
  /** Cameras this guard flagged earlier in this session. */
  guardFlaggedIds: ReadonlySet<string>;
  /** Cameras whose flag write failed; not retried until the guard is paused. */
  failedIds: ReadonlySet<string>;
  /** Whether the guard was on at the previous run (a true -> false change is a pause). */
  wasCapturing: boolean;
}

/** Only remote feeds the server is allowed to fetch can be handed over. */
export const canAnalyzeOnServer = (c: GuardCamera): boolean =>
  Boolean(c.useRemoteFeed) && c.remoteStreamUrl.trim() !== '' && isSafeCameraUrl(c.remoteStreamUrl);

/**
 * The cameras an analysis covers. "all": every camera. Otherwise exactly the ticked ones: the camera in focus is NOT added on its own,
 * so a person who ticks one camera gets one camera.
 */
export function analysisTargets(scope: 'active' | 'selected' | 'all', ticked: Iterable<string>, allIds: Iterable<string>): Set<string> {
  return scope === 'all' ? new Set(allIds) : new Set(ticked);
}

export function planGuardSync(input: GuardSyncInput): { enable: string[]; disable: string[] } {
  const byId = new Map(input.cameras.map((c) => [c.id, c] as const));
  const targets = new Set(input.targetIds);
  const wanted = new Set<string>();
  if (input.isCapturing) for (const id of targets) { const c = byId.get(id); if (c && canAnalyzeOnServer(c)) wanted.add(id); }

  const enable = [...wanted].filter((id) => !input.failedIds.has(id) && !byId.get(id)!.serverAnalysis);

  let disable: string[];
  if (input.isCapturing) {
    // Running: the flagged set is exactly the targets. Anything else still flagged (this run's deselections, or flags left by an
    // earlier run or by Settings) is released.
    disable = input.cameras.filter((c) => c.serverAnalysis === true && !wanted.has(c.id)).map((c) => c.id);
  } else if (input.wasCapturing) {
    // The stop itself: nothing stays flagged, so nothing keeps analysing in the background.
    disable = input.cameras.filter((c) => c.serverAnalysis === true).map((c) => c.id);
  } else {
    // Not running and not just stopped (for example the app was only opened): leave every flag as it is.
    disable = [];
  }
  return { enable, disable };
}

export type GuardScope = 'active' | 'selected' | 'all';

/**
 * Ticking a camera's checkbox means "analyse this one too", which only has an effect in the "selected"
 * scope. In "active" scope (the default) the tick used to be stored but ignored, so the box never looked
 * ticked. A tick there now switches to "selected"; an untick keeps the scope. In "all" every box is ticked
 * already, so a click changes nothing.
 */
export function toggleGuardSelection(scope: GuardScope, selected: ReadonlySet<string>, id: string): { scope: GuardScope; selected: Set<string> } {
  if (scope === 'all') return { scope, selected: new Set(selected) };
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return { scope: 'selected', selected: next };
}
