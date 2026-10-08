# Plan: a camera profile that picks each camera's best playback path

Status: **plan only, nothing built yet** (written 2026-10-08; the five open decisions were answered the same day, see
"Decisions" below). Today every special case is hand-kept and keyed on a grid
camera id: `MEDIA_TRANSCODE_IDS` in `scripts/demo.mjs`, `GRID_HEALTH_ORDER` in `src/lib/cameraHealth.ts`, notes in
`docs/media-server.md`. A real deployment has cameras with other names, codecs and faults, so this plan replaces those
lists with something every new camera goes through.

## Core idea

1. **A probe at onboarding** measures what the camera actually does.
2. **A profile** records the result.
3. **A decision table** maps the profile to one playback recipe.
4. **MediaMTX config is generated** from the profiles.

Every new camera follows the same template, whatever it is called. Nothing is keyed on `cam06`.

## 0. What every camera looks like (given)

Every camera is published as a **live RTP/RTSP stream**. One second of video takes one second to arrive, frames carry
monotonic presentation timestamps (PTS), and there is no seeking, no byte-range fetching and no way to run ahead of real
time. Each endpoint is treated like a physical camera on an operational network. Three endpoints per camera:

| Protocol | Endpoint | Intended for |
|---|---|---|
| RTSP | `rtsp://<host>:8554/stream/<id>` | AI inference (OpenCV, GStreamer, FFmpeg, DeepStream) |
| WebRTC (WHEP) | `http://<host>:8889/stream/<id>/whep` | Low-latency browser preview |
| HLS | `http://<host>/live/stream/<id>/index.m3u8` | Dashboards, mobile, restricted networks |

Consequences for the design:

- **A probe takes as long as it samples.** A 30 s sample costs 30 s of wall time per camera; it cannot be sped up. Deep
  probes are therefore budgeted and queued (section 9).
- **Probe every endpoint, use each for what it is for.** RTSP is the ingest and analysis path (the media server and the
  server-side capture pull it); WHEP and HLS are measured as browser-facing candidates and as fallbacks.
- **Monotonic PTS is a given,** so timestamp problems are treated as a camera or network fault to record, not something
  to assume away.
- **Out of scope for now:** ONVIF discovery, NVR/VMS vendor URL templates, and cameras that are not RTSP/WHEP/HLS endpoints
  of this shape. The schema leaves room for them.

## 1. What the profile records

Profiles live in **Postgres** (see Decisions): a `camera_profiles` row per camera (current profile, chosen recipe, reason,
override) and a `probe_runs` table for history (one row per probe with its raw measurements and report).

| Group | Fields |
|---|---|
| Access | Protocols that answer (RTSP, WHEP, HLS, ONVIF, snapshot URL), auth type, transport that works (TCP or UDP), name and location if available |
| Encoding | Codec, profile, B-frames and reorder depth, resolution, fps, bitrate, audio |
| Behaviour | Time to first frame, keyframe interval, packet loss, corrupt-frame errors, whether the stream drops or ends early |
| Per path | Time to a working HLS playlist, muxer errors, ffmpeg exit codes |
| Meta | When it was probed, probe version, confidence (how many repeats agreed) |

## 2. The onboarding probe, cheapest step first

Each stage has a timeout and a named failure result.

1. **Reachability:** DNS, TCP and auth. A failure here is "unreachable" or "bad credentials", never "no video".
2. **Describe:** `ffprobe` for codec, resolution, fps and B-frame hints (a few seconds).
3. **Sample, 30-60 s over TCP:** keyframe interval, packet loss, time to first frame, corrupt-frame errors, timestamp problems.
4. **Try the candidate paths for real:** run each viable recipe through the actual media server; measure time to a playlist and any muxer errors.
5. **Decide**, store the profile, and keep the probe report as proof.

## 3. Problems already seen, as classes

| Class | Seen on | Detected by |
|---|---|---|
| H.265 | cam06, 12, 17, 22, 26 | Codec in step 2 |
| B-frames break the HLS muxer ("too many reordered frames") | cam09, 13, 14, 24, 27, 28 | Muxer error in step 4 |
| Sparse keyframes (HLS segments grow to 59 s) | cam30 | Keyframe interval in step 3 |
| Very high resolution | cam26 (1440p) | Step 2 |
| Heavy packet loss | cam06 and others | Step 3 |
| Connected but no frame | cam07, 08, 10, 22 | Step 3 times out |
| Stream closes early | cam18 | Step 3 |
| Slow first frame | cam11, 15 | Step 3 |
| Fine alone, fails under load | cam25 | Step 3 repeated |
| Bad credentials, unreachable | not seen yet | Step 1 |

