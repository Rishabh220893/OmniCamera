# Capacity: what was measured, what is modelled, what is unknown

Written 2026-10-10 (gap G9). The scripts that produced every number are in `scripts/capacity/`; raw results are in `scripts/capacity/results/`.
Re-run them on the hardware you intend to deploy on before sizing anything: **every figure below comes from one weak, shared laptop**.

> Machine: Intel Celeron N4020, 2 cores at 1.1 GHz, 8 GB RAM, Windows 11, with the app's demo, a browser and the desktop app running beside the tests (about one core
> was busy with other programs throughout). A modern server core is expected to be several times faster, but that was not measured. Read "cores of this class"
> as "cores of this Celeron".

## 1. What the platform's own code costs (measured)

`scripts/capacity/controlPlane.ts` runs the **real** analysis worker, analyzer pipeline, log builder, event derivation and alert engine for 2.5 camera intervals
at each fleet size. Faked: the camera frame (64 bytes) and the Gemini answer (canned). So it measures our code, not capture, not the model, not any database.

| Cameras | Analyses run | CPU per analysis | Scheduler tick (avg / worst) | Late runs | Heap per 1,000 cameras | Process memory at end |
|---:|---:|---:|---:|---:|---:|---:|
| 500 | 1,242 | 0.55 ms | 0.6 / 33 ms | none | 0.8 MB | 103 MB |
| 5,000 | 12,417 | 0.53 ms | 1.2 / 16 ms | none | 0.5 MB | 296 MB |
| 20,000 | 49,667 | 0.52 ms | 3.8 / 117 ms | none | 0.5 MB | 628 MB |
| 80,000 | 150,194 | 0.54 ms | 48 / 966 ms | none | 0.5 MB | 1,386 MB |

- The platform code costs about **0.54 ms of CPU per analysed frame**, flat from 500 to 80,000 cameras: one core of this Celeron could run about 1,800 analyses per second
  of our code alone. At 80,000 cameras and a 60 s interval that is 1,333 frames per second, so the platform's own work would use well under one core. It is not the limit.
- The scheduler wakes once a second and looks at every camera (cost grows with the fleet): 48 ms on average at 80,000 cameras (5% of a core), with one slow tick of 0.97 s
  (garbage collection). No camera ran late. A single scheduler process is enough on this measure; the Redis split (`ANALYSIS_ROLE`) is for the capture and model work, not for scheduling.
- **A bug found and fixed by this measurement:** the in-memory alert store scanned every alert on each event, so cost per analysis doubled at 5,000 cameras (1.16 ms) and
  would have grown without limit. It now keeps an index per rule and key (0.54 ms, flat). The Postgres store uses indexed queries and was run against Neon (section 3b); its answers match the in-memory store's.
- The run produced, per analysed frame in a busy scene: a log of about 520 bytes, 3 events of about 390 bytes each, and 1 plate sighting.

## 2. What capture, the gate and probing cost (measured)

| Operation | CPU per operation (this machine) | Wall time | Notes |
|---|---:|---:|---|
| One still-frame grab from RTSP (`extractFrameDetailed`) | **0.125 s** | 1.8 s median | Total process CPU incl. start-up, measured on a local clip (`scripts/capacity/os-costs.ps1`); ffmpeg's own accounting says 0.016 s, so **most of the cost is starting an ffmpeg process**. Wall time is mostly waiting for the next keyframe (2 s GOP). Peak memory 46 MB. |
| Frame-gate fingerprint (one short ffmpeg run) | **0.078 s** | 0.15 s | Also dominated by process start-up. Peak memory 22 MB. |
| Probe, 8 s sample at 720p/15 fps | 0.69 s of ffmpeg CPU (+ start-up) | 14 s | CPU grows with the sample length; a real 30 s probe is about 4x that. Probes take as long as their sample (live streams cannot be sped up). |

## 3. What the media server costs (measured)

`scripts/capacity/media.ts` publishes simulated 720p / 15 fps / 1.6 Mbps H.264 cameras (`ffmpeg -c copy`, no transcoding) into a private MediaMTX, then attaches readers
(viewers or analysis pulls).

| Cameras publishing | MediaMTX CPU (% of one core) | MediaMTX memory | With readers (half as many as cameras) | Memory |
|---:|---:|---:|---:|---:|
| 5 | 3.2% | 39 MB | 5.8% (2 readers) | 39 MB |
| 10 | 9.9% | 42 MB | 14.6% (5 readers) | 43 MB |
| 20 | 22.3% | 55 MB | 28.5% (10 readers) | 46 MB |
| 30 | 24.8% | 50 MB | 49.3% (15 readers) | 73 MB |

