# Profile test checklist

There is **no `PROFILE` variable**. A profile is just the set of feature switches you turn on (`docs/deployment-modes.md`). `server.ts` reads each variable on its own and starts only the modules whose switch is set. So "which profile is running" means "which switches are set"; to test Profile N, set that column and leave the rest unset.

Step numbers (T#) refer to sections of `docs/testing-guide.md`. Run every profile's checks with each of the **three logins** at the end.

## Profile 2: unified viewing

`.env`:
```
MEDIA_SERVER_URL=http://localhost:8888      # MediaMTX running (docs/media-server.md)
MEDIA_AUTH_MODE=token                       # per-department video access
EVENT_BUS=memory
SECURITY_CSP=true  FORCE_HTTPS=true  TRUST_PROXY=true   # off locally if no HTTPS
# Leave UNSET: FEDERATION_ENABLED, VMS_ENABLED, WEBHOOK_ENABLED, RECORDINGS_DIR, GATEWAY_RECORDINGS_DIR
```
Checklist:
- [ ] App starts; startup log shows no federation, VMS, recording or gateway module.
- [ ] Onboard a camera (RTSP/ONVIF) via `docs/adapters.md`; tile plays through MediaMTX.
- [ ] Video wall opens and shows several tiles (T3).
- [ ] Settings page loads; no Federation section is functional (T2).
- [ ] Per-user video access: a department user's stream token cannot play another department's camera (T14).
- [ ] Negative: `/api/federation/me` and recording routes are unavailable or refused.
- [ ] Negative: no gateway is deployed (it forbids an intermediate layer).

## Profile 3: federation middleware

`.env`: everything from Profile 2, plus
```
FEDERATION_ENABLED=true
FEDERATION_STORE=redis   REDIS_URL=...      # only if you run several servers
VMS_ENABLED=true  WEBHOOK_ENABLED=true  VMS_REGISTRY_SYNC=true
EVENT_BUS=redis                             # kafka is unverified
DATABASE_URL=...  EVENT_STORE=postgres      # recommended
# Still UNSET: RECORDINGS_DIR (departments keep the video)
```
Checklist:
- [ ] Profile 2 checks still pass.
- [ ] Federation clients, keys, quotas and session caps (T1).
- [ ] Department system with login added in the Sources/VMS panel; password stored sealed, not plain (T7).
- [ ] Webhook or fake-device events arrive in the Events tab and are not duplicated.
- [ ] Incident across departments: summary visible to all, events only to those allowed (`docs/incidents.md`).
- [ ] Federated report and vehicle trail (T4).
- [ ] Alert channels and holds (T9); department picker (T10); event bus across processes (T11).
- [ ] Negative: no recording is created (`RECORDINGS_DIR` unset).

## Profile 1: central VMS

`.env`: everything from Profile 3, plus
```
RECORDINGS_DIR=...  (+ warm dir / S3)
GATEWAY_RECORDINGS_DIR=...                  # on each gateway
DATABASE_URL=...  EVENT_STORE=postgres      # required
INFERENCE_SERVICE_URL=...  ANPR_SERVICE_URL=...   # GPU services
EVIDENCE_SIGNING_KEY=...  EVIDENCE_ENCRYPTION_KEY=...   # required
```
Checklist:
- [ ] Profile 3 checks still pass.
- [ ] Recording, retention and playback (`docs/recording.md`).
- [ ] Evidence export is signed, chain-of-custody checked and encrypted (T8).
- [ ] Edge recording and clip fetch through a gateway (T12).
- [ ] Count anomalies and the inference service (T13); ANPR.
- [ ] Kubernetes manifests (T15) and capacity benchmark (T16).
- [ ] Known limit: nothing has been tested at scale (`docs/load-test-report.md`).

## Logins to repeat in every profile

| Login | How to create | Expect |
|---|---|---|
| Admin | `npm run set-role -- chief@example.org admin` | All cameras, Settings admin sections, access log |
| Department operator | `npm run set-role -- op@example.org operator traffic` | Only `traffic` cameras and events; can record snippets |
| Viewer | `npm run set-role -- v@example.org viewer traffic` | Read-only; recording a snippet gives 403 |

Also check that a `traffic` user cannot see `water` cameras, events or video (T14, `docs/authz.md`).
