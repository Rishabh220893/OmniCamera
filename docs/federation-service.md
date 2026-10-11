# Federation service (gap A7)

Who a department's system or a connector is when it talks to the platform, and how much it may do. Code: `server/federation/`
(`service.ts`, `routes.ts`), tests: `tests/federation.test.ts`. Built 2026-10-11 (session 5).

## What it gives

| Piece | How it works |
|---|---|
| **Identity** | A *client* per department system / connector / integrator, made by an administrator (`vms.manage`). Its **API key** (`fed_<id>.<secret>`) is shown **once**; only the SHA-256 is stored. The id is inside the key, so a request names no id and cannot ask for another identity. Wrong key, unknown id, switched-off client and malformed key all answer the same 401 and cost the same time. Rotate replaces the key at once. |
| **Department stamp** | The department is fixed on the client. Every event it pushes carries that department, whatever the body says (the body's `department` is ignored). Events are filed under the client's owner user, as department systems and webhook sources are. |
| **Event push** | `POST /api/federation/events`, the generic-JSON format of the webhook receiver (`docs/connectors-vms.md`), 512 KB, up to 100 events. Goes to the event bus like every other producer. Retrying an event with the same `id` makes no second event. Without an `id`, the id is made from camera, type, time (`at`), plate and text, so a repeat only matches if it carries the same `at`; an event with no `at` is stamped with the time it arrives and is therefore always new. Senders should send their own `id`. The reply's `ignored` lists events that could not be read, not duplicates. |
| **Quotas** | Per client: events a minute (default 600), events a day (default 200,000, UTC day), live sessions at once (default 4). A batch that would pass a limit is refused **whole** (429 + `Retry-After`) and counts for nothing. If the bus is down the sender gets 503 and nothing is counted. |
| **Session caps** | `POST /api/federation/sessions` takes a slot (a person watching a department's camera through the platform), `.../renew` keeps it, `DELETE` gives it back. A lease not renewed within 60 s runs out by itself. Optional `FEDERATION_DEPARTMENT_SESSION_CAP` caps all clients of one department together. |
| **Scopes** | `events.push`, `sessions`. A key without the scope gets 403. |
| **Use** | `GET /api/federation/me` (the client) and `GET /api/federation/clients` (admin): quotas, events in the last minute / today, active sessions, received, rejected, last seen, last error. |

## Routes

Client side (public, API key; mounted before the global body parser with small limits): `GET /api/federation/me`, `POST /api/federation/events`,
`POST /api/federation/sessions`, `POST /api/federation/sessions/:id/renew`, `DELETE /api/federation/sessions/:id`.
Key as `Authorization: Bearer fed_...` or `X-Api-Key`.

Admin side (`vms.view` to read, `vms.manage` to change): `GET|POST /api/federation/clients`, `PATCH|DELETE /api/federation/clients/:id`,
`POST /api/federation/clients/:id/rotate`, `GET /api/federation/sessions`.

Example:

```
POST /api/federation/clients   { "id": "police-nvr", "department": "Police", "scopes": ["events.push","sessions"], "quotas": { "eventsPerMinute": 300, "maxSessions": 6 } }
POST /api/federation/events    Authorization: Bearer fed_police-nvr.<secret>
                               { "events": [ { "camera": "gate-1", "type": "intrusion", "text": "Person at the gate" } ] }
```

Settings: `FEDERATION_ENABLED` (default on; `false` switches the routes off), `FEDERATION_DEPARTMENT_SESSION_CAP` (unset = no department-wide cap),
clients are kept in `<VMS_DATA_DIR or .data>/federation-clients.json` (mode 0600).

## Screen

Settings > **Department and connector access** (administrators who are signed in; not shown in guest mode): add a client (name, department, permissions, limits),
see each client's use (events this minute / today against the limits, live sessions, last seen, refused requests), change limits, switch a client on or off,
make a new key, remove. A key is shown once, with a Copy button. Code: `src/components/FederationPanel.tsx`, `src/lib/federationApi.ts`.
**Type-checked and built, not opened in a browser** (the panel needs a real signed-in administrator; the in-app browser only had guest mode).

## Shared counters (Redis)

Counters and session leases live behind a `UsageStore` (`server/federation/usageStore.ts`). The default is in this process's memory. With
`FEDERATION_STORE=redis` and `REDIS_URL` the quotas and caps hold across several server processes: events are counted in ten-second buckets over the last
minute and per UTC day; a quota check and its count, and a session slot check and its take, are each one Lua script, so two servers cannot both take the
last slot. A push the bus then refuses gives its count back. The same contract suite (`tests/federationUsage.test.ts`) runs on both stores.
**The Redis store has never been run against a Redis** (none on this machine): set `TEST_REDIS_URL` and run that file first. The client list itself
(`federation-clients.json`) is still a file per server, so with several servers create clients through one of them or share that file.

## Not built and not verified

- **mTLS identities.** Only API keys. mTLS belongs at the reverse proxy (it can map a certificate to a key header); nothing in the app reads certificates.
- **Routing and sharing policy** (which department may see which other department's events or cameras, who may open whose video): not built. Event
  visibility stays as in `docs/admin-users.md` and `docs/incidents.md`. The **session cap counts slots but does not control video access**: the
  media server's shared viewer password is still the only video gate (A21).
- Without Redis, counters are per process and a restart forgets them (leases simply end).
- Clients are not in `docs/openapi.yaml` yet.
- Tested with fakes over real HTTP (a real Express app, real fetch); **never with a real department system**, never on the live server.