- Pass-through costs roughly **0.6-1.1% of a Celeron core and about 1 MB of memory per camera**, and roughly **1% of a core per reader**. The run stopped at 30 cameras because the 2-core
  machine was nearly saturated by the simulated publishers themselves (they cost more than the server), not because MediaMTX struggled. These are single 15-second windows on a shared machine; expect +/- a few points.
- This is pass-through only. **Re-encoding** (recipes B, C, D) is a different cost and was not measured; it is the expensive path and what the `MEDIA_MAX_TRANSCODES` slots limit.
- Bandwidth is the real media cost: 1.6 Mbps in per camera and 1.6 Mbps out per viewer. 80,000 cameras at that rate would be 128 Gbps of ingest, which is the case for processing next to the cameras (section 5, `docs/regional-gateway.md`).

## 3b. PostgreSQL on Neon (measured, from this machine)

`tests/alertStorePg.test.ts` also timed the real database, over the internet from this laptop. The time here is dominated by the network round trip to Neon (about 85-130 ms), not by Postgres.

| Operation | Result |
|---|---:|
| Round trip (`SELECT 1`, first call including connecting) | 84-132 ms |
| 2,000 events written as batches of 100 | about 900-970 rows/s (about 105 ms per batch) |
| 800 events as 8 parallel batches of 100 | about 730-930 rows/s |
| One event written alone | median 104-115 ms |
| List 100 events by type | median 103-117 ms, worst 188-224 ms |

- Batching matters most: one event per call is about 9 per second per connection, a batch of 100 about 900. The worker sends one batch per analysed frame (about 3 events), so at high frame rates it should group several frames per write; today it does not.
- Parallel batches did not beat sequential ones here: the path from this laptop and the free tier's compute are the limit, not the client.
- Read this as "Neon from a laptop", not as "Postgres". A database in the same region as the server, on larger compute, will be much faster. Even so, 333 writes/s (20,000 cameras, section 4) would be tight at the rates above without batching.
- Ran twice in a row; the 2 s-class variation between runs is normal for a shared free-tier database.

## 4. Sizing (model, not measurement)

These tables are produced by `node --import tsx scripts/capacity/report.ts` from the numbers above and the formulas in `scripts/capacity/model.ts` (unit-tested).
**Assumptions:** 60% target CPU load; 25% of captured frames pass the frame gate and reach the model (the real rate depends on the scenes, and was not measured); 10% of logs are
"notable"; every analysed frame is one model call and produces the busy-scene log and events measured above.

### Capture, gate and platform work (CPU), and model calls

| Cameras | Interval | Captures/s | Analyses/s | Model calls/day | Cores of this class | Cameras per core |
|---:|---:|---:|---:|---:|---:|---:|
| 500 | 60 s | 8.3 | 2.1 | 180,000 | 2.8 | 177 |
| 5,000 | 60 s | 83.3 | 20.8 | 1,800,000 | 28.2 | 177 |
| 20,000 | 60 s | 333.3 | 83.3 | 7,200,000 | 112.9 | 177 |
| 80,000 | 60 s | 1,333.3 | 333.3 | 28,800,000 | 451.4 | 177 |
| 500 | 300 s | 1.7 | 0.4 | 36,000 | 0.6 | 886 |
| 5,000 | 300 s | 16.7 | 4.2 | 360,000 | 5.6 | 886 |
| 20,000 | 300 s | 66.7 | 16.7 | 1,440,000 | 22.6 | 886 |
| 80,000 | 300 s | 266.7 | 66.7 | 5,760,000 | 90.3 | 886 |

### Event storage and writes (60 s interval, gate 25%)

| Cameras | Log rows/day | Event rows/day | Postgres GB/day (data only, no indexes) | Writes/s | Firestore log writes/day, mode `all` | mode `notable` |
|---:|---:|---:|---:|---:|---:|---:|
| 500 | 180,000 | 540,000 | 0.30 | 8.3 | 180,000 | 18,000 |
| 5,000 | 1,800,000 | 5,400,000 | 3.03 | 83.3 | 1,800,000 | 180,000 |
| 20,000 | 7,200,000 | 21,600,000 | 12.11 | 333.3 | 7,200,000 | 720,000 |
| 80,000 | 28,800,000 | 86,400,000 | 48.44 | 1,333.3 | 28,800,000 | 2,880,000 |

