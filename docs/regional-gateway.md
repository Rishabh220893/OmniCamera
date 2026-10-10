# Regional gateways (gap G6)

Cameras spread over a state, up to about 1,000 km from the centre, cannot all send their video to one place: 500 cameras are about 800 Mbps of video, and any link
that long fails sometimes. A **regional gateway** is a copy of the analysis path that runs *next to* a group of cameras. It captures and analyses locally, and sends
only the **results** to the centre: about 28 kbps for 500 cameras (`docs/capacity.md`). If the link drops, it keeps analysing, stores the results on disk, and sends them
all, once, when the link returns.

```
   region                                              centre
   ┌──────────────────────────────────┐              ┌───────────────────────────────────────────┐
   │ cameras ──▶ gateway.ts           │   results    │ /api/gateway/*  ──▶ event store (logs, sightings)
   │            capture + gate        │  (signed,    │        │          alert engine ──▶ webhooks
   │            analyzers (same code) │   batched)   │        ▼          gateway monitor ──▶ gateway.offline / .degraded / .online
   │            outbox on disk  ──────┼─────────────▶│   camera list, user data, health      │
   │            agent: heartbeat,     │◀─────────────┼── cameras assigned to this gateway   │
   │            retry, clock fix      │              └───────────────────────────────────────────┘
   │ (optional) MediaMTX for local video
   └──────────────────────────────────┘
```

## What runs where

| | Gateway (`gateway.ts`) | Centre (`server.ts`) |
|---|---|---|
| Frame capture, frame gate, analyzers (Gemini, ANPR, tamper, any added) | yes | only for cameras without a `gatewayId` |
| Camera list, known faces, watchlist | fetched from the centre | owns them (Firestore) |
| Logs, plate sightings, events | written to its outbox | stored (Postgres / Firestore), events go through the alert engine |
| Alert rules and delivery | no | yes - so an alert can be late by the length of an outage, but rules live in one place |
| Per-camera webhook (`webhookUrl`) | sent directly from the gateway | not for gateway cameras |
| Firebase credentials | **none needed** | yes |
| Video for people to watch | the region's own media server (`GATEWAY_MEDIA_URL`, reported in the heartbeat) | does not carry it |

A camera belongs to a gateway when its record has `gatewayId`. The centre's own worker skips those cameras, and the centre's `/api/gateway/cameras` hands them (and only them, with
`serverAnalysis: true`) to that gateway.

## Setting one up

1. **Create the gateway** (an admin, once). The secret is shown once and never again:
   ```bash
   curl -X POST https://CENTRE/api/gateways -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
        -d '{"name":"Surat district","region":"Gujarat-South"}'
   # -> { "gateway": { "id": "gw-1a2b3c4d", ... }, "secret": "..." }
   ```
2. **Assign cameras**: set `gatewayId: "gw-1a2b3c4d"` (and `serverAnalysis: true`, `useRemoteFeed: true`, the stream URL as seen *from the region*) on the camera records. Only an admin may set `gatewayId` (Firestore rules + the registry API key).
3. **Run the gateway** in the region (a small server with ffmpeg and a disk; Node 20+):
   ```bash
   CENTRAL_URL=https://CENTRE GATEWAY_ID=gw-1a2b3c4d GATEWAY_SECRET=... GEMINI_API_KEY=... \
   GATEWAY_REGION=Gujarat-South GATEWAY_MEDIA_URL=https://media.south.example GATEWAY_STATUS_PORT=8099 npm run gateway
   ```
   All settings are in the header of [gateway.ts](../gateway.ts). Check `http://127.0.0.1:8099/status` on the gateway (link, outbox, cameras, worker).
4. **Watch it from the centre**: `GET /api/gateways` lists every gateway with `online / degraded / offline / never_seen / disabled`, the reasons, and its last heartbeat.
   Add an alert rule on `gateway.*` events (`docs/analytics.md`) to be told when one goes quiet.

## What happens when things go wrong

