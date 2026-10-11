# Recorded snippets: record a few seconds from a camera, keep it, play it back

For demos and evidence notes: a live camera can be slow or unavailable at the wrong moment, so record a few seconds of it **beforehand**, keep the clip in the app, and play it back on cue.

This is separate from the continuous recorder (`docs/recording.md`, MediaMTX segments, retention, evidence export), which records 10-minute segments by policy and has no screen. Snippets are short, on demand, and have a screen.

## What it does

**Registry > Recorded snippets** (a panel under the camera tools):
1. Pick a camera (any camera with a stream address), a length (10, 20, 30, 60 or 120 seconds) and optionally a title.
2. Press **Record**. The server reads the camera's stream and writes an MP4. The row shows "Recording 12 of 30 s".
3. When it is ready the row shows a thumbnail, the length, the size and the first characters of the file's SHA-256. **Play** opens a player in the page, **Download** saves the MP4, **Delete** removes the video and the row.

## Where things are kept

| What | Where |
|---|---|
| The video and its thumbnail | Files in `SNIPPETS_DIR` (default `.data/snippets`): `snp_<id>.mp4`, `snp_<id>.jpg` |
| The details (who recorded it, which camera and department, when, requested and actual length, size, SHA-256, status, error) | A row in PostgreSQL, table `recording_snippets`, when `DATABASE_URL` is set. Without it, a JSON file `snippets.json` next to the videos. `SNIPPETS_STORE=file` forces the file. |

The table is created by the server on start (`CREATE TABLE IF NOT EXISTS`). If the database cannot be used, the server logs why and keeps the list in the file; recording still works.

Why files for the video and a database for the details: the database answers "which snippets, by whom, of which camera" quickly and survives moving the app; video bytes belong on disk (or later object storage), not in database rows.

## How long it records (the length is counted from the first frame)

The recorder does not use a timer that starts when it connects. It watches ffmpeg's own progress, starts counting at the **first frame** (so connecting, and waiting for a keyframe, are not part of the length), and stops ffmpeg cleanly when the file holds the length you chose. If the source ends or drops before that, it **reconnects and carries on**, and the parts are joined without re-encoding (up to 4 connections). A source that delivers faster than real time and overshoots is cut to the exact length. A source that goes silent for longer than twice the length plus 20 s is given up on and what was captured is kept (if it is at least 3 seconds; otherwise the recording fails with a sentence). The row shows the true length of the file.

Verified with a live-like camera (real-time video over HTTP): a camera that takes 6 s to send its first frame still gives the full length; a source that drops after 3 s is reconnected and joined; a source that goes silent keeps what it gave. Not verified on the real grid's RTSP/HLS: if a clip is still shorter than chosen there, the row says how long it really is and the server log line shows why.

## How it records

The server needs the camera's stream address, which it **reads from the camera's own record** (never from the request) and checks is not an internal address. It then runs ffmpeg for the requested length, **copying the video without re-encoding** (so it costs almost no CPU), and tries, in order:
- grid cameras: the grid's RTSP origin with the stream login, then the proxied HLS;
- other `rtsp://` addresses directly;
- other `http(s)` addresses (HLS, MP4);
- as a last resort, a quick H.264 re-encode, so an odd source still gives something playable.

A still-image address cannot be recorded. If the grid answers 401, it stops and says so (check the stream access email and password in Settings). Error text never contains the password.

The stream login comes from the same place the app already uses for snapshots (`X-Stream-Email` and `X-Stream-Password` from Settings, or `STREAM_EMAIL` and `STREAM_PASSWORD` on the server).

After recording, the server measures the true length (ffprobe), makes a thumbnail, and stores the SHA-256 of the file.

## AI analysis of a recorded clip

