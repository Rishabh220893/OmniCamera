# Testing guide for everything built in session 5 (2026-10-11)

How to check each feature yourself: first the automated test that covers it, then the manual steps. "Expected" says what you should see; anything else is a bug to report.
**On Windows PowerShell use `curl.exe` (not `curl`, which is an alias with different options), or `Invoke-RestMethod -Uri <url> -Headers @{ Authorization = "Bearer <key>" }`.** Start the app with `npm run dev` (port 3000) unless a step says otherwise. Sign in as an **administrator** for admin screens and as an **operator/viewer** where a step says so (`npm run set-role` sets roles).

## 0. Automated checks

| Command | What it covers | Result on 2026-10-11 |
|---|---|---|
| `npx tsc --noEmit` (use `NODE_OPTIONS=--max-old-space-size=6144` if it runs out of memory) | Types | One old error in `MonitorTab.tsx(681)`; nothing new |
| `node --import tsx --test tests/<file>.test.ts` | One area (files named per feature below) | The 25 files of this session: 252 tests, 229 pass, 0 fail, 23 skipped (environment-gated: Postgres, Redis, Firestore emulator) |
| `npm run test:rules` | Firestore rules in the emulator (needs Java) | 7 of 7 passed earlier in the session |
| `npm test` | Whole suite, about 13 minutes | Run when nobody is testing live |
| `TEST_DATABASE_URL=... node --import tsx --test tests/*Pg.test.ts` | Postgres code paths (**never run for the new plate-index code**) | not run |

## 1. Federation service, client keys, quotas, session caps (A7)

Auto: `tests/federation.test.ts`, `tests/federationUsage.test.ts`. Needs `FEDERATION_ENABLED=true`.
1. Settings > Federation (admin). Create a client "test-dept" with department "traffic", a small quota (e.g. 5 events/minute) and a session cap of 2. **Expected:** the key is shown once; copy it.
2. `curl.exe -H "Authorization: Bearer <key>" http://localhost:3000/api/federation/me` **Expected:** your client, limits and usage.
3. Post 6 events in one batch to `/api/federation/events` (PowerShell, one line, with the plain key `fed_<id>.<secret>`: `$key = "<key>"; $body = @{ events = @( @{ camera = "gate-1"; type = "intrusion"; text = "Person at the gate" } ) } | ConvertTo-Json -Depth 5; Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/federation/events -Headers @{ Authorization = "Bearer $key" } -ContentType "application/json" -Body $body`; add `id = "t1"` to the event and send it twice: the Events tab must show it once; `ignored` lists unreadable events, not duplicates, and without an `id` or `at` every push is a new event). **Expected:** the sixth is refused (429) and usage shows 5.
4. Open 3 sessions with `POST /api/federation/sessions`. **Expected:** the third is refused (cap); close one with DELETE and retry: accepted.
5. Wrong key: **Expected** 401. Disabled client: 403.
6. Rotate the key in the panel: the old key stops working at once, the new one works.
7. Redis counters: set `FEDERATION_STORE=redis` and `REDIS_URL`; repeat steps 3 and 4 with two server processes: the limit must hold **across** both. (Not run against a real Redis.)

## 2. Settings screen
1. Open Settings. **Expected:** theme, notifications, federation section (admin only), department picker for admins. A viewer sees no admin-only sections.
2. Toggle the theme and reload: it persists.

## 3. Video walls (A10)

Auto: `tests/wall.test.ts`. Needs `WALL_ENABLED=true`. Monitor > Wall.
1. As admin create a wall with a 2x2 layout and four cameras. **Expected:** it appears in the list.
2. As operator A: take control. **Expected:** you are the controller. Change the layout: it changes for viewers.
3. As operator B: try to take control. **Expected:** told who has it (409). Admin can force it.
4. Close A's tab and wait for the lease to run out (about a minute): B can take control.
5. Check the wall's audit (`GET /api/walls/<id>/audit`): every take, release and layout change is listed.
6. Restart the server: walls and layouts remain; sessions do not need to.

## 4. Federated report (A26) and vehicle trail (A18)

Auto: `tests/federatedReport.test.ts`, `tests/vehicleTrail.test.ts`. Events > Report; Events > Vehicle trail.
1. Report: pick a range; **Expected:** per-department figures, plates seen across departments, incidents, systems and retention; export CSV and print the page. A department user sees only their department's figures and the counts of others.
2. Trail: choose a plate with sightings in two departments (use the demo data or post plate events via the webhook). **Expected:** legs in time order, speeds and "too fast" flags, a look-alike confirmation prompt, CSV download.
3. A user of one department: **Expected** other departments' sightings appear only as allowed by the visibility rules, never their video.

## 5. Zone and line editor for the local detector

Auto: `tests/detectorZones.test.ts`. Settings > a camera with **AI analysis off**.
1. **Expected:** the editor appears over the camera frame. Draw a zone (click points, close it), draw a line, name them, save.
2. Reload: they are still there. Delete one; save; reload: gone.
3. Drag a point mid-draw, then start another shape: no stale shape appears.
4. With AI analysis **on**, the editor must not appear.

## 6. Full-screen camera: AI button and captions