## 4. Recipes and the decision table

| Recipe | Chosen when |
|---|---|
| **A. Pass-through HLS** | Clean H.264: no B-frames, keyframe gap up to about 7 s, little decoder damage |
| **B. H.264 re-encode** | H.264 with B-frames, keyframes sparser than about 7 s, or damaged video |
| **C. H.265 to H.264** | H.265 or another codec the browser path cannot use |
| **D. Downscale re-encode** | Above 1080p (cut the cost before it hits the transcode budget) |
| **E. Direct WebRTC (WHEP)** | Only for the focused camera, if WHEP works and the codec fits |
| **F. Snapshot only** | Video is unusable, or no transcode capacity is left |
| **G. Unsupported, with a reason** | Unreachable, no frames, or the stream keeps closing |

Rules are ordered so each camera lands on the cheapest recipe that works. The existing tile policy stays: grid tiles are
stills, live video is for the focused camera, analysis targets and the visible page.

**Start-up time threshold: 30 seconds** to the first picture. A camera whose chosen recipe is measured above that gets
snapshots in the grid and goes live only when focused; a camera under 10 s is tagged "fast" and preferred for the visible
page. (On 2026-10-07 only about 9 of 29 grid cameras were under 10 s before any re-encode.)

## 5. Capacity

- **Target hardware: Intel PCs like the demo PC (Quick Sync).** Recipes B, C and D use `hevc_qsv` / `h264_qsv`. Still
  detect the available encoder at startup (Quick Sync, NVENC, AMF or none) so a machine without one degrades cleanly
  instead of failing; NVENC and software encoders are not built in this phase.
- **Cost per recipe:** pass-through is free, a re-encode takes a transcode slot. Measured on the demo PC (Celeron N4020):
  about six concurrent transcodes worked, seven made one fail until its restart. The slot count is a per-machine setting,
  default 6 here, and should be re-measured on any other PC.
- **Admission control:** when slots run out, lower-priority cameras fall back to snapshot (F) rather than failing silently.
- **No encoder available:** H.265 and B-frame cameras go to F. Never run software transcoding on weak hardware.

## 6. Generating the media server config

- MediaMTX paths are built from profiles; `media-server/entrypoint.sh` reads them instead of `MEDIA_TRANSCODE_IDS`.
- Changes apply through MediaMTX's API without a full restart.
- Credentials: **one secret reference per site, with an optional per-camera override.** Secrets stay in server settings
  (environment or a secret store) and are referenced by name from the camera or site record; they are never stored in the
  profile or the camera document. The global `GRID_*` login becomes the secret of the "grid" site.
- `GRID_HEALTH_ORDER` becomes a health score computed from the profile.

## 7. Keeping it right after onboarding

- **Re-probe on a schedule** (lightly), and after repeated failures.
- **Self-heal:** classify a runtime failure from MediaMTX events (a DTS error, an ffmpeg exit code, a timeout) and move the
  camera to the next recipe, with hysteresis so it does not flip back and forth.
- **Manual override** per camera. Every change records its reason and a timestamp.
- **History is kept**, so any failure in a demo can be explained with timestamped proof (as `scripts/probe-grid.mjs` does today).

## 8. Testing "all permutations"

The full cross product is far too large, so:

1. **Dimensions, covered pairwise:** codec (H.264, H.264 with B-frames, H.265, MJPEG, AV1, unknown), transport (RTSP TCP or
   UDP, HLS, WHEP, HTTP MJPEG), keyframe interval (under 2 s to over 15 s), resolution (720p to 4K), fps (under 5 to 30),
   packet loss (0 to over 5%), time to first frame, auth type, reachability. Every interaction that matters is tested at
   least once.
2. **A synthetic camera lab:** ffmpeg generates test RTSP streams for each type with injected faults (B-frames, long GOP,
   H.265, high resolution, packet loss, dropped connections, wrong credentials). The probe and decision engine run against
   it in automated tests, with no real cameras needed.
3. **The real grid as ground truth:** the decision engine must reproduce what we already know: cam06 -> C, cam28 -> B,
   cam30 -> B, cam07/08/10/18/22 -> G.

## 9. Scale

