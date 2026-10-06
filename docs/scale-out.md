# Scaling the analysis path

Three changes that make server-side analysis cheaper and able to grow past one process. All are opt-in or
safe by default; with none of the new variables set, behaviour is the same as before, except the frame gate
(below), which is on by default for server-side analysis.

## 1. Frame gate: don't call the model for a scene that hasn't changed

Every captured frame is reduced by ffmpeg to a 64x36 greyscale fingerprint and compared with the **last frame
that was actually analysed** for that camera. If fewer than 2% of the pixels moved noticeably, the run is
skipped: no Gemini call, no log row, no camera write. A heartbeat still analyses each camera at least every
10 minutes, so a quiet scene is not silent forever.

- A frame that cannot be fingerprinted is analysed (the gate fails open).
- A failed analysis does not become the baseline, so the change is retried, not swallowed.
- Skipped runs count as healthy (no back-off) and show up as `skippedUnchanged` in `GET /api/analysis/status`.
- Cost of the gate itself: one extra short ffmpeg process per capture (~tens of ms on a 640p frame).

| Variable | Default | Meaning |
|---|---|---|
| `ANALYSIS_GATE` | on | `off` analyses every frame, as before |
| `ANALYSIS_GATE_CHANGED_FRACTION` | `0.02` | Share of pixels that must change to count as activity. Lower = more sensitive |
| `ANALYSIS_GATE_MAX_SKIP_S` | `600` | Longest a camera goes without an analysis |

What it is not: it detects *change*, not *objects*. A parked scene with a person standing still is "unchanged"
until the heartbeat. A local object detector (YOLO etc.) can be dropped in by implementing the `FrameGate`
interface in `server/frameGate.ts`; the worker does not need to change.

**Effect on the UI:** quiet cameras produce fewer log rows, so timelines and analytics show activity rather than
one entry per interval. Set `ANALYSIS_GATE=off` if you need a row per interval.

## 2. Separate scheduler and workers over a real queue

By default one process schedules and executes (in-memory queue, unchanged). With Redis the two halves can run as
separate processes:

```
scheduler (1)  ──jobs──▶  Redis (BullMQ)  ──jobs──▶  workers (N)
      ▲                                                  │
      └───────────── outcome (ok / error / skipped) ─────┘
```

| Variable | Meaning |
|---|---|
| `REDIS_URL` | `redis://` or `rediss://` URL. Enables the shared queue |
| `ANALYSIS_ROLE` | `all` (default), `scheduler`, or `worker`. Anything but `all` needs `REDIS_URL` |
| `ANALYSIS_CONCURRENCY` | Parallel jobs per **worker** process |

- The scheduler watches Firestore and decides what is due. Workers do capture, model call and writes.
- A job carries the camera record and its failure history, so workers keep no schedule state: add, remove or
  restart them freely. Capacity = workers × `ANALYSIS_CONCURRENCY`.
- One job per camera at a time (job id = camera id). A job that dies without reporting (worker killed) is
  treated as a failed attempt and retried after back-off.
- Run every instance from the same image; the role is just an environment variable. Workers still need
  `FIREBASE_SERVICE_ACCOUNT`, `GEMINI_API_KEY`, `STREAM_*`, ffmpeg, and (if used) the Postgres settings.
- Keep **one** scheduler. A second one is harmless (Redis refuses duplicate jobs) but wasteful.
- `ANALYSIS_DISTRIBUTED` (Firestore leases) is for several `all` instances without Redis; with a queue you don't need it.
- The frame gate's baseline lives in the worker that handled the last run. When a camera moves to a different
  worker its first frame there is simply analysed once (fail-open), so it costs one extra call, never a missed one.

## 3. Events in Postgres instead of Firestore

Every analysis used to be a Firestore document write (plus index entries, billed per operation). Logs and plate
sightings now go through an `EventStore`. With `EVENT_STORE=postgres`, Postgres is the record; Firestore keeps
camera config, auth, and a **bounded live feed** so the existing UI keeps working.

| Variable | Meaning |
|---|---|
| `EVENT_STORE` | `firestore` (default, as before) or `postgres` |
| `DATABASE_URL` | Postgres connection string (Timescale/Neon/RDS/Supabase all work). Tables and indexes are created on start |
| `DATABASE_SSL` | `true` for hosts that require TLS (certificate not verified, for managed hosts with private CAs) |
| `FIRESTORE_LOG_MODE` | With Postgres: `notable` (default: only unusual / alert / watchlist logs), `all`, or `none` |

- Postgres is written first; if it fails the job fails and retries. The Firestore mirror is best-effort, so a
  Firestore error neither loses nor duplicates an event already in Postgres.
- **Plate sightings are still mirrored to Firestore** because the Vehicle tracker reads them from there. They
  are small compared with logs. Sightings in Postgres are idempotent on id.
- History API, for anything that outgrows the live feed (requires `Authorization: Bearer <Firebase ID token>`;
  a user can only read their own events):
  - `GET /api/events/logs?cameraId=&from=&to=&before=&notable=true&limit=` (max 500, newest first)
  - `GET /api/events/plates/:plate?limit=`
- **The browser UI does not read these endpoints yet.** The Logs tab still reads Firestore, so with
  `FIRESTORE_LOG_MODE=notable` it shows notable events only. Pointing it at the history API is the remaining UI work.
- Not migrated: logs written by browser tabs (the in-browser capture loop) still go to Firestore, and existing
  Firestore history is not backfilled.

## What was and was not tested

Tested (`tests/scaleOut.test.ts`, whole suite passes, 103 tests):
- Gate decisions (first frame, noise vs change, heartbeat, per-camera baselines, fail-open, failed-analysis
  baseline), and the ffmpeg fingerprint on real generated JPEGs.
- Worker + gate end to end, including that skipped runs write nothing.
- A scheduler-only process and a worker-only process cooperating over a shared in-memory queue: results, failures,
  back-off and recovery flow back correctly; a lost job is handled.
- Postgres statements against a fake client: placeholder/parameter counts, user scoping, no user input in SQL
  text, capped page size. Tee ordering and failure rules. Firestore live-feed modes against a fake.
- The server bundle builds and boots; `/api/events/*` returns 501 when Postgres is off.

**Not tested** (no Redis, Postgres or Docker available when this was written): the BullMQ backend against a real
Redis (`server/bullBackend.ts`), the SQL against a real Postgres, and the new endpoints with a real Firebase
token. Run the setup in a staging environment first: start a scheduler and a worker against a Redis, add a few
cameras, and watch `GET /api/analysis/status` (`backend: "bull"`, `queue`, `skippedUnchanged`).
