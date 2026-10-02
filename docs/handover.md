# Handover: what changed, what to check, what is left

Companion to `docs/deployment.md` (how to deploy). Tab names below are the ones in the sidebar: **Feed, Logs, Registry, Settings, Guide**.

---

## 1. Checklist of changes made in this work

Tick each once you have seen it work. Items marked ⚠ were **not exercised against the real service** (no real Firestore/Render/GPU/camera grid was reachable while building).

### Server-side capture and analysis
- [ ] Server captures frames with ffmpeg and runs Gemini analysis on a per-camera schedule — no browser tab needed (`server/analysisWorker.ts`, `server/frameSource.ts`) ⚠
- [ ] Bounded job queue, one job per camera at a time, failure back-off up to 5 min
- [ ] Cadence measured from run start (a 60 s camera runs every 60 s, not 75 s); cameras added together are spread across the interval
- [ ] Opt-in per camera ("Analyze on server") and for the whole grid; browser loop skips those cameras (no double analysis)
- [ ] Unsafe camera URLs (localhost / private ranges) are never fetched by the server
- [ ] `/api/analysis/config` (public: enabled, anpr, ffmpeg) and `/api/analysis/status` (registry key: queue, backlog, ANPR health, ffmpeg version)
- [ ] ffmpeg availability check + startup log line
- [ ] Server honours `PORT`; root `Dockerfile` (with ffmpeg) for hosts without it ⚠ (never built)

### Shared job queue (multi-instance)
- [ ] `ANALYSIS_DISTRIBUTED=true`: each camera claimed through a Firestore lease; no camera analysed twice; crashed instance's work taken over; lease-store outage → skip rather than duplicate ⚠ (tested against a stand-in for Firestore only)
- [ ] Status shows `distributed`, `instanceId`, `skippedClaims`, `overdue`, `maxLagSeconds`

### ANPR (licence plates)
- [ ] `anpr-service/` (FastAPI + fast-alpr): plate detector + OCR, CPU or NVIDIA GPU, `ANPR_DEVICE=cuda` is strict ⚠ (real models/GPU never run)
- [ ] Indian-plate positional correction (`GJO1AB1234` → `GJ01AB1234`), conservative; Delhi-style `DL1SAB1234` untouched
- [ ] API key (`X-ANPR-Key`); warning when the service runs without one
- [ ] Node client with authenticated probe, confidence filter, **circuit breaker** (3 failures → 60 s skip)
- [ ] ANPR is authoritative when it answers (even with no plates); Gemini plates only if ANPR is unconfigured or failing (`plateSource`: `anpr` / `gemini` / `gemini-fallback`)
- [ ] `scripts/check-anpr.mjs` (device, key, speed on a real frame, capacity verdict)
- [ ] Watchlist comparison ignores spaces/punctuation on both sides

### Permanent sightings and vehicle tracking
- [ ] Every plate read stored append-only in `plateSightings` (+ counters in `plateIndex`), by browser and server ⚠ (needs deployed rules)
- [ ] Exact-match route; look-alike "possible matches" you confirm/reject (saved, undoable)
- [ ] Route legs with distance and speed; implausible-speed and simultaneous-sighting flags
- [ ] Route CSV export (one row per sighting, injection-safe)
- [ ] New Firestore rules: `plateSightings`, `plateIndex`, `plateMatchDecisions` ⚠ (never run in an emulator)

### Catalogue onboarding (item 10)
- [ ] "Onboard grid cameras": idempotent, fills missing details on existing cameras without overwriting, validated coordinates, batches of 200 with atomic audit entries
- [ ] Warning when the server substituted its built-in 30-camera list (and it stays until dismissed)
- [ ] Summary message incl. how many cameras have no map location
- [ ] 50/60-camera tests and a sizing rule (`docs/onboarding.md`)

### Docs / tests added
- [ ] `docs/`: `server-analysis.md`, `anpr-service.md`, `vehicle-tracking.md`, `onboarding.md`, `deployment.md`, this file
- [ ] 64 Node tests (`npm test`) + 26 Python tests (`cd anpr-service && pytest`) pass

---

## 2. UI to check after deployment

**Registry tab**
- [ ] Button now reads **Onboard grid cameras** (was "Load demo grid"); hover text explains behaviour
- [ ] After clicking: a banner summarising *N added / N updated / N already up to date / N skipped* and the **"no map location"** warning; green style when the live catalogue was used
- [ ] If the live catalogue can't be reached: an **orange warning** saying the built-in list of 30 was used; it does **not** disappear on its own; has a **Dismiss** link
- [ ] **Analyze all on server** and **Stop** buttons appear only when the server worker is enabled (`/api/analysis/config` → `enabled: true`) and only for admin users; they switch every remote-feed camera
- [ ] **Bulk import CSV** now shows a "CSV import: …" summary banner
- [ ] Map: after "Show route on map" from Logs, the route chip and dashed route line appear; clearing it works
- [ ] A 50-camera list still pages/filters normally

**Logs tab — "Vehicle tracking" (replaces "Vehicle search")**
- [ ] Search box accepts spaces/lower case (`gj 01 ab 1234`)
- [ ] Header line: `PLATE: N exact sightings · N stops · X km`; buttons **Show route on map** and **Export route CSV**
- [ ] Numbered stops with camera, department, time range, read count, best confidence
- [ ] Between stops: distance, time and speed; an **orange warning chip** for implausible speed / simultaneous sighting / missing camera location
- [ ] **Possible matches** list: each shows the edit in words (e.g. "digit 0 ↔ letter O at position 3 (look-alike)") with the differing character highlighted; **Same vehicle** / **Different** buttons
- [ ] After "Same vehicle": it moves to **Confirmed as the same vehicle** (with an undo icon) and the route gains that plate's stops, marked **includes look-alike**
- [ ] "Show N rejected" toggle with undo
- [ ] **unverified read** badge on stops read by Gemini rather than the plate service
- [ ] Phone width (≈375 px): no horizontal scroll
- [ ] Guest ("demo") mode: works from the in-memory log; decisions last only for the session

