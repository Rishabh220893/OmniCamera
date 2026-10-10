# Plan: one platform, three deployment profiles

Written 2026-10-10 from three requirement briefs, against the code as it stands (`docs/gap-list.md`). Items marked **[built]** are
done; the rest is the order of work and the reasons. This file is the gap stack; `docs/gap-list.md` stays the status log.

## 1. The three models are three deployment profiles of one platform

| | Profile 2: Unified viewing | Profile 3: Federation middleware | Profile 1: Central VMS |
|---|---|---|---|
| Connects to departments | Directly, per camera or VMS | Through a middleware layer exposing one interface | Statewide feeds ingested centrally (with regional edge) |
| Intermediate layer | **Forbidden** | **The point** | Streaming gateway + regional edge |
| Video stored centrally | **No** | No (metadata and events) | **Yes**: recording, tiered hot/warm/cold, playback |
| Headline features | Walls, ANPR metadata, tagging, searchable movement, alerts | Connectors, event bus, **cross-system correlation**, workflow dashboard | Recording/playback, S3-class storage, face/crowd/anomaly analytics, statewide tracking and route reconstruction, VAHAN/SARTHI/eGujCop/AFIS/NAFIS readiness, redundancy/DR/encryption/segmentation/RBAC |
| Scale | tens-hundreds of cameras per demo | many departments | **~80,000 cameras** |
| Stack named | WebRTC/HLS, Kafka, Elasticsearch, Postgres | Kafka/RabbitMQ, Kong/NGINX, Postgres+Redis, React | Ceph/S3, Kafka + GPU, Postgres/TimescaleDB, Kubernetes |
| Deliverables | 2-system viewer, ANPR demo, metadata dashboard, "departments unaffected" note | 2-system federation demo, correlation dashboard, adapter docs, federated report | Prototype on multi-department feeds, ANPR + multi-location tracking demo, **80k-camera load-test report**, **DR/redundancy design**, **security architecture** |

Consequence: the connector layer, event schema, analyzers, rules/alerts, search and dashboard are shared. What differs is which
modules are switched on (recording and storage only in Profile 1; the federation service in Profile 3; "no layer" direct mode in
Profile 2) and the deployment shape. One codebase, one set of tests, three configurations.

## 2. Open questions: what the three briefs have answered

| Question | Answer | Effect |
|---|---|---|
| Gateway / regional layer acceptable? | Profile 1 and 3: **yes** ("regional edge support", "middleware layer"). Profile 2: **no**. | Gateway (G6) stays. Direct mode must work without it. |
| Recorded playback needed? | **Profile 1: required** (recording, storage, playback). Profiles 2 and 3: not required. | **Reverses my last conclusion.** G10 is back in scope and becomes a core module, not dormant. |
| Where do recordings live? | Profile 1: **S3-compatible distributed object storage (Ceph)**, tiered hot/warm/cold. | Option D (object storage) from `docs/recording.md` is now required, not optional. Local disk stays as the hot tier and the demo/pilot backend. |
| How long to keep? | **Varies by department** (stated by the project owner): some keep **7 days**, others **15 days or more**; some use **cloud storage**, others **local storage**. Every department runs its own standalone camera system. | For Profile 3 the departments' systems remain the video store, so the platform does not set retention; it keeps metadata, events and alerts under its own policy. Evidence fetched on demand exists only while the department still holds it: the **shortest** department retention (7 days) is the planning window for cross-department correlation, and an incident older than a department's retention must say "video no longer held". Next: a per-department descriptor (retention days, storage type) on the department record so the dashboard can warn. Profile 1's central recording numbers (section 3) are unaffected. |
| Kafka? | Named in Profiles 1, 2, 3 (as "Kafka plus GPU", "Kafka", "Kafka/RabbitMQ"). | The bus interface needs a Kafka implementation, not just Redis Streams. Cannot be tested here (no broker). |
| Elasticsearch / TimescaleDB? | Profile 2 suggests Elasticsearch; Profile 1 suggests PostgreSQL/TimescaleDB. | Postgres with the time-series layout and search behind an interface; TimescaleDB is a Postgres extension, so the same SQL. |
| Which VMS/NVR vendors? | **Still not named.** Profile 1's sources are "government and eligible integrated feeds" (RTSP/ONVIF-class). | Protocol-level connectors + reference mocks; vendor SDKs wait. |
| Are the three alternatives or one platform? | **Not stated.** They read like three options for the State to choose between. | Default: build one platform with three profiles so the choice stays open. Confirm with the State. |
| Face recognition / AFIS / NAFIS? | Profile 1 lists face recognition and AFIS/NAFIS "integration readiness". | Face matching against enrolled faces exists (Gemini-based, small scale). AFIS/NAFIS match fingerprints/faces against national databases: only a contract and a mock are possible; the legal basis is the State's to give. |