| Situation | What the gateway does | What the centre does |
|---|---|---|
| Link down for minutes or days | Keeps analysing. Results go to the outbox on disk; sending is retried with back-off (1 s doubling to 60 s, jittered). | After 90 s without a heartbeat marks it **offline** and raises `gateway.offline` (critical). Its cameras' results stop. |
| Link returns | Sends the backlog in order, in batches of up to 200, then carries on. | Applies each item once; raises `gateway.online`. Alerts for the backlog fire then (they are late, not lost). |
| A reply is lost after the centre applied a batch | Sends the batch again. | Recognises each item id and accepts it without applying it twice. |
| The centre's store (Firestore/Postgres) is down | Items stay in the outbox. | Leaves them unconfirmed, so they are sent again later. |
| Gateway process restarts or the machine loses power | Reads the outbox from disk and resumes. A line cut off by the crash is ignored; item ids never repeat. | Same as above. |
| Disk limit reached (`GATEWAY_OUTBOX_MAX_MB`, default 200; or older than 7 days) | Drops the **oldest** results and counts them; the count is in the heartbeat. | Marks the gateway **degraded** ("N results were dropped"). |
| Gateway clock hours wrong | Corrects itself from the centre's time on the first refusal and keeps going. | Refuses requests more than 5 minutes off until corrected. |
| Wrong or rotated secret, or gateway disabled | Reports `unauthorized`, keeps its results, retries slowly. | Answers 401; nothing is applied. Fix it and the backlog is sent. |
| Gateway sends something for a camera it does not own | - | Refuses and discards that item (counted as "rejected"); the rest of the batch goes through. |
| Slow link (hundreds of ms) | Works; batches amortise it. | - |
| Centre restarted | Carries on. | Its list of already-applied ids is in memory, so **an item whose confirmation was lost just before the restart can be applied twice**. |

## Security model

- Every request carries `X-Gateway-Id`, `-Time`, `-Nonce`, `-Signature`: HMAC-SHA256 over method, path+query, body hash, time and nonce, with the gateway's secret. The centre rejects a bad signature,
  a time more than 5 minutes off (only revealed to a correct signature), a repeated nonce, an unknown or disabled gateway. Unknown ids and wrong signatures look identical from outside.
- **Blast radius of a stolen secret**: the holder can send results for the cameras assigned to that gateway (and their owners), read the user context (faces, watchlist) of users who have a camera there, and see that
  gateway's camera list. It cannot write to other cameras, list gateways, or touch the registry. Rotate with `POST /api/gateways/:id/rotate-secret`, or switch the gateway off.
- Use **HTTPS** to the centre. The signature protects integrity and replay, not confidentiality.
- The secret is stored in the Firestore `gateways` collection (clients cannot read it: the rules deny everything not listed) because the centre needs it to verify signatures.
- **Until real roles replace the self-set "admin" field (gap G8), "only an admin can set `gatewayId`" is only as strong as that field.** A gateway fetches whatever URL a camera record names from inside its own network, so
  treat `gatewayId` and camera URLs as sensitive.

## API

Admin: `GET/POST /api/gateways`, `POST /api/gateways/:id/rotate-secret|disable|enable`, `DELETE /api/gateways/:id`.
Gateway (signed): `POST /api/gateway/heartbeat`, `POST /api/gateway/ingest`, `GET /api/gateway/cameras` (ETag), `GET /api/gateway/user-context?userId=[&departmentId=]` (with a department: the owner's faces and plates plus that department's, only for a department that has a camera of that user on this gateway). See `docs/openapi.yaml`.

## Tested

- `tests/gateway.test.ts` (24 tests): signing (every way to tamper, replay, clock), the outbox (order, restart, torn write, id uniqueness after a crash, size/age limits, unwritable disk), the centre's rules,
  and the gateway agent over **real HTTP** through a link that can be cut, slowed, made to 503 and made to lose answers after the centre has acted - including a 20,000-item backlog (4 s over loopback).
- `tests/gatewayRuntime.test.ts`: the real worker and analyzer pipeline at the edge -> outbox -> agent -> centre -> alert engine -> webhook, with the link cut and restored: nothing lost, nothing doubled, `gateway.offline` and `gateway.online` alerts raised.
- The real `gateway.ts` process was started against a local centre: it registered, received its camera, captured a frame from a URL, called Google's API (rejected: fake key) and its camera-error update reached the centre through the outbox.

## Not built / not verified

- **Never run against real distant sites**, real latency over hundreds of kilometres, a real Firestore (the `gateways` collection code and the new `cameras` rules for `gatewayId` were written but not run in the emulator or against Firebase), or a real Gemini key.
- **No playback through the gateway yet.** The gateway reports a `mediaUrl`, but the app does not use it: viewers still reach video the way they did.
- **No evidence images.** Only text results cross the link; a frame for an alert stays at the gateway.
- **No failover.** If a gateway is down, its cameras are not analysed by anyone else (the centre usually cannot reach them); that is shown as `gateway.offline`.
- Duplicate-after-centre-restart (above); multiple centre instances share no applied-id list.
- Nothing updates a gateway's software; no mutual TLS; the Registry screen has no gateway page (API only).
- The simulated link is software on one machine: it models cuts, delay, 503s and lost answers, not a real WAN's jitter and partial packet loss.
