# Onboarding the camera grid

**Registry → Onboard grid cameras** adds every camera in the grid's own catalogue to the registry in one action. **Bulk import CSV** uses the same path.

## What it does

- Reads the catalogue through the server proxy (`/api/camera-catalogue`), builds each camera's HLS URL from its id, and picks up coordinates, department and live/offline status **if the catalogue provides them** (field names are matched loosely — `lat`/`latitude`, `lng`/`lon`/`longitude`, a nested `location`/`coordinates` object, `department`/`dept`; an object keyed by camera id is accepted as well as an array).
- **Idempotent.** Cameras are matched by stream URL (ignoring case/whitespace). Running it again never duplicates a camera.
- **Fills in, never overwrites.** If an existing camera is missing a department, ownership, type, install date, storage detail or location, and the new data has it, that field is filled. Anything already set (including a name you edited) is left alone. So you can re-run it after the catalogue gains coordinates.
- **Atomic and audited.** Changes are committed in batches of up to 200 cameras; each camera's audit-trail entry is written in the same batch as the change. (The previous version used one batch for everything, which fails above ~500 cameras.)
- **Coordinates are validated.** Blank, non-numeric, out of range, or exactly 0,0 are treated as "no location" instead of being stored.
- **Tells you the result:** how many were added, updated, already up to date, skipped as duplicates/nameless — and **how many cameras have no map location**, because vehicle routes (speed, distance, map) can't use those.

## If the real catalogue can't be reached

The server then answers with its built-in list of **30** cameras. The app now says so, in a warning that stays until dismissed: *"The live grid catalogue couldn't be reached, so the built-in list of 30 cameras was used instead — the real grid may have more."* Before, this was reported as a normal successful load, which would have silently onboarded 30 cameras of a ~50-camera grid. Fix the stream-access email/password in Settings and run it again; already-added cameras are left as they are.

## Server-side analysis for the whole grid

When the server worker is running (`SERVER_ANALYSIS=true`), **Analyze all on server** / **Stop** switch server-side analysis on or off for every camera with a remote feed in one step (otherwise it is a per-camera toggle in Settings).

## Is ffmpeg installed on the host?

Server-side capture (and `/api/camera-snapshot`) needs ffmpeg. Check without a shell:

- Open `https://<your-app>/api/analysis/config` — it returns `"ffmpeg": true` or `false`.
- `GET /api/analysis/status` (with `X-Registry-Api-Key`) also returns the version string.
- The server log prints `[FFMPEG] ffmpeg version …` at startup, or a warning if it's missing.

If it's `false` on Render's Node runtime, switch the service to a Docker deploy that installs ffmpeg (e.g. `apt-get install -y ffmpeg` in the Dockerfile).

## Sizing the worker for ~50 cameras

Each camera is re-analysed one interval after its last run **started**; a run that outlasts its interval is followed by a 2 s minimum gap. Cameras added together are spread evenly across the interval rather than all firing at once. The number of jobs that must run in parallel is roughly:

> **concurrency ≈ cameras × seconds per analysis ÷ interval**

Simulated with the real worker under a fake clock (50 cameras, 15 s per analysis — an **assumption**, not a measurement; capture plus the model call will differ on your host):

| Interval | `ANALYSIS_CONCURRENCY` | Result |
|---|---|---|
| 60 s | 4 | cameras run about every 187 s; large backlog |
| 60 s | 8 | about every 94 s; backlog |
| 60 s | 13 or 16 | every 60 s; no backlog |
| 30 s | 16 | about every 47 s; backlog |
| 30 s | 32 | every 30 s; no backlog |

`GET /api/analysis/status` reports `overdue` (cameras waiting) and `maxLagSeconds`; if those keep growing, raise `ANALYSIS_CONCURRENCY`, lengthen the interval, or run another instance (`ANALYSIS_DISTRIBUTED`). Higher concurrency also means more simultaneous Gemini calls and ffmpeg processes — watch your API rate limit and the host's CPU/memory.

## Not verified

The real catalogue's response shape is unknown to this code and the sandbox cannot reach the grid, so parsing is tested against plausible shapes only. If the real response has a different shape, onboarding will say it found no usable cameras (rather than guessing).