Still open and only the State can answer: vendor brands, retention periods, whether the three are alternatives, hardware and bandwidth
budget, and who may query the national databases.

## 3. The numbers that decide Profile 1

Storage is arithmetic from the bitrate (not measured; nothing was recorded from a real camera). `B` Mbit/s = `B x 10.8` GB per day per camera.

| Cameras | Bitrate | Per day | 7 days | 30 days |
|---|---|---|---|---|
| 1,000 | 2 Mbps | 21.6 TB | 151 TB | 648 TB |
| 80,000 | 1 Mbps (sub stream) | 864 TB | 6.0 PB | 25.9 PB |
| 80,000 | 2 Mbps | 1.73 PB | 12.1 PB | 51.8 PB |
| 80,000 | 4 Mbps | 3.46 PB | 24.2 PB | 103.7 PB |

Bandwidth into the centre for 80,000 cameras at 2 Mbps is 160 Gbit/s sustained, so central ingestion of everything is not what the
brief's own "regional edge support" can mean; recording at regional edges with central pull on demand (the gateway design) is the only
shape that fits a normal backbone. A load-test report for 80,000 cameras therefore has to say what was simulated (control plane,
metadata, events: done up to 80,000 in `docs/capacity.md`) and what cannot be tested without a data centre (media, storage, GPU).

## 4. Gap stack (everything, all profiles)

Verdicts: **have** = built and tested (with fakes where stated); **partial**; **missing**. P1/P2/P3 = profiles that need it.

