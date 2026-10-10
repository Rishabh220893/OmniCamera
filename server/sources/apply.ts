/**
 * Puts the sources' media paths on the running media server (and in the generated file) without re-applying the grid.
 * Used by `POST /api/sources/apply-media`. When the grid's own paths can be planned (a grid login is configured) the generated file gets
 * both, so a restart comes back with everything; when they cannot, only the running server is changed and the file is left alone, because
 * writing it would drop the grid's paths.
 */
import type { ProfileStore } from '../cameraProfile';
import type { EncoderKind } from '../cameraRecipe';
import { applyPaths } from '../mediaApply';
import type { PathBuildOptions } from '../mediaPaths';
import { applyToMedia } from '../profileService';
import type { MediaApplyResponse } from '../../src/lib/cameraProfileView';
import { sourcesMediaPlan } from './media';
import type { SecretBox } from './secretBox';
import { SOURCE_PATH_PREFIX, type SourceStore } from './store';

export interface ApplySourcesOptions {
  profiles: ProfileStore;
  sources: SourceStore;
  box: SecretBox | null;
  encoder: EncoderKind;
  /** Build options for the sources' site (its login callback is never called: every source carries its own address). */
  sourcesBuild: PathBuildOptions;
  /** The grid's site and build options, or null when no grid login is configured. */
  grid: { site: string; build: PathBuildOptions } | null;
  api: string;
  pathsFile?: string;
  dryRun: boolean;
  fetchImpl?: typeof fetch;
}

export async function applySourcesMedia(o: ApplySourcesOptions): Promise<MediaApplyResponse & { gridInFile: boolean }> {
  const extra = await sourcesMediaPlan({ profiles: o.profiles, sources: o.sources, box: o.box, encoder: o.encoder, build: o.sourcesBuild });
  if (o.grid) {
    const res = await applyToMedia(o.profiles, { site: o.grid.site, encoder: o.encoder, build: o.grid.build, api: o.api, dryRun: o.dryRun, pathsFile: o.pathsFile, extra, extraOnly: true, fetchImpl: o.fetchImpl });
    return { ...res, gridInFile: !!res.fileWritten };
  }
  const res = await applyPaths(extra.paths, extra.managed, { api: o.api, dryRun: o.dryRun, fetchImpl: o.fetchImpl, managedPrefixes: [SOURCE_PATH_PREFIX] });
  return { dryRun: o.dryRun, ...res.diff, errors: res.errors, skipped: extra.skipped, fileWritten: null, gridInFile: false };
}
