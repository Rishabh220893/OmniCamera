# Gap list and implementation order

Written 2026-10-10 against the four key challenges (heterogeneous infrastructure, geographical dispersion, unified
analytics, scalability). Based on reading the code and docs, not on running anything. Companion to `docs/handover.md`
(whose table predates the camera-profile, self-heal and WHEP work and should be refreshed).

Effort: S = days, M = 1-2 weeks, L = several weeks. Rough, one developer.

## Progress

| Gap | State (2026-10-10) |
|---|---|
| G1 adapter interface | Built: `server/adapters/` (contract, registry, `rtsp`, `http`, `grid-rtsp`), admin routes in `server/adapterRoutes.ts`, `docs/adapters.md`. The Registry screen does not use it yet; existing grid probing still calls `probeCamera` directly. |
| G2 ONVIF | Built as an adapter: WS-Discovery, WS-Security and HTTP Digest/Basic logins, clock-skew handling, profile and stream-URI reads, fallbacks for unreachable announced addresses, probe. Tested against a fake device over HTTP/UDP (135 login/XML/capability/clock combinations) and end to end against a real MediaMTX stream with real ffprobe/ffmpeg. **Not run against a real camera.** HTTPS ONVIF is not supported. |
| G4 pluggable analytics | Built: `server/analytics/` (Analyzer contract, pipeline with failure isolation, timeouts and merge rules). Gemini scene analysis and the plate reader now run behind it; the prompt is byte-identical to before (fixture from git) and output parity is tested for every ANPR situation. New `camera-tamper` analyzer (no model call). A new detector reaches an alert with no worker change (tested). Per-camera analyzer settings are not read from the camera record yet. |
| G5 events and alerts | Built: `server/events/` (event schema, rules with conditions/schedule/throttle, alert lifecycle, signed webhook channel with retries, memory and Postgres stores) and the API in `docs/openapi.yaml`. Docs: `docs/analytics.md`. The Postgres store was run against the project's Neon database (alert store, event store, plate sightings: all pass; Neon timings in `docs/capacity.md` 3b); the running server against Neon end to end was not. No e-mail/SMS channel, no screen in the app yet. |
| G9 scale test and capacity | Built: `scripts/capacity/` (control-plane benchmark up to 80,000 simulated cameras, media-server and per-operation benchmarks, a tested sizing model) and `docs/capacity.md`. Measured on one weak shared laptop only. Found and fixed an O(n) scan in the in-memory alert store (cost per analysis doubled at 5,000 cameras). Postgres was timed on Neon from this laptop (section 3b). Firestore, Redis, real Gemini, ANPR/GPU, re-encoding and real networks were **not** measured: see "Not verified" below. |
| G6 regional gateway | Built: `gateway.ts` (a gateway process with no Firebase credentials), `server/gateway/` (signed protocol, durable outbox, agent with back-off and clock correction, centre-side registry/health/ingest with per-camera authorisation, admin and gateway routes), `gatewayId` on cameras (admin-only in the Firestore rules), `gateway.offline/degraded/online` events into the alert engine. Docs: `docs/regional-gateway.md`. 25 tests including a cut/lossy/slow link over real HTTP; the real `gateway.ts` process was smoke-run. **Never run against real distant sites, a real Firestore, or a real Gemini key.** No playback or evidence frames through the gateway, no failover, no screen in the app. |
| G11 OpenAPI | `docs/openapi.yaml` covers registry, adapters, profiles, events, alert rules, alerts, gateways and analysis status; it parses and its references resolve. Not checked against live responses. |
| G13 docs refresh | Status note added to `docs/handover.md`; its old tables were left as history. |
| G3 vendor NVR adapters | Built (2026-10-10): `hikvision` and `dahua` adapters (`server/adapters/vendorNvr.ts`) with stream addressing, device information, channel listing and probe, and `POST /api/adapters/channels` to onboard a whole recorder. Analog cameras via DVR channels documented. Tested against a fake device that checks logins and a real MediaMTX stream. **Not run against any real recorder.** Milestone and Genetec are only reachable through ONVIF/RTSP; no native adapter. The vendor list was chosen by me (the most common public-sector makes), not by the target estate: decision 1 below is still open. |
| G8 real roles | Built (2026-10-10): `server/authz/` (roles viewer/operator/admin from Firebase custom claims, named permissions, department scope in the policy, access log), `npm run set-role`, rules that stop clients writing `role`, the app no longer self-assigns admin. Details and migration: `docs/authz.md`. **Not run against Firebase**; department scoping is not yet enforced on stored data (everything is still per-owner). Also fixed a broken token pattern (`Bearers+`) that made the events/alerts API refuse every real sign-in. |
| G12 integration connectors | Built as mocks (2026-10-10): `server/connectors/` (contract, hub with timeout/cache/circuit breaker, mock VAHAN, SARTHI and eGujCop, plate-read checks that raise `plate.vehicle_flagged` and `plate.wanted` events through the ordinary rules and alerts, `/api/connectors`). On with `CONNECTORS=mock`. Docs: `docs/connectors.md`. **No real system contacted**; AFIS/NAFIS not mocked (biometric); no screen. |
| G10 recording and playback | Built, API only (2026-10-10): MediaMTX records fmp4 segments from generated settings (`server/mediaPaths.ts`), `server/recording/` indexes them, cuts clips without re-encoding, exports evidence with hashes and holds, and runs retention with an optional warm tier. Tested against a real MediaMTX and real ffmpeg with synthetic video. Docs and the decisions still open: `docs/recording.md`. **No real camera; no screen; no gateway-side recording; no object storage.** |
| Federation foundations (2026-10-10, plan A2/A3/A6/A15) | Built: VMS connector contract + two reference connectors + two reference VMS systems (`server/connectors/vms/`, `docs/connectors-vms.md`), event bus with conformance suite (in-process tested; Redis written, never run), S3 cold tier for recordings (`docs/recording.md`). Next: shared multi-department data (A5). Plan: `docs/federation-plan.md`. |
| A5 remainder (2026-10-10, session 3) | Built: an organisation-wide administrator (claim, no department or '*') sees events and alerts on **every** camera and handles any alert; an administrator with departments listed sees those; **department alert rules** (`department` on a rule: fires for events on the department's cameras whoever owns them, managed by its operators); **faces, watchlist plates and logs per department** (`departmentId`; shared by members, written by Operators/Admins as the rules say; logs tagged with their camera's own department); the analysis worker and gateways use owner + department faces and plates. Tested: stores (memory and **real Postgres**), engine, routes, worker, gateway, listeners (`tests/departmentData.test.ts`, `tests/alertStorePg.test.ts`) and the new Firestore rules in the **Firebase emulator** (`npm run test:rules`). **Not run:** the app's new listeners and Settings notes in a browser against Firebase; Firebase Auth/claims on a real project. Not built: plate sightings per department, an admin all-department view of faces/plates/logs in the app, a department picker for people in several departments. |
| Step 3: event connectors, webhook receiver, one bus (2026-10-10, session 3) | Built: **live event connectors** `hikvision-events`, `dahua-events` (one GET each) and `onvif-events` (PullPoint) on a shared stream engine (reconnect, idle watchdog, honest status, no replay claimed), a **webhook receiver** (`/api/ingest/webhook/:id`, per-source hashed token, generic JSON and Hikvision XML, mounted before the global body parser, rate-limited) and **every producer on the bus** (analysis worker, gateways, runners, webhooks -> `platform.events` -> alerting; retried, dead-lettered, deduplicated). Tested: parsers cut at every chunk size, connectors against fake recorders and a fake ONVIF device over real HTTP (login, drops, silence, refusal, shutdown, read-only audit), the full path device -> runner -> bus -> alert, webhook routes, and the real server booted (401 / 413 / protected admin routes). **Not run:** any real Hikvision, Dahua or ONVIF device (formats are from public documentation), the Redis bus, a real sender pushing to the receiver. Limit: events missed while disconnected are gone; no per-system connection caps (A7). |
| A4 adapter cameras into the Registry, grid and media config (2026-10-10, session 3) | Built: **onboarding through adapters** (`server/sources/`, `docs/adapters.md` "Onboarding"): ONVIF, Hikvision/Dahua (a whole recorder as a job) and RTSP addresses are probed through their adapter, saved as a profile (site `federated`), a sealed source (AES-256-GCM, `SOURCE_SECRET_KEY`) and a Registry camera (department optional), then served through the media server (`fed-<hex>` paths merged with the grid's into one apply and one generated file; removed cameras' paths are removed). Tiles play them from the media server; server analysis grabs from the stored source. Registry panel "Add cameras from a device or recorder". Tested: unit tests with fakes, **an end-to-end test with a real MediaMTX camera system, real ffprobe/ffmpeg probe, a second real MediaMTX configured through its control API and a decoded frame from its HLS** (`tests/sourcesEndToEnd.test.ts`), and the panel opened in a browser. **Not run:** a real ONVIF/Hikvision/Dahua device, the Registry write to real Firestore, the Postgres source store (test written, needs `TEST_DATABASE_URL`), the panel with a signed-in admin, real H.265 re-encode, gateway-assigned cameras. Limit: video access is the media server's shared viewer password, not department-scoped (A21). |
| Users, departments, camera allotment (2026-10-10, plan A5 part 1) | Built: administrators create departments and username+password accounts and give cameras to departments; password sign-in added beside Google and guest; people see their department's cameras, events and alerts. `docs/admin-users.md`. **Not run against Firebase**; needs Email/Password enabled in the Firebase console and the rules deployed with the new app. |
| G7 | Not started as code: decided by G6 (regional gateways carry the video locally, so the centre does not). | (G7 is decided by G6: regional gateways carry the video locally, so the centre does not.) |