(Type-checked and designed; **not tried on a real camera**.) Monitor > Full Panel > open a camera full screen.
1. **Expected:** an "AI" button at the top. Click: it turns on; every ~10 seconds a caption appears bottom-centre describing the scene.
2. Click again: captions stop. Close the camera: no more requests in the network tab (`/api/gemini/analyze-frame`).
3. With no AI key set: the caption area shows a clear error, not a blank.

## 7. Sealed department logins and key rotation

Auto: `tests/keyRotation.test.ts`. 
1. Add a department system with a login (Sources/VMS panel). Open `vms-systems.json` in `VMS_DATA_DIR`: the password must be unreadable (starts with a seal prefix), not plain text.
2. Rotate: set `SOURCE_SECRET_KEY_PREVIOUS` to the old key, `SOURCE_SECRET_KEY` to a new one, run `npm run rotate-source-key` (dry-run by default; add the flag it prints to apply). **Expected:** counts of re-sealed items; the system still connects afterwards.
3. Run it again: nothing left to change.

## 8. Evidence: signed, custody-chained, encrypted exports

Auto: `tests/evidence.test.ts`, `tests/recordingRoutes.test.ts` (real ffmpeg). Needs recording on and a recorded camera.
1. `npm run evidence-key` and put the keys in `EVIDENCE_SIGNING_KEY` and `EVIDENCE_ENCRYPTION_KEY`; restart.
2. Export a clip (Recording). **Expected:** the folder holds `manifest.json`, its signature, `custody.jsonl`, the video as `.mp4.enc`.
3. Download it from the UI: it plays (decrypted on the fly). Open the `.enc` file directly: unplayable.
4. `POST /api/recording-exports/<id>/verify`: **Expected** all checks pass; custody now has a "verified" line.
5. Offline check: `npm run evidence-key -- --verify manifest.json manifest.sig.json`: valid. Edit one byte of the manifest: invalid.
6. Remove the encryption key and restart, download: 409 with the reason, not noise.

## 9. Alert channels, incident notifications, holds from alerts

Auto: `tests/alertChannels.test.ts`, `tests/incidents.test.ts`. Events > Rules.
0. Plate rule: Events > Rules > new rule, types "Any plate read", **Only for these plates** = `GJ05AB1234`, repeats window 0. Push a plate event for that plate (PowerShell, one line: `$body = @{ events = @( @{ id = "p1"; camera = @{ id = "cam-1"; name = "Junction 1" }; type = "plate"; plate = "GJ05AB1234" } ) } | ConvertTo-Json -Depth 6; Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/federation/events -Headers @{ Authorization = "Bearer $key" } -ContentType "application/json" -Body $body`). **Expected:** an alert in Events > Alerts. Push another plate (new id): no alert. Verified on a live server 2026-10-11.
1. Create a rule with an **e-mail** channel (needs `SMTP_URL`, `ALERT_EMAIL_FROM`) and press Test: a test mail arrives, or a clear error shows. Same for **SMS** (`SMS_GATEWAY_URL`, `SMS_GATEWAY_TOKEN`).
2. Create a rule with **keep the recording around the event** (5 min before, 5 after). Trigger the event: **Expected:** an alert, a `recording.hold_placed` event, and the hold in Recording. Test button: no real hold.
3. Open an incident (two correlated events): **Expected:** the incident notification goes to the rule's channels once, not once per repeat.
4. Fill the recording disk below 15% (or set `RECORDING_DISK_LOW_PERCENT=99`): a `recording.disk_low` event within a minute, once.

## 10. Department picker and all-department view

1. As a multi-department admin: Monitor shows a department picker; choosing one filters cameras.
2. Admin > All departments: faces, plates, logs of every department in one place; a department admin sees only their own.
3. Plate sightings: a sighting created from a department's camera carries the department (check in Firestore); `npm run test:rules` proves another department cannot read it.

## 11. Event bus: Redis and Kafka

Auto: `tests/bus.test.ts` (memory, Redis if `TEST_REDIS_URL`, a fake Kafka). With `EVENT_BUS=kafka` and `KAFKA_BROKERS`: post a webhook event; **Expected:** it appears in Events and alerts fire; stop the broker, post more, restart: they are delivered (at-least-once) with no duplicates in the store. **Never run against a real broker.**

## 12. Edge recording and clip fetch (A16)

Auto: `tests/gatewayClips.test.ts`. Manual setup in `docs/regional-gateway.md`.
1. `npm run edge-recording-config -- cameras.json /var/recordings > paths.yml`, add to the site's MediaMTX; run the gateway with `GATEWAY_RECORDINGS_DIR`.
2. From the centre: `POST /api/gateways/<id>/clips {cameraId, from, to, reason}`. **Expected:** pending, then (within the gateway poll interval) ready; the export downloads and verifies (section 8).
3. Ask for a range with no footage: **failed** with a reason; the hold still exists.
4. Stop the gateway during the request: the request returns to pending after 5 minutes and completes when it is back.

## 13. Count anomalies and the inference service (A17)

