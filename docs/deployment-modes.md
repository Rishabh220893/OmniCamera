# Deployment modes (gap A25)

One codebase, three configurations, chosen by what is switched on (`docs/federation-plan.md` section 1). This page says, for each mode, what to turn on, what to leave off, and what the
departments' systems see of you. Environment variables are in `.env.example` and the docs named in each row.

| | **Profile 2: unified viewing** | **Profile 3: federation middleware** | **Profile 1: central VMS** |
|---|---|---|---|
| Intent | One viewer over many departments' cameras; **no intermediate layer** | A middleware that connects departments' systems through one interface and correlates across them | A central system with recording, tiered storage, analytics and statewide tracking |
| Video | Played from the departments' own streams (RTSP/ONVIF/HLS) | The departments' systems stay the video store; the platform keeps metadata | Recorded centrally or at regional edges; stored and played back |
| Departments' systems | Untouched: read-only access to a stream address | Untouched: read-only account, or they push events | Fed by cameras directly (an NVR can still run beside it) |
| Turn on | Camera onboarding (`docs/adapters.md`), the media server (`docs/media-server.md`), the wall (`docs/video-wall.md`), per-user video access if departments must not see each other's cameras | All of Profile 2 plus the federation service, department-system connectors, webhooks, the event bus, correlation (`docs/federation-service.md`, `docs/connectors-vms.md`, `docs/incidents.md`) | All of Profile 3 plus recording, edge gateways with edge recording, object storage, the GPU services, evidence handling, Kubernetes (`docs/recording.md`, `docs/regional-gateway.md`, `deploy/k8s`) |
| Leave off | Recording, federation, gateways | Central recording | Nothing, but each piece is optional |
| Typical scale | tens to hundreds of cameras per deployment | many departments, thousands of cameras of metadata | up to 80,000 (modelled: `docs/load-test-report.md`) |
| What was tested | Onboarding and playback against real MediaMTX; the wall API and screen | Connectors and webhooks against fake devices; correlation, federation API, reports and trail on stores in memory and on Neon for incidents | Recording, retention, evidence and clip fetch with real ffmpeg video; manifests checked for consistency; **nothing at scale** |

## The settings that define a mode

| Setting | Profile 2 | Profile 3 | Profile 1 |
|---|---|---|---|
| `MEDIA_SERVER_URL` (+ `MEDIA_AUTH_MODE=token` for per-department video) | on | on | on |
| `FEDERATION_ENABLED`, `FEDERATION_STORE=redis` (several servers) | off | on | on |
| `VMS_ENABLED`, `WEBHOOK_ENABLED`, `VMS_REGISTRY_SYNC` | off | on | on |
| `EVENT_BUS` | memory | `redis` (or `kafka`, unverified) | `redis` / `kafka` |
| `DATABASE_URL`, `EVENT_STORE=postgres` | optional | recommended | required |
| `RECORDINGS_DIR` (+ warm dir, S3) | off | off (the departments record) | on |
| Gateways (`GATEWAY_RECORDINGS_DIR` at each site) | off (it forbids an intermediate layer) | optional | on |
| `INFERENCE_SERVICE_URL`, `ANPR_SERVICE_URL` | optional | optional | on (GPU) |
| `EVIDENCE_SIGNING_KEY`, `EVIDENCE_ENCRYPTION_KEY` | optional | optional | required |
| `SECURITY_CSP`, `FORCE_HTTPS`, `TRUST_PROXY` | on | on | on |

## Choosing

- If the State wants **no layer between the viewer and the departments' systems**, run Profile 2 and do not deploy gateways: video is then played straight from the source and the platform
  holds only the cameras' addresses, names and the events it derives from the frames it analyses.
- If departments will not share video but will share *what happened*, run Profile 3: events and incidents cross departments by the visibility rules; video stays with the department.
- If the State wants a single system of record for video, run Profile 1 and size storage with `docs/load-test-report.md`; recording at the edge is the only shape that fits a normal backbone.
- The three can be one deployment: a statewide centre can run all three at once for different departments.

Which of these the State wants is still an open question (`docs/federation-plan.md` section 2: the three briefs read as alternatives); the platform is built so the answer does not change the code.
