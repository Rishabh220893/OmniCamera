# Session summary (sessions 2 to 4, 2026-10-10 and 2026-10-11) and open items

Continues `docs/session-handoff.md` and `docs/gap-list.md` (status log). The plan is `docs/federation-plan.md`. Session 2 built the foundations;
session 3 chose **Profile 3 (federation middleware)** as the first demo target and built plan steps 1 to 3; session 4 (the longest) finished
step 4, built A8 incidents, a local no-AI detector, the Analyze / Analyze All buttons and a grid guard, and found and fixed the reasons the
AI analysis and the alert rules appeared dead. All of it is committed on `main` (last commit: "Wire the grid guard into the analysis frame
grab and add GET /api/grid/status"). Persistent notes for the assistant are in its memory folder (see "How to start the next session").

## Where it started

- **Session 2:** 343 of 346 tests passing; built: adapters, ONVIF, analyzers, events/alerts, regional gateway, capacity benchmarks, OpenAPI. Not started: G3, G8, G10, G12.
- **Session 3:** everything below, plus the three requirement briefs treated as three profiles of one platform (`docs/federation-plan.md`). The user chose Profile 3, said the Firebase side ("step 0") was done and tested, and said the State's questions are unanswerable for now.

## What was done in session 2

| Area | Built | Where | Verified how |
|---|---|---|---|
| G3 vendor recorders | Hikvision and Dahua adapters, channel listing (`POST /api/adapters/channels`) | `server/adapters/vendorNvr.ts`, `docs/adapters.md` | Fake recorder with Digest/Basic logins; real MediaMTX streams. No real recorder. |
| G8 roles | Claim-based roles (viewer/operator/admin), named permissions, department scope, access log, `npm run set-role`, rules stop self-set roles; app no longer makes everyone admin; fixed a broken token pattern (`Bearers+`) that made the events API refuse real sign-ins | `server/authz/`, `docs/authz.md` | Fakes; the rules are now also tested in the Firebase emulator (session 3) |
| G12 connectors | Mock VAHAN/SARTHI/eGujCop, hub (timeout, cache, circuit breaker), plate checks raising `plate.vehicle_flagged` / `plate.wanted` | `server/connectors/`, `docs/connectors.md` (`CONNECTORS=mock`) | Mocks only |
| G10 recording | MediaMTX recording config, index, clips, evidence export with hashes and holds, retention (hot/warm/cold), S3 cold tier | `server/recording/`, `docs/recording.md` | Real MediaMTX + ffmpeg on synthetic video; fake S3 that checks signatures; AWS's own signature examples reproduced |
| Federation foundations | VMS connector contract, 2 reference connectors + 2 reference VMS labs, event bus (+ conformance suite) | `server/connectors/vms/`, `server/bus/`, `tests/lab/fakeVms.ts`, `docs/connectors-vms.md` | In-process bus tested; Redis bus written, never run; no Kafka |
| Users and departments | Admin-created username+password users, departments, camera allotment, password sign-in beside Google and guest, department-scoped cameras/events/alerts, admin panel in Settings | `server/admin/`, `src/components/AdminUsersPanel.tsx`, `docs/admin-users.md` | Memory directory + routes + event scoping tested; sign-in screen in a browser |
| Fixes after use | Admin camera query falls back to own cameras if the rules refuse it | `src/App.tsx` | Type-checked only |
| Planning | Three briefs as three profiles of one platform; gap stack A1-A26 and order | `docs/federation-plan.md` | n/a |
| Tools | Duplicate-camera clean-up for the browser console | `scripts/dedupe-cameras.console.js` | Syntax only (now moot: cameras were cleared and re-onboarded) |

## What was done in session 3

| # | Area | Built | Where | Verified how |
|---|---|---|---|---|
| 1 | **AI provider choice** (advice, then adapter) | `AI_PROVIDER=gemini` (default) `\|anthropic\|openai`; any OpenAI-compatible endpoint (Qwen-VL on DashScope/Together/Fireworks, vLLM) through `OPENAI_BASE_URL`; the call sites are unchanged. `npm run ai:bench` compares models on your own frames with the app's real prompts (speed, JSON validity, tokens, cost with `--prices`, accuracy with ground-truth JSON files). Key checks in `server.ts`, `gateway.ts`, `server/trackingRoutes.ts` now name the chosen provider's key | `server/llm.ts`, `server/gemini.ts`, `scripts/ai-benchmark.ts`, `docs/ai-providers.md`, `.env.example` | `tests/llm.test.ts` (request shapes, retry classification) against stubbed HTTP. **Never run against a real key or on real frames.** |
| 2 | **Wrong-camera tile** (CAM18 showing Chiman Bhai Bridge) | Investigated, not code-fixed: upstream `cam18` (Rajkot junction) and `cam01` (bridge) are different on the grid and on the local MediaMTX; app code paths checked. It went away after the cameras were cleared and re-onboarded, so it was almost certainly a bad registry record; the root cause was never pinned down. `npm run clear-cameras` (dry run by default, backs up to `cameras-backup-*.json`, now git-ignored) | `scripts/clear-cameras.ts` | Help text only; the user ran it |
| 3 | **Step 1 (A5 remainder): department data** | Organisation-wide admins (claim, no department or `*`) see events and alerts on every camera and handle any alert; admins with a department list see those; the old self-set admin is deliberately not trusted with others' data (`eventScope` in `server/authz/policy.ts`). **Alert rules per department** (`department` on a rule, owner key `dept:<name>`). **Faces, watchlist and logs per department** (`departmentId`; faces by operators+, plates by admins, a log's department must equal its camera's). Analysis worker and gateways load owner + department faces and plates (`server/userContext.ts`) | `server/events/{store,rules,alertEngine,routes}.ts`, `firestore.rules`, `src/App.tsx`, `src/lib/mergedQueries.ts`, `docs/admin-users.md` | `tests/departmentData.test.ts` (13); Postgres store on the real Neon database (7 pass incl. the new department test); **Firebase emulator** `npm run test:rules` (`tests/firestoreRules.test.ts`, 6). Not run: the new listeners in a browser against Firebase |
| 4 | **Step 2 (A4): cameras from adapters** | Registry panel "Add cameras from a device or recorder": ONVIF, Hikvision/Dahua recorders (every channel, as a job) and RTSP addresses are probed through their adapter, saved as a profile (site `federated`), a **sealed source** (AES-256-GCM, `SOURCE_SECRET_KEY`) and a Registry camera (department optional), then served through the media server on `fed-<hex>` paths merged with the grid's into one apply and one generated file. Tiles play them from the media server; server analysis grabs from the stored source | `server/sources/`, `src/components/SourcesPanel.tsx`, `src/lib/gridCamId.ts` (`mediaPathId`), `docs/adapters.md` "Onboarding" | `tests/sources.test.ts` (23); **`tests/sourcesEndToEnd.test.ts`: real MediaMTX camera system + real second MediaMTX through its control API + real ffprobe/ffmpeg + a decoded HLS frame**; `tests/sourceStorePg.test.ts` on Neon (2 pass, `camera_sources` table now exists, test rows removed); panel opened in a browser. Not run: a real device, the Registry write to real Firestore |
| 5 | **Step 3: event connectors, webhooks, one bus** | Live event connectors `hikvision-events`, `dahua-events` (one GET each) and `onvif-events` (PullPoint) on a shared push-feed engine (reconnect, idle watchdog, honest status; restart starts from now, no replay claimed). **Webhook receiver** (`/api/ingest/webhook/:id`, hashed per-source tokens, generic JSON and Hikvision XML, mounted before the global 25 MB body parser with its own 512 KB limit, rate-limited, identical 401 for unknown source and wrong token). **Every producer now publishes to the event bus** (analysis worker, gateways, runners, webhooks) and one consumer alerts | `server/connectors/vms/{eventStream,streamBuffer,streamHttp,hikvisionEvents,dahuaEvents,onvifEvents}.ts`, `server/connectors/webhook/`, `server/events/pipeline.ts`, `server/bus/topics.ts`, `docs/connectors-vms.md` | `tests/eventStreams.test.ts` (24), `tests/onvifEvents.test.ts` (10), `tests/webhook.test.ts` (13) against fake devices over real HTTP, the full path device -> runner -> bus -> alert, and the real server booted (401 / 413 / protected admin). **Not run: any real device**; formats are from public documentation |

Bugs found by the tests along the way (all fixed): a regex that lost its backslash in a scripted edit; a SQL `LIMIT $${n}` turned into a literal number by `String.replace`; removed cameras leaving their media path on the running server (the apply now manages every `fed-` path); the Registry panel crashing when a route does not exist; a webhook-store deadlock (a queued operation waiting on itself); Dahua events with no id colliding within one millisecond; MediaMTX 1.21's default MoQ listener on port 8892 clashing with a running media server (every test that starts MediaMTX now sets `moq: false`, which also explains the earlier "ONVIF probe tests fail" runs).

**Test status:** the last full run, on the finished code: **622 tests, 592 passed, 1 failed, 0 cancelled, 29 skipped** (Postgres, Redis, the emulator and `sh`-dependent tests need environment). The one failure was a test that listed the registered connector types and did not expect the three new ones; it was fixed and re-run (`tests/vmsService.test.ts`, `tests/vmsConnectors.test.ts`: 19 of 19 pass), but the whole suite was not run a second time, so confirm with a fresh full run. After step 2 the suite had been 575 tests, 546 passed, 0 failed. Step 3 added 47 tests (24 + 10 + 13). `tsc --noEmit` reports only the two old errors (`AnalyticsTab.tsx` `Clock`, `MonitorTab.tsx` argument count).

## Session 4 (2026-10-11): what was done

| # | Area | What was built or fixed | Where | Verified how |
|---|---|---|---|---|
| 1 | **Events tab finished** | Search API and tags (from 2026-10-10), Events / Alerts / Incidents / Rules / Health. Rules use **lists, not codes**: event types are tick boxes with plain names, departments a dropdown (a text box for non-admins). New events `vehicle.seen` and `person.seen` (from the AI's counts). **The rule Test button now leaves a labelled TEST event and alert** (it used to store nothing, so it could never show). Fixed the Logs-screen crash (`Clock` not imported) | `src/components/events/*`, `server/events/{schema,alertEngine}.ts` | Tests; the user used it. Postgres half of the event store **passed on Neon** |
| 2 | **AI switch + local detector** | Per-camera "Analyze with AI" (Settings). Off = no model call; `local-detector` reports motion, movement in a zone and across a line from frame differences. `camera.offline` / `camera.online` from the worker's run history, **reported once, 30-minute gap against flapping** (it had produced 130 events in 3 hours) | `server/analytics/localDetector.ts`, `server/analysisWorker.ts`, `docs/analytics.md` | `tests/localDetector.test.ts` (synthetic frames). Never on real footage |
| 3 | **Department video descriptor** | Retention days and storage (cloud / local / mixed) per department; admin panel; the Events tab marks older events "video likely no longer held" (admins) | `server/admin/*`, `AdminUsersPanel.tsx`, `docs/admin-users.md` | Tests (memory directory and routes). The Firebase implementation was not run |
| 4 | **A8 incidents** | Correlation engine with three rules: the same plate on 2+ cameras within an hour, a watchlist/wanted hit, two different systems on one camera within 3 minutes. Department-scoped API and the Events > Incidents screen (timeline, notes, close/reopen; a department sees that other departments' events exist, not their content) | `server/incidents/`, `docs/incidents.md` | `tests/incidents.test.ts` (11); **`tests/incidentStorePg.test.ts` passed on Neon**; screen checked in the in-app browser with mock data |
| 5 | **Why no AI results: capture and model** | One grid RTSP grab measured at ~15 s against a 7 s limit: timeouts now 25 s / 30 s (`FRAME_RTSP_TIMEOUT_MS`, `FRAME_HLS_TIMEOUT_MS`), `ANALYSIS_CONCURRENCY=4`, `ANPR_TIMEOUT_MS=20000` (in `scale.local`). Gemini 2.5 and 2.0 are **retired** for this key: defaults and `scale.local` now use the cheapest family models (`gemini-3.5-flash-lite`, fallback `gemini-3.1-flash-lite`). The cheap model sometimes returned broken JSON: now asked for **structured output (a response schema)** with a repair step behind it | `server/frameSource.ts`, `server/llm.ts`, `server/analytics/{builtin,modelJson}.ts` | Key and models tested against Google (8 of 8 calls valid); capture timing measured once |
| 6 | **Why no alerts: identity bug** | `scripts/demo.mjs` sets `MEDIA_ALLOW_GUESTS=true`, and the permissions code then treated **every request as the guest `demo`**, even with a valid Google sign-in. Rules, the Events tab and incidents looked at `demo`'s data while the AI events (739 stored) belonged to the real account. **Fixed**: a valid sign-in keeps its identity; guest only without one. The user's old rule was **moved from `demo` to their account in Neon** (with their request) | `server/authz/authz.ts` | `tests/authz.test.ts`; read-only database queries showed the cause |
| 7 | **Analyze / Analyze All** | Replaced the Scope selector and "Activate Guard". **Analyze** covers exactly the ticked cameras (disabled at 0); **Analyze All** covers every camera (confirms above 10); **Stop analysis**. The camera in focus is **no longer added silently**. Cause of "1-2 ticked but 18-30 analysed": `serverAnalysis` flags persist in Firestore (30 were flagged) and the worker analyses every flagged camera. Starting now makes the flagged set exactly the targets; Stop releases all; opening the app never changes a flag; **`scripts/demo.mjs up` clears leftover flags** (`--keep-analysis` opts out) | `src/lib/guardSync.ts`, `src/App.tsx`, `src/components/Header.tsx`, `scripts/demo.mjs` | `tests/guardSync.test.ts`; behaviour checked in the in-app browser (guest mode) |
| 8 | **Grid guard** | The camera grid caps each account's viewing time and refuses the account (HLS 403 "watch time limit", RTSP/WHEP 401) for a cooldown. Now: at most `GRID_GRABS_PER_MIN` (default 10) analysis grabs a minute (extra ones wait); a refusal pauses all analysis grabs 5 min, doubling to 30; **a pause is not a failure** (no failure count, no offline event, no back-off); state shared through Redis; `GET /api/grid/status` | `server/gridGuard.ts`, `server.ts`, `server/frameSource.ts`, `server/analysisWorker.ts` | `tests/gridGuard.test.ts` (fake clock and store). **Never against the real grid** |
| 9 | **Per-camera AI status** | Feed camera list: "AI: Analysed 3 min ago / Waiting for its first analysis / Paused, resumes by itself / Not working right now" (hover for the reason); "Ongoing context" shows the actual reason; **Events > Health "AI analysis and the camera grid"**: whether the grid refuses the account, grab usage, and a table of every analysed camera | `src/lib/analysisStatus.ts`, `MonitorTab.tsx`, `HealthView.tsx` | Unit tests for the wording; grid part and Feed list checked in the browser (guest mode). The camera table with real records was not shown |
| 10 | **Checks run** | Full suite, the incident store on Neon, read-only database queries, an RTSP grab test, in-app browser checks on an isolated dev server (`PORT=3199 SERVER_ANALYSIS=false`, so the user's grid account was not touched) | | see Test status |

**Findings worth remembering**
- The AI analysis **was working** (hundreds of events in Postgres) while the user believed it was not: check `platform_events` by `user_id` and `type` before guessing.
- The grid's watch-time cap, shared by analysis and the live wall, is the main reason cameras show "Could not capture a frame". The grid's real allowance is unknown.
- `FIRESTORE_LOG_MODE=notable` means the Logs tab shows only notable frames; the Events tab reads Postgres. `scripts/demo.mjs up --all-logs` shows every analysis in Logs (more Firestore writes).
- A full suite run loads the 2-core laptop: do not run it while the user is testing live. A `grep -l` that matches nothing inside `node --test $(...)` runs the **whole** suite.

**Test status:** last full run **655 tests, 624 passed, 0 failed, 0 cancelled, 31 skipped** (Postgres, Redis, the emulator and `sh`-dependent tests need environment), 12.9 minutes. It started before the grid-guard edits; the 46 related tests were re-run on the finished code and all pass, but **the full suite was not run again after them**. `tsc --noEmit` shows only the old `MonitorTab.tsx` argument-count error (the `Clock` error is fixed).

## Completed and left to do (the short list)

**Completed in session 4**
- Events tab with rules as tick boxes, `vehicle.seen` / `person.seen`, a visible rule Test, department dropdowns; Logs crash fixed
- Per-camera AI on/off with the local motion / zone / line detector; offline/online events de-flooded
- Department video descriptor (retention, storage) and the "video likely no longer held" marker
- A8 incidents: engine, store (Postgres run on Neon), API, screen, docs
- Capture timeouts, cheaper Gemini models, structured output, JSON repair
- Identity bug (everything filed under `demo`) fixed; the old rule moved to the user's account
- Analyze / Analyze All / Stop; no hidden focus camera; stale server flags released (also at launcher start)
- Grid guard (rate limit, pause on refusal, shared state, `/api/grid/status`)
- Per-camera AI status in the Feed and on the Health tab
- Docs: `docs/incidents.md`, new sections in `docs/analytics.md`, `docs/admin-users.md`, `docs/openapi.yaml`, this file

**Still to do (in the order I would take them)**
1. **Confirm end to end on the real grid:** restart through `scripts/demo.mjs`, sign in with Google, tick 1-2 cameras, press Analyze; check that the "Vehicle seen" rule raises an alert, that Events > Incidents fills when a plate appears on two cameras, and that Events > Health shows the grid state. Delete the duplicate rule (the database holds two rules under the user's account).
2. Run the **full suite once more** (and record the numbers here).
3. **A7 federation service**: department and connector identities (API keys or mTLS), quotas, session caps.
4. **A10 / A26**: video wall layouts and session control; federated analytics report.
5. A **screen to draw zones and lines** for the local detector (without it only motion is reported).
6. **Plate sightings per department** (still per-owner), then **A18** statewide tracking and route reconstruction.
7. Small follow-ups: a department picker for people in several departments; an all-department view of faces, plates and logs for organisation-wide admins (needs a server route); an indexed plate column for incident lookups (they use the text search); incident notifications (webhook / e-mail); a sealed store for department-system logins; key rotation for `SOURCE_SECRET_KEY`; linking a runner's discovered cameras to the Registry; onboarded cameras assigned to a regional gateway; Kafka bus if needed; low-disk alert for recordings; automatic holds from alerts; signed evidence manifests; e-mail/SMS alert channels; pinning the wrong-camera tile's root cause.
8. **Profile 1 only** (deliberately later): A16, A17, A21 to A25 (edge recording, GPU analyzers, encryption and per-user stream tokens, DR, Kubernetes, the 80,000-camera load test, architecture and security documents).

## Decisions and facts from the user (session 3)

- **Profile 3 (federation middleware) first**, then the others as needed.
- **Departments run standalone camera ecosystems with mixed storage (some cloud, some local) and retention from 7 days to 15+ days.** For Profile 3 the departments' systems stay the video store; the platform keeps metadata, events and alerts. 7 days is the planning window for cross-department evidence (recorded in `docs/federation-plan.md`).
- **No secret vault for now.** `SOURCE_SECRET_KEY` (one key for the whole server, 64 hex characters) was generated and added to `scale.local` (git-ignored); the logins of cameras added from a device are sealed with it. It must be backed up: if lost, those cameras must be re-added. There is no key rotation.
- Writing throwaway test rows to the Neon database (and creating `camera_sources`) was approved for tests; rows are removed after each run.
- The "needs you" items 1 to 5 from the session 2 list were reported done and tested by the user; #6 (the State's questions) is unanswerable for now.

## Step 4 (2026-10-10): search API and Events tab (early session 4)

Built the event search API (text, tags, department, source, cursor paging, total) and tag editing, and a new **Events tab** with Events, Alerts, Rules and Health (details in `docs/gap-list.md` and `docs/analytics.md`).
Everything from sessions 2 to 4 was committed and pushed to `main`; `.gitignore` now also excludes keys, certificates, env files, service accounts and `live-grid-report-*` (their network captures contain the camera grid's login).

**Test status after step 4:** 626 tests, 594 passed, 2 failed, 30 skipped (Postgres, Redis, the emulator and `sh`-dependent tests need environment). The two failures are one test, `tests/cameraLab.test.ts`
(`tall_h265: 1440p H.265 -> D`: the synthetic 1440p H.265 stream is software-encoded on the shared 1.1 GHz Celeron, falls behind real time during a 15-minute full run and closes early, so the probe answers F). It is load-related, not in code step 4 touched;
re-run it alone to confirm. `tsc --noEmit`: only the two old errors.

**Not verified:** the Postgres half of `tests/eventSearch.test.ts` (run with `TEST_DATABASE_URL`; it creates `platform_events_ts_id` and `platform_events_tags` on the database, so approve that first), a real signed-in session in the Events tab, Health against real gateways and department systems.

## Open items

### Needs you
1. **Restart through your launcher** (`node scripts/demo.mjs up`; it rebuilds and clears the cameras left flagged for analysis), hard-reload the page, sign in with **Google** (not the guest bypass), tick the cameras, press **Analyze**. Until you restart, the old server keeps analysing all the flagged cameras.
2. Delete the duplicate "Vehicle" rule in the Rules tab (two rules now exist under your account).
3. **Questions only the State can answer** (still open): which VMS/NVR brands, hardware and bandwidth budget, who may query VAHAN/SARTHI/eGujCop/AFIS/NAFIS and on what legal basis, whether departments will give read-only accounts, and whether the three models are alternatives.
4. Optional: `--all-logs` on `up` to see every analysis in the Logs tab; collect ~100 frames in `bench-frames/` and run `npm run ai:bench` to compare models (see `docs/ai-providers.md`).
5. Done by you earlier and still needed to keep true: `SOURCE_SECRET_KEY` backed up, `firestore.rules` deployed with the current app build.
6. The working tree holds `docs/*.pptx` / `.docx` changes that are not part of this work (a deleted old deck, a new deck and speaker notes): decide whether to commit them.

### Built but never run against the real thing
- **Real devices:** ONVIF, Hikvision and Dahua (adapters, onboarding, event connectors); the webhook receiver with a real sender.
- **Firebase on a real project:** claims, the admin directory (including the new department retention fields), Email/Password sign-in, the new face/watchlist/log listeners, the Registry write for onboarded cameras.
- **The camera grid:** the grid guard's refusal and pause paths (only fakes so far), the effect of `GRID_GRABS_PER_MIN`, the Analyze flag handling against real Firestore data (only guest mode was exercised in the browser).
- **AI and video:** the local detector on real footage; incidents on real cameras; the Health camera table with real camera records; ANPR on GPU; H.265 re-encode on Quick Sync; viewer scale.
- **Infrastructure:** Kafka (not written); Ceph/MinIO/AWS; a gateway on another machine over HTTPS; capacity on server-class hardware.
- Now run (were not before): Postgres stores (events, alerts, sources, incidents) on Neon, the Firestore rules in the emulator, the media path with two real MediaMTX servers, the Redis bus.
- The full list is in `docs/gap-list.md` "Not verified".

### Next build steps
See "Completed and left to do" above; the plan itself is `docs/federation-plan.md`. Done so far: A4, A5 (except plate sightings), A8, A9 and a thin A11 (the Events tab), event connectors, webhook receiver, worker and gateway on the bus, the grid guard.

### Known limits and quirks
- **Video access is the media server's shared viewer password, not department-scoped.** A signed-in user who knew a camera's path name could play it. Names are random (`fed-<12 hex>`) and appear only in camera documents the person may read, but this is not access control (A21).
- **Event feeds from Hikvision/Dahua/ONVIF are live-only:** events missed while disconnected cannot be recovered, and a server restart starts from now. The in-process bus loses unconsumed events on restart.
- **The device formats are unverified.** Element names, event codes and message shapes come from vendors' public documentation and the ONVIF specs: which channel id an NVR uses, where Dahua puts a plate, whether an ONVIF device sends a state flag. Expect to adjust the mappings on first contact with each make.
- Video retention is the departments' own; the platform does not set it for Profile 3.
- Two older tests (`mediaServerEntrypoint`, the synthetic camera lab) were never confirmed on a clean tree; the camera lab passed in the later full runs, and `mediaServerEntrypoint` is skipped without `sh` and its environment variables.
- The wrong-camera tile's root cause was never pinned down (it cleared after re-onboarding).
- **Grid watch-time cap** (see above): the guard's per-minute number is a guess; the live wall tiles and the playback proxy also use the account and are not limited by it. A wrong password also answers 401 and is treated as a refusal.
- **Analyze, Stop and flags:** Stop and Analyze release every camera flagged for server analysis in the user's list, including ones flagged in Settings ("Analyze on server"); flags are changed only by those two actions and by the launcher at start.
- **Guest / demo mode** is the shared user `demo` (no real identity); rules and events made there are not visible to a signed-in account.
- **Incident lookups** use the text search on the events table (fine at demo scale); two server processes handling the first two sightings of a trail at the same instant can each open an incident.
- Zones and lines for the local detector are set in the camera record (`analyzers['local-detector']`); there is no screen yet.

### Tooling notes
- `src/App.tsx`, `server.ts`, `firestore.rules`, `server/mediaPaths.ts` and many other files mix CRLF and LF: scripted multi-line replaces must try both. **Write the patch script with the Write tool** (shell `node -e` and heredocs with backticks or `$` silently mangle code), pass replacements as functions (`String.replace` treats `$$` as one `$`), and re-run the tests after every scripted edit.
- `tsconfig` is not strict: narrow discriminated unions with `=== true` / `=== false`. The installed `lucide-react` has `AlertTriangle`, not `TriangleAlert`.
- The user's server on port 3000 may be the built `dist/server.cjs` (old code). To check new server behaviour boot `tsx server.ts` with `PORT=3199` and stop it by its PID afterwards; for the UI use `preview_start` on another port (temporary `.claude/launch.json` entry with `autoPort`, then remove it). The dev server takes about a minute to start.
- MediaMTX 1.21 binds MoQ on :8892 by default and writes TLS files into its working directory: tests set `moq: false` and give each MediaMTX its own cwd.
- Node on Windows cannot read bash `/tmp` paths. Java, the firebase CLI and the Firestore emulator jar exist on this machine, so `npm run test:rules` works; the dev dependency `@firebase/rules-unit-testing@^5` was added (v6 needs firebase 13).
- **Edit helper that keeps line endings:** a small `patch(file, pairs)` that tries the text as written, then with CRLF, and replaces with a function. Write the script with the Write tool, run it, delete it. Long shell heredocs with mixed quotes break the bash tool.
- **In-app browser check without touching the grid:** add a temporary `verify-3199` entry to `.claude/launch.json` (`node --import tsx server.ts`, env `PORT=3199`, `SERVER_ANALYSIS=false`), start it with `preview_start` (about a minute), use the guest bypass, mock `fetch` for API answers, then stop it and restore `launch.json`.
- **Read-only database checks** use `scale.local` (`DATABASE_URL`, `DATABASE_SSL=true`) with the `pg` package from a throwaway script; print counts only, never the connection string. Writing to Neon needs the user's yes each time.
- Do not run the full suite while the user tests live; do not kill the user's `mediamtx.exe` or `scripts/demo.mjs` processes.

## Commands and settings added in sessions 3 and 4

| What | Where |
|---|---|
| `npm run ai:bench`, `npm run clear-cameras`, `npm run test:rules` | `package.json` |
| `AI_PROVIDER`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AI_VISION_MODELS`, `AI_CHAT_MODELS` (also `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `OPENAI_JSON_MODE`, `OPENAI_OMIT_TEMPERATURE`). Session 4: both model lists in `scale.local` are `gemini-3.5-flash-lite,gemini-3.1-flash-lite` | `docs/ai-providers.md`, `.env.example`, `scale.local` |
| `SOURCE_SECRET_KEY` (needs `DATABASE_URL` and `FIREBASE_SERVICE_ACCOUNT` too) | `scale.local`, `docs/deployment.md` |
| `WEBHOOK_ENABLED` (default on), `VMS_ENABLED`, `VMS_DATA_DIR`, `VMS_ALLOW_PRIVATE`, `EVENT_BUS=redis` + `REDIS_URL` | `docs/connectors-vms.md`, `.env.example` |
| `FRAME_RTSP_TIMEOUT_MS` (25000), `FRAME_HLS_TIMEOUT_MS` (30000), `ANPR_TIMEOUT_MS` (20000 in `scale.local`), `ANALYSIS_CONCURRENCY` (4 in `scale.local`), `GRID_GRABS_PER_MIN` (10), `HLS_COOLDOWN_MS` (5 min base for the pause) | `server/frameSource.ts`, `server/gridGuard.ts`, `docs/analytics.md` |
| `node scripts/demo.mjs up [--keep-analysis] [--all-logs]`, `status`, `analysis-off --yes` | `scripts/demo.mjs` |
| `GET /api/grid/status`, `GET|POST /api/incidents...`, `PATCH /api/admin/departments/{id}` | `docs/openapi.yaml`, `docs/incidents.md` |
| Environment-gated tests: `TEST_DATABASE_URL` (+ `TEST_DATABASE_SSL=true` for Neon) for the Postgres tests (`tests/*Pg.test.ts`); the emulator via `npm run test:rules` | `tests/` |

## How to start the next session

1. Read this file, `docs/gap-list.md` (status log) and `docs/federation-plan.md` (gap stack and order), then the area you are changing (`docs/incidents.md`, `docs/analytics.md`, `docs/connectors-vms.md`, `docs/adapters.md`, `docs/admin-users.md`). The assistant's memory folder has the same story in short form.
2. Ask the user what they saw after restarting and pressing Analyze (the "Still to do" item 1). If rules still do not fire, check the database first: `platform_events` by `user_id`/`type`, `alert_rules` by `user_id`, and `node scripts/demo.mjs status` (cameras flagged, recent logs).
3. Re-run the full suite (`node --import tsx --test tests/*.test.ts`, about 13 minutes, only when the user is not testing live) and `npx tsc --noEmit`; record the numbers here.
4. Then take the next item from "Still to do": A7 (federation service), A10 / A26, the zone and line screen, plate sightings per department, A18.
5. Say plainly what is not verified whenever you touch an area in "Built but never run".
