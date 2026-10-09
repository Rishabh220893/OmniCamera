/**
 * What the Registry's "Playback profiles" panel needs, kept apart from Express so it can be tested: turning stored profiles
 * into display rows, importing saved probe runs, and applying the chosen recipes to the media server.
 */
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { FAILURES_BEFORE_REPLACING_PROFILE, type ProfileRow, type ProfileStore, type ProbeReport } from './cameraProfile';
import { allocateSlots, decide, type EncoderKind, type Recipe } from './cameraRecipe';
import { renderPathsYaml } from './mediaPaths';
import { applyPaths } from './mediaApply';
import { planMedia } from './mediaPlan';
import { mergeProfileFiles } from './profileFiles';
import type { MediaApplyResponse, ProfileSummary, ProfileView, RecipeCode } from '../src/lib/cameraProfileView';
import type { PathBuildOptions } from './mediaPaths';

const RECIPE_CODES: RecipeCode[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

export function profileView(row: ProfileRow, encoder: EncoderKind): ProfileView {
  const r = row.report, s = r.sample, d = r.describe;
  const natural = decide(r, { encoder });
  const dec = decide(r, { encoder, force: (row.override as Recipe | null) ?? undefined });
  const has = !!s && s.frames > 0;
  return {
    cameraId: r.cameraId, site: r.site, probedAt: r.probedAt, failure: r.failure, failureDetail: r.failureDetail, notes: r.notes ?? [],
    codec: d?.codec ?? null, width: d?.width ?? null, height: d?.height ?? null, fps: d?.fps ?? null,
    firstFrameSec: s?.timeToFirstFrameMs != null ? Math.round(s.timeToFirstFrameMs / 100) / 10 : null,
    keyframeGapSec: has ? Math.round(Math.max(s.keyframeIntervalSec?.max ?? 0, s.sinceLastKeyframeSec ?? 0) * 10) / 10 : null,
    reorderSec: s?.maxReorderSec ?? 0,
    damagePer100: has ? Math.round((s.corruptErrors / s.frames) * 100) : null,
    flags: r.flags,
    recipe: dec.recipe, naturalRecipe: natural.recipe, reason: dec.reason, cause: dec.cause ?? dec.reason,
    override: (row.override as RecipeCode | null) ?? null, overrideReason: row.overrideReason,
    transcode: dec.transcode, gridLive: dec.gridLive, speed: dec.speed, webrtcFocus: dec.focusRecipe === 'E', health: dec.health,
    lastFailure: row.lastFailure ? { at: row.lastFailure.probedAt, failure: row.lastFailure.failure, detail: row.lastFailure.detail, inARow: row.lastFailure.inARow, limit: FAILURES_BEFORE_REPLACING_PROFILE } : null,
    pathKind: dec.recipe === 'F' || dec.recipe === 'G' || dec.recipe === 'E' ? 'none' : dec.transcode ? 're-encode' : 'pull',
  };
}

export function summarize(views: ProfileView[], slots: number): ProfileSummary {
  const counts = Object.fromEntries(RECIPE_CODES.map((c) => [c, 0])) as Record<RecipeCode, number>;
  for (const v of views) counts[v.recipe]++;
  const transcoding = views.filter((v) => v.transcode);
  // Every camera asking at once: the highest-health ones get the slots.
  const live = allocateSlots(
    transcoding.map((v) => ({ cameraId: v.cameraId, priority: 1, decision: { recipe: v.recipe as Recipe, reason: v.reason, transcode: true, encode: null, gridLive: v.gridLive, speed: v.speed, focusRecipe: null, health: v.health } })),
    slots,
  ).filter((a) => a.live).length;
  return { counts, total: views.length, needSlots: transcoding.length, slots, liveTogether: live, overrides: views.filter((v) => v.override).length };
}

export async function listViews(store: ProfileStore, site: string, encoder: EncoderKind): Promise<ProfileView[]> {
  const rows = await store.listProfiles(site);
  return rows.map((row) => profileView(row, encoder)).sort((a, b) => a.cameraId.localeCompare(b.cameraId, undefined, { numeric: true }));
}

/** Saves a probe run and what the decision table makes of it. A manual override is kept, and so is an earlier good profile when this probe merely failed. */
export async function saveReport(store: ProfileStore, report: ProbeReport, encoder: EncoderKind): Promise<void> {
  const saved = await store.saveProbe(report);
  if (saved.kept) return; // the earlier good profile stays, and so does the decision made from it
  const dec = decide(report, { encoder });
  await store.saveDecision(report.site, report.cameraId, { ...dec });
}

/** Loads the probe runs saved by scripts/probe-cameras.ts (one merged result per camera) into the store. */
export async function importSaved(store: ProfileStore, site: string, files: string[], encoder: EncoderKind): Promise<number> {
  const reports = mergeProfileFiles(files).filter((r) => r.site === site);
  for (const r of reports) await saveReport(store, r, encoder);
  return reports.length;
}

export interface ApplyMediaOptions {
  site: string;
  encoder: EncoderKind;
  build: PathBuildOptions;
  /** The control API of the media server, e.g. http://127.0.0.1:9997. */
  api: string;
  dryRun: boolean;
  /** Also write this file, so a restart of the media server comes back the same. */
  pathsFile?: string;
  fetchImpl?: typeof fetch;
}

export async function applyToMedia(store: ProfileStore, o: ApplyMediaOptions): Promise<MediaApplyResponse> {
  const rows = await store.listProfiles(o.site);
  const plan = planMedia(rows, { encoder: o.encoder, build: o.build });
  let fileWritten: string | null = null;
  if (!o.dryRun && o.pathsFile) {
    mkdirSync(path.dirname(o.pathsFile), { recursive: true });
    writeFileSync(o.pathsFile, `# Generated from the camera profiles on ${new Date().toISOString()}. Contains the camera login: keep it out of git.\n${renderPathsYaml(plan.paths)}`, { mode: 0o600 });
    try { chmodSync(o.pathsFile, 0o600); } catch { /* not supported on this file system */ }
    fileWritten = o.pathsFile;
  }
  const res = await applyPaths(plan.paths, plan.managed, { api: o.api, dryRun: o.dryRun, fetchImpl: o.fetchImpl });
  return { dryRun: o.dryRun, ...res.diff, errors: res.errors, skipped: plan.skipped, fileWritten };
}