## Not verified - open items (for the verification discussion)

Collected from every gap so far. Nothing here has been removed or softened; items are added as work lands.

**G1 / G2 adapters and ONVIF**
- ONVIF has never run against a real camera or recorder. Vendor quirks, ONVIF over HTTPS with a self-signed certificate (unsupported), multicast discovery across several network adapters or managed switches, and the PTZ/events/analytics services are untested or unsupported.
- The Registry screen does not use the adapter layer; existing grid probing still calls `probeCamera` directly.

**G3 vendor adapters**
- Response shapes (Hikvision ISAPI XML, Dahua key=value) come from public documentation and memory, not from a device. Real firmware varies by model and version.
- Hybrid DVRs may number IP channels differently from analog ones (Hikvision starts IP channels at 33 on some models); the adapter takes the channel number as given and does not map them.
- HTTPS to a recorder with a self-signed certificate is not handled. No recorded playback, PTZ or device events. No Milestone or Genetec native adapter.
- The Registry screen does not call `/api/adapters/channels` yet.

**G10 recording**
- Never run with a real camera or the grid. Not tested: H.265, audio, a camera reconnecting mid-segment, camera clock jumps, a full disk. MediaMTX names segments in local time (found by running it); a different time zone between media server and app needs `RECORDINGS_NAME_TIME=utc` and `TZ=UTC`.
- Continuous recording keeps every recorded camera's stream open all day: on the grid that counts against watch time. Re-encoded cameras cannot be recorded. No gateway-side recording, object storage, automatic holds from alerts, signed manifests, low-disk alert, or screen.

