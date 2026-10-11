# Redundancy and disaster recovery design (gap A22)

A design, not a tested system. Nothing here has been failed over, restored from backup, or timed on a real cluster; every number marked *target* is a proposal for the State to
agree or change, and every drill listed is one that has to be run before the claim is made. Written 2026-10-11.

## 1. What has state, and what losing it means

| State | Where | Lost: what happens | Rebuildable? |
|---|---|---|---|
| Users, roles, departments, camera records, faces, watchlist, logs | Firebase (Auth and Firestore) | The platform cannot sign anyone in or list cameras | Google's durability; export Firestore on a schedule (section 3) |
| Events, alerts, rules, incidents | PostgreSQL | History and alerting state gone | From backups only; the bus can replay recent events, not history |
| Event bus | Redis Streams / Kafka | In-flight events lost; consumers pause | Producers re-send on failure; the bus keeps a bounded window |
| Quotas, session caps, wall sessions | Redis | Counters reset; sessions end and are retaken | Self-healing (leases expire, counters refill) |
| Analysis queue | Redis (BullMQ) | Pending jobs lost | Self-healing: the scheduler queues what is due again |
| Camera and system logins (sealed) | `camera_sources` (Postgres), `vms-systems.json` | Cameras need their logins re-entered | **Needs `SOURCE_SECRET_KEY`**; the key is as critical as the data |
| Walls, layouts, federation clients, clip requests, anomaly baselines | Small files in `VMS_DATA_DIR` | Layouts and API keys gone; clients must be re-issued keys | Back up the folder; baselines relearn in days |
| Recordings | Edge disks (gateways), media tier disks, object storage | Footage for the period | Only from replicas or erasure coding; **retention is the department's** for Profile 3 |
| Evidence exports | `exports/<id>/` | Evidence gone | **Highest-value files**: replicate and snapshot; keep the signing public keys and the encryption master key elsewhere |
| Holds | `holds.json` (centre and each gateway) | Footage may be deleted by retention | Back up with the recordings; a restore must restore holds before retention runs |
| Keys | Orchestrator secret store / KMS | See `docs/security-architecture.md` section 4 | `EVIDENCE_ENCRYPTION_KEY` and `SOURCE_SECRET_KEY` must have an offline, separate backup |

## 2. Targets (proposals)

| Tier | Examples | RPO (data we can lose) | RTO (time to be back) |
|---|---|---|---|
| 0: identity and evidence | Firebase, exports, holds, keys | 0 to 5 minutes | 1 hour |
| 1: events and alerts | PostgreSQL, bus | 5 minutes | 1 hour (reads), 15 minutes (accepting events) |
| 2: live viewing and analysis | Media tier, workers | none (live data) | 15 minutes, in the surviving zone |
| 3: recordings | Edge disks, object storage | the last segment (10 minutes) per failed disk, 0 with replicas | per site: hours; the centre is not needed for edge recording |

