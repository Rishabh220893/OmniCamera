import { decide, type Decision, type EncoderKind, type Recipe } from './cameraRecipe';
import type { ProfileRow } from './cameraProfile';
import { buildPaths, type PathBuildOptions, type PathPlan } from './mediaPaths';
import { credentialResolver } from './siteSecrets';

export interface MediaPlan extends PathPlan {
  decisions: Array<{ cameraId: string; decision: Decision; override: string | null }>;
  /** Every camera this plan is responsible for: a path for one of these that is no longer wanted gets removed. */
  managed: string[];
}

/** Profiles (with any manual override) -> decisions -> the MediaMTX paths that serve them. */
export function planMedia(rows: ProfileRow[], o: { encoder: EncoderKind; build: PathBuildOptions }): MediaPlan {
  const decisions = rows.map((row) => ({
    cameraId: row.report.cameraId,
    override: row.override,
    decision: decide(row.report, { encoder: o.encoder, force: (row.override as Recipe | null) ?? undefined }),
  }));
  const { paths, skipped } = buildPaths(decisions, o.build);
  return { decisions, paths, skipped, managed: decisions.map((d) => d.cameraId) };
}

/**
 * The settings for building a site's paths, from the environment (demo.local and scale.local are merged into it by the scripts).
 * Defaults are the ones media-server/entrypoint.sh uses.
 */
export function pathBuildOptionsFromEnv(site: string, env: Record<string, string | undefined>): PathBuildOptions {
  return {
    site: { host: env.GRID_RTSP_HOST || '103.250.160.189', rtspPort: Number(env.GRID_RTSP_PORT || 8554), pathPrefix: env.GRID_RTSP_PATH || 'stream' },
    credentials: credentialResolver(site, env),
    transcode: {
      ffmpeg: env.MEDIA_FFMPEG || 'ffmpeg', bitrate: env.MEDIA_TRANSCODE_BITRATE || '2500k',
      publishPort: Number(env.MEDIA_TRANSCODE_RTSP_PORT || 18554), scaleFilter: env.MEDIA_SCALE_FILTER || null,
    },
    startTimeout: env.SOURCE_START_TIMEOUT || '60s', closeAfter: env.SOURCE_CLOSE_AFTER || '5s',
  };
}