Open a clip (Play) and press **AI analysis** (or the sparkles button on the clip's row). The browser takes frames evenly across the video (every 4 s or more, at most 12), sends them one at a time to the same frame analysis the live views use (`/api/gemini/analyze-frame`), and shows:
- progress ("Analysing frame 3 of 6") with a Stop button;
- a summary (frames analysed, most people and vehicles, plates seen, when something unusual was flagged);
- a timeline, one line per frame (time, what the scene shows, counts, plates, alerts); click a line to jump the video there;
- captions at the bottom of the video that follow the playhead (red when the frame was flagged unusual).
It stops after three failed frames in a row (for example the model is not configured) and says why. Each frame is a call to the AI model, so a 30 s clip costs about 7 calls. Results are kept in the page while it is open; they are not stored on the server.

Checked in a browser with a mocked analysis: six different real frames, progress, summary, timeline seek, captions, failure. **Not checked against the real model.**

## Who may use it

- **Recording** needs the `recording.export` permission (operators and administrators) and access to the camera (its owner, or someone in its department): the same rule as exporting evidence.
- **Listing and playing** needs `recording.view`. You see your own snippets; an administrator sees everyone's. Another user's snippet answers "No such snippet", not "forbidden".
- The offline demo user has no server session, so the panel says to sign in.

## Limits and settings

| Setting | Default | Meaning |
|---|---|---|
| `SNIPPETS_ENABLED` | on | `false` turns the recorder off. It is also off when Firebase Admin is not configured. |
| `SNIPPETS_DIR` | `.data/snippets` | Where the videos go. |
| `SNIPPETS_STORE` | postgres if `DATABASE_URL`, else file | `file` forces the JSON file. |
| `SNIPPETS_MAX_SECONDS` | 120 | Longest snippet. |
| `SNIPPETS_MAX_CONCURRENT` | 2 | Recordings at once on the server (each is an ffmpeg process); more answers 429. |
| `SNIPPETS_MAX_MB` | 2000 | Total size of all snippets; beyond it, recording answers 507 until some are deleted. |

Also: at most 3 recordings at once per user. A recording cut off by a server restart is marked failed on the next start, not left "recording" forever.

## API

`POST /api/snippets {cameraId, seconds, title?}` (202), `GET /api/snippets?cameraId=`, `GET /api/snippets/:id` (poll until `ready` or `failed`), `GET /api/snippets/:id/file` (supports Range, so a player can seek; `?download=1`), `GET /api/snippets/:id/thumb`, `DELETE /api/snippets/:id`. Listed in `docs/openapi.yaml`.

## What is verified, and what is not

**Verified** (`tests/snippets.test.ts`): the file store (filters, updates, restart, 40 simultaneous writes); the recorder with **real ffmpeg** against a camera simulated by a generated video served over HTTP (H.264 copied, about the requested length, a dead address fails without echoing the password and leaves no file); the routes with real recordings (start, poll, file, thumbnail, Range, download, SHA-256 equals the file's, list, delete removes both files); access rules (401, 403, another user gets 404, an administrator sees all, an id is never a path); input errors; limits (429 at once, 507 disk); restart recovery. The screen was driven in a browser against a mocked server that serves a real video: record, progress, ready with thumbnail and hash, play (the browser decoded 320x180, 3 s), the error sentence, delete.

**Also verified on 2026-10-11 against the project's Neon database:** the PostgreSQL store passes the same expectations as the file store (insert, filters, update, interrupted recordings, delete, totals), run in a scratch schema that was dropped afterwards.

**Not verified:**
- Recording from a **real camera or the real grid** (RTSP login, HLS through the proxy, the grid's viewing-time limits). Recording from the grid holds a connection for the length of the snippet and counts against the account's watch time.
- A snippet plays in a browser only if the camera sends H.264 (H.265 is copied faithfully but many browsers will not play it; download it instead).
- The signed-in screen end to end with real Firebase accounts (the panel was checked with a mocked server).
- Large clips: the player loads the whole file into memory before playing (fine for the 120 s maximum at normal bitrates, not for hours).