**G12 connectors**
- Only mocks; the real VAHAN / SARTHI / eGujCop interfaces, authentication, rate limits and the legal basis for querying are unknown. The contract is a design, not a copy of theirs.
- Nothing checks a plate the registry does not know (the mock never invents records). AFIS/NAFIS need biometric templates and are not modelled. The cache and circuit breaker are per process. No screen.

**G8 roles**
- Claims, `set-role`, the Firestore log and the new rules never ran against Firebase; test the rules in the emulator before deploying (deploy them together with the new app build).
- Department scoping exists in the policy but guards no stored data yet. Views, searches and exports are not in the access log. The registry API still uses a shared key.
- New accounts are now operators, not admins; the pilot must run `set-role` for real admins, and set `AUTHZ_LEGACY_ROLE=false` once everyone has a claim.

**G4 / G5 analyzers, events, alerts**
- Postgres: the alert store, event store and plate sightings were run against the project's Neon database on 2026-10-10 and passed (`tests/alertStorePg.test.ts`, `tests/profileStorePg.test.ts`). Still open: the running server against Neon end to end, many server instances at once, a database near the server, growth and index size over time. (Earlier "never run" wording was because I had not looked in `scale.local`.)
- Several server instances can each open an alert for the same event at the same moment (events are stored once; folding repeats is per process).
- Only webhook and log channels; no e-mail/SMS. No screen in the app for events, rules or alerts. Per-camera analyzer settings are not read from the camera record. The browser capture loop emits no events.
- The camera-tamper analyzer is on by default and costs one extra short ffmpeg run per analysed frame (about 0.08 s of CPU on the test machine).

