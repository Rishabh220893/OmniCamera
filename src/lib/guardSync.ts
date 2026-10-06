import { isSafeCameraUrl } from './cameraUrl';

/**
 * "Activate Guard" hands the cameras it targets to the server worker (serverAnalysis: true in Firestore),
 * and "Pause Guard" takes them back. This decides which cameras to flag or unflag; App.tsx does the writes.
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

export function planGuardSync(input: GuardSyncInput): { enable: string[]; disable: string[] } {
  const byId = new Map(input.cameras.map((c) => [c.id, c] as const));
  const targets = new Set(input.targetIds);
  const wanted = new Set<string>();
  if (input.isCapturing) for (const id of targets) { const c = byId.get(id); if (c && canAnalyzeOnServer(c)) wanted.add(id); }

  const enable = [...wanted].filter((id) => !input.failedIds.has(id) && !byId.get(id)!.serverAnalysis);

  let disable: string[];
  if (input.isCapturing) {
    // Deselected while running: release only what this guard flagged.
    disable = [...input.guardFlaggedIds].filter((id) => !wanted.has(id) && byId.get(id)?.serverAnalysis === true);
  } else {
    // Paused: release what this guard flagged, and (on the pause itself) the cameras it was targeting.
    const release = new Set(input.guardFlaggedIds);
    if (input.wasCapturing) for (const id of targets) release.add(id);
    disable = [...release].filter((id) => byId.get(id)?.serverAnalysis === true);
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