| # | Gap | Profiles | State |
|---|---|---|---|
| A1 | Source adapters (RTSP, ONVIF, HTTP, grid, Hikvision, Dahua) | all | **have** (no real device) |
| A2 | **VmsConnector contract**: cameras, events (pull/stream), health, streams, later playback; builds on `SourceAdapter` | 2, 3 | **built** (`server/connectors/vms/`; reference connectors only; Hikvision/Dahua/ONVIF event connectors not yet) |
| A3 | Reference **mock VMS x2** with different APIs and real RTSP, for demos and tests | 2, 3 | **built** (`tests/lab/fakeVms.ts`: JSON+token and XML+Basic; they serve no video yet) |
| A4 | Adapter-onboarded cameras reach the grid, wall and media config; Registry uses the adapter layer | all | **built** (2026-10-10): onboarding service, sealed sources, merged media paths, Registry panel (`docs/adapters.md` "Onboarding"); proven against a real MediaMTX pair, **not against a real device or real Firestore**; shared viewer password is not department-scoped video access |
| A5 | **Shared multi-department data model** (department-owned cameras/events, visibility by policy) | all | **built** (2026-10-10): departments, username+password users, camera allotment, department-scoped cameras/events/alerts, administrators see all events, department alert rules, department faces/watchlist/logs (`docs/admin-users.md`); stores tested on real Postgres, rules in the Firebase emulator; **not run in a browser against Firebase**; plate sightings still per-owner |
| A6 | **Event bus** interface (publish/subscribe/replay); in-process, Redis Streams, **Kafka** | all (Kafka: 1) | **built, and now carries every producer** (analysis worker, gateways, runners, webhooks; step 3): interface, conformance suite, in-process (tested); Redis Streams written, **never run**; Kafka not written |
| A7 | **Federation service**: connector/department identities, routing, quotas, sharing policy, session caps | 2, 3 | missing |
| A8 | **Correlation engine** and incidents | 3 (and 1 for tracking) | missing |
| A9 | **Search API** (events, sightings, tags; Postgres, engine hidden) and tag editing | 1, 2, 3 | missing |
| A10 | **Video wall** layouts and session control | all | missing |
| A11 | **Dashboard**: search, alerts, rules, incidents, health, report | all | missing (largest) |
| A12 | ANPR metadata and watchlist | all | **have** (not on real feeds/GPU) |
| A13 | Alerts, rules, webhooks, mock VAHAN/eGujCop/SARTHI | all | **have** (mock only) |
| A14 | Recording, index, clips, evidence, retention, local hot/warm | 1 | **have** (G10, synthetic video) |
| A15 | **Object-storage tier** (S3-compatible: put/list/get/delete behind a `ColdTier`), cold tier, lifecycle | 1 | **built**: SigV4 client (reproduces AWS's documented signatures), cold tier in the store, retention hot -> warm -> cold -> delete, clips from cold footage; tested against a signature-checking fake S3, **not a real Ceph/MinIO/AWS** |
| A16 | Recording at regional edges + central clip fetch through the gateway | 1 | missing |
| A17 | **Analyzers**: face recognition at scale, crowd/vehicle counting, anomaly detection behind the analyzer contract; GPU inference service | 1 | partial (Gemini scene, ANPR, tamper) |
| A18 | **Statewide tracking and route reconstruction** on shared data | 1, 2 | partial (single-user tracking) |
| A19 | AFIS/NAFIS contract + mock; SARTHI/VAHAN real connectors when access is granted | 1 | partial (mocks, no AFIS/NAFIS) |
| A20 | Roles, departments, access log | all | **have** (not run on Firebase); needs A5 to bite |
| A21 | **Encryption** (at rest for recordings/exports, in transit), network segmentation design, key management, audit export | 1 | missing |
| A22 | **Redundancy/DR**: replicated metadata DB, storage replication/erasure coding, failover for ingest and the bus, RPO/RTO | 1 | missing (design doc first) |
| A23 | **Kubernetes** deployment (manifests/Helm), autoscaling workers, health probes | 1 | missing |
| A24 | **Load-test report** for 80,000 cameras (control plane **done**; add storage/bandwidth/event-rate/search models and a clear statement of what was not testable) | 1 | partial |
| A25 | Documents: connector/adapter guide, "departments unaffected", security architecture, DR design, deployment modes | all | missing |
| A26 | Federated analytics report | 3 | missing |

## 5. Order of work

Effort: S = days, M = 1-2 weeks, L = several weeks, one developer. Every step ends with tests and a doc that says what was not verified.

| Phase | Steps | Why this order |
|---|---|---|
| **P0 foundations (no outside input needed)** | A3 mock VMS x2 -> A2 VmsConnector -> A6 event bus (in-process + Redis Streams, Kafka behind the same interface) -> A15 storage-tier interface with an S3-compatible backend tested against an in-process S3 fake | Everything else is built and tested against these. |
| **P1 shared data** | A5 multi-department model (+ A20 so policy bites), A4 adapter cameras into grid/media | Riskiest change (data ownership); before any screen. |
| **P2 intelligence** | A9 search, A8 correlation, A18 statewide tracking/route reconstruction on shared data, A17 analyzers (counting, anomaly; face behind the contract) | The features the briefs headline. |
| **P3 federation and edge** | A7 federation service + session caps, A16 edge recording with central clip fetch | Profile 3 core and the only shape that fits Profile 1's bandwidth. |
| **P4 screens** | A10 wall + sessions, A11 dashboard, A26 report | Needs the data and APIs above. |
| **P5 platform** | A21 encryption/segmentation, A22 DR design, A23 Kubernetes, A24 load-test report, A25 documents | Mostly design documents and deployment artifacts; cannot be proven without real infrastructure. |

**Step 3 (2026-10-10): event connectors for Hikvision, Dahua and ONVIF, a webhook receiver for push-only systems, and the analysis worker and gateways moved onto the bus are built** (`docs/connectors-vms.md`); against fakes, not real devices. Next: A9 search and a thin A11 dashboard.

**P0 status (2026-10-10): A3, A2, A6 and A15 are built** (see the verdicts above and `docs/connectors-vms.md`, `docs/recording.md`). Next: P1 shared data (A5, A4).

## 6. Decisions and defaults (change any)

1. **Retention.** Not stated. Default for design: 7 days hot for everything, 30 days for named cameras, evidence by hold, sub-stream recording as the planning bitrate. At 80,000 cameras the choice of bitrate and days moves the storage figure by 20x (section 3), so this is the first thing to put to the State.
2. **Bus.** Interface first; Redis Streams for demos; Kafka implementation written against its client API but **unverified until a broker exists** (stated in the docs, not hidden).
3. **Search.** Postgres (TimescaleDB-compatible); Elasticsearch behind the same interface if needed.
4. **Object storage.** S3-compatible API (works for Ceph RGW, MinIO, AWS S3) with local disk as hot tier. Tested only against an in-process fake; real Ceph untested.
5. **Face recognition and AFIS/NAFIS.** Contract and mocks only; no biometric database is built. The legal and policy basis is the State's.
6. **Runtime.** Node/TypeScript throughout; Java/Python only if a vendor SDK or model server requires it.

## 7. What this plan cannot cover

Real departmental VMSs, vendor SDKs, GPUs, a Ceph/Kafka/Kubernetes cluster, real 80,000-camera media load, and the legal agreements
between departments. Anything built for these is proven against fakes and simulations only, and each document says so.
