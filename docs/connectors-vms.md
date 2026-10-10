# Department system connectors and the event bus (federation plan A2, A3, A6)

A `VmsConnector` knows a whole department video system: its cameras, the events it raises, its health, and where each stream is.
(A `SourceAdapter`, `docs/adapters.md`, knows one camera's stream.) A runner per system reads it, turns what it finds into the
platform's events, and puts them on the **event bus**, where alerting (and later search and correlation) pick them up.

```
department VMS  <--read-only--  VmsConnector  <--  runner (one per system)  -->  EventBus 'platform.events'  -->  alerting consumer -> rules -> alerts
```

## The rule: read-only, and provably so

`server/connectors/vms/types.ts` has no method that creates, changes or deletes anything on a VMS, and `http.ts` offers a connector
only GET plus one explicit sign-in POST. The reference systems in `tests/lab/fakeVms.ts` count every other request they receive;
`tests/vmsConnectors.test.ts` and `tests/vmsService.test.ts` assert that count stays zero through sync, polling, restarts and removal.
That is the evidence behind "existing departmental systems remain unaffected". It covers what *this code* sends; what a department's
firewall, account permissions and connection limits do is theirs to set (give the connector a read-only account).

## The contract

| Method | Does |
|---|---|
| `cameras()` | Every camera (all pages): id, name, group, online (or unknown), location. |
| `events(cursor, limit)` | Events after an opaque cursor (`null` = from now, never from the beginning of time). Returns `{events, cursor, more}`. Event kinds are a shared vocabulary: `motion`, `plate`, `tamper`, `line_crossing`, `intrusion`, `alarm`; the vendor's own code is kept alongside. |
| `streams(cameraId)` | The camera's stream address(es). The URL may hold a login: treat as secret. |
| `health()` | `{ok, latencyMs, detail}` from a real call. |

A system is configured as `{ id, kind, baseUrl, credentials, ownerUserId, department, timezoneOffsetMinutes?, options? }`. Camera ids on the
platform are `<systemId>-<vendorCameraId>`; event ids come from the vendor's own id, so a repeated poll stores nothing twice.

## Writing a connector for a vendor

1. Copy `server/connectors/vms/referenceJson.ts` (REST + token) or `referenceXml.ts` (Basic auth, XML, zone-less local times).
2. Change the paths and field names; map the vendor's event codes to the shared kinds; keep the cursor opaque and safe against the
   boundary problems in section "What the reference systems teach" below.
3. Register it with one line in `createVmsConnectorTypes` (`server/connectors/vms/index.ts`).
4. Test it against a small fake of that vendor's API the way `tests/vmsConnectors.test.ts` does, including a write-counter.

### What the reference systems teach (each is a real failure mode that is tested)

- **Tokens expire**: a 401 triggers one re-login and a retry; simultaneous calls share one sign-in.
- **Cursor at a one-second boundary**: the XML system returns an alarm again in the second it was read, and may add a late alarm in that
  same second. The cursor carries the alarm numbers already handled in its last second, so none is repeated and none is lost.
- **No time zone in the data**: set `timezoneOffsetMinutes`. A wrong value shifts every event by exactly the zone difference (tested), so it is visible, not silent.
- **Newest-first, paged lists** are re-ordered oldest first before they are handed on.
- **Awkward text**: escaped names, `>` inside an attribute, passwords with `:`, `/`, `@`, `%`.

## The runner

Per system: reads cameras (every minute), polls events, hands each page to the bus, **then** saves the position (a crash repeats at most
one page; ids make that harmless). Camera offline/online changes become events (the first look only learns). Failures back off
(1 s doubling to 5 min); a refused login waits at least a minute and shows `auth_failed`; three failures in a row show `down`. A minimum gap between
calls (200 ms) protects the department's system. One department failing never touches another's runner (tested).

## The event bus (`server/bus/`)

Topics with ordered offsets, consumer groups (at-least-once), replay from any offset, bounded retention, and a dead-letter topic
(`<topic>.dlq`) for a message that keeps failing. `tests/busConformance.ts` is the executable contract.

| Implementation | State |
|---|---|
| In-process (`memoryBus.ts`) | Complete and tested (conformance suite passes). Lost on restart; one server only. |
| Redis Streams (`redisBus.ts`) | Written, type-checked, **never run**: no Redis was available. The same conformance suite runs against it when `TEST_REDIS_URL` is set (11 tests, skipped now). Run them before relying on it. |
| Kafka / RabbitMQ | Not written. The interface is the contract they would implement; add a client library and run the conformance suite. |

The Redis implementation has not been checked for: behaviour when a consumer crashes mid-batch (it relies on `XAUTOCLAIM` after 60 s),
Redis versions before 6.2/7.0, cluster mode, or throughput.

## Live event streams from recorders and cameras (Hikvision, Dahua, ONVIF)

Three connector types read a device's **live events** directly (kinds `hikvision-events`, `dahua-events`, `onvif-events`; `baseUrl` is the device's address, `credentials` a read-only account):

