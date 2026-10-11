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

## Local detector (AI analysis off)

A camera with `aiAnalysis: false` (Settings > "Analyze with AI") is not sent to the model. The Gemini analyzer skips it and
`local-detector` (`server/analytics/localDetector.ts`) watches it instead, from the difference between two 64x36 greyscale frames:
`vms.motion`, `vms.intrusion` (movement inside a zone) and `vms.line_crossing` (movement on both sides of a line). The plate reader
(ANPR service) is independent of the switch, so `plate.*` events and watchlist hits still work. `camera.offline` and `camera.online`
come from the worker's run history (3 failed runs in a row, then the first good run), for every camera whatever the switch.

Optional per-camera settings, on the camera document: `analyzers: { 'local-detector': { zone: {x,y,w,h}, line: {x1,y1,x2,y2}, motionPercent } }`
(fractions of the picture). **Settings > a camera with "Analyze with AI" off** has a screen to draw them: pick *Draw zone* or *Draw line*, drag on a picture from the camera (or the grey frame when there is no stream), clear either, set the motion sensitivity, then press Save settings. Checked in the in-app browser (guest mode) and with tests (`tests/detectorZones.test.ts`, which also checks the saved settings against the server's own reader); not run against a real camera picture. Without a zone or line only motion is reported.

Limits: it cannot tell a person from a vehicle or a branch, cannot follow an object between frames, and frames arrive seconds apart, so
"line crossing" means movement touching the line from both sides. People, faces, scene and unusual-activity events need AI. `vms.alarm`
comes only from a recorder. Verified with synthetic fingerprints and a fake model (`tests/localDetector.test.ts`); never run on real footage.

## Grid guard and analysis status

**The problem it solves.** The camera grid caps how long one account may watch. Past the cap it refuses the account (HLS "watch time limit
reached", RTSP/WHEP "401 Unauthorized") for a cooldown it does not announce. Analysis used to keep asking, so a few dozen cameras at a
60 s interval could keep the account refused for hours, and every camera then showed "Could not capture a frame".

`server/gridGuard.ts` (used by the analysis worker's frame grab in `server.ts`):

- **Limit on grabs per minute**: `GRID_GRABS_PER_MIN` (default 10). A grab holds a grid session for several seconds, so this limits session
  time. Excess grabs wait their turn (up to 45 s) instead of failing; past that the camera is told "waiting its turn" and tries later.
- **Pause while refused**: a refusal (the HLS 403 text, or a 401 on the grid's RTSP) pauses every grid grab, 5 min at first and doubling on
  repeats up to 30 min (`HLS_COOLDOWN_MS` sets the base). Nothing is asked of the grid during the pause; analysis resumes by itself.
- **A pause is not a failure.** The camera's failure count does not grow, it is not reported offline, it does not back off, and the reason
  ("Paused: the camera grid is refusing this account...") is saved once on the camera (`lastAnalysisError`) so the screens can show it.
- **Shared state.** The pause and the recent grabs are kept in Redis when `REDIS_URL` is set, so the Health tab (served by another process
  than the worker that grabs) shows the real state and the limit holds across workers; without Redis they live in each process.
- `GET /api/grid/status` (needs `event.view`) returns `{ blocked, retryAfterSec, message, trips, refusals, lastRefusalAt, grabsLastMinute,
  grabsLastHour, limitPerMinute, store }`.

**What people see** (`src/lib/analysisStatus.ts`, one wording everywhere):

- Feed, right-hand camera list: under each ticked camera, "AI: Analysed 3 min ago", "Waiting for its first analysis", "Paused, resumes by
  itself" or "Not working right now" (hover for the reason and the last time it worked).
- Feed, "Ongoing context": the reason in plain words instead of an endless "Waiting for the first analysis".
- Events > Health, "AI analysis and the camera grid": whether the grid is refusing the account (and for how long), how much of the grab
  allowance is used, and a table of every camera that is or was analysed: working, waiting, paused or not working, last analysed, why.

**Limits.** The per-minute limit is a guess at a safe rate; the grid does not publish its allowance, so tune `GRID_GRABS_PER_MIN` by watching
the Health tab. A wrong password also answers 401 and is treated as a refusal (the pause then lasts minutes: correct the login and restart).
Only the analysis worker's grabs go through the guard; the live wall tiles and the playback proxy still use the account too, and the
guard learns of their refusals (they report to it) but does not limit them. Never run against a real over-limit account in a test: the
tests use a fake clock and a fake store.
