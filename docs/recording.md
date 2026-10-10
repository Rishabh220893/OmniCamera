# Recording, playback and evidence (gap G10)

The media server (MediaMTX) does the recording. OmniSee decides what is recorded, reads the result back as a timeline, cuts
clips, exports evidence, and removes old footage. Nothing here re-encodes video: segments are the camera's own H.264/H.265 in
fragmented MP4, and clips are copied out of them.

## What is built

| Piece | Where | Does |
|---|---|---|
| Policy | `server/recording/policy.ts`, `retention.ts` | Per camera `off` or `continuous`, with `keepDays`; a default for cameras without their own. Kept in a JSON file (`RECORDING_POLICY_FILE`). Nothing is recorded unless asked. |
| Media config | `server/mediaPaths.ts` | A recorded camera gets `record: yes`, 10-minute fmp4 segments and is pulled **all the time** instead of on demand. Applied by the same mechanism as every other playback change (file at start-up, control API on a running server). |
| Index | `server/recording/store.ts` | The files are the index (`<dir>/<camera>/<start>.mp4`): start from the name, true duration from ffprobe (remembered), coverage, gaps, disk use. Reads a hot and an optional warm folder as one timeline. |
| Clips | `server/recording/clip.ts` | One MP4 from a time range, joined from segments without re-encoding. Starts at the keyframe at or before the requested time. Gaps inside the range are reported, not hidden. |
| Evidence | `routes.ts` | An export needs a reason (case or FIR number), is hashed (SHA-256 of the file and of every source segment, in a manifest), and places a **hold** on the range so retention cannot delete the originals. |
| Retention | `retention.ts` | Hourly: segments older than `hotDays` move to the warm folder, older than `keepDays` are deleted. Held ranges and the segment being written are never touched. The delete refuses anything that is not a recorded segment under the recordings folder. |
| Access | `routes.ts`, `docs/authz.md` | `recording.view` / `recording.export` (operators and admins, for cameras they own or in their departments, and in the access log); `recording.manage` (admin): policy, holds, retention, disk use. |

Turn it on with `RECORDINGS_DIR` (and Firebase Admin, which camera ownership and departments are read from). Optional:
`RECORDINGS_WARM_DIR`, `RECORDINGS_HOT_DAYS`, `RECORDING_POLICY_FILE`, `RECORDINGS_NAME_TIME` (`local` or `utc`).

Routes are in `docs/openapi.yaml`. A typical flow: `PUT /api/recording-policy/cam01 {"mode":"continuous","keepDays":14}`, apply the
media configuration, then `GET /api/recordings/cam01?from=&to=` for the timeline, `.../clip?from=&to=` to watch, and
`POST .../export {from,to,reason}` for evidence.

## Cold tier: object storage (federation plan A15)

Segments older than `RECORDINGS_COLD_DAYS` are uploaded to an S3-compatible store (`RECORDINGS_S3_*`, `server/recording/s3.ts`, `coldTier.ts`) and the local copy is deleted only after the store confirms the object's size. The timeline, coverage and clips read hot, warm and cold as one; a clip over cold footage downloads those segments to a bounded cache (`.cold-cache`, 2 GB, least-recently-used out) and cuts from them. Retention order: hot -> warm (`RECORDINGS_HOT_DAYS`) -> cold (`RECORDINGS_COLD_DAYS`) -> deleted (`keepDays`); holds block every step. Segment duration is kept as object metadata, so listing a camera costs one list plus one metadata read per object not seen before (remembered).

- **Verified:** the signer reproduces the three worked examples in AWS's Signature V4 documentation; the client and tier run against an in-process S3 that recomputes every signature and checks every body hash, including paging, folders, clock skew, outages, a 40 MB streamed upload, lost uploads (local copy kept), and clips whose source hashes equal the originals.
- **Not verified:** a real Ceph RGW / MinIO / AWS endpoint, TLS, multipart upload (objects above 5 GB are refused; a 10-minute segment is a few hundred MB), server-side encryption, bucket lifecycle rules, erasure-coding or replication behaviour, throughput, and egress cost. Listing a very large camera history is not optimised (it lists the whole prefix).

## Facts the real recorder showed (so they are not assumptions)

- MediaMTX 1.21 **names segments in the local time of the machine it runs on**, not UTC. The index reads them in local time by
  default, which is right when MediaMTX and this server share a machine or time zone. Across machines, or to avoid the hour that
  repeats when clocks go back, run both with `TZ=UTC` and set `RECORDINGS_NAME_TIME=utc`.
