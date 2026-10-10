# Handoff: state at the end of the 2026-10-10 session

Read `docs/gap-list.md` first (progress table, consolidated "Not verified - open items", implementation order). This file is the short version plus the test list.
Nothing from this session is committed: `git status` shows modified and new files.

## What was asked and what was done

You asked whether the app could meet four state-wide requirements (heterogeneous infrastructure, geographical dispersion, unified analytics, scalability). The answer was "partly",
a gap list with an implementation order was written, and then implemented in that order.

| Gap | What exists now | Where |
|---|---|---|
| G1 adapter interface | One contract for a camera source; adapters for direct RTSP, HTTP (HLS/MJPEG/snapshot), the grid; admin API | `server/adapters/`, `server/adapterRoutes.ts`, `docs/adapters.md` |
| G2 ONVIF | Discovery, WS-Security and HTTP Digest/Basic logins, clock-skew handling, profile and stream reads, fallbacks, probe | `server/adapters/onvif*.ts`, `tests/lab/fakeOnvif.ts` |
| G4 pluggable analytics | Analyzer contract and pipeline; Gemini + ANPR moved behind it (prompt byte-identical, output parity tested); new camera-tamper analyzer | `server/analytics/`, `docs/analytics.md` |
| G5 events and alerts | Typed events, rules (conditions, schedule, throttle), alert lifecycle, signed webhooks, memory + Postgres stores, API | `server/events/` |
| G6 regional gateway | `gateway.ts` process (no Firebase credentials), signed protocol, durable outbox, agent, centre-side health/ingest, `gateway.*` events, `gatewayId` on cameras (admin-only rule) | `gateway.ts`, `server/gateway/`, `docs/regional-gateway.md` |
| G9 capacity | Benchmarks up to 80,000 simulated cameras, media-server and per-operation costs, tested sizing model | `scripts/capacity/`, `docs/capacity.md` |
| G11 OpenAPI | 34 paths, parses and resolves | `docs/openapi.yaml` |
| G13 docs | Status note in `docs/handover.md` (its old tables are history) | |

Other changes made on the way: Gemini client moved to `server/gemini.ts`; the centre's own worker skips cameras with a `gatewayId`; `express.json` keeps the raw body for gateway paths; Firestore rules restrict `gatewayId` to admins;
`firestore.rules`, `server.ts`, `server/analysisWorker.ts`, `server/frameSource.ts`, `server/frameGate.ts`, `server/logEntry.ts`, `src/types.ts`, `package.json` (script `gateway`) were edited.

Bugs found by testing and fixed: `%` in a password broke the RTSP URL; ONVIF fallback kept the wrong port; a dead stream address made ffprobe hang for a minute; the in-memory alert store scanned every alert per event;
the two alert stores disagreed about which alert is "live" (now identical).

## Not started

G3 vendor NVR/VMS adapters (needs your list of vendors) - G8 real roles (custom claims) and department separation - G10 recording and playback - G12 mock government connectors (VAHAN, eGujCop...).
(G7, avoiding Cloudflare for video, is settled by G6 in principle: regional gateways carry video locally.)

Natural follow-ups: group several analysed frames into one database write; Registry screens for gateways, alert rules and alerts; make the Registry use the adapter layer; read per-camera analyzer settings from the camera record;
an e-mail/SMS channel; gateway playback and evidence frames; the capacity optimisations in `docs/capacity.md` section 5 (stills from the media server's open stream, in-process gate fingerprint).

## Open items for testing

Needs a thing only you have (a camera, a service, a second machine):

1. **ONVIF on a real camera or NVR** - discovery, login (WS-Security vs HTTP Digest), profiles, stream address, probe. Not supported yet: ONVIF over HTTPS with a self-signed certificate.
2. **Firestore (real or emulator)** - the `gateways` collection code, the new `cameras` rules for `gatewayId` (a non-admin must not be able to set or change it), and the centre's camera/user-context queries for gateways.
3. **The running server against Neon, end to end** - start with `EVENT_STORE=postgres`, `DATABASE_URL`, `DATABASE_SSL=true`; check `GET /api/events`, `/api/alerts`, `/api/gateways`. (The stores themselves already pass against Neon.) Also several server instances at once (duplicate-alert risk) and growth/index size over time.
4. **Redis / BullMQ** - `scale.local` has a `REDIS_URL` line; nothing was connected. Queue depth, scheduler/worker split, `ANALYSIS_ROLE`.
5. **A real gateway on another machine** - `npm run gateway` with `CENTRAL_URL` (HTTPS), a camera assigned with `gatewayId`, real link loss (unplug/firewall), and a restart of the *centre* during an outage (a lost confirmation can apply one item twice).
6. **Real Gemini key** - the gateway and analyzer pipeline end to end (only a fake key was used); the frame gate's real pass rate on real scenes (25% is an assumption); latency, rate limits, cost per day at your intervals.
7. **A webhook receiver** - `POST /api/alert-rules/:id/test` against your real endpoint; check the `X-OmniSee-Signature` verification on the receiving side.
8. **ANPR service** - speed on CPU vs GPU (`scripts/check-anpr.mjs`), accuracy on real frames.
9. **Re-encoding (recipes B/C/D), H.265 cameras, WebRTC/HLS viewer scale** - never measured.
10. **Capacity on real hardware** - re-run `scripts/capacity/*` on an idle server-class machine and with the database in the same region; current numbers are one 1.1 GHz Celeron shared with your demo.
11. **Disk-full and long-outage behaviour** of the gateway outbox on a real disk (limits are tested with small caps only).
12. **Browser UI** - nothing built here was checked in a browser; no screens exist for events, rules, alerts or gateways.

Already runnable on your machine, but should be confirmed on a clean tree:

13. `tests/mediaServerEntrypoint.test.ts` fails and the synthetic camera lab test times out here; neither imports the new code, but they were not run on an unchanged tree to prove they failed before.
14. `tsc --noEmit` reports two errors in `AnalyticsTab.tsx` and `MonitorTab.tsx` (not changed by this work).
15. Security review of the new surface: gateway signature checks, `gatewayId` + camera URLs (a gateway fetches URLs from inside its network), secrets stored in the Firestore `gateways` collection, and that "admin" is still the self-set role until G8.

## Commands

```bash
FILES=$(ls tests/*.test.ts | grep -v -E "mediaServerEntrypoint|cameraLab")
node --import tsx --test $FILES                                   # 346 tests: 343 pass, 0 fail, 3 skipped (Postgres)
TEST_DATABASE_URL=... node --import tsx --test tests/alertStorePg.test.ts tests/profileStorePg.test.ts   # against Neon
node --expose-gc --import tsx scripts/capacity/controlPlane.ts 500 5000 20000 80000
node --import tsx scripts/capacity/media.ts --costs-only
node --import tsx scripts/capacity/report.ts
```
