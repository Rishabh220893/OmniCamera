/**
 * Generates the media server's camera paths from the camera profiles, and changes a running server to match.
 * Replaces the hand-kept MEDIA_TRANSCODE_IDS list (docs/camera-onboarding-plan.md step 3).
 *
 *   node --import tsx scripts/media-config.ts plan             what each camera would get (no secrets printed)
 *   node --import tsx scripts/media-config.ts write            write media-server/bin/paths.generated.yml (holds the login, mode 600)
 *   node --import tsx scripts/media-config.ts apply            change the RUNNING media server to match, without a restart
 *   node --import tsx scripts/media-config.ts apply --dry-run  show what apply would change
 *
 * Where the profiles come from:  --db (Postgres: PROFILE_DATABASE_URL or DATABASE_URL)  |  --from a.json b.json  |  default: every
 * saved probe run in .demo-logs merged (scripts/probe-cameras.ts). Other options:
 *   --site grid        which site's profiles and login (GRID_EMAIL / GRID_PASSWORD, or GRID_CAM07_EMAIL for one camera)
 *   --encoder none     this machine has no Quick Sync: re-encodes become snapshot-only (default qsv)
 *   --out FILE         where `write` puts the file
 *   --api URL          the media server's control API (default http://127.0.0.1:9997)
 *   --no-prune         `apply` leaves paths alone that the profiles no longer want
 *   --slots N          `plan` also shows how many re-encodes fit at once (default 6)
 * Settings (MEDIA_FFMPEG, MEDIA_TRANSCODE_BITRATE, MEDIA_TRANSCODE_RTSP_PORT, MEDIA_SCALE_FILTER, SOURCE_START_TIMEOUT, SOURCE_CLOSE_AFTER,
 * GRID_RTSP_HOST/PORT/PATH) come from the environment, demo.local and scale.local, with the defaults media-server/entrypoint.sh uses.
 * Start the server with the file:  MEDIA_PATHS_FILE=media-server/bin/paths.generated.yml (scripts/demo.mjs does this when the file exists).
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createProfileStore, type ProfileRow } from '../server/cameraProfile';
import { allocateSlots, type EncoderKind } from '../server/cameraRecipe';
import { renderPathsYaml, type PathBuildOptions } from '../server/mediaPaths';
import { applyPaths } from '../server/mediaApply';
import { planMedia } from '../server/mediaPlan';
import { credentialResolver } from '../server/siteSecrets';
import { loadLocalEnv } from '../server/localEnv';
import { mergeProfileFiles, profileFiles } from '../server/profileFiles';

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('--') && !/\.json$/.test(a)) ?? 'help';
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n: string) => argv.includes(n);
const env = loadLocalEnv();
const site = opt('--site', 'grid');
const encoder = opt('--encoder', 'qsv') as EncoderKind;

if (!['plan', 'write', 'apply'].includes(command)) {
  console.log(readUsage());
  process.exit(command === 'help' ? 0 : 2);
}

function readUsage() {
  return 'Usage: node --import tsx scripts/media-config.ts <plan|write|apply> [--db | --from FILE... ] [--site grid] [--encoder qsv|none] [--out FILE] [--api URL] [--dry-run] [--no-prune] [--slots N]\nSee the comment at the top of the script.';
}

async function loadRows(): Promise<{ rows: ProfileRow[]; from: string }> {
  if (flag('--db')) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.PROFILE_DATABASE_URL || env.DATABASE_URL });
    try { return { rows: await createProfileStore(pool).listProfiles(site), from: 'Postgres' }; } finally { await pool.end(); }
  }
  const named = argv.filter((a) => /\.json$/.test(a));
  const files = named.length ? named : profileFiles();
  if (files.length === 0) throw new Error('No saved probe runs found in .demo-logs. Run scripts/probe-cameras.ts first (or use --db).');
  return { rows: mergeProfileFiles(files).map((report) => ({ report, override: null, overrideReason: null })), from: `${files.length} saved probe run(s)` };
}

const build = (): PathBuildOptions => ({
  site: { host: env.GRID_RTSP_HOST || '103.250.160.189', rtspPort: Number(env.GRID_RTSP_PORT || 8554), pathPrefix: env.GRID_RTSP_PATH || 'stream' },
  credentials: credentialResolver(site, env),
  transcode: {
    ffmpeg: env.MEDIA_FFMPEG || 'ffmpeg', bitrate: env.MEDIA_TRANSCODE_BITRATE || '2500k',
    publishPort: Number(env.MEDIA_TRANSCODE_RTSP_PORT || 18554), scaleFilter: env.MEDIA_SCALE_FILTER || null,
  },
  startTimeout: env.SOURCE_START_TIMEOUT || '60s', closeAfter: env.SOURCE_CLOSE_AFTER || '5s',
});

const { rows, from } = await loadRows();
const plan = planMedia(rows, { encoder, build: build() });
const count = (r: string) => plan.decisions.filter((d) => d.decision.recipe === r).length;
const kind = (id: string) => (plan.paths[id]?.runOnDemand ? 're-encode' : plan.paths[id] ? 'pull' : 'none');

if (command === 'plan') {
  console.log(`Profiles from ${from}, site ${site}, encoder ${encoder}\n`);
  console.log('camera  recipe  path        live in grid  reason');
  for (const d of plan.decisions) {
    const dec = d.decision;
    console.log(`${d.cameraId.padEnd(7)} ${(dec.recipe + (d.override ? ' (override)' : '')).padEnd(7)} ${kind(d.cameraId).padEnd(11)} ${(dec.gridLive ? 'yes' : dec.recipe === 'F' || dec.recipe === 'G' ? '-' : 'snapshots').padEnd(13)} ${dec.reason.slice(0, 110)}`);
  }
  for (const s of plan.skipped) console.log(`skipped ${s.cameraId}: ${s.why}`);
  const reencodes = Object.values(plan.paths).filter((p) => p.runOnDemand).length;
  const slots = Number(opt('--slots', '6'));
  const live = allocateSlots(plan.decisions.map((d) => ({ cameraId: d.cameraId, decision: d.decision, priority: 1 })), slots).filter((a) => a.decision.transcode && a.live).length;
  console.log(`\nRecipes: A ${count('A')}, B ${count('B')}, C ${count('C')}, D ${count('D')}, F ${count('F')}, G ${count('G')}.  ${Object.keys(plan.paths).length} paths: ${reencodes} re-encode, ${Object.keys(plan.paths).length - reencodes} pull.`);
  console.log(`Re-encodes run only while watched, and about ${slots} fit at once on the demo PC (${live} of ${reencodes} could be live together). The app's live-tile cap keeps it under that; the media server does not enforce it.`);
} else if (command === 'write') {
  const out = opt('--out', 'media-server/bin/paths.generated.yml');
  const header = `# Generated by scripts/media-config.ts on ${new Date().toISOString()} from ${from}, site ${site}. Contains the camera login: keep it out of git.\n# ${Object.keys(plan.paths).length} paths (${count('A')} A, ${count('B')} B, ${count('C')} C, ${count('D')} D); F and G cameras have no path.\n`;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, header + renderPathsYaml(plan.paths), { mode: 0o600 });
  try { chmodSync(out, 0o600); } catch { /* not supported on this file system */ }
  console.log(`Wrote ${out}: ${Object.keys(plan.paths).length} paths. Start the media server with MEDIA_PATHS_FILE=${out}`);
  for (const s of plan.skipped) console.log(`skipped ${s.cameraId}: ${s.why}`);
} else {
  const api = opt('--api', `http://127.0.0.1:${env.MEDIA_API_PORT || 9997}`);
  const managed = flag('--no-prune') ? Object.keys(plan.paths) : plan.managed;
  const res = await applyPaths(plan.paths, managed, { api, dryRun: flag('--dry-run') });
  const d = res.diff;
  console.log(`${res.applied ? 'Applied to' : 'Would change'} ${api}: add ${d.add.length}, replace ${d.replace.length}, remove ${d.remove.length}, unchanged ${d.unchanged.length}`);
  if (d.add.length) console.log(`  add: ${d.add.join(', ')}`);
  if (d.replace.length) console.log(`  replace (viewers reconnect): ${d.replace.join(', ')}`);
  if (d.remove.length) console.log(`  remove: ${d.remove.join(', ')}`);
  for (const e of res.errors) console.error(`  FAILED ${e}`);
  for (const s of plan.skipped) console.log(`skipped ${s.cameraId}: ${s.why}`);
  process.exit(res.errors.length ? 1 : 0);
}