A site that loses its link to the centre keeps analysing and recording (the gateway's outbox holds results for days: `docs/regional-gateway.md`); that is a degraded mode, not a disaster.

## 3. Design by component

**PostgreSQL**: a primary and at least one synchronous replica in another zone, continuous WAL archiving to object storage (point-in-time recovery), failover by the operator or a manager
(Patroni or the cloud's managed failover); daily base backup, kept 35 days; restore drill monthly. For the full-scale design the events table is partitioned by day: restoring recent
partitions first gets the platform accepting events before the old history is back. *Target RPO 5 minutes (WAL shipping interval); RTO 1 hour.*

**Firebase**: scheduled Firestore export to a bucket in another region (daily, and before every `firestore.rules` change); Authentication users exported weekly (`firebase auth:export`).
Custom claims are rebuilt from the admin directory if lost (`npm run set-role`); keep that list.

**Redis / Kafka**: Redis with AOF and a replica (or a managed HA Redis); the app tolerates losing it (section 1). Kafka with replication factor 3 and `min.insync.replicas=2`, retention
at least 24 hours so consumers that were down can catch up; the dead-letter topic is reviewed daily.

**Media tier**: stateless apart from recordings; run at least two instances per region behind the ingress; a failed instance's cameras are pulled again by the survivor on the next request.
Per-camera pulls are on demand, so failover is a re-pull (seconds), not a data recovery.

**Recording storage**: hot tier on local or replicated disks; warm and cold on an object store with erasure coding (for example 8+3 across at least 11 failure domains) or three-way
replication across two sites for the most recent days. A disk failure loses at most the open 10-minute segment of the cameras it held unless replicated. The recording disk watch warns at 15%
and 5% free so a full disk is not the first sign of trouble. **Holds and evidence exports** are replicated to a second site as they are created.

**Application tier**: at least two web replicas, one scheduler (restarted automatically; a missed minute is caught up by the next due-check), N workers; rolling updates with `maxUnavailable: 0`;
`/readyz` keeps pods that are not ready out of rotation. Spread replicas across zones (`topologySpreadConstraints`; add to the manifests for a multi-zone cluster).

**Regional gateways**: one per site, with local recording. Losing a gateway loses analysis for that site until a replacement starts with the same id and secret (keep the secret in the site's
secret store); recordings on its disk survive on the disk. A second gateway per site (active/standby) is not built.

**The centre as a whole**: a second site (warm standby) with the database replica, the object store replica, a copy of the container images and the secrets, and DNS or a global load
balancer pointing at it on failover. *Target RTO for a full-site loss: 4 hours.*

## 4. Backups: what, how often, how long, and the restore order

| What | How often | Kept | Restore order |
|---|---|---|---|
| PostgreSQL base + WAL | Base daily, WAL continuous | 35 days | 2 |
| Firestore export, auth export | Daily / weekly | 35 days | 1 |
| `VMS_DATA_DIR` (small state), `exports/`, `holds.json` | Hourly snapshot | 35 days (exports: per case) | 3 |
| Keys: signing public keys, `EVIDENCE_ENCRYPTION_KEY`, `SOURCE_SECRET_KEY` | On creation and rotation | Forever, offline, in two places, not with the data | 0 (before anything that is encrypted) |
| Container images and manifests | On release | Last 10 releases | 4 |

Restore order matters: keys, then identity (Firebase), then the database, then the small state and exports, then the application, then the media tier. **Restore holds before anything that
runs retention**, or the first retention run deletes footage that was under a hold.

## 5. Failure drills (to run, and record the time against the target)

1. Kill the PostgreSQL primary during an event burst: failover time, events lost (compare the bus offsets), alerts re-raised.
2. Restore the database to a new instance from base + WAL at a chosen time; check the newest event and the hold list.
3. Stop Redis for 10 minutes: what the screens show, whether quotas and sessions recover, whether analysis resumes without duplicates.
4. Kill a media pod during a clip fetch and a live view; kill a gateway mid-upload (the clip request goes back to waiting).
5. Fill a recording disk (the disk watch must alert before it fills; recording must fail loudly, not silently).
6. Restore an encrypted export on a clean machine with only the offline keys; verify its signature with the public key alone.
7. Lose a zone: bring up the standby site from backups and measure to a working sign-in and a working video wall.
8. Rotate `SOURCE_SECRET_KEY` and `EVIDENCE_ENCRYPTION_KEY` while the system runs (the tooling exists; the drill proves the runbook).

## 6. What exists in the code toward this

Edge recording with the gateway outbox and clip fetch; holds that outlive retention; the disk watch; sealed state with key rotation; signed and encrypted exports; the bus's
at-least-once delivery with a dead-letter topic; `/healthz` and `/readyz`; non-root, restartable pods with probes (`deploy/k8s`). **Not built:** any backup or restore tooling
(this document is the plan; `pg_dump`/WAL archiving, Firestore export and the object store's replication are the tools), a standby gateway, multi-zone manifests, an automated failover.
