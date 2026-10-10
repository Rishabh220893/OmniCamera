# Session summary (2026-10-10: sessions 2 and 3) and open items

Continues `docs/session-handoff.md` and `docs/gap-list.md` (status log). The plan is `docs/federation-plan.md`. Session 2 built the foundations;
session 3 (the long chat after it) chose **Profile 3 (federation middleware)** as the first demo target and built plan steps 1 to 3. Both
sessions are in this file. Persistent notes for the assistant are in its memory folder (see "How to start the next session").

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

## Decisions and facts from the user (session 3)

- **Profile 3 (federation middleware) first**, then the others as needed.
- **Departments run standalone camera ecosystems with mixed storage (some cloud, some local) and retention from 7 days to 15+ days.** For Profile 3 the departments' systems stay the video store; the platform keeps metadata, events and alerts. 7 days is the planning window for cross-department evidence (recorded in `docs/federation-plan.md`).
- **No secret vault for now.** `SOURCE_SECRET_KEY` (one key for the whole server, 64 hex characters) was generated and added to `scale.local` (git-ignored); the logins of cameras added from a device are sealed with it. It must be backed up: if lost, those cameras must be re-added. There is no key rotation.
- Writing throwaway test rows to the Neon database (and creating `camera_sources`) was approved for tests; rows are removed after each run.
- The "needs you" items 1 to 5 from the session 2 list were reported done and tested by the user; #6 (the State's questions) is unanswerable for now.

## Session 4 (2026-10-10): step 4, search API and Events tab

