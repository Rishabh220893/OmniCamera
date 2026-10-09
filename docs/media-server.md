# Media server (live video for many cameras)

Without it, every live tile's video flows through the app server and the grid's front door, so a wall of live
cameras is not possible. With it, **one small service pulls each camera once** (only while someone is watching) and
re-serves it to any number of browsers as HLS (and WebRTC). The app server stops carrying video.

```
grid cameras ──RTSP, one pull per camera──▶ media server ──HLS──▶ every browser
                                              (MediaMTX)
app server (Render): sign-in, camera records, analysis. No video.
```

It lives in `media-server/` and is [MediaMTX](https://github.com/bluenviron/mediamtx) (open source, MIT) plus an
entrypoint that writes its config from environment variables. **Nothing secret is stored in the repo or the image.**

## Does it need a signup or an API key?

**No signup and no API key for the software itself.** MediaMTX needs no account or licence. You need:

| You need | Notes |
|---|---|
| The grid email and password | You already have them. They stay on the media server (`GRID_EMAIL` / `GRID_PASSWORD`). |
| A viewer password you invent | `MEDIA_VIEWER_PASSWORD`. What the app's browsers use to watch. Make it long and random (below). |
| A place to run it that stays on | Your PC for a demo, or any server. Hosting providers need an account and usually a card. |
| **HTTPS** if the app is on Render | The Render app is `https://`, and browsers refuse to play video from a plain `http://` address inside it. |

Ways to get HTTPS for the media server:

| Option | Signup / cost | Notes |
|---|---|---|
| **Run both on your PC** (`npm run dev` + the media server) | None | Everything is `http://localhost`, which is allowed. Simplest demo. |
| **A Docker web service on Render** | You already have Render. Paid plan recommended: the free plan sleeps and has little CPU and bandwidth. | HTTPS comes with it. Set `MEDIA_HLS_PORT=10000` (Render's port). WebRTC does not work there (no UDP), HLS does. **Not tested.** |
| **A VPS plus a domain and Caddy** | VPS about $5–20/month, domain about $10/year, Let's Encrypt is free | Best for real use: a fixed address and full control. |
| **Cloudflare Tunnel** | Free account (quick tunnels need none) | Fine for a short demo. Cloudflare's terms restrict heavy video through its free service, so do not rely on it for a lot of streams. |

## Run it

```bash
cd media-server
cp .env.example .env        # fill in GRID_EMAIL, GRID_PASSWORD, MEDIA_VIEWER_PASSWORD
docker compose up -d --build
```

Make the viewer password (MediaMTX only accepts letters, digits and `! $ ( ) * + . ; < = > [ ] ^ _ , @ # & -`, so
random hex is safest):

```powershell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''
```

Check it (the first request starts the pull and can take several seconds):

```bash
curl -i -u viewer:<VIEWER_PASSWORD> "http://localhost:8888/cam01/index.m3u8?cookieCheck=1"   # 200 and a playlist
curl -i "http://localhost:8888/cam01/index.m3u8?cookieCheck=1"                                 # 401 without the password
```

## Connect the app

On the app server (Render), set:

| Variable | Value |
|---|---|
| `MEDIA_SERVER_URL` | The media server's public HLS address, e.g. `https://media.example.com` (no trailing path) |
| `MEDIA_VIEWER_PASSWORD` | The same viewer password |
| `MEDIA_MAX_LIVE_TILES` | Optional. How many wall tiles play live (default 12). A browser can only decode so many streams at once. |

On the media server, set `MEDIA_ALLOW_ORIGIN` to the app's address (e.g. `https://omnicamera.onrender.com`) so other sites cannot play it.

The app then gives the media-server address and viewer login **only to signed-in users** (their Firebase sign-in is
verified on the server). Guests get still images. `MEDIA_ALLOW_GUESTS=true` skips that check; use it for local demos only.
Verifying a sign-in needs `FIREBASE_SERVICE_ACCOUNT` on the app server.

If the media server is down, a tile falls back to the app's own route for that camera.

## Settings that matter

| Variable | Default | Meaning |
|---|---|---|
| `CAMERA_COUNT` / `CAMERA_IDS` | 30 / (cam01..cam30) | Which cameras exist |
| `GRID_RTSP_HOST` / `GRID_RTSP_PORT` | 103.250.160.189 / 8554 | Where the grid's RTSP server is |
| `MEDIA_IDLE_CLOSE` | 60s | How long a camera stays pulled after its last viewer leaves. **Do not set it below your slowest camera's keyframe interval**: the timer also runs while a stream waits for its first keyframe, so a camera that sends one every 30 s would never start (seen in testing at 15 s). |
| `SOURCE_CLOSE_AFTER` | 5s | Extra wait before the pull is dropped. Total idle time is the sum of the two. |
| `SOURCE_START_TIMEOUT` | 60s | How long to wait for a camera to start |
| `MEDIA_HLS_VARIANT` | fmp4 | Standard HLS: about 1 request/s per camera, smooth over a slow or distant link, a few seconds of delay. `lowLatency` cuts the delay but fetches tiny parts several times a second; with a simulated 300 ms network delay it stalled (14 buffering events in 45 s, none for `fmp4`). `mpegts` is the most compatible. |

## H.265 cameras (cam06, 12, 17, 22, 26)

Five grid cameras send H.265. WebRTC cannot carry it, and MediaMTX never produced an HLS playlist for them (tested on
cam06 and cam26: nothing after 60 s, even though Chrome itself can decode HEVC). So the media server can re-encode
them to H.264 with ffmpeg and Intel Quick Sync, only while somebody watches:

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_TRANSCODE_IDS` | empty (off) | Cameras to re-encode, e.g. `cam06,cam12,cam09:h264`. A bare id is an H.265 camera; `:h264` marks an H.264 camera whose B-frames kill MediaMTX's HLS muxer ("unable to extract DTS: too many reordered frames", seen on cam09, 14, 24, 28). `scripts/demo.mjs` sets the list for all of these by default; put `MEDIA_TRANSCODE_IDS=` (empty) in `scale.local` on a PC without Quick Sync. |
| `MEDIA_PATHS_FILE` | empty | A file of `paths:` entries generated from the camera profiles (see below). When set it replaces the camera list and `MEDIA_TRANSCODE_IDS` (setting both is refused). The private RTSP listener for re-encoded cameras is then always on, 127.0.0.1 only. |
| `MEDIA_TRANSCODE_BITRATE` | 2500k | Output bitrate |
| `MEDIA_TRANSCODE_RTSP_PORT` | 18554 | Private RTSP port (127.0.0.1 only) ffmpeg publishes to |
| `MEDIA_FFMPEG` | ffmpeg | ffmpeg to run (needs `hevc_qsv` and `h264_qsv`) |

Measured on the demo PC (Celeron N4020, UHD Graphics 600), through HLS: cam06 1080p playlist in 27 s, cam12 720p in 15 s,
cam17 1080p in 16-47 s (its very first request can 404 once; a player retries), cam26 1440p in 22-36 s. CPU use is
negligible (about 1 s of CPU per 20 s of video). **cam22 sends no decodable frames, so it is left out.** There is no limit on how many
transcodes run at once: the demo runner sets `MEDIA_MAX_LIVE_TILES=6` (one grid page; about six transcodes at once was fine on the Celeron N4020 demo PC, seven made one fail until its automatic restart). A Docker host without Quick Sync needs a different encoder (not built).
Do not add `-use_wallclock_as_timestamps` to the ffmpeg command: on cam06 it makes h264_qsv refuse to start.

## What was and was not tested

Tested with the real MediaMTX v1.21.1 (built from source), a stand-in RTSP grid with a login, and a real browser:
- Wrong or missing password: 401. Correct: playlist. Nobody can publish.
- Pulls only when watched; 12 simultaneous viewers shared **one** pull from the grid; the pull was released after idle.
- Three tiles played live in step with real time with **zero** requests through the app's proxy. A camera whose keyframe comes every 30 s started after about 40 s and then played continuously.
- The entrypoint (credentials with `@` and `!` encoded, `*` kept literal, bad passwords and camera ids refused): automated tests in `tests/mediaServerEntrypoint.test.ts`.

**Not tested:** the Docker image and compose file (no Docker daemon here), anything against the real grid (its RTSP port is unreachable from my environment), the Render deployment, WebRTC, H.264 decoding in the browser (my test browser has none, so the test streams were VP9; real browsers decode H.264), and a signed-in Firebase user fetching the config.

## Limits

- The grid still limits how much one account may watch, and every camera being watched is pulled continuously. Many viewers cost no extra watch time; many *cameras* do.
- The viewer password reaches the browser of every signed-in user, so treat it as shared. Rotate it if someone leaves.
- Bandwidth out of the media server is roughly (cameras shown) x (stream bitrate) per viewer. On a cloud host that is the main cost.


## Paths generated from camera profiles

`MEDIA_TRANSCODE_IDS` is a hand-kept list keyed on camera ids. The replacement works from what the onboarding probe measured
(`docs/camera-onboarding-plan.md`): each camera's profile gives a recipe, and the recipe gives its MediaMTX path.

| Recipe | Path |
|---|---|
| A (clean H.264) | a plain on-demand RTSP pull |
| B, C, D (B-frames, long keyframe gap, damaged video, H.265, other codecs, over 1080p) | an on-demand ffmpeg re-encode with Quick Sync, same command as above |
| F, G (no usable video) | no path: a request fails at once instead of waiting a minute |

```
node --import tsx scripts/probe-cameras.ts                      measure the cameras (or --db to keep the profiles in Postgres)
node --import tsx scripts/media-config.ts plan                  what each camera gets, and how many re-encodes there are
node --import tsx scripts/media-config.ts write                 write media-server/bin/paths.generated.yml (it holds the camera login, mode 600)
node --import tsx scripts/media-config.ts apply --dry-run       what a running server would change
node --import tsx scripts/media-config.ts apply                 change the running server, no restart
```

- `scripts/demo.mjs up` starts the media server from the generated file when it exists (a `MEDIA_TRANSCODE_IDS=` line in
  `scale.local`, set on purpose, still wins). Otherwise it uses its built-in list.
- **`apply` talks to MediaMTX's control API** (127.0.0.1 only). It adds new cameras, replaces ones whose recipe changed (their viewers
  reconnect) and removes ones that no longer have video. Cameras that did not change are not touched: a viewer on one kept receiving
  a segment every 2 s while others were added and removed. Applying twice changes nothing.
- API changes live only in the running server, so run `write` as well; a restart then comes back the same.
- **The login**: one per site from `GRID_EMAIL` / `GRID_PASSWORD` (or `STREAM_*` for the grid), with an optional login for one camera
  in `GRID_CAM07_EMAIL` / `GRID_CAM07_PASSWORD`. Nothing is stored in a profile.
- **A manual override** (`recipe_override` and `override_reason` in the `camera_profiles` table, used with `--db`) forces a recipe for one camera;
  the reason shown by `plan` keeps what the measurements had chosen.
- **Recipe D does not scale yet.** `scale_qsv` failed on the demo PC and nothing else has been validated, so D re-encodes at the source size
  unless `MEDIA_SCALE_FILTER` is set (for example `vpp_qsv=w=1920:h=1080`) after trying it on the target PC.
- **Not enforced here: the number of re-encodes running at once.** They run only while watched, and about 6 fit on the demo PC (7 made one
  fail). The app's live-tile cap (`MEDIA_MAX_LIVE_TILES`, default 6) is what keeps it under that; the media server does not refuse a seventh.

## The Registry screen: Playback profiles

Registry > **Playback profiles** (admins) shows the same thing as `media-config.ts plan`, and lets you act on it without a terminal:

- **Probe N cameras** runs the onboarding probe from the server (about 30 s per camera, two at a time; needs ffmpeg on the server and the camera login in
  `GRID_EMAIL` / `GRID_PASSWORD` or `STREAM_*`). Progress shows on the screen; **Stop** keeps what was probed.
- **Load saved probe runs** reads what `scripts/probe-cameras.ts` saved in `.demo-logs`, so you do not have to probe again.
- Each camera shows how it will be played, why (in a few words; hover for the full sentence), what was measured and the problems found, with a pencil to
  **override** the choice. An override needs a reason and is kept with the profile.
- **Apply to the media server** previews the changes, then applies them to the running media server (add, replace, remove; unchanged cameras keep playing). It
  appears only when the media server is on the same machine as the app (`MEDIA_SERVER_URL` is localhost, or `MEDIA_API_URL` is set).

**A failed probe does not erase a camera.** Every probe is kept in the history, but a camera that gave video before keeps its profile (and its path on the media
server) until it has failed 3 probes in a row. Until then its row says "The last probe failed ... after N more failures in a row this camera is marked as having no
video". This is because the grid sometimes refuses or times out a camera that played a minute earlier. A good probe resets the count.

Profiles are kept in Postgres, so this needs `DATABASE_URL`. Only admins can use it; with `MEDIA_ALLOW_GUESTS=true` (local demo only) the sign-in check is skipped.

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_ENCODER` | `qsv` | `none` on a machine without Intel Quick Sync: cameras that need a re-encode show snapshots instead. |
| `MEDIA_MAX_TRANSCODES` | 6 | How many re-encodes fit at once on this machine; only used for the "fits about N at once" line. |
| `MEDIA_API_URL` | derived | The media server's control API, if it is not `http://127.0.0.1:9997` on this machine. |
| `GRID_WHEP_PORT` | 8889 | The WebRTC port probed on the camera host. |