| Kind | How it reads | Sends |
|---|---|---|
| `hikvision-events` | `GET /ISAPI/Event/notification/alertStream`: the device holds the connection open and writes an `EventNotificationAlert` document per event | one GET (Digest or Basic login) |
| `dahua-events` | `GET /cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=5`: a multipart body, one `Code=...;action=...;index=...` record per event | one GET |
| `onvif-events` | a PullPoint subscription on the ONVIF Event Service: create it, long-poll `PullMessages`, `Renew` it, `Unsubscribe` when stopped | SOAP POSTs; they create and end the connector's own subscription and change nothing in the device's configuration (the lab counts every other operation) |

Channels (cameras) and RTSP streams come from the matching adapter (`docs/adapters.md`), so a recorder's channel list is the system's camera list. Plates the device's own analytics read arrive as `plate.read`; motion, line crossing, intrusion and tamper as the shared kinds; anything else as an alarm.

These feeds are **push** feeds, so a small engine (`eventStream.ts`, `streamBuffer.ts`) holds the connection in the background and gives the runner the cursor it expects, which means polling, back-off, status, the bus and the cursor file are all the existing code:

- **It reconnects by itself** with back-off, and while it is down `events()` fails, so the system shows as degraded or down (`auth_failed` for a refused login, retried no faster than once a minute), never as "healthy and silent".
- **A silent connection is torn down and reopened** (no bytes for `idleTimeoutMs`, default 60 s): devices send heartbeats, and a half-dead TCP connection otherwise looks alive forever.
- **Events missed while disconnected cannot be recovered**: these devices have no replay. A server restart starts from now (the saved position belongs to the previous run of the buffer, so nothing is replayed or repeated). `status()` says when it was last connected, and how many events were dropped if the runner fell behind.
- Events are cut across network chunks at any position (tested at every size), and the same notice always gets the same id, so a repeat is never a second event.
- Tuning, per system, in `options`: `idleTimeoutMs`, `backoffBaseMs`, `backoffMaxMs`, `connectTimeoutMs`, and for ONVIF `pullTimeoutS`, `renewEveryMs`, `rtspPort` (recorders).