At 80,000 cameras a 30-60 s probe for each is not possible (the streams are real time, so it cannot be sped up), and it
would use up each account's watch time on the grid. So:

- Run a quick describe on every camera at onboarding.
- Run the deep probe only on cameras that get watched or analysed, queued with a rate limit and serial per source.
- Repeat measurements twice and keep the worse one; load changes results (cam25 failed 4-at-a-time but took 3.2 s alone).

## 10. Order of work

| Step | Work |
|---|---|
| 1 | Profile schema, plus a probe command running steps 1-3 on all 30 grid cameras, checked against the ground truth |
| 2 | Decision engine and the synthetic lab with its tests |
| 3 | Config generator replacing `MEDIA_TRANSCODE_IDS`, with hot reload |
| 4 | Onboarding step in the Registry UI: results, recommended path, override |
| 5 | Re-probe and self-healing |
| 6 | Load test on the target machine, and docs |

## Decisions (confirmed 2026-10-08)

| # | Question | Decision | Effect on the plan |
|---|---|---|---|
| 1 | Where do profiles live? | **Postgres** | `camera_profiles` (current profile, recipe, reason, override) and `probe_runs` (history and reports). The demo runner and the scale-out path already use Postgres. Cameras themselves stay in Firestore and reference the profile by camera id. |
| 2 | Production hardware | **Intel PCs like the demo PC** | Quick Sync only (`hevc_qsv`, `h264_qsv`); about 6 concurrent transcodes per machine; no NVENC or software transcoding in this phase; snapshot-only when no slot is free. |
| 3 | What the cameras are | **Live RTP/RTSP streams on three endpoints** (RTSP, WHEP, HLS), real time, monotonic PTS, no seeking (section 0) | The probe measures all three endpoints; RTSP is the ingest/analysis path. ONVIF and NVR/VMS are out of scope for now. |
| 4 | Credentials | **Per-site secret with optional per-camera override** | Secrets are referenced by name, never stored in the profile or camera record (section 6). |
| 5 | Time to first picture | **Under 30 seconds** | Cameras measured above 30 s are snapshot-only until focused; under 10 s is tagged "fast" (section 4). |

## Step 1 status

Built: `server/cameraProfile.ts` (profile types, parsing, fault flags, Postgres schema and store), `server/gridGroundTruth.ts`
(what is already known, used only to check a run), `scripts/probe-cameras.ts` (stages 1-3, `--db` to save to Postgres) and
`scripts/probe-report.ts` (merges saved runs into one table and re-applies the current flag rules).
Run: `node --import tsx scripts/probe-cameras.ts`, then `node --import tsx scripts/probe-report.ts --all`.

Result of the first full runs on the grid (2026-10-08, 28 of 30 cameras gave video):

- H.265: cam06, 12, 17, 18, 22, 26 (cam18 was not on the earlier list). cam26 is 1440p.
- B-frames (packets reordered by 0.4-8.5 s): cam07, 08, 09, 24, 25, 27, 28, 29, and by the decoder's hint cam10, 11.
  **cam13 and cam14 show none** in two runs, so the earlier note that they were B-frame cameras is not supported.
- Keyframe gaps over 5 s: 19 cameras, up to about 30 s. **Only about four cameras would pass through unchanged**
  (cam01 and cam03 cleanly; cam02 and cam14 with caveats: cam02 has timestamp problems, cam14 sits just under the 5 s limit). Plan for most of the grid needing a re-encode, which makes the
  6-transcode limit and admission control (section 5) the central constraint, not an edge case. The 5 s threshold itself
  should be tested: whether MediaMTX plays a 6-10 s gap fine is a stage 4 question.
- Time to first frame: 12 cameras are over 15 s, cam07 and cam11 over 30 s. Delivery is not stable: cam10 and cam11 gave
  video in one run and none in the next, so a profile needs repeated probes (section 9).
- Decoder damage is common (more than 10 error lines per 100 frames on 25 cameras), which probably explains the smeared
  picture seen on cam06. It is flagged but does not change the recipe.
- A burst of 401s mid-run, with the same login accepted before and after, is the grid limiting the account, not bad
  credentials. Probe 2 cameras at a time, with nothing else using the account.

## Pass-through test through MediaMTX (2026-10-08)

Eight cameras were run through the local MediaMTX with no re-encoding (`scripts/check-media-health.mjs`, 60 s each):