Auto: `tests/inferenceAnalyzers.test.ts`. 
1. Anomalies need days of data. To see one sooner, run the test file (it feeds a synthetic week and a spike) and read the output.
2. Remote detector: run any HTTP server that follows `docs/inference-service.md` (a ten-line mock is in the test), set `INFERENCE_SERVICE_URL`; analyse a camera: **Expected** counts and `person.seen` events from the detector. Stop the service: analysis continues and an `analyzer.failed` notice appears; after three failures it is skipped for a minute.

## 14. Security: headers, HTTPS, audit export, per-user video

Auto: `tests/security.test.ts`, `tests/ops.test.ts`, `tests/mediaAuth.test.ts`, `tests/mediaServerEntrypoint.test.ts` (real MediaMTX).
1. `curl.exe -I http://localhost:3000/`: **Expected** CSP, `X-Content-Type-Options`, frame protection; with `FORCE_HTTPS=true` plain HTTP redirects (behind a proxy also set `TRUST_PROXY`).
2. `GET /api/access-log/export` (auditor/admin): sealed export; tamper with a line and verify fails.
3. `METRICS_ENABLED=true`: `GET /metrics` (with `METRICS_TOKEN`) returns Prometheus text; `/healthz` and `/readyz` return 200.
4. Per-user video (`MEDIA_AUTH_MODE=token`, `MEDIA_TOKEN_SECRET`, `MEDIA_AUTH_SECRET`): sign in, open a camera in your department: plays. Copy its stream URL and open it without the token or as a user from another department: refused. A token older than `MEDIA_TOKEN_TTL_MIN` stops working. **Not tried in a live browser.**

## 15. Kubernetes manifests (A23)

Auto: `tests/k8sManifests.test.ts` (structure only). Manual: `kubectl apply -k deploy/k8s --dry-run=server` on a real cluster, then check pods become ready, probes pass, network policies block a pod that is not allowed. **Never applied.**

## 16. Capacity benchmark (A24)

`node --import tsx scripts/capacity/platform.ts --quick` (seconds) or without `--quick` (about a minute; writes `scripts/capacity/results/platform.json`), then `node --import tsx scripts/capacity/platformReport.ts`. Compare with `docs/load-test-report.md`; numbers differ by machine.

## 16b. Registry and GIS map (Model 1)

Auto: `tests/registryReport.test.ts`, `tests/registryQuery.test.ts`. Registry tab, signed in as admin.
1. **Bulk import:** Bulk import CSV with `docs/sample-cameras.csv`. **Expected:** "CSV import: N added", pins on the map, rows in the list. Import it again: existing cameras are not duplicated.
2. **Manual entry:** Add camera, fill location, department, type, ownership, install date, storage details. **Expected:** it appears on the map and in the list, and in the audit trail as `create` via manual.
3. **API onboarding:** `POST /api/registry/cameras` with `X-Registry-Api-Key` (see `docs/registry-api.md`). **Expected:** 201 and the camera in the list (audit: via api).
4. **Map layers:** use the layer control (top right of the map): switch Status layers, Coverage and Uncovered zones on and off; tick or untick Departments and Camera types above the map. **Expected:** pins and circles appear and disappear; the "N of M located cameras shown" line follows.
5. **Gap analysis:** open Gap analysis report. **Expected:** unlocated, offline/degraded, ageing, stale, incomplete metadata (which fields are missing per camera), uncovered zones (with the share of the area covered). Download report (CSV) opens in a spreadsheet; Print gives a printable page.
6. **Filters and export:** search, department, status and type filters narrow both the list and the map; Export CSV downloads what you can see; the audit trail has Export audit trail (CSV).
7. **API filters:** `...cameras?userId=U&status=offline`, `&bbox=77.5,12.9,77.7,13.1`, `&format=geojson` (opens in QGIS), `&format=csv`; a bad `bbox` gives 400.
8. **Sample report:** `npm run registry-gap-report -- docs/sample-cameras.csv` prints the report (see `docs/sample-gap-report.md`).
9. **PostGIS mirror (optional, off by default):** first `DATABASE_URL=... DATABASE_SSL=true npm run registry-postgis-check -- --yes` (scratch schema, dropped afterwards; all lines must say ok). Then set `REGISTRY_POSTGIS=true`, restart, and watch the log for `First copy applied (N cameras); the mirror is live.`. `GET /api/registry/status` (header `X-Registry-Api-Key`) shows `ready: true`. Add a camera in the app; within seconds `...cameras?userId=U` lists it. Break it on purpose (wrong password in `DATABASE_URL`, restart): the log says so, `/api/registry/status` shows `ready: false`, and `...cameras?userId=U` still answers from Firestore. `GET /api/registry/gaps?userId=U` returns uncovered zones (503 while not ready). See `docs/registry-postgis.md`.
10. **Role-based access:** sign in as a department user: only that department's cameras are listed; as admin: all (see `docs/authz.md`).

## 17. Known gaps to check by eye (not covered by anything)

The wrong-camera tile in the pinned grid (root cause not found); admin screens (Federation, All departments, Report) opened signed-in against live Firebase; Postgres plate column (`platform_events_plate`) creation on Neon: run the Pg tests with `TEST_DATABASE_URL`.