**Not verified: none of the three has run against a real device.** The record and element names, event codes and message shapes are from the vendors' public documentation and the ONVIF specifications, written to be tolerant, and tested against fake devices (`tests/lab/fakeNvr.ts`, `tests/lab/fakeOnvif.ts`). Real firmware differs: which events a device offers, whether an NVR names an IP channel by `channelID` or `dynChannelID`, whether Dahua's plate sits under `TrafficCar` or `Object`, whether an ONVIF device sends a state flag. Dahua events carry no time zone of their own (the device's UTC stamp is used when present, else the arrival time). Expect to adjust the mappings on first contact with each make.

## Devices that only push: the webhook receiver

Some systems cannot be read at all and can only send. They get a **webhook source** (administrators: `POST /api/webhooks`), which returns a secret token **once**; only its SHA-256 is kept. The sender then POSTs to `/api/ingest/webhook/<source>` with the token as `Authorization: Bearer <token>` or `X-Webhook-Token` (or `?token=`, for devices that cannot set headers; proxies and logs can see a query string). Formats:

- `generic-json`: `{ "events": [ { "id", "camera": "gate-1" | { "id", "name" }, "type": "motion|plate|tamper|line_crossing|intrusion|alarm", "at", "text", "plate", "confidence", "data" } ] }`; a single event or a list is accepted too. Without an `id` the id is made from the event's content, so a sender that retries after a timeout does not create a second event. Up to 100 events and 512 KB per request; a bad event is named by its number and the good ones in the same request still count.
- `hikvision-xml`: a Hikvision device's own HTTP-listening push (the same `EventNotificationAlert` document), bare or inside a multipart body; pictures are ignored. Not verified against a real device.

The receiver is public (a camera cannot sign in), so it is protected by the token alone and by guards: it is mounted **before** the app's global JSON parser with its own 512 KB limit (an oversize body is a 413 before any token is looked at), an unknown source and a wrong token get **exactly the same 401** (ids cannot be probed), the comparison is constant-time, and each source is limited to 200 requests per 10 s (429 with `Retry-After`). `5xx` means "try again": if the bus cannot take the events the sender is told to retry, not that its request was bad. `POST /api/webhooks/:id/rotate` replaces a token (the old one stops at once). `WEBHOOK_ENABLED=false` switches the receiver off; with no sources it only ever answers 401.

## One bus for every producer

The analysis worker, the regional gateways, the department-system runners and the webhook receiver all publish to `platform.events`; one consumer (group `alerting`, `server/events/pipeline.ts`) stores the events and raises alerts. The bus is always on now (in-process unless `EVENT_BUS=redis`). Delivery is at-least-once and the alert engine stores an event once by its id, so a retry never opens a second alert; a batch that keeps failing goes to `platform.events.dlq` and does not block the others, and events published while the alert store is down are retried and alerted once it returns (tested). Producers no longer wait for alerting, so a slow alert store cannot slow an analysis or a gateway. With the in-process bus a restart loses what had not been consumed yet; use Redis (never run here) when that matters.

## Turning it on

`VMS_ENABLED=true`. Optional: `VMS_DATA_DIR` (default `.data/`; systems and positions are JSON files there), `VMS_SYSTEMS_FILE`,
`VMS_ALLOW_PRIVATE=true` (departmental systems are usually on private networks; off by default as a guard against pointing the server at
internal addresses), `EVENT_BUS=redis` with `REDIS_URL`. Admins manage systems through `/api/vms` (`docs/openapi.yaml`); logins are accepted on creation and never returned.
The login is stored in the systems file in clear text: protect that file (or move to a secret store before a real deployment). `WEBHOOK_ENABLED=false` turns the webhook receiver off (on by default, answering 401 until a source exists); the webhook sources are kept hashed in `webhook-sources.json` beside the systems file.

## Not done / not verified

- **No real vendor system, no real device.** The two reference systems, and the fake recorder, fake ONVIF device and webhook senders written for the tests. Real APIs and firmware differ in ways nobody has seen yet (see the notes under each section above).
- Events still belong to `ownerUserId` (the owner who adds the system), and carry the department; cameras discovered by a runner are reported but not yet created in the Registry or shown on the grid (that is what `docs/adapters.md` "Onboarding" does for cameras added from a device or recorder; a runner's cameras are not linked to it yet).
- Credentials of department systems are in the systems file in clear text (the sealed store used for onboarded cameras is not used here yet); webhook tokens are stored hashed. No per-system connection caps beyond the call gap and one runner, and a recorder that allows only a few event connections may refuse a second (plan A7).
- Hikvision and Dahua events are live-only (no replay after a disconnect); ONVIF over HTTPS with a self-signed certificate is not supported.
- The in-process bus is lost on restart and serves one server; the Redis bus has still never run. Kafka is not written.
- Push-only **vendor** formats other than Hikvision's are not built (generic JSON covers anything that can be told to send it).
