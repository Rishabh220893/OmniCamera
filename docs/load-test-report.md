# Load-test report for the 80,000-camera target (gap A24)

Written 2026-10-11. This is the report the Profile 1 brief asks for, and its first job is to be honest about what a load test can and cannot be here. **Nothing
below was measured at 80,000 cameras, on a real network, with real video, or against a database server.** What was measured is our own code on one weak laptop;
the rest is arithmetic from stated inputs. The two are kept apart, section by section.

| | What it rests on |
|---|---|
| **Measured** | Our code's cost per frame, per event, per search, per quota check, per encryption: `scripts/capacity/controlPlane.ts` (up to 80,000 simulated cameras, `docs/capacity.md`) and `scripts/capacity/platform.ts` (2026-10-11). Raw results are in `scripts/capacity/results/`. |
| **Modelled** | Video storage, bandwidth, event rates and sizes, clip-fetch times: formulas in `scripts/capacity/platformModels.ts`, worked by hand in `tests/capacityModels.test.ts`, tables printed by `scripts/capacity/platformReport.ts`. |
| **Not testable here** | Media at scale, storage hardware, a message bus under load, PostgreSQL at hundreds of millions of rows, GPUs, real links, failover. Listed in section 6 with what would be needed. |

Test machine for every measurement: Intel Celeron N4020, 2 cores at 1.1 GHz, 8 GB RAM, Windows 11, shared with the developer's browser and tools. A server core is
expected to be several times faster; that was not measured. Numbers vary by tens of percent between runs on this machine.

## 1. Measured: what our own code costs

### 1.1 The scheduler and analysis path (from `docs/capacity.md`, measured earlier)

At 500, 5,000, 20,000 and 80,000 simulated cameras (real worker, analyzers, log builder, event derivation and alert engine; a fake frame and a canned model answer):
**0.52-0.55 ms of CPU per analysed frame, flat from 500 to 80,000 cameras**; the scheduler's tick averaged 48 ms (worst 0.97 s) at 80,000 cameras with no late
runs; about 0.5 MB of heap per 1,000 cameras. The platform's own scheduling is not the limit at any size tested.

### 1.2 The event path, search, trail, report, anomaly detector, quotas and cryptography (this report)

All in one process, in memory, no network and no database (`node --import tsx scripts/capacity/platform.ts`; sizes 50,000 events through the pipeline, 200,000
stored for search, 20,000 plate reads for the trail and report, 200,000 for the anomaly detector and the quota checks, a 200 MB file for the cryptography).

| What | Result | What it means |
|---|---:|---|
| Event path: bus -> alert engine with 20 rules -> alerts (memory) | **1,250 events/s** (50,000 events in 40 s) | The speed of our code with the database taken away. A database adds its write time (the Neon measurement in `docs/capacity.md` 3b: about 900 rows/s in batches of 100 over the internet from this laptop). |
| Event search over 200,000 stored events (memory store: a linear scan) | newest 100: 248 ms; one department: 112 ms; one plate: 120 ms; free text: 545 ms; last hour of one camera: 50 ms | **Not what Postgres will do.** The Postgres store uses indexes (department and time, type, tags, and now the plate); its search time at hundreds of millions of rows was not measured. |
| Statewide trail: reading 20,000 plate reads, then building a trail | read 4.95 s; the trail itself 129 ms; the list of plates 21 ms | The reading is the cost (pages of 500 from the memory store, each a scan). The route maths is not. |
| Federated report over 20,000 events | 14.0 s | Same: dominated by reading events back. It is cut at 20,000 events per report; a long period on a big fleet needs SQL aggregates (listed in `docs/federated-report.md`). |
| Anomaly detector | **144,000 events/s** | Negligible next to the event path. |
| Federation quota checks (memory store) | 128,000 checks/s; 181,000 session take-and-release/s | With Redis each call adds a round trip (not measured). |
| Evidence cryptography, 200 MB file | AES-256-GCM encrypt 32 MB/s, decrypt 55 MB/s; SHA-256 69 MB/s; manifest signing 400/s, verifying 1,000/s | A 10-minute clip at 2 Mbit/s (150 MB) takes about 5 s to encrypt and 2 s to hash on this machine. An encryptor bug (copying every piece of input many times) was found by this measurement: 19 MB/s before the fix, 32 MB/s after on a loaded machine, 76 MB/s on a quieter run. |
| Encrypted-file overhead | about 20 bytes per MB (4 KB on 200 MB) | A 16-byte tag per 1 MiB chunk plus a header. |