**G9 capacity** (details in `docs/capacity.md`, section 6)
- Not measured: Firestore writes/latency/cost; Redis/BullMQ queue depth and throughput; PostgreSQL beyond Neon-from-this-laptop (a database near the server, larger compute, many writers, growth over time); real Gemini latency, limits, errors and cost; the frame gate's real pass rate on real scenes (25% is an assumption); ANPR speed on CPU/GPU; re-encoding capacity and hardware encoders; H.265 cameras; WebRTC/HLS viewer scale.
- All figures come from one 2-core 1.1 GHz Celeron shared with other programs (about one core busy elsewhere); the 80,000-camera memory and pause figures are a single run; the media numbers are single 15-second windows and stop at 30 simulated cameras; per-grab CPU was measured on a local clip, not over RTSP.

**G6 regional gateway** (details in `docs/regional-gateway.md`, last section)
- Never run against real distant sites, real latency, a real Firestore (the `gateways` collection code and the `gatewayId` rules for `cameras` were not run in the emulator), or a real Gemini key.
- Playback through a gateway, evidence frames, failover, gateway self-update, mutual TLS and a Registry page are not built. An already-applied item can be applied twice if the centre restarts just as a confirmation is lost; multiple centre instances share no applied-id list.
- "Only an admin can set `gatewayId`" now rests on claims (G8) once accounts are migrated; until then the old stored role still counts.
- The simulated link models cuts, delay, 503s and lost answers on one machine, not a real WAN.

**Test suite and tooling**
- `tests/mediaServerEntrypoint.test.ts` fails and the synthetic camera lab test times out on the test machine; neither imports the new code, and neither was run on an unchanged tree to confirm they failed before.
- `tsc --noEmit` reports two errors in files this work did not change (`AnalyticsTab.tsx`, `MonitorTab.tsx`).

## Next phase

Two requirement briefs (Model 2 unified viewing, Model 3 federation middleware) now drive the work. Their answers to the open
questions, the new gaps (VMS connector contract, event bus, correlation, shared multi-department data, search, dashboard, session
caps) and the ordered plan are in `docs/federation-plan.md`. G10 recording is dormant for this phase (the briefs need no central
video storage).

## Where we are

(Updated 2026-10-10 after G1, G2, G4, G5, G6, G9, G11. The first column of each row is the original assessment; the second says what changed. See "Not verified" above for what none of this has been proven against.)

| Challenge | Status |
|---|---|
| 01 Heterogeneous infrastructure | Partial. RTSP/WHEP/HLS/MJPEG/snapshot inputs, probing, profiles, generated MediaMTX config, CSV and API onboarding. **Now also:** an adapter interface and ONVIF (tested against fakes and a real media stream, not a real camera). Now also Hikvision and Dahua recorder adapters with channel listing (G3; not run on a real recorder). No Milestone/Genetec native adapters. |
| 02 Geographical dispersion | Weak. Everything pulls through one central media server. No edge or regional tier. **Now:** a regional gateway tier (analysis next to the cameras, results sent over a signed, store-and-forward link; health and offline alerts at the centre). Not yet run across real distances or against real Firebase; video playback still goes the old way. |
| 03 Unified analytics | Mostly. One event log feeds plate tracking, routes and the full panel. Analytics are Gemini + ANPR only, not pluggable. **Now:** pluggable analyzers, a common event schema, rules and alerts with webhooks. No screens yet; no VAHAN-style connectors (G12). |
| 04 Scalability | Partial. Redis worker pool and idempotent onboarding exist. Untested past ~50 cameras; RBAC is a stand-in. **Now:** our own code measured up to 80,000 simulated cameras and per-operation costs measured (one weak laptop); the real limits (model calls, per-frame ffmpeg start-up, databases) are identified in `docs/capacity.md`. Roles are now claim-based (G8, not run against Firebase). |

## Gaps

### G1. Camera adapter interface (challenge 01) - M
No documented contract for "how a source type becomes a playable, analysable stream". Today the logic is spread across
`src/lib/streamAdapters.ts`, `server/cameraProbe.ts`, `server/cameraRecipe.ts` and `server/mediaPlan.ts`.
Define one interface (discover, probe, resolve stream URLs, health) and move the existing protocols behind it.
**Done when:** adding a new source type means adding one file, with a test, and no edits elsewhere.

### G2. ONVIF discovery and device profile (challenge 01) - M
Out of scope in `docs/camera-onboarding-plan.md`. Needs WS-Discovery, GetProfiles/GetStreamUri, and the device's
make and model captured on the record. Built as the first adapter on G1.

