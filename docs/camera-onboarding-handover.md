# Camera onboarding: handover (steps 1-4 done, step 5 next)

Written 2026-10-09. Read `docs/camera-onboarding-plan.md` for the design and the evidence; this file is where the work stands and what to do next.
The plan has a status section per step. How to operate it day to day is in `docs/media-server.md` ("Paths generated from camera profiles", "The Registry screen").

## 0. Start here: get the code

Steps 1-4 live only on the branch, **not on `main`**. A new session that starts on `main` will not find any of it. First:
```
git fetch origin
git checkout claude/camera-onboarding-step-1-ivp3tf
git pull
npm install
npm test
```
Then work on that branch (commit and push to it). No pull request is needed for that. Open one only when the work should go into `main`; before merging, run the demo on the PC
(`node scripts/demo.mjs up`) and confirm a re-encoded camera plays (section 5, item 1), since that is the one thing the tests cannot show. If it is merged first, start from `main` instead.

## 1. Where things are

- **Branch:** `claude/camera-onboarding-step-1-ivp3tf`, about 15 commits ahead of `main` (`8a04f9e`, see `git log`). **Not merged. No pull request opened.** On the user's demo PC the step-3 start-up
  has been run (the media server came up from the generated paths file); the step-4 screen and the failed-probe rule have not been run there yet (the user was about to test them).
- **Steps:** 1 probe and profile schema, 2 decision engine and synthetic lab, 3 media config generator with live reload, 4 Registry "Playback profiles" screen: **done**.
  5 re-probe and self-healing, 6 load test on the target machine and final docs: **not started**.
- **Tests:** `npm test` gives 203 passing (the camera lab alone takes about 35 s; `SKIP_CAMERA_LAB=1` leaves it out). Two TypeScript errors predate this work
  (`AnalyticsTab.tsx` `Clock`, `MonitorTab.tsx` line ~615); nothing here adds any.

## 2. What exists

| Area | Files | What it does |
|---|---|---|
| Profile and probe | `server/cameraProfile.ts`, `server/cameraProbe.ts`, `server/cameraProbeRun.ts`, `scripts/probe-cameras.ts` | Probe stages 1-3 (reachable, describe, 30 s sample), fault flags, thresholds (`THRESHOLDS`), Postgres store (`camera_profiles`, `probe_runs`). A failed probe keeps an earlier good profile until it has failed 3 times in a row (`FAILURES_BEFORE_REPLACING_PROFILE`). |
| Decision | `server/cameraRecipe.ts` | `decide(report, {encoder, closedEarlyRuns, force})` gives recipe A-G, the reason, `cause`, encode spec, health score; `allocateSlots` shares the transcode slots. |
| Check against known | `server/gridGroundTruth.ts`, `tests/fixtures/grid-2026-10-08.ts`, `scripts/probe-report.ts` | What is known about the grid; the 30 real measurements replayed through the table; a merged table of saved runs. |
| Synthetic lab | `tests/lab/cameraLab.ts`, `scripts/camera-lab.ts`, `tests/cameraLab.test.ts` | ffmpeg makes 15 streams with one fault each; the real probe and table must pick the right recipe. |
| Media paths | `server/mediaPaths.ts`, `server/mediaPlan.ts`, `server/mediaApply.ts`, `server/siteSecrets.ts`, `scripts/media-config.ts`, `media-server/entrypoint.sh` (`MEDIA_PATHS_FILE`) | Profiles to MediaMTX paths (pull, or Quick Sync re-encode), YAML for start-up, and the control API to change a running server (add/replace/remove, idempotent). |
| Screen and API | `src/components/CameraProfilesPanel.tsx`, `src/lib/cameraProfile*.ts`, `server/profileService.ts`, `server/probeJob.ts`, `server.ts` (`/api/camera-profiles/*`) | List, filter, probe, load saved runs, override with a reason, preview and apply. |
| Runner | `scripts/demo.mjs` | Starts the media server from `media-server/bin/paths.generated.yml` when it exists; otherwise from its old built-in re-encode list. |

## 3. How to run it

```
node --import tsx scripts/probe-cameras.ts                 # probe the cameras (about 15 min for 30; 2 at a time; nothing else may use the grid account)
node --import tsx scripts/probe-report.ts --all            # table of every saved run, with the recipe per camera
node --import tsx scripts/media-config.ts plan             # what each camera would get
node --import tsx scripts/media-config.ts write            # writes media-server/bin/paths.generated.yml
node scripts/demo.mjs up                                   # starts the app and the media server from that file
```
Or in the app: Registry > Playback profiles > Load saved probe runs (or Probe) > Preview changes > Apply. Needs `DATABASE_URL`.
Windows PowerShell notes that cost time: call Git Bash by its full path (`& "C:\Program Files\Git\bin\bash.exe" ...`), because plain `bash` may be WSL;
assigning an empty string to `$env:X` deletes the variable, so use `X=` in `scale.local` instead; `node scripts/demo.mjs stop` before probing.