| Camera | Keyframe gap | Decoder errors /100 frames | Result through MediaMTX |
|---|---|---|---|
| cam01 | 2.0 s | 0 | played: 26 segments, first after 5.2 s, no loss |
| cam05 | 6.0 s | 3 | played: 24 segments, first after 7.8 s, no errors |
| cam14 | 4.9 s | 25 | muxer crash, 3 segments, 1304 RTP packets lost |
| cam13 | 9.5 s | 21 | muxer crash, 3 segments, 2568 lost |
| cam15 | 6.9 s | 18 | muxer crash, no playlist |
| cam20 | 8.4 s | 90 | muxer crash, no playlist, 1550 lost |
| cam23 | 8.4 s | 111 | muxer crash, no playlist, 2053 lost |
| cam04 | 26 s | 40 | no playlist, 5887 lost |

What it shows (a correlation across 8 cameras, not a proof of cause):

- **The keyframe gap alone is not the problem.** cam05 played at 6.0 s. The limit is now 7 s; nothing clean above 6.0 s was available to test.
- **Damaged video is.** Every camera with more than about 15 decoder errors per 100 frames crashed MediaMTX's HLS muxer or got no playlist;
  the two with 0-3 played. The grid drops RTP packets before they reach us (MediaMTX counted 1300-5900 lost over TCP, which ffmpeg does not
  report), and MediaMTX's H.264 handling does not survive the gaps. The probe's decoder-error rate is the proxy for it.
- **Confirmed for cam14 from the MediaMTX log:** the stream started cleanly (02:13:50), RTP packet loss began at 02:14:06 (about 1,000
  packets over ten seconds), and at 02:14:11 the muxer died with `unable to extract DTS: too many reordered frames (11)`. That message is a
  symptom of the loss, not evidence of B-frames. The same pattern is inferred, not yet read from the log, for cam13, 15, 20 and 23.
- **This explains cam13 and cam14.** The probe finds no B-frames and no reordering on either, so the earlier "B-frame cameras"
  label was likely a misdiagnosis: they are damaged-video cameras, and the re-encode fixed them because it rebuilds the stream.
- So `damaged` joins recipe B, and the clean-and-pass-through set on the grid is cam01, 02, 03 and 05.

## Step 2 status

Built: `server/cameraRecipe.ts` (the decision table, a provisional 0-100 health score, and slot admission control),
`server/cameraProbe.ts` (stages 2-3 of the probe, shared by the real probe and the lab), and the synthetic camera lab
(`tests/lab/cameraLab.ts`, run with `node --import tsx scripts/camera-lab.ts`). `probe-report.ts` now shows each camera's
recipe and how many can be live with N slots (`--slots`).

- **Lab:** ffmpeg makes 15 streams, each with one fault (B-frames, 12 s keyframe gap, a stream joined mid-GOP, H.265,
  MJPEG, AV1, 1440p clean / with B-frames / H.265, 5 fps, ends early, damaged bytes, audio only, random bytes). Each is read in real
  time through the same probe code and must end on the right recipe. All 15 do. It takes about 35 s;
  `SKIP_CAMERA_LAB=1 npm test` leaves it out. A file cannot imitate packet loss, dropped connections, wrong credentials or
  an unreachable host; those are covered by unit tests on the parsers and the decision table.
- **Replay of the real grid** (`tests/fixtures/grid-2026-10-08.ts`): cam06 -> C, cam28 -> B, cam30 -> B, cam26 -> D, cam22 -> G.
  Result: 4 cameras A, 19 B, 4 C, 1 D, 2 G. 24 need a transcode slot, so with 6 slots 18 cameras show snapshots until a slot is free.
- **Choices I made that you may want to change:**
  1. A *clean* stream above 1080p stays on A (it plays without a re-encode, which is cheaper than D). D is chosen when a
     stream above 1080p needs a re-encode anyway (B or C), to cut its cost.
  2. A stream that closes early once is F (snapshots until a second probe); closing early in two probes in a row is G.
  3. E (direct WebRTC) is a focus-time option on a camera (`focusRecipe`), not a grid recipe: offered when WHEP answers and the
     stream is H.264 with no B-frames and no long keyframe gap.
  4. "Over 30 s to the first picture" means snapshots in the grid (`gridLive: false`), measured on the source stream before any
     re-encode. The re-encoded path is measured in stage 4, which is not built yet.
  5. Fewer than 3 decoded frames in a sample is not a live stream (random bytes decode as one frame of text).
- **Not yet decided by evidence:** the 5 s keyframe limit and the weights in the health score.

## Step 3 status

