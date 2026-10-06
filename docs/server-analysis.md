# Server-side analysis

Capture and AI analysis normally run in the browser tab (`App.tsx`), so cameras are only analysed while someone has the app open, and the tab can't realistically sustain dozens of feeds. The server-side worker moves that loop onto the server.

## How it works

- Cameras with `serverAnalysis: true` in their registry record are watched through a Firestore subscription (Admin SDK).
- Each camera is scheduled on its own `interval` (minimum 5 s), measured from when its last run *started*. Cameras added together are spread evenly across the interval so they don't all fire at once. Sizing guidance: `docs/onboarding.md`.
- Due cameras go through a bounded queue (`ANALYSIS_CONCURRENCY`, default 4). A camera that is already queued or running is never queued twice — it just runs late.
- Per job: grab a frame with ffmpeg (direct RTSP for grid cameras, falling back to the HLS proxy; other `rtsp://`, image and HLS/MP4 URLs also work) → Gemini analysis (the same function behind `/api/gemini/analyze-frame`) → write a `logs` document (same shape the UI already reads, plus `analyzedBy: "server"`) → update the camera's `lastAnalysisTime` → fire the camera's webhook.
- Failures back off exponentially (interval × 2^failures, capped at 5 min). The error is saved on the camera as `lastAnalysisError` (only when the text changes) and cleared on recovery.
- The user's known faces and watchlist are loaded server-side and cached for 60 s.

## Enabling it

1. Set `FIREBASE_SERVICE_ACCOUNT`, `GEMINI_API_KEY` and `SERVER_ANALYSIS=true`. ffmpeg must be on the server's `PATH`.
2. Turn on **Analyze on server** for a camera under Settings → Sync frequency (remote link feeds only), then save. The toggle only appears when the worker is enabled.
3. The browser loop skips any camera with `serverAnalysis: true`, so nothing is analysed twice.

`GET /api/analysis/config` → `{ "enabled": boolean }` (public).
`GET /api/analysis/status` → queue depth, active jobs and per-camera status (requires `X-Registry-Api-Key` when `REGISTRY_API_KEY` is set).

## Running more than one instance (shared queue)

By default the worker assumes it is the only instance. To share the work across several server instances, set `ANALYSIS_DISTRIBUTED=true` on **all** of them (same Firestore project). Each camera is then claimed through a Firestore lease (`analysisLeases/{cameraId}`, Admin SDK only) before it is analysed:

- the claim succeeds only if nobody else holds an unexpired lease **and** the camera is actually due, so a camera is never analysed twice per interval;
- the holder records when the camera is next due (including failure back-off) when it finishes;
- a crashed instance simply stops renewing — its lease expires (`ANALYSIS_LEASE_MS`, default 120 s, which must exceed your slowest capture + analysis) and another instance takes the camera over;
- if the lease store is unreachable an instance does **not** analyse (rather than risk a duplicate) and retries in ~5 s.

Cost and limits: each run adds two small Firestore transactions (claim and release), so leave it off for a single instance. Instances compare their own clocks against the lease times, so keep clocks within a few seconds (normal NTP is enough). This was verified with unit tests against an in-memory stand-in for Firestore, not against a real Firestore project.

`GET /api/analysis/status` shows `distributed`, `instanceId`, `skippedClaims`, and the backlog: `overdue` (cameras due but not started) and `maxLagSeconds`. A lag that keeps growing means there is not enough capacity — raise `ANALYSIS_CONCURRENCY` or add instances.

## Limits

- Webcam and simulated cameras only exist in a browser and cannot be analysed server-side.
- Camera URLs that point at loopback, link-local or private-network addresses are ignored (the server is making these requests). The check is hostname-only and doesn't defend against DNS rebinding.
- Google Sheets export is still browser-driven; server-produced logs are not appended to the sheet.
- Analysis is still one Gemini call per frame; plate-reading accuracy is unchanged.

For the frame gate, a Redis-backed scheduler/worker split, and moving events to Postgres, see `docs/scale-out.md`.
