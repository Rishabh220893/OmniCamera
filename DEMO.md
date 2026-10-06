# Demo runbook

Run everything with one script, `scripts/demo.mjs`. It works in PowerShell, cmd and Git Bash, from the repo folder.

## Every time (3 commands)

```powershell
node scripts/demo.mjs up --all-logs      # 1. start everything (checks first, builds if needed, ~2 min cold)
node scripts/demo.mjs status             # 2. any time: is analysis really flowing?  (second window)
node scripts/demo.mjs analysis-off --yes # 3. at the end: stop spending Gemini calls
```

`up` does, in order: pre-flight check, production build (only if the code changed), media server (MediaMTX),
scheduler (also serves the web app on port 3000), one worker (port 3001). It waits for each to be ready and prints
`READY`. Ctrl+C in that window stops all of it.

Then in the browser at **http://localhost:3000**:

1. Sign in with **Google** (not the offline demo; guest cameras can't be analysed by the server).
2. Tick the cameras to analyse in the right-hand list. The header scope switches to **Selected**.
3. Click **Activate Guard**. Those cameras are handed to the server automatically.
4. Watch the `[status]` line in the `up` window (updates every 30 s).

## Day before / just before the demo

```powershell
node scripts/demo.mjs check
```

Everything should say `PASS` or `INFO`. It tests Node, ffmpeg, your settings, Redis, Postgres (and warms it up),
the camera grid, free ports, Git Bash, the media binary, whether a rebuild is needed, and ANPR if configured.
Fix any `FAIL`. A `WARN` on the camera grid means the third-party server is down; nothing on your side fixes that.

Run `node scripts/demo.mjs up --build` once the day before so the first start on demo day is quick.

## Options for `up`

| Option | Meaning |
|---|---|
| `--all-logs` | Show every analysis in the Logs tab. Without it only unusual/alert events appear there (Postgres keeps everything). **Use it for demos.** |
| `--workers 2` | More workers (ports 3001, 3002, ...). Each does `ANALYSIS_CONCURRENCY` jobs at a time. |
| `--single` | One process, in-memory queue, no Redis. The fallback if Redis is unreachable. |
| `--no-pg` | Store events in Firestore only, no Postgres. The fallback if Neon is unreachable. |
| `--no-media` | Skip the local media server (tiles then use the app's own route; slower). |
| `--dev` | Run from source with Vite instead of the production build (slower start, hot reload). |
| `--build` | Force a rebuild. |

Safest "no internet services" demo: `node scripts/demo.mjs up --single --no-pg --all-logs`.

## Other commands

| Command | Use |
|---|---|
| `node scripts/demo.mjs status` | Processes, queue, flagged cameras, server logs in the last 5 minutes, failing cameras with their error. |
| `node scripts/demo.mjs analysis-off` | Shows how many cameras are flagged. Add `--yes` to switch them all off. |
| `node scripts/demo.mjs stop` | Kills anything still on ports 3000-3009 and 8888 (leftovers from a crashed run or old windows). |

Logs of each process are written to `.demo-logs/` (`scheduler.log`, `worker1.log`, `media.log`).

## Settings files (git-ignored, filled in once)

- `scale.local`: Firebase service account, `GEMINI_API_KEY`, `STREAM_EMAIL`, `STREAM_PASSWORD`, `REDIS_URL`,
  `DATABASE_URL` (+ `EVENT_STORE=postgres`, `DATABASE_SSL=true`).
- Optional: `ANALYSIS_CONCURRENCY=4` (per worker), `ANPR_SERVICE_URL` + `ANPR_API_KEY`, `MEDIA_VIEWER_PASSWORD`.
- `demo.local` is only needed if you want to run the old `scripts/local-demo.sh` on its own.

## Choosing cameras

- Known good: **cam05, cam13, cam14, 01 Chiman bhai Bridge, 03 O.N.G.C. Office**.
- Avoid **cam18** (times out on RTSP) and **cam12** (takes ~14 s per frame).
- Keep camera intervals at **15-30 s** and 5-10 cameras at a time. The grid takes 2-14 s per capture, so a 6 s
  interval cannot keep up and shows `Could not capture a frame`. Each analysis costs a Gemini call.
- The camera you are currently viewing is always included in the guard. Click a good camera first.

## If something goes wrong

| Symptom | Fix |
|---|---|
| `check` says ports in use | `node scripts/demo.mjs stop`, then `up` again |
| Redis `FAIL` | Check the Redis Cloud database is running; or `up --single` |
| Postgres `FAIL` | Neon may be waking up, retry once; or `up --no-pg` |
| Camera grid `WARN` | Third-party outage. Retry later; nothing to fix here |
| `up` stops with "did not come up" | Open `.demo-logs/scheduler.log` (or `worker1.log`, `media.log`) |
| Cameras ticked but `status` shows 0 flagged | You are in guest mode, or Activate Guard is off; sign in with Google and activate |
| Flagged cameras but no server logs | Worker not running or cameras failing: `status` lists their errors |
| Logs tab shows only a few entries | You started without `--all-logs` |
| Tiles slow or blank | Grid or media server load; reduce `MEDIA_MAX_LIVE_TILES` (default 10) in `scale.local` |

## Not automated (be aware)

- **ANPR (licence plates)** is not started by the script. It needs Python or Docker, which this PC does not
  have. Without it the app reads plates with Gemini (shown as "unverified read"). To use it, run the service on
  another machine (`docs/anpr-service.md`) and put its address in `scale.local`; `check` will then test it.
- **Google sign-in** and ticking cameras are manual (browser).
- **Rotate your keys after the demo season.** The Firebase key, Gemini key and grid password were pasted into
  chat while testing.
- Deploying to Render is separate (`docs/deployment.md`); this runbook is for running on this PC.

## What each piece does

```
 grid cameras ──RTSP──▶ media server :8888 ──HLS──▶ browser tiles
 grid cameras ──RTSP──▶ worker :3001  ──▶ Gemini ──▶ Postgres (record) + Firestore (live feed)
 scheduler :3000  ──jobs via Redis──▶ worker(s);  also serves the web app
```

Details: `docs/scale-out.md`, `docs/media-server.md`, `docs/server-analysis.md`.
