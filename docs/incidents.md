# Incidents and correlation (A8)

An **incident** groups events that belong together across cameras, sources and departments, so an operator follows one thing instead of
many events. It is built from the events already stored (analysis worker, recorder feeds, webhooks); nothing new is needed from a device.

## The three rules

| Kind | Opens when | Folds new events in while | Severity |
|---|---|---|---|
| `plate_trail` | The same plate (any spacing or case) is seen on **2 or more different cameras** within the trail window (60 min) | sightings keep arriving within 60 min of the last one | notice; **warning** if more than one department's cameras are involved; critical if any event in it is |
| `watchlist` | A `plate.watchlist_match` or `plate.wanted` event: **one sighting is enough** | sightings of that plate keep arriving within 60 min | critical |
| `multi_source` | **2 or more different sources** (e.g. a department's recorder and the AI, or two analyzers) report activity (`vms.*`, `person.unknown`, `scene.*`, `camera.tamper`, watchlist hits) on the **same camera** within 3 min | reports on that camera keep arriving within 30 min | warning or higher |

Bookkeeping events (`plate.read` on one camera, `vehicle.seen`, `person.seen`, camera/gateway health) never open an incident by themselves.
An incident holds an event once, so repeats and retries change nothing. Closing an incident ends it: later activity starts a new one.

## Who sees what

- An organisation-wide administrator sees every incident.
- People in a department see every incident that touches their department; everyone else sees incidents involving cameras they own.
- An incident across departments shows its summary (cameras, departments, counts) to all of them, but the **events inside it only to people who could already see those events**. One department learns that its vehicle was also seen elsewhere, not what the other department's system recorded; the count of events it cannot see is shown. This keeps Profile 3's rule that departments are unaffected.

## API (see `docs/openapi.yaml`)

`GET /api/incidents?state=open|closed&limit=&before=`, `GET /api/incidents/{id}` (incident, visible events, number hidden),
`POST /api/incidents/{id}/close`, `/reopen`, `/notes` {text}. Reading needs `alert.view`; closing, reopening and notes need `alert.handle`.

## Where it runs

`server/incidents/` (`correlator.ts`, `store.ts`, `routes.ts`). The correlator runs right after the alert engine stores events, in whichever
process handled them (`ingestAndCorrelate` in `server.ts`, covering the analysis worker, gateways, recorder feeds and webhooks). It reads
neighbouring events from the shared event store, not from its own memory, so several server processes still correlate each other's events.
Incidents are in Postgres when `DATABASE_URL` is set (table `platform_incidents`, created on start), else in memory. The screen is
**Events > Incidents**.

## Not verified, and limits

- **Postgres:** `tests/incidentStorePg.test.ts` holds the same contract as the memory store and runs when `TEST_DATABASE_URL` is set. It creates
  `platform_incidents` and two indexes in that database; **not yet run against Neon** (needs your yes).
- Never run on real cameras: the rules were tested with synthetic events of the shapes the platform produces. How often real footage yields a
  readable plate on two cameras within an hour is unknown.
- **Plate lookups use the text search** on the events table (an ILIKE over details) per plate event. Fine at demo scale; at the statewide scale
  it needs an indexed plate column (an A9 follow-up).
- Two server processes handling the first two sightings of a trail at the same instant can each open an incident; the next event folds into the
  newer one and an operator can close the duplicate. Not made airtight.
- Camera-to-camera **distance and travel time are not checked**: the same plate on two cameras within the window counts, however far apart.
  Route reconstruction and "impossible travel" belong to A18.
- The windows (60 min, 3 min, 30 min) are constants in `createCorrelator`, not settings.
- Incidents are not yet sent anywhere (no webhook or e-mail on a new incident); alert rules still cover that, per event.