Built: `server/mediaPaths.ts` (recipe to MediaMTX path, YAML, and the comparison with a running server), `server/mediaApply.ts` (changes a
running MediaMTX through its control API), `server/mediaPlan.ts`, `server/siteSecrets.ts` (the per-site login with per-camera override),
`scripts/media-config.ts` (`plan`, `write`, `apply`), profile storage for decisions and overrides, and `MEDIA_PATHS_FILE` in
`media-server/entrypoint.sh`. `scripts/demo.mjs up` uses the generated file when it exists. How to use it: `docs/media-server.md`.

- **Same output as today's entrypoint.** A test runs the shell entrypoint and the generator on the same cameras and compares the YAML.
- **Tested against a real MediaMTX 1.21.1** (`MEDIAMTX_BIN=... node --import tsx --test tests/mediaApply.test.ts`; skipped otherwise). That
  found a bug a fake server could not: MediaMTX reports an idle path's source as `publisher`, which made every re-encode path look changed.
- **Hot reload checked end to end** with a fake grid and a viewer: while cam01 was removed and cam04 added, the viewer of cam02 kept
  getting a segment every 2 s with no error, and cam02's muxer was never recreated.
- **Not covered:** a re-encode actually running (this machine has no Quick Sync); the number of re-encodes at once is not enforced by the
  media server (the app's live-tile cap does it; a gate that refuses the seventh belongs with step 5); recipe D does not scale until a filter
  is validated on the target PC (`MEDIA_SCALE_FILTER`).

## Step 4 status

Built: Registry > **Playback profiles** (`src/components/CameraProfilesPanel.tsx`) and its server side (`/api/camera-profiles/*` in `server.ts`,
`server/profileService.ts`, `server/probeJob.ts`, `server/cameraProbeRun.ts`). It lists each camera's recipe, reason, measurements and problems; filters by recipe
and text and pages through the list; starts and stops a probe; loads saved probe runs; sets and clears an override (reason required); and previews and applies the
result to the running media server. How to use it: `docs/media-server.md`.

- **Checked in a real browser** against a real PostgreSQL 16 and a real MediaMTX: the 30 grid cameras listed with the counts from the earlier analysis; an
  override saved and cleared through the screen; the media-server preview showed 28 added, the apply added them, and a second preview showed 28 unchanged; the
  phone layout has no sideways scroll. The profile store's SQL also ran against the real database (the earlier tests used a fake): schema twice, upsert, history,
  decision, override.
- **Not covered:** a probe started from the screen against real cameras (the probe job is tested with fakes and the probe itself ran from the command line);
  signing in as a Firebase admin (the checks used the local-demo guest switch, `MEDIA_ALLOW_GUESTS`); a list of thousands of cameras (the screen pages 20 at a
  time, but the server returns every camera in one answer, so it would need paging on the server first).
- **Left out on purpose:** the media server's own slot limit (step 5), and showing which cameras the registry already has next to the profiles.

## Open points for step 1

- Postgres schema details (column types, how a probe run references a site) and a migration approach.
- Which secret store holds the per-site secrets in a real deployment (environment variables are enough for the demo).
- Whether the HLS endpoint `http://<host>/live/stream/<id>/index.m3u8` is reachable without the Cloudflare front door that
  throttled the earlier `cctv.corp8.cloud` path (the probe will measure it per camera and record the answer).

## What is reused

- `scripts/probe-grid.mjs`: base of the probe command.
- `scripts/check-media-health.mjs`: step 4 of the probe.
- The Quick Sync re-encode in `media-server/entrypoint.sh`: recipes B and C.
- The ranking in `src/lib/cameraHealth.ts`: becomes the computed score.

## Evidence this plan rests on (2026-10-08, demo PC: Celeron N4020, Intel UHD 600)

- MediaMTX never produced an HLS playlist for the grid's H.265 cameras; re-encoding with Quick Sync fixed cam06, 12, 17, 26
  (cam22 sends no decodable frames).
- cam09, 13, 14, 24, 27, 28 killed MediaMTX's HLS muxer ("too many reordered frames"); cam30 sends a keyframe about once a
  minute. Re-encoding with a forced keyframe every 3 s and no B-frames fixed them.
- The live-tile cap compared a tile's position in the whole list instead of the tiles on screen, so grid page 2 could not
  be fully live. Fixed in `src/components/MonitorTab.tsx`.
- Probe results: `.demo-logs/probe-*.csv` and `.json`.
