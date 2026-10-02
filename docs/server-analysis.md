# Server-side analysis

Capture and AI analysis normally run in the browser tab (`App.tsx`), so cameras are only analysed while someone has the app open, and the tab can't realistically sustain dozens of feeds. The server-side worker moves that loop onto the server.

## How it works

- Cameras with `serverAnalysis: true` in their registry record are watched through a Firestore subscription (Admin SDK).
- Each camera is scheduled on its own `interval` (minimum 5 s). First runs are spread out so cameras added together don't all fire at once.
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

## Limits

- Webcam and simulated cameras only exist in a browser and cannot be analysed server-side.
- Camera URLs that point at loopback, link-local or private-network addresses are ignored (the server is making these requests). The check is hostname-only and doesn't defend against DNS rebinding.
- Google Sheets export is still browser-driven; server-produced logs are not appended to the sheet.
- It is a single in-process worker. Running multiple server instances would analyse each camera once per instance; a distributed lock or job queue is needed before scaling out.
- Analysis is still one Gemini call per frame; plate-reading accuracy is unchanged.