**Tests that need something extra (skipped otherwise):**
- `MEDIAMTX_BIN=<mediamtx> node --import tsx --test tests/mediaApply.test.ts`: against a real MediaMTX 1.21.1 (it caught the `source: publisher` bug).
- `TEST_DATABASE_URL=postgres://user@host/db node --import tsx --test tests/profileStorePg.test.ts`: the store's SQL on a real PostgreSQL.

## 4. What the evidence says (details and numbers in the plan)

- **Grid, 2026-10-08, 28 of 30 cameras gave video.** Recipes: 4 direct (cam01, 02, 03, 05), 19 re-encode, 4 H.265 conversion, 1 re-encode with scale-down (cam26), 2 unsupported
  (cam21, cam22). **24 need a transcode slot and the demo PC fits about 6**, so the slot limit, not the recipe, is the central constraint.
- **Damaged video is what breaks MediaMTX pass-through,** not B-frames or keyframe gaps alone: the grid drops RTP packets upstream, then MediaMTX dies with
  `unable to extract DTS: too many reordered frames`. cam13 and cam14 are damaged-video cameras, not B-frame cameras. The probe's decoder-error rate is the proxy
  (ffmpeg over TCP does not report the loss).
- **The keyframe limit is 7 s** (cam05 played at 6.0 s); nothing clean above that was available to test.
- **The grid limits the account:** a burst of 401s with a login that worked minutes earlier is a limit on its side. Probe 2 at a time, pause and retry, stop after 3.
- **Delivery is intermittent** (cam10, cam11: video one run, none the next), which is why a failed probe must not erase a good profile.

## 5. Not verified, and known gaps

1. **A re-encode has never run from this work.** This session's machine has no Quick Sync. The ffmpeg command is the one proven on the demo PC and a test pins it, but after the step-3
   change nobody has confirmed a re-encoded camera (cam28, cam06) playing in the browser from the generated file.
