# Analyzers, events and alerts

Two layers that sit on the server-side analysis path:

```
frame ─▶ frame gate ─▶ analyzers (run side by side) ─▶ log entry (as before)
                                  │
                                  └─▶ events ─▶ rules ─▶ alerts ─▶ channels (webhook, log)
```

Everything downstream of an analyzer works from **events**, never from a particular analyzer, so a new detector needs no change to the worker, the log
or the alerting.

## Analyzers (`server/analytics/`)

An analyzer looks at one frame and returns any of: **fields** for the log entry (summary, counts, alerts...), typed **events**, and **signals** for
the finalizer. Contract: `server/analytics/types.ts`.

| Member | Meaning |
|---|---|
| `id` | Lower case, digits, `-`. Becomes the `source` of its events. |
| `required` | A required analyzer failing fails the analysis (retried with back-off, as before). Any other failure is recorded and the rest of the result is kept. |
| `timeoutMs` | Longest it may run; its `signal` is aborted when the time is up. |
| `appliesTo(camera)` | Return false to skip it for a camera (zones, departments, camera types). |
| `analyze(input)` | `input` has the camera, the frame (JPEG and base64), the user's known faces and watchlist, the time, and the abort signal. |

Shipped analyzers:

| `id` | What | Required |
|---|---|---|
| `gemini-scene` | Scene summary, counts, known faces, brands, unusual-activity judgement. The prompt is unchanged (`tests/fixtures/geminiScenePrompt.json` holds the original). | yes |
| `anpr-plates` | The dedicated plate reader, when `ANPR_SERVICE_URL` is set. When it answers, its plates replace Gemini's; when it is down, Gemini's are used and marked `gemini-fallback`. | no |
| `camera-tamper` | Flags a picture with no detail, an almost black or almost white one, from pixel statistics. No model call. Emits `camera.blocked`, `camera.dark`, `camera.overexposed`. | no |

`ANALYZERS_OFF=camera-tamper,anpr-plates` switches the optional ones off. The scene analyzer cannot be removed.

**How results combine** (`mergeFields`): lists are joined without repeats; counts take the larger number per key; `isUnusual` is true if any says so (reasons
joined); the most severe `sentiment` wins; any other field takes the first non-empty value in registration order. Plates are settled by the scene
finalizer (`createSceneFinalizer`): ANPR when it answered (even with no plates), else Gemini's, then the watchlist check.

### Adding an analyzer

```ts
import type { Analyzer } from './server/analytics';

const zoneIntrusion: Analyzer = {
  id: 'zone-intrusion', label: 'Restricted zone', description: 'Flags people inside a drawn zone.',
  appliesTo: (camera) => !!camera.analyzers?.['zone-intrusion'],
  timeoutMs: 8000,
  async analyze({ camera, frame }) {
    const people = await myDetector(frame.jpeg, camera.analyzers!['zone-intrusion']);
    return people === 0 ? {} : { events: [{ type: 'zone.intrusion', severity: 'critical', summary: `Person in restricted zone at ${camera.name}`, data: { people } }] };
  },
};
```

