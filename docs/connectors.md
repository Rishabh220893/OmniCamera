# Connectors to outside systems (gap G12)

Live access to VAHAN, SARTHI, eGujCop and AFIS/NAFIS is restricted, so what is built is the **contract**, a **hub** that makes
calling an outside system safe, a **plate check** that turns findings into ordinary events, and **mock connectors** that behave
as the contract says. Everything a mock returns is marked `mock: true`, and the events built from it say `[MOCK]` in their summary
and carry a `mock` tag, so a test answer cannot be mistaken for a real one.

Turn the mocks on with `CONNECTORS=mock`. Nothing else changes when they are off.

## What it does

```
plate.read  ->  vehicle lookup (vahan)         ->  plate.vehicle_flagged   stolen, blacklisted, insurance_expired, fitness_expired
            ->  wanted_vehicle lookup (egujcop) ->  plate.wanted            named in an open FIR
```

- It runs **after** the plate read has been stored and alerted, never in front of it. A slow or dead outside system cannot delay or
  lose a camera's own events.
- Derived events are normal events: alert rules match them (`types: ["plate.vehicle_flagged", "plate.wanted"]`, `minSeverity:
  "critical"`), and throttling, acknowledgement and webhooks work unchanged. Severity of `plate.vehicle_flagged` is the worst flag.
- Reads below 60 % confidence are not checked, so a doubtful read cannot raise "stolen vehicle". A plate is checked at most once a
  minute per camera. A plate the registry does not know produces **nothing** (the mock does not invent records; a real registry's
  "not found" may deserve its own rule, which needs a real connector to design against).
- Derived events keep the original camera, user, department and frame time, and have stable ids, so a retry stores them once.

## The contract (`server/connectors/types.ts`)

A connector has an `id`, the query types it answers (`vehicle`, `licence`, `wanted_vehicle`) and
`lookup(query, signal) -> { found, flags[{code, severity, text}], data, queriedAt, mock }`. `data` holds only what OmniSee needs
(owners are masked); the full personal record is never passed on. To replace a mock with the real system, implement `Connector` and
register it under the same id; nothing else changes.

The hub (`server/connectors/hub.ts`) gives every connector: a time limit per call (3 s), a cache of answers (5 min; the same plate
is read many times a minute), one shared call for identical simultaneous questions, a circuit breaker (5 failures in a row pause it
for 30 s, reported in the status), and a cap of 8 calls in flight (the rest are refused, not queued).

## API

| Route | Does |
|---|---|
| `GET /api/connectors` | Each connector, whether it is healthy (`ok`, `failing`, `open`), call, cache, failure and timeout counts. |
| `POST /api/connectors/:id/lookup` | `{ "query": { "type": "vehicle", "plate": "GJ27GH3456" } }`; also `licence` (`number`) and `wanted_vehicle`. 400 bad question, 404 unknown connector, 422 the connector does not answer that type, 503 paused or busy, 504 timeout. |

Both need the `connector.query` permission (operators and admins) and every call is in the access log (`docs/authz.md`), because the
answers are about people.

## Demo data

`GJ27GH3456` is stolen and in an FIR; `GJ03JK7890` is blacklisted; `GJ05CD5678` has expired insurance; `GJ18EF9012` has an expired
fitness certificate; `GJ01AB1234` is clean; licence `GJ1820190009999` is suspended. Validity is judged against the clock, so
`GJ01AB1234` itself starts reporting expired insurance after 2027-04-11. The table is `DEMO_DATA` in `server/connectors/mock.ts`.

## Not done / not verified

- **No real system was contacted.** The real VAHAN, SARTHI and eGujCop interfaces (authentication, field names, rate limits,
  state differences, legal basis for querying) are unknown to this project; the contract is a design, not a copy of theirs.
- **AFIS / NAFIS are not mocked.** They match fingerprints or face templates; a camera frame gives neither a template nor a
  legitimate basis to query. A face-search connector would need a decision on what may be searched and by whom.
- SARTHI (licence numbers) cannot be driven by cameras; it is for officers using the lookup route. There is no screen for any of this.
- Findings are not stored apart from the events; the raw answer is not kept. The cache and breaker are per server process.