### G3. NVR/VMS adapters (challenge 01) - L
Per-vendor URL templates and auth for the platforms actually in use (ask which: Hikvision, Dahua, Milestone, Genetec,
others). Start with one or two real ones, not all. Also covers analog cameras behind DVR/encoders as a documented path.

### G4. Pluggable analytics (challenge 03) - M
Gemini and ANPR are wired in directly. `FrameGate` in `server/frameGate.ts` is the only existing plug-in point.
Add an `Analyzer` interface (input frame or stream, output typed events written to the existing event store), register
analyzers per camera or per department, and move Gemini and ANPR behind it.
**Done when:** a new detector (for example YOLO for crowd or intrusion) is added without touching the worker.

### G5. Event and alert framework (challenge 03) - M
Events exist as logs and sightings. Missing: a common event schema across analyzers, rules (watchlist, zone, count),
alert routing (webhook, email) and acknowledgement. `/api/alerts` and `/api/proxy-webhook` exist but are minimal.

### G6. Edge and regional tier (challenge 02) - L
The largest gap. Needs a design before code:
- A regional gateway that pulls local cameras, runs MediaMTX and capture or analysis nearby, and sends only events,
  snapshots and on-demand video to the centre.
- Registration and heartbeat of gateways; the central registry knows which gateway owns which camera.
- Behaviour when a link is slow or down: queue events, mark cameras degraded, resume.
Reuses the Redis queue (workers in regions) and the existing role split (`ANALYSIS_ROLE`).
Test with simulated latency, as was already done for HLS in `docs/media-server.md`.

### G7. Remove dependence on Cloudflare for video (challenge 02) - S/M
`docs/media-server.md` notes the free tier's terms restrict heavy video. Decide the production path (direct public
address, regional gateways with their own addresses, or a paid plan). Mostly a deployment decision that G6 settles.

### G8. Real RBAC and department separation (challenge 04) - M
Role is a self-set Firestore field (`src/types.ts`, `firestore.rules`). Move to custom claims or OIDC, add department
scoping so one department cannot see or edit another's cameras, and extend the audit trail to views, searches and
exports (today only registry changes and route decisions).

### G9. Scale test and capacity numbers (challenge 04) - M
Nothing verified past ~50 cameras. Produce measured figures: cameras per media server, per analysis worker, Firestore
write rate, Redis queue depth. Use simulated cameras at 500, then 5,000. This feeds the 80,000-camera plan.

### G10. Storage tiers, recording and playback (challenge 01/04) - L
No recording exists. Needed for recorded viewing and evidence. Segment storage plus a time/camera index and a
playback UI; hot/warm/cold tiers in the plan.

### G11. Vendor-neutral API spec (challenge 04) - S
Publish an OpenAPI spec for `/api/registry/*`, `/api/camera-profiles/*`, `/api/events/*` and `/api/analysis/*`.

### G12. Integration connectors (challenge 03) - M
VAHAN, SARTHI, eGujCop, AFIS, NAFIS: live access is restricted, so build mock connectors with documented contracts
that raise alerts on a plate or person match. Depends on G5.

### G13. Docs refresh - S
Update the status table in `docs/handover.md`, then keep this file as the source of truth for what is left.

## Implementation order

| Step | Gaps | Why this order |
|---|---|---|
| 1 | G13, G11 | Cheap, and make the current state accurate before building on it. |
| 2 | G1, then G2 | The adapter interface is a prerequisite for every other source type; ONVIF is the best first adapter because it is vendor-neutral. |
| 3 | G4, then G5 | Unified analytics needs a common analyzer and event contract before more detectors or integrations are added. |
| 4 | G9 | Measure before designing the regional tier. Capacity numbers decide how many gateways are needed. |
| 5 | G6 with G7 | Edge and regional design, informed by step 4. Biggest piece; do it once the interfaces from steps 2-3 are stable. |
| 6 | G8 | Needed before more than one department uses it. Can move earlier if a real multi-department pilot is close. |
| 7 | G3 | Build only the VMS adapters for platforms actually in the target estate. Needs input from the departments. |
| 8 | G12, G10 | Integrations and recording are large and depend on earlier work. |

## Decisions needed from you

1. Which VMS or NVR vendors are in the target estate? This sets G3.
2. Is a regional gateway acceptable at each site cluster, or must cameras be reachable only from the centre? This sets G6.
3. Is recorded playback required for the first milestone? This decides whether G10 moves earlier.