Two things this run showed: the in-memory event store's paging is linear per page (so reading 20,000 events takes seconds: fine for tests and a pilot, wrong for a
fleet, which is what the Postgres store is for), and **the event path at about 1,250 events/s per process on this machine is about the rate the 80,000-camera model
needs** (1,267 events/s): on a normal server one process would have headroom, on this laptop two would be needed.

## 2. Modelled: video storage

Storage is the bitrate times the cameras times the seconds. It is arithmetic, and the first thing to put to the State, because the choice of bitrate and days
moves the number by 20 times (a figure that was not given: `docs/federation-plan.md` section 2).

| Cameras | Bitrate | Per day | 7 days | 30 days |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2 Mbps | 21.6 TB | 151.2 TB | 648.0 TB |
| 5,000 | 2 Mbps | 108.0 TB | 756.0 TB | 3.24 PB |
| 20,000 | 2 Mbps | 432.0 TB | 3.02 PB | 12.96 PB |
| 80,000 | 1 Mbps (sub stream) | 864.0 TB | 6.05 PB | 25.92 PB |
| 80,000 | 2 Mbps | 1.73 PB | 12.10 PB | 51.84 PB |
| 80,000 | 4 Mbps | 3.46 PB | 24.19 PB | 103.68 PB |

Raw capacity depends on protection. Three copies cost 3x; 4+2 erasure coding 1.5x; 8+3 1.375x. A plan for 80,000 cameras at 1 Mbps for 30 days, hot 3 days on
three copies, warm 4 days on 4+2, cold 23 days on 8+3, needs **25.9 PB of video and about 40.3 PB of raw capacity**:

| Tier | Days | Logical | Overhead | Raw |
| --- | ---: | ---: | ---: | ---: |
| hot | 3 | 2.59 PB | x3 | 7.78 PB |
| warm | 4 | 3.46 PB | x1.5 | 5.18 PB |
| cold | 23 | 19.87 PB | x1.375 | 27.32 PB |
| **total** | 30 | **25.92 PB** | | **40.28 PB** |

What was built toward this and how far it was tested: recording on local disk (hot), a warm directory, and an S3-compatible cold tier with a signature-correct client,
tested with a fake S3 and real MediaMTX/ffmpeg video (`docs/recording.md`); **never against Ceph, MinIO or AWS, never at more than a handful of cameras**.

## 3. Modelled: bandwidth

| Cameras | Bitrate | Sustained into one place | One day of it over 100 Gbit/s |
| ---: | ---: | ---: | ---: |
| 1,000 | 2 Mbps | 2 Gbit/s | 0.7 h |
| 20,000 | 2 Mbps | 40 Gbit/s | 13.7 h |
| 80,000 | 1 Mbps | 80 Gbit/s | 27.4 h |
| 80,000 | 2 Mbps | 160 Gbit/s | 54.9 h |

Moving 80,000 cameras' video to one centre in real time needs a backbone no ordinary deployment has. This is why the design records **at the edge** and sends a clip
only when someone asks (gap A16, built): the cost becomes the clips, not the stream.

| Clip | Camera | Link | At once | One clip takes | Bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 min | 2 Mbps | 20 Mbit/s | 1 | 86 s | 150 MB |
| 10 min | 2 Mbps | 20 Mbit/s | 4 | 5.7 min | 150 MB |
| 60 min | 2 Mbps | 20 Mbit/s | 1 | 8.6 min | 900 MB |
| 10 min | 2 Mbps | 100 Mbit/s | 1 | 17 s | 150 MB |
| 10 min | 4 Mbps | 10 Mbit/s | 1 | 5.7 min | 300 MB |

(70% link efficiency; clips share the link.) The clip fetch itself was tested with real ffmpeg video over real HTTP on one machine (`tests/gatewayClips.test.ts`): it
works, and says nothing about a 20 Mbit/s link, packet loss, or hundreds of gateways.

## 4. Modelled: events

60 s interval, 25% of frames pass the gate to the analyzers (an assumption: the real pass rate on real scenes was never measured), 3 events per analysis (measured in
`docs/capacity.md`), 12 events per camera per hour pushed by department systems, 390 bytes per event on the bus, 450 bytes per Postgres row.