### Probing

| Re-probe the whole fleet every | Cameras | Probes running at once (30 s sample + 6 s set-up) |
|---:|---:|---:|
| day | 5,000 | 3 |
| week | 5,000 | 1 |
| day | 80,000 | 34 |
| week | 80,000 | 5 |

The probe job today runs **two at a time**, so one pass over 80,000 cameras would take 400 hours (16.7 days).

## 5. What this means

1. **The model call, not our code, is the limit at scale.** At 80,000 cameras and one frame a minute the gate has to hold the model to tens of millions of calls a day even at a 25% pass rate; the call volume, rate limits and cost
   of that are a decision to make before anything else (longer intervals, cheaper local detectors for the first pass, Gemini only for what a detector flags). The gate's pass rate is the most valuable number to measure on real scenes.
2. **Spawning one ffmpeg process per frame is the largest cost we control** (0.2 s of CPU per frame for capture plus gate, 370 times the platform code). Options, none built: read stills from the
   media server's already-open stream instead of opening a new RTSP session per frame, compute the gate's fingerprint in-process from the JPEG instead of spawning a second ffmpeg, or keep one long-lived ffmpeg per camera. Any of these
   would cut CPU several-fold; the first two also remove the 1.8 s wait for a keyframe.
3. **Video cannot be hauled to one centre.** 500 cameras in a region are 800 Mbps of video but 28 kbps of results: a regional gateway (`docs/regional-gateway.md`) sends about 28,000 times less.
4. **Postgres is a better home than Firestore for the event firehose** at these rates (333 writes/s at 20,000 cameras, 1,333/s at 80,000, 48 GB/day of row data plus indexes). Firestore's `FIRESTORE_LOG_MODE=notable` cuts its writes tenfold under the 10% assumption.
5. **Probing needs to run wider** (or much less often) before a state-sized fleet: about 34 at once to re-probe everything daily.
6. The scheduler's own state is small: about 0.5 MB of heap per 1,000 cameras (about 40 MB at 80,000). The test process still reached 1.4 GB, mostly the in-memory event and alert stores and garbage not yet collected, so budget about 2 GB for a process at that size until the real stores are in use.

## 6. Not measured - the unverified list stays open

- **Firestore** write rates, latency and cost. The numbers above are write *counts* from the model; no Firestore was reachable.
- **Redis / BullMQ queue depth and throughput**. No Redis was connected. The scheduler/worker split was only exercised through its in-memory backend and fakes.
- **PostgreSQL**: measured on Neon from this laptop only (section 3b). Not measured: a database in the same region as the server, larger compute, many concurrent writers, growth and index size over time, and the running server against Neon.
- **Real Gemini** latency, rate limits, error rates and cost; the first-pass gate's real pass rate on real scenes.
- **ANPR service** speed on CPU or GPU (`scripts/check-anpr.mjs` does this; it needs the service running).
- **Re-encoding** capacity (recipes B/C/D) and hardware encoders; **H.265 cameras**; **WebRTC / HLS viewer** scale; transcoding slot behaviour under load.
- **Real cameras and real networks**: bitrates other than 1.6 Mbps, mixed codecs, packet loss, links of hundreds of kilometres.
- **A normal server**: every number here is from a 1.1 GHz laptop CPU shared with other programs; the GC pause and memory figures at 80,000 cameras are from a single run.
- The 25% gate pass rate, the 10% notable share and the busy-scene event count are assumptions, not measurements.

## 7. Re-running

```bash
node --expose-gc --import tsx scripts/capacity/controlPlane.ts 500 5000 20000 80000   # our code (~3 min)
node --import tsx scripts/capacity/media.ts 5 10 20 30                               # needs media-server/bin/mediamtx and ffmpeg (~5 min); stops if free RAM < 700 MB
node --import tsx scripts/capacity/media.ts --costs-only                              # just capture, gate and probe costs
powershell -NoProfile -File scripts/capacity/os-costs.ps1                             # whole-process CPU of a grab and a gate run (Windows); record in results/osCosts.json
node --import tsx scripts/capacity/report.ts                                          # the tables above
```

Run them on a machine that is otherwise idle; the media benchmark in particular starts dozens of ffmpeg processes.
