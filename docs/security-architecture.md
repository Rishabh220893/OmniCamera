# Security architecture (gaps A21 and A25)

What the platform protects, from whom, with what, and what it does not. Written 2026-10-11 against the code as it stands; each statement says whether it is built and
how far it was tested. Where a control exists only as a design (or only on paper), it says so.

## 1. What is being protected

| Asset | Why it matters | Where it lives |
|---|---|---|
| Video: live and recorded | Evidence, privacy | The media server; recordings on disk or object storage; exports in `exports/` |
| Events, alerts, incidents, plate reads, trails | Reveals where people and vehicles went | PostgreSQL (or memory); Firestore for logs |
| Faces and the watchlist | The most sensitive personal data here | Firestore (`faces`, `watchlist`) |
| Logins to cameras and department systems | Access to the departments' own systems | Sealed (AES-256-GCM) in the source store and the systems file |
| Keys: signing, encryption, tokens, API keys | Whoever holds them can forge or read | Environment / the orchestrator's secret store |
| The access log | Proof of who did what | In memory and Firestore `accessLog` |
| Evidence exports | May be produced in court | `exports/<id>/`: the video, a manifest, its signature, the custody log |

## 2. Who is trusted

- **Platform administrators** (claim `role: admin`, no department or `*`): everything, platform-wide. The most powerful accounts; there is no break-glass or four-eyes rule yet.
- **Department users** (claims `role` and `departments`): their departments' cameras, events, alerts, rules, faces, plates and logs, by the roles viewer / operator / admin.
  Another department's data appears only as a count (reports, trails) or as the fact that an incident exists.
- **Department systems and integrators** (federation clients: API keys): push events as their own department, within quotas; they read nothing.
- **Regional gateways** (HMAC-signed requests): send results, fetch their camera list and user context, and serve clip requests. They hold their cameras' logins (given to them
  sealed in transit by TLS and the signature, stored on the gateway's disk).
- **The operator of the servers**: can read everything the process can (it holds the keys). This is the largest single trust assumption (section 6).

Roles come from Firebase custom claims (`npm run set-role`); the rules are in `server/authz/policy.ts` and `firestore.rules` and are tested in the Firebase emulator.

## 3. Controls by layer

### 3.1 In transit
- **Browsers to the app**: TLS terminated at the ingress or reverse proxy (`deploy/k8s/base/ingress.yaml`); the app sets HSTS when it sees HTTPS (directly or via a trusted
  `X-Forwarded-Proto`), and `FORCE_HTTPS=true` redirects plain HTTP (`server/security/headers.ts`, tested). The app does not terminate TLS itself.
- **Gateways to the centre**: HTTPS plus a signature over method, path, body and time with a replay cache (`server/gateway/protocol.ts`); a captured request cannot be replayed or changed.
  Clip uploads sign the declared SHA-256 and the centre re-hashes the bytes.
- **Department systems and federation clients**: HTTPS plus an API key (hashed at the centre, shown once). **Mutual TLS is not built**; if the State wants it, terminate it at the
  reverse proxy and map the certificate to the client's key header.
- **Inside the cluster**: not encrypted by the app. Use a service mesh (mTLS) or the CNI's encryption if the threat model includes the cluster network.
- **Media**: HLS and WebRTC over HTTPS/DTLS between browser and media server; the camera-to-media-server legs are whatever the camera speaks (RTSP is usually unencrypted:
  keep it on a segregated network, section 3.5).

### 3.2 Who may watch video (new)
Until now every signed-in person received the media server's one shared password, which opens every camera path. With `MEDIA_AUTH_MODE=token` (`server/media/streamAuth.ts`):
a signed-in person gets a **short-lived signed token** (10 minutes) instead; MediaMTX asks the app on every request whether *that person* may read *that path* (they own a
camera on it, or it belongs to a department they work for, or they administer every department); anything else is refused. Verified with a real MediaMTX (`tests/mediaAuth.test.ts`):
the right token plays, another camera's path, no token, the old shared password and a changed token all get 401, and a request from the same machine is **not** exempt.
Limits: a token is a bearer token for its 10 minutes (a person can hand it on); the callback adds a lookup to every HLS request (cached index, not load-tested); recorded
video is protected by the recording routes' own checks, not by this.