Built the event search API (text, tags, department, source, cursor paging, total) and tag editing, and a new **Events tab** with Events, Alerts, Rules and Health (details in `docs/gap-list.md` and `docs/analytics.md`).
Everything from sessions 2 to 4 was committed and pushed to `main`; `.gitignore` now also excludes keys, certificates, env files, service accounts and `live-grid-report-*` (their network captures contain the camera grid's login).

**Test status after step 4:** 626 tests, 594 passed, 2 failed, 30 skipped (Postgres, Redis, the emulator and `sh`-dependent tests need environment). The two failures are one test, `tests/cameraLab.test.ts`
(`tall_h265: 1440p H.265 -> D`: the synthetic 1440p H.265 stream is software-encoded on the shared 1.1 GHz Celeron, falls behind real time during a 15-minute full run and closes early, so the probe answers F). It is load-related, not in code step 4 touched;
re-run it alone to confirm. `tsc --noEmit`: only the two old errors.

**Not verified:** the Postgres half of `tests/eventSearch.test.ts` (run with `TEST_DATABASE_URL`; it creates `platform_events_ts_id` and `platform_events_tags` on the database, so approve that first), a real signed-in session in the Events tab, Health against real gateways and department systems.

## Open items

### Needs you
1. **Back up `SOURCE_SECRET_KEY`** (in `scale.local`) somewhere safe. **Restart the server through your launcher** (`scripts/demo.mjs`) so it picks up the key and all the new routes; the server on port 3000 was the old built bundle when last checked.
2. **Confirm the deployed `firestore.rules` include the step 1 changes** (faces, watchlist, logs per department): `firebase deploy --only firestore:rules` together with the new app build. You reported items 1 to 5 done; this is the one thing that changed after the original list.
3. **Questions only the State can answer** (still open): which VMS/NVR brands, hardware and bandwidth budget, who may query VAHAN/SARTHI/eGujCop/AFIS/NAFIS and on what legal basis, whether departments will give read-only accounts, and whether the three models are alternatives. (Retention and storage: answered in part, above.)
4. If you want AI costs down: collect ~100 frames in `bench-frames/` and run `npm run ai:bench` (needs the provider keys; see `docs/ai-providers.md`).

### Built but never run against the real thing
- **Real devices:** ONVIF, Hikvision and Dahua (adapters, onboarding, and now the three event connectors); the webhook receiver with a real sender.
- **Firebase on a real project:** claims, the admin directory, Email/Password sign-in, the new face/watchlist/log listeners and Settings notes in a browser, the Registry document write for onboarded cameras.
- **Infrastructure:** Redis bus (and Kafka, not written); Ceph/MinIO/AWS; a gateway on another machine over HTTPS; capacity on server-class hardware (all figures from one shared 1.1 GHz Celeron).
- **AI and video:** a real Gemini key at scale and the frame gate's real pass rate; the AI provider switch and benchmark on real keys; ANPR on CPU/GPU; H.265 re-encode of onboarded cameras on Quick Sync; viewer scale; the analysis worker's frame grab from a stored source on a real camera.
- Now run (were not before): Postgres stores on Neon, the Firestore rules in the emulator, the media path with two real MediaMTX servers.
- The full list is in `docs/gap-list.md` "Not verified".

### Next build steps
Done since session 2: A5 remainder (except plate sightings), A4, event connectors, webhook receiver, worker and gateway onto the bus.

- **Step 4 (done, session 4): A9 search API and a thin A11 dashboard** (the Events tab). Still to do there: run its Postgres test, check it signed in, a per-department descriptor so Health can say "video no longer held".
- **A8** correlation engine and incidents; **A18** statewide tracking and route reconstruction on shared data.
- **A7** federation service: department and connector identities (API keys or mTLS), quotas, session caps (also for the new event connections: a recorder may allow only a few).
- **A10** video wall layouts and session control; **A26** federated analytics report.
- **Profile 1 only** (deliberately later): A16 edge recording with central clip fetch; A17 face/crowd/anomaly analyzers and a GPU service; A21 encryption, segmentation and per-user stream tokens; A22 DR design; A23 Kubernetes manifests; A24 the 80,000-camera load-test report; A25 the architecture, security and "departments unaffected" documents.
- **Small follow-ups:** a per-department descriptor (retention days, storage type) so the dashboard can say "video no longer held"; a department picker for people in several departments; plate sightings per department (still per-owner); an all-department view of faces, plates and logs for organisation-wide admins (needs a server route); linking a runner's discovered cameras to the Registry; a sealed store for department-system logins (they are still in a plain file); onboarded cameras assigned to a regional gateway; key rotation for `SOURCE_SECRET_KEY`; Kafka bus if a department needs it; low-disk alert for recordings; automatic holds from alerts; signed evidence manifests; per-camera analyzer settings from the camera record; e-mail/SMS alert channels.

### Known limits and quirks
- **Video access is the media server's shared viewer password, not department-scoped.** A signed-in user who knew a camera's path name could play it. Names are random (`fed-<12 hex>`) and appear only in camera documents the person may read, but this is not access control (A21).
- **Event feeds from Hikvision/Dahua/ONVIF are live-only:** events missed while disconnected cannot be recovered, and a server restart starts from now. The in-process bus loses unconsumed events on restart.
- **The device formats are unverified.** Element names, event codes and message shapes come from vendors' public documentation and the ONVIF specs: which channel id an NVR uses, where Dahua puts a plate, whether an ONVIF device sends a state flag. Expect to adjust the mappings on first contact with each make.
- Video retention is the departments' own; the platform does not set it for Profile 3.
- Two older tests (`mediaServerEntrypoint`, the synthetic camera lab) were never confirmed on a clean tree; the camera lab passed in the later full runs, and `mediaServerEntrypoint` is skipped without `sh` and its environment variables.
- The wrong-camera tile's root cause was never pinned down (it cleared after re-onboarding).

### Tooling notes
- `src/App.tsx`, `server.ts`, `firestore.rules`, `server/mediaPaths.ts` and many other files mix CRLF and LF: scripted multi-line replaces must try both. **Write the patch script with the Write tool** (shell `node -e` and heredocs with backticks or `$` silently mangle code), pass replacements as functions (`String.replace` treats `$$` as one `$`), and re-run the tests after every scripted edit.
- `tsconfig` is not strict: narrow discriminated unions with `=== true` / `=== false`. The installed `lucide-react` has `AlertTriangle`, not `TriangleAlert`.
- The user's server on port 3000 may be the built `dist/server.cjs` (old code). To check new server behaviour boot `tsx server.ts` with `PORT=3199` and stop it by its PID afterwards; for the UI use `preview_start` on another port (temporary `.claude/launch.json` entry with `autoPort`, then remove it). The dev server takes about a minute to start.
- MediaMTX 1.21 binds MoQ on :8892 by default and writes TLS files into its working directory: tests set `moq: false` and give each MediaMTX its own cwd.
- Node on Windows cannot read bash `/tmp` paths. Java, the firebase CLI and the Firestore emulator jar exist on this machine, so `npm run test:rules` works; the dev dependency `@firebase/rules-unit-testing@^5` was added (v6 needs firebase 13).

## Commands and settings added in session 3

| What | Where |
|---|---|
| `npm run ai:bench`, `npm run clear-cameras`, `npm run test:rules` | `package.json` |
| `AI_PROVIDER`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AI_VISION_MODELS`, `AI_CHAT_MODELS` (also `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `OPENAI_JSON_MODE`, `OPENAI_OMIT_TEMPERATURE`) | `docs/ai-providers.md`, `.env.example` |
| `SOURCE_SECRET_KEY` (needs `DATABASE_URL` and `FIREBASE_SERVICE_ACCOUNT` too) | `scale.local`, `docs/deployment.md` |
| `WEBHOOK_ENABLED` (default on), `VMS_ENABLED`, `VMS_DATA_DIR`, `VMS_ALLOW_PRIVATE`, `EVENT_BUS=redis` + `REDIS_URL` | `docs/connectors-vms.md`, `.env.example` |
| Environment-gated tests: `TEST_DATABASE_URL` (+ `TEST_DATABASE_SSL=true` for Neon) for the Postgres tests; the emulator via `npm run test:rules` | `tests/*Pg.test.ts`, `tests/firestoreRules.test.ts` |

## How to start the next session

1. Re-run the full suite (`node --import tsx --test tests/*.test.ts`, about 10 minutes; do not run other heavy work alongside, some tests are load-sensitive) and `npx tsc --noEmit`; record the numbers here.
2. Read this file, `docs/gap-list.md` (status log) and `docs/federation-plan.md` (gap stack and order), then the area you are changing (`docs/connectors-vms.md`, `docs/adapters.md`, `docs/admin-users.md`).
3. Step 4 (A9 search API, thin A11 dashboard) is done. Start **A7** (federation service: identities, quotas, session caps), then A8 and A18, per "Next build steps".
4. Say plainly what is not verified whenever you touch an area in "Built but never run".