| Cameras | Events/s | Events/day | Bus MB/s | Rows in 30 days | Postgres, 30 days (data / with indexes) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 7.9 | 684,000 | 0.00 | 20,520,000 | 9.2 GB / 22.2 GB |
| 5,000 | 79.2 | 6,840,000 | 0.03 | 205,200,000 | 92.3 GB / 221.6 GB |
| 20,000 | 316.7 | 27,360,000 | 0.12 | 820,800,000 | 369.4 GB / 886.5 GB |
| 80,000 | 1,266.7 | 109,440,000 | 0.49 | 3,283,200,000 | 1.5 TB / 3.5 TB |

- **The bus is not the problem**: half a megabyte a second at 80,000 cameras is one Kafka partition or one Redis stream by a wide margin.
- **The database is**: 3.3 billion rows in 30 days is a partitioned time-series table (TimescaleDB, or Postgres partitioned by day) with retention by dropping partitions, not one table.
  The schema today is a single table with five indexes; that is right to hundreds of millions of rows and wrong beyond. This is the first thing to change for the full target.
- Index overhead is an estimate (140% of the data for the five indexes).
- At 80,000 cameras the measured event path needs 2 processes at the test machine's speed (60% headroom), 1 on a normal server.

## 5. Modelled: the analysis and model calls

From `docs/capacity.md` section 4 (unchanged): at 80,000 cameras and one frame a minute, 28.8 million model calls a day at a 25% pass rate; **the model call, its cost and
its rate limits, not our code, are the limit at scale**. The local detector (no model) and the inference service (a detector on a GPU, built and mock-tested, never run on a
GPU: `docs/inference-service.md`) are the way to keep the language model for what a detector flags.

## 6. What could not be tested here, and what it would take

| Not tested | Why | What a real test needs |
|---|---|---|
| 80,000 cameras of media | No cameras, one 2-core laptop | A lab with a stream generator per region (many ffmpeg publishers), the real media servers, and 10+ Gbit/s links; measure per-region ingest, HLS/WebRTC viewer fan-out, and recording write rates. |
| Storage at petabyte scale | No storage hardware | A Ceph (or MinIO) cluster of the real size; test write throughput, erasure-coding repair after a disk loss, listing and retention at hundreds of millions of objects. |
| The event database at scale | No server-class Postgres; Neon was measured from a laptop only | A partitioned Postgres/TimescaleDB on server hardware loaded with the modelled rows; measure ingest at 1,300 rows/s sustained, search by department and time, plate and trail queries, retention by partition drop. |
| A message bus under load | No Kafka or Redis broker here (the Kafka bus ran against a client stand-in only) | The real broker; replay the modelled event rate for hours; kill a broker. |
| GPU inference and ANPR throughput | No GPU | The inference and ANPR services on the target GPUs, fed frames at the modelled rate; measure frames per second per GPU. |
| Real links | One machine | Edge-to-centre links of the real bandwidth and loss; clip fetch under contention; gateway outbox behaviour over a day-long outage. |
| Failover and recovery | Nothing replicated | The drills in `docs/disaster-recovery.md`, run against a real cluster, with times recorded against the targets there. |
| Viewer scale | One machine | Thousands of simultaneous video-wall viewers on the media tier; the per-user video token callback under that load (it is called on every HLS request). |

**What the 80,000-camera claim can honestly say today:** the control plane (scheduling, analysis plumbing, alerting, federation checks) was simulated to 80,000 cameras
and is not the limit; the designs for recording at the edge, tiered storage, the bus and the database are built or specified and tested at small scale; the numbers that
decide cost (storage, bandwidth, model calls, database size) are in this report as arithmetic with the inputs shown, so the State can change an input and see the effect.
It cannot say that the whole system sustains 80,000 cameras, because nothing like that was run.

## 7. Re-running

```bash
node --expose-gc --import tsx scripts/capacity/controlPlane.ts 500 5000 20000 80000   # the scheduler and analysis path (about 3 minutes)
node --import tsx scripts/capacity/platform.ts                                        # the event path, search, trail, report, cryptography (about 2 minutes; --quick for seconds)
node --import tsx scripts/capacity/platformReport.ts                                  # the model tables of this report
node --import tsx --test tests/capacityModels.test.ts                                 # the formulas, checked by hand
```

Run them on an idle machine; the measured figures move with the load on it.