### 3.3 At rest
- **Logins of cameras and department systems**: sealed AES-256-GCM with `SOURCE_SECRET_KEY` (a key ring supports rotation: `npm run rotate-source-key`). Department systems' logins
  were stored in clear text until this release; they are sealed on the next start when the key is set.
- **Evidence exports**: encrypted with `EVIDENCE_ENCRYPTION_KEY` (per-file data key wrapped by the master key, chunked AES-256-GCM, tamper-evident, re-wrappable without
  re-encrypting video: `server/recording/exportCrypto.ts`, tested incl. reordering, truncation and bit flips).
- **Recordings (segments on disk or in object storage)**: **not encrypted by the application.** Use volume or disk encryption (LUKS, BitLocker, the storage class's encryption) and
  server-side encryption in the object store (SSE-S3/SSE-KMS, Ceph's SSE). This is a deployment control, and the manifests do not set it for you.
- **Database**: use the database's encryption at rest and TLS to it (`DATABASE_SSL=true`).
- **Backups**: encrypted by the backup tool; see `docs/disaster-recovery.md`.

### 3.4 Evidence integrity
- Every export has a manifest with SHA-256 of the file and of each source segment, a **signature** (Ed25519, `EVIDENCE_SIGNING_KEY`; `npm run evidence-key` makes the key and verifies offline),
  and a **hash-chained custody log** (exported, fetched from a gateway, downloaded, verified). Anyone with the public key can check a manifest without trusting the server.
- Limits: the custody chain proves order and edits, not completeness (the newest lines can be cut off); a person with the server's disk and keys could replace a whole export folder.
  Write-once (WORM/object-lock) storage for exports is the control for that, and is not built.
- An alert can hold the footage around it (`recording-hold` channel); a clip fetched from a gateway places a hold at the edge.

### 3.5 Network segmentation
`deploy/k8s/base/networkpolicies.yaml` (checked for consistency in `tests/k8sManifests.test.ts`, **not applied to a cluster**): default deny; ingress only from the ingress controller to
the web tier; Redis only from the app pods; the media server only from the app pods and the ingress, and calling the web tier for video authorisation; GPU services only from the app
pods; metrics only from the monitoring namespace; egress limited and the cloud metadata address (169.254.169.254) blocked. The edge gateway accepts nothing inbound.

Recommended zones for a real deployment: (1) **camera networks** (cameras, NVRs; reachable only from the media tier and the gateways, never from the internet or user networks),
(2) **media tier**, (3) **application tier**, (4) **data tier** (database, Redis, object storage; no internet), (5) **management** (admin access, CI, monitoring). Department systems
connect inward to the federation API only. A regional site has its own camera network and one outbound path to the centre.

### 3.6 Application hardening
Security headers on every response (`nosniff`, frame and referrer policies, a permissions policy, an opener policy that keeps Google sign-in working); a Content-Security-Policy
sent **report-only** by default with a violation endpoint (`/api/csp-report`) so it can be tightened from evidence, then `SECURITY_CSP=enforce`; `X-Powered-By` removed;
JSON bodies limited (25 MB general; 512 KB for the public ingest endpoints); public endpoints rate limited and answering the same 401 for an unknown identity and a wrong key;
a non-root container with no capabilities (`Dockerfile`, `deploy/k8s`).
**Not done:** a general rate limit and brute-force protection on the sign-in routes beyond Firebase's own; dependency and image scanning in CI; a web application firewall.

### 3.7 Audit
Refusals and sensitive uses are logged (`docs/authz.md`); `GET /api/access-log/export` produces a **sealed export** (entries hashed, header signed with the evidence key, checkable
offline: `server/security/auditExport.ts`, tested) for an auditor, as JSON (signed) or CSV (spreadsheet-safe, unsigned). From Firestore it includes everything saved in the period
(up to 20,000 entries); from memory alone, the newest 2,000, and it says so. Not built: shipping the log to a SIEM, tamper-proof storage for the log itself.

## 4. Keys and secrets

| Secret | Protects | Made with | Rotation | If it leaks | If it is lost |
|---|---|---|---|---|---|
| `SOURCE_SECRET_KEY` | Camera and department-system logins at rest | 32 random bytes (hex) | `SOURCE_SECRET_KEY_PREVIOUS` + `npm run rotate-source-key`, no downtime | Logins readable by whoever also has the database/file: change the logins at the devices | The stored logins cannot be opened: re-enter them |
| `EVIDENCE_SIGNING_KEY` | Authenticity of manifests and audit exports | `npm run evidence-key` (Ed25519) | A new key signs new exports; old signatures stay valid with the old public key (kept offline) | Forged manifests possible: revoke by publishing the key id as compromised; re-sign nothing silently | New exports are unsigned until a key is set; old ones still verify with the saved public key |
| `EVIDENCE_ENCRYPTION_KEY` | Exports at rest | 32 random bytes | `rewrap` re-wraps each file's data key (header only) | Exports on a stolen disk are readable | **The encrypted exports are unreadable.** Back it up separately from the data |
| `MEDIA_TOKEN_SECRET` | Video tokens | 32 random bytes | Change it: tokens end within 10 minutes | Anyone can mint tokens: change at once | Change it |
| `MEDIA_AUTH_SECRET` | The media server's callback | 32 random bytes | Change it in both places | The callback can be probed (it only answers allow/deny) | Change it |
| Gateway secrets | A gateway's requests | Made at provisioning (shown once) | `rotate-secret` | Forged gateway requests: rotate and disable | Rotate |
| Federation API keys | A department system's pushes | Made by an administrator (shown once) | Rotate in Settings | That system's events can be forged | Rotate |
| Firebase service account | Admin access to Firebase | Google | Google's process | Full access to users and data: rotate immediately | Make a new one |

Keys live in the environment or the orchestrator's secret store. They are never logged and never returned by the API (the lists show a hash or nothing). **A KMS or HSM is not
integrated**: the server holds its master keys in memory; the next step is to hold them in a KMS so the server asks for data keys and an operator with a shell cannot copy them.

## 5. Threats and what answers them

| Threat | Answer | Gap |
|---|---|---|
| A department user reads another department's data | Department scope in the rules, the stores and the routes; counts only across departments | Tested with fakes and in the emulator; not on a live multi-department deployment |
| A signed-in user watches a camera they should not | Per-user video tokens (3.2) | Off by default (needs MediaMTX configured); the shared password remains the default |
| A stolen API key | Hashed at rest, shown once, rotation, per-key scopes and quotas, department stamped by the key | No IP allow-listing per key; no mTLS |
| A stolen gateway secret | Signed requests, replay cache, disable and rotate | A gateway holds camera logins on its disk |
| Evidence tampering | Hashes, signature, custody chain, edge holds | No WORM storage; trust in the server's disk |
| Insider with server access | Access log; sealed logins; encrypted exports | The server holds the keys (4); admin actions are not four-eyes |
| Injection and XSS | Parameterised SQL; output escaped in the printable report; CSV formula neutralisation; report-only CSP | CSP not yet enforcing; no automated security testing in CI |
| Denial of service | Body limits, rate limits on public endpoints, quotas, session caps, a grid guard | No global request rate limiting or WAF |
| A compromised pod | Non-root, no capabilities, network policies, no metadata service | Not run on a cluster |

## 6. What this document does not claim

No penetration test was done; no threat-modelling workshop; no review by a security professional; the cluster policies were not applied to a cluster; the controls above were
tested with fakes, a real MediaMTX, a Firebase emulator, and real HTTP on one machine. The legal basis for storing and matching faces and plates, retention, and who may query the
national databases is the State's to settle (`docs/federation-plan.md` section 2).