**Settings tab**
- [ ] Under *Sync frequency*: **Analyze on server** switch (only when the worker is enabled; disabled for non-remote feeds), with the last server error shown in red if there is one
- [ ] Remember to press **Save settings** after toggling

**Feed tab**
- [ ] Cameras set to server analysis are **not** also analysed by the open browser (watch for duplicate log entries per interval — there should be one)

**Not UI, but check**
- [ ] `/api/analysis/config` (browser) and `/api/analysis/status` (with `X-Registry-Api-Key`)

---

## 3. Left over from the original mandatory-FAQ table

Legend: ✅ done · 🟡 partly · ❌ not done · ⛔ not possible for a participant

| # | Requirement | Status | What is left |
|---|---|---|---|
| 1 | **Model 1** registry + GIS (FAQ 12–15) | 🟡 | Automated health probing (ping each stream → `connectivityStatus`); map layer filters by department/type/status (the list has filters, the map was not changed) |
| 2 | Model 1 + at least one other model | 🟡 | Hybrid exists (1 + parts of 2 + a slice of 4). Missing: ONVIF discovery, a documented adapter interface per protocol, vendor-SDK stubs |
| 3 | Onboard ~50 live-simulated feeds | ✅ code / ❓ unverified | Run it against the real catalogue (the real response format is unconfirmed) |
| 4 | Central monitoring + analytics on those feeds | ✅ | Measure real analysis time and tune `ANALYSIS_CONCURRENCY` |
| 5 | Track a designated vehicle across cameras | 🟡 | Plate-based tracking done; **accuracy on the real feeds untested** (tune `ANPR_MIN_CONFIDENCE` and look-alike scoring); no appearance-based re-identification (plate only) |
| 6 | Route, timestamped history, output report | 🟡 | CSV done. Missing: PDF report; snapshot image per sighting as evidence; configurable speed/dwell thresholds |
| 7 | Solution presentation (PPT/PDF) | ❌ | Write it (model choice + justification) |
| 8 | HLD / technical proposal | ❌ | Architecture diagrams, integration approach, analytics approach, scalability plan, department technical info |
| 9 | Demo on your own feed (2–3 min) | ❌ | Record: onboarding, live **and recorded** viewing, ANPR. Recorded viewing needs recording/playback, which does not exist |
| 10 | Demo on the government feed + output report | ❌ | Record after the accuracy check; export the route CSV |
| 11 | Real working software, no mock-ups (FAQ 32) | 🟡 | Ensure everything shown runs for real; no animated/concept parts |
| 12 | Submission format (unlisted YouTube/Drive; optional hosted URL + repo) | ❌ | Upload videos; deploy per `deployment.md`; share repo |
| 13 | Scalability plan for ~80,000 cameras (FAQ 30, 35) | ❌ | Document only: central/regional/edge, GPU sizing, bandwidth, hot/warm/cold storage, HA/DR, phased rollout. (Building it is not realistic.) |
| 14 | Security, RBAC, audit (FAQ 24) | 🟡 | Real RBAC (custom claims instead of a self-set profile field); extend the audit trail to views/searches/exports (today only registry changes + route decisions are recorded) |
| 15 | Open, vendor-neutral, API-driven design | 🟡 | OpenAPI spec for the server APIs; adapter interface (see 2) |
| 16 | Heterogeneous cameras incl. analog | 🟡 | Analog only via DVR/encoder guidance (`DvrGuideModal`); document in the HLD |
| 17 | Integration readiness: VAHAN, SARTHI, eGujCop, AFIS, NAFIS | ⛔ live / ❌ mock | Live access is restricted to government agencies. Build mock connectors + documented API contracts that raise alerts on a plate/person match |
| 18 | Model 3 federation middleware (optional) | ❌ | Skip unless time allows |
| 19 | Model 4 central VMS + AI (optional) | 🟡 | Prototype slice only. No recording, playback, storage tiers, crowd/anomaly analytics, GPU video pipeline |
| — | Recording, storage and playback | ❌ | Needed for "recorded viewing" in the demo; a media server (go2rtc/MediaMTX) + segment storage + time/camera index + playback UI |

### Operational leftovers (from earlier discussion)
- [ ] **Rotate the grid password** committed in `server.ts` (`DEFAULT_STREAM_EMAIL/PASSWORD`), set `STREAM_EMAIL/STREAM_PASSWORD` in the environment, then remove the defaults from code
- [ ] **Deploy the Firestore rules** and do one end-to-end sighting test
- [ ] Confirm **ffmpeg** on the host (`/api/analysis/config`)
- [ ] Run the **ANPR accuracy check** on real frames and tune the confidence threshold
- [ ] Decide CPU vs GPU for ANPR using `scripts/check-anpr.mjs` on a real frame
- [ ] Use an **always-on** instance for server-side analysis
- [ ] Optional: Google Sheets export for server-produced logs; PDF report; PTZ/ONVIF

### Known limitations (unchanged)
Sightings are recorded from this version on (no back-fill of older logs); possible-match scoring only knows common look-alike pairs; the server-URL safety check is hostname-only; one Gemini call per frame; plate reading quality depends on camera resolution/angle/light.