- A finished file is treated as "still being written" for 20 s after its last write, so the newest minute of a camera that just
  stopped shows as open until then.
- Every recorded camera holds a connection to its source open all day. On the integrator grid this counts against the account's
  watch time and bandwidth (see `docs/media-server.md`); that is the main limit on how many cameras can be recorded centrally.

## Decisions needed, with realistic options

**1. Where do recordings live?**

| Option | Good | Bad | Choose when |
|---|---|---|---|
| A. Local disk on the media server (what is built) | Works today, no extra service, fastest to cut clips | One machine's disks; lose the machine, lose the footage; capacity is that machine's | A pilot, or a few dozen cameras |
| B. Hot local + warm network share/NAS (built: `RECORDINGS_WARM_DIR`) | Cheap bulk storage for older footage, same code | A mounted share is only as reliable as the network; clips from warm are slower | One site, hundreds of cameras, weeks of retention |
| C. Recording at each regional gateway, centre asks for clips | Video never crosses the WAN except when someone watches; matches the gateway design | **Not built**: needs a clip-request path through the gateway protocol and a gateway-side copy of this module | Far-away sites with thin links; the real state-wide design |
| D. Object storage (S3/R2-style) | Effectively unlimited, durable | **Not built**: upload, listing and ranged reads; egress cost; slower first byte | Long retention, a cloud deployment |

My recommendation: **A or B for the pilot, C for the state-wide rollout.** D only if retention is months and a cloud is already chosen.

**2. How long to keep?** Storage is arithmetic, not measurement (nothing was recorded from a real camera). A stream of `B` Mbit/s
uses `B × 10.8` GB per day. Examples:

| Stream | per camera per day | 100 cameras, 7 days | 500 cameras, 30 days |
|---|---|---|---|
| 1 Mbps (sub stream, 720p) | 10.8 GB | 7.6 TB | 162 TB |
| 2 Mbps (typical 1080p H.264) | 21.6 GB | 15 TB | 324 TB |
| 4 Mbps (main 4 MP) | 43.2 GB | 30 TB | 648 TB |

Realistic options: **7 days** for everything (pilot default), **30 days** for named cameras (junctions, government buildings),
**per-camera exceptions** through holds for evidence. Longer than 30 days across all cameras is a storage-budget decision first.
Many deployments record the **sub stream** to cut this by 2-4x; this build records whatever stream the media server pulls.

**3. Continuous or event-only?** Continuous is built. Event-only (record around an alert) needs a rolling buffer so the seconds
before the event exist, which means continuous capture anyway; the saving is in what is *kept*, not what is pulled. Realistic options:
continuous with short retention plus **event clips kept longer** (an alert automatically places a hold; not built, small follow-up), or
continuous everywhere with one retention.

**4. Is playback through a regional gateway required?** If cameras are only reachable from a far site, option C of decision 1 is the
only way to play their recorded video; otherwise the centre records over the WAN, which is exactly the load the gateway design avoids.

**5. Evidence handling.** Built: hashes, a reason, a hold, an access-log entry. Not built: signing the manifest, chain-of-custody
transfers, and tamper-evident storage. Whether the courts or the department require more than hashes is a question for them, not for the code.

## Not done / not verified

- **Never run against a real camera or the real grid.** Tested with synthetic H.264 through a real MediaMTX (settings accepted, segments
  indexed with correct times and durations, a clip cut from them plays) and with generated MP4s for gaps, tiers, holds and retention.
  H.265, audio, camera clock jumps, a camera that reconnects mid-segment, and disks that fill up were not tested.
- Camera-side (SD card/NVR) recordings are not read; playback through Hikvision/Dahua recorders is not built.
- No recording through gateways, no object storage, no automatic holds from alerts, no signed manifests, no screen in the app (no
  timeline, player or export page); everything is API only.
- Re-encoded cameras (recipes B-D) are not recorded: they run only while someone watches. Planning reports them as `notRecorded`.
- Disk-full behaviour: MediaMTX keeps trying to write; nothing here stops recording or raises an alert when free space runs low
  (`GET /api/recordings/usage` shows free space; wiring it to an alert is a small follow-up).
- Retention and holds are per server process on local files; two servers sharing one folder would both run retention.