2. **Open problem from the user, unresolved:** after `node scripts/demo.mjs up` the media server came up on :8888 but `http://localhost:3000` showed "offline". `up` starts the web app after the
   media server and prints READY only when `/api/analysis/status` says the worker runs (up to 3 minutes). The production bundle builds and serves port 3000 here, so my changes are not an
   obvious cause, but it was never reproduced with their Firestore, Redis and Gemini. Asked for: what exactly is on screen (browser error, or the app's own offline mode) and the output after "media server up".
   First try: `node scripts/demo.mjs up --single`.
3. **"Admin only" is weak.** Every new account is an admin and can set its own role in Settings (`firestore.rules`: owner may write their profile). The new endpoints use that same check; with
   `MEDIA_ALLOW_GUESTS=true` (local demo) there is no check. Proposed, not built: `PROFILE_ADMIN_EMAILS` allowlist checked on the verified token.
4. **The app does not act on the plan yet.** `gridLive: false` ("Snapshot in grid") is only a tag; the grid tiles do not read it. F/G cameras lose their path, so a live request fails and the app
   should fall back to snapshots (not tested). `GRID_HEALTH_ORDER` in `src/lib/cameraHealth.ts` is still the hand-kept ranking; the plan says it becomes the computed health score (the score exists in
   `healthScore()` but nothing replaces the list). The `MEDIA_TRANSCODE_IDS` list in `scripts/demo.mjs` remains as the fallback.
5. **The media server does not cap simultaneous re-encodes.** About 6 worked, 7 made one fail. Only the app's `MEDIA_MAX_LIVE_TILES` (6) keeps it under.
6. **Recipe D does not scale** until `MEDIA_SCALE_FILTER` is set and tried (`scale_qsv` failed earlier); cam26 is the only D camera.
7. **Server returns every camera in one answer** (the screen pages 20 at a time); thousands of cameras need server-side paging.
8. **Not measured:** the HLS endpoint `http://<host>/live/stream/<id>/index.m3u8` (and the Cloudflare question), and plan section 2 stage 4 (trying each candidate path through the media server for real).
   `scripts/check-media-health.mjs` does that by hand and is the base for it.
9. **Guessed numbers:** the health-score weights, the 3-failure rule, `corruptPerFrame` 0.1, `timestampMinErrors` 5. All in `THRESHOLDS` / `server/cameraRecipe.ts` / `server/cameraProfile.ts`.
10. **Sign-in as a real Firebase admin was never exercised** (checks used the guest switch). Probing from the screen against the real grid was not run (the job is tested with fakes; the probe itself ran from the CLI).

## 6. Step 5: re-probe and self-healing (plan section 7)

Goal: keep the profiles right after onboarding without a person running scripts.

1. **Self-heal from MediaMTX events.** Classify a runtime failure and move the camera to the next recipe, with hysteresis so it does not flip. The signals already known:
   `unable to extract DTS: too many reordered frames`, `N RTP packets lost` (per second, per path), `[RTSP source] stopped: an error`, ffmpeg exit, a start-up timeout.
   Where to read them: MediaMTX's log (`media-server/bin/mediamtx.log`, format in `scripts/check-media-health.mjs` `logEvents`) or its control API (`/v3/paths/list`, per-path state). Decide which is sturdier.
   Likely rule: a camera on pass-through (A) that produces a muxer error or sustained loss moves to B and is marked so; a re-encode (B/C/D) that keeps dying moves to F; record why and when.
2. **Re-probe on a schedule,** lightly: a quick describe on all, a deep sample only for cameras being watched or analysed, queued and serial per source (plan section 9). `probeJob` already runs a list with
   2 at a time, a 401 pause and a stop; it needs a scheduler and the "watched or analysed" input. Repeat measurements twice and keep the worse one (load changes results).
3. **A gate for simultaneous re-encodes.** `allocateSlots` exists; nothing calls it at run time. Options: a wrapper around the ffmpeg `runOnDemand` command that checks a counter and exits so MediaMTX falls back, or a decision made where the app asks for live video. The result must be a snapshot with a reason, never a silent failure.
4. **A record of recipe changes.** The plan says every change records its reason and a timestamp. Today only overrides keep a reason, and there is no history of recipe changes. Add a table (camera, from, to, reason, source: probe / heal / override, time) and show it on the row.
5. **Feed `closedEarlyRuns`.** `decide()` takes it (one early close is F, two in a row is G) but nothing supplies it yet; the probe history in `probe_runs` has what is needed.
6. Smaller items worth doing in the same pass: act on `gridLive` in the tiles, replace `GRID_HEALTH_ORDER` with the computed score, the `PROFILE_ADMIN_EMAILS` allowlist, and the HLS endpoint measurement.

Tests to keep green while doing it: `tests/cameraRecipe.test.ts` (the 30-camera replay pins 4/19/4/1/2), `tests/mediaPaths.test.ts` (the YAML equals what the shell entrypoint writes), the lab, and the two opt-in real-service tests above.

## 7. Working notes for the next session

- Real services available in the sandbox: MediaMTX (download `mediamtx_v1.21.1_linux_amd64.tar.gz` from GitHub releases into its own folder), PostgreSQL 16 (`/usr/lib/postgresql/16/bin`, run as a non-root user, data in `/var/tmp`, not the scratchpad: its permissions changed and the server died),
  Chromium for Playwright (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, library at `/opt/node-tools/node_modules/playwright`). There is no Quick Sync, no grid access and no Firebase.
- `pkill -f` kills your own shell when the command line contains the pattern. Use the bracket form (`pkill -f "[m]ediamtx"`) and do not start a process in the same command.
- The user runs everything on a Windows PC (Celeron N4020, Intel UHD 600) from PowerShell and gives back pasted output; give commands that work in PowerShell and say what to paste back.
- Credentials are never printed or stored in profiles: `GRID_EMAIL` / `GRID_PASSWORD` (or `STREAM_*`), per camera `GRID_CAM07_EMAIL` / `..._PASSWORD`, read from the environment, `demo.local`, `scale.local`
  (later files win, and both beat the shell).

New settings from this work: `MEDIA_PATHS_FILE`, `MEDIA_ENCODER` (qsv/none), `MEDIA_MAX_TRANSCODES` (6, display only), `MEDIA_API_URL`, `MEDIA_SCALE_FILTER`, `GRID_WHEP_PORT`, `PROFILE_DATABASE_URL`;
for tests `MEDIAMTX_BIN`, `TEST_DATABASE_URL`, `SKIP_CAMERA_LAB`.

## 8. Suggested first message for the next session

"Check out the branch claude/camera-onboarding-step-1-ivp3tf (it is not on main), then read docs/camera-onboarding-handover.md and docs/camera-onboarding-plan.md. Start step 5 (self-healing and re-probe). First tell me what you will do about the items in section 6 and in what order, and
ask about anything that needs my hardware. The 'offline on port 3000' problem in section 5 item 2 is still open: here is the output: ..."