Pass it as `extra` to `createDefaultPipeline` in `server.ts`. `tests/analytics.test.ts` ("a new detector added to the pipeline reaches a webhook alert through
the unchanged worker") does exactly this and follows the event through to a signed webhook.

Per-camera analyzer settings (`camera.analyzers`) are not yet read from the camera record; the field exists in the contract but the worker does not fill it.

## Events (`server/events/schema.ts`)

| Field | |
|---|---|
| `id` | Deterministic from user, camera, type, frame time and a dedupe key: a retried job produces the same id and the event is stored once. |
| `type` | `group.name`, lower case (`plate.read`, `zone.intrusion`). Rules can match a group with `plate.*`. |
| `source` | The analyzer that found it. |
| `severity` | `info`, `notice`, `warning`, `critical`. Default comes from the catalogue, else `info`. |
| `userId`, `cameraId`, `cameraName`, `department`, `location` | From the camera. |
| `ts`, `summary`, `data`, `confidence`, `tags` | The frame time, one line of text, type-specific JSON (max 20 KB), 0-1, up to 20 tags. |

Catalogue (`GET /api/event-types`): `plate.read`, `plate.watchlist_match`, `person.unknown`, `person.known`, `scene.unusual`, `scene.alert`, `analyzer.failed`,
`system.test`; the tamper analyzer adds `camera.*`. The Gemini/ANPR result is turned into events by `eventsFromLog`, so existing analysis feeds alerting without
changes. A draft that breaks the contract (bad type, no summary) is dropped with a warning; it never fails the frame.

## Rules and alerts (`server/events/`)

A **rule** says which events matter and where to send them:

```json
{
  "name": "Watchlist plates, night shift",
  "match": {
    "types": ["plate.watchlist_match"], "minSeverity": "critical",
    "departments": ["Traffic"], "cameraIds": [], "sources": [], "tags": [],
    "where": [{ "field": "data.plate", "op": "startsWith", "value": "GJ05" }, { "field": "confidence", "op": "gte", "value": 0.8 }]
  },
  "schedule": { "days": [1, 2, 3, 4, 5], "from": "22:00", "to": "06:00", "tzOffsetMin": 330 },
  "throttle": { "windowMs": 300000, "by": ["event"] },
  "channels": [{ "type": "webhook", "url": "https://soc.example.org/hook", "secret": "..." }, { "type": "log" }]
}
```

- **Conditions** (`where`): `eq neq in contains startsWith gt gte lt lte exists` on `data.<key>` or `type source severity cameraId cameraName department confidence summary`. All must hold.
- **Schedule**: days and a time window in the rule's time zone; `from` later than `to` is overnight, and the early-morning part belongs to the day the window started. It uses the time the event happened.
- **Throttle**: events with the same key fold into one alert while the window lasts (the window runs from the latest event). `by` chooses the key: `camera`, `type`, `event` (the same plate/person/text), `rule`. `windowMs: 0` alerts on every event.
- **Alert lifecycle**: `open` -> `acknowledged` -> `resolved`. New events fold into an open or acknowledged alert; after it is resolved the next one opens a new alert. A higher severity raises the alert, never lowers it.
- **Webhook**: JSON `{ alert, rule, event }`, `X-OmniSee-Signature: sha256=<HMAC of the body with the secret>`, `X-OmniSee-Event`, `X-OmniSee-Alert`. 10 s timeout; 5xx, 408, 429 and network errors are retried (after 1 s, then 4 s, three attempts); other refusals are not. Redirects are not followed. Addresses on private networks are refused unless `ALERT_WEBHOOK_ALLOW_PRIVATE=true`. Every attempt's result is stored on the alert.
- Secrets are never returned by the API (`********`); sending the placeholder back on an edit keeps the stored one.

### API (see `openapi.yaml`)

`GET /api/events`, `GET /api/event-types`, `GET|POST /api/alert-rules`, `PUT|DELETE /api/alert-rules/:id`, `POST /api/alert-rules/:id/test`, `GET /api/alerts`,
`POST /api/alerts/:id/acknowledge|resolve`. All act for the signed-in user (Firebase ID token) and only see that user's data.

**Searching events.** `GET /api/events` takes `q` (free text over the summary, camera name, type, source, tags and details such as a plate; case-insensitive, 100 characters),
`tag` (repeat for several; all must be present), `department` and `source` (these only narrow what the caller may already see), `type`, `minSeverity`, `from`/`to`,
`limit` (up to 500) and `cursor` for the next page: the answer carries `nextCursor` whenever a full page came back (pages join up exactly, even for events with the same time).
`count=1` adds `total`. `PUT /api/events/:id/tags` replaces an event's tags (operators and administrators; trimmed, lower-cased, at most 20); only events the caller may see can be tagged, and the access log records it.
Text search is a case-insensitive substring match (`ILIKE` in Postgres, with an index on tags and on time); it is not ranked and not a full-text index, which matters once the table is large.

**The Events tab** (`src/components/EventsTab.tsx`, `src/components/events/`) is the screen for all of this: Events (search, filters, detail, tags), Alerts (open / acknowledged / resolved, acknowledge and resolve),
Rules (list, create, edit, switch on or off, test, delete; a rule with a department is that department's) and Health (open alerts, regional gateways, department video systems). Guest mode has no events.

### Storage

Postgres when `DATABASE_URL` is set (tables `platform_events`, `alert_rules`, `alerts`, created on start; a Neon connection string works, with `DATABASE_SSL=true`), else memory (10,000 events and 5,000 alerts, lost on restart).

## Limits and what is not verified

- **Postgres store**: run against the project's Neon database on 2026-10-10 (`tests/alertStorePg.test.ts`, with `TEST_DATABASE_URL`): events stored once and filtered, rules and alerts owned per user, the engine folding 12 concurrent
  events into one alert, the event store's logs and plate sightings. **Not yet exercised:** the running server against Neon end to end, and several server instances at once. Check `GET /api/events` once on a deployed server.
- **Several server instances**: events are stored once (the id is the key), but repeat-folding is serialised inside one process, so two instances handling the same user's events at the same moment can each open an alert.
- **Channels**: webhook and log only. There is no e-mail or SMS channel; the `Channel` interface in `channels.ts` is where one goes.
- **The frame gate** skips unchanged scenes, so analyzers see only frames the gate lets through (a blocked camera is re-checked at the gate's heartbeat, 10 minutes by default).
- **Events from the browser loop** (cameras not analysed on the server) are not produced; only the server worker emits events.
- No screen in the app uses these yet; they are reachable through the API.
