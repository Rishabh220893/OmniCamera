/**
 * The media-server paths for the cameras onboarded through adapters. The grid's paths come from `planMedia` with the site's address;
 * these come from the same `planMedia`, with each camera's own stored address instead (`sourceUrlFor`). The two are merged into one
 * generated file and one apply, so neither erases the other when the media server restarts.
 */
import type { ProfileStore } from '../cameraProfile';
import type { EncoderKind } from '../cameraRecipe';
import type { PathBuildOptions } from '../mediaPaths';
import { planMedia, type MediaPlan } from '../mediaPlan';
import { openSourceAddress } from './address';
import type { SecretBox } from './secretBox';
import { SOURCES_SITE, type SourceStore } from './store';

export async function sourcesMediaPlan(o: { profiles: ProfileStore; sources: SourceStore; box: SecretBox | null; encoder: EncoderKind; build: PathBuildOptions }): Promise<MediaPlan> {
  const [rows, recs] = await Promise.all([o.profiles.listProfiles(SOURCES_SITE), o.sources.list(SOURCES_SITE)]);
  const urls = new Map<string, string>();
  const unreadable: Array<{ cameraId: string; why: string }> = [];
  for (const r of recs) {
    try { urls.set(r.cameraId, openSourceAddress(r, o.box).rtspUrl); }
    catch (e) { unreadable.push({ cameraId: r.cameraId, why: e instanceof Error ? e.message : 'the stored address cannot be read' }); }
  }
  const plan = planMedia(rows, { encoder: o.encoder, build: { ...o.build, sourceUrlFor: (id) => urls.get(id) ?? null, requireSource: true } });
  return { ...plan, skipped: [...plan.skipped.filter((s) => !unreadable.some((u) => u.cameraId === s.cameraId)), ...unreadable] };
}
