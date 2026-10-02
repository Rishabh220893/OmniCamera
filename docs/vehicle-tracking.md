# Vehicle tracking

Find a vehicle by plate, see where and when it was seen, and export the route. Lives in the **Analytics** tab ("Vehicle tracking"); the route is drawn on the **Map** tab.

## How it works

1. **Sightings are recorded permanently.** Every plate read — by the browser loop or the server worker — writes one `plateSightings` document (plate, camera, the camera's position at that moment, time, OCR confidence, source) and bumps a per-plate counter in `plateIndex`. Sightings are append-only (see `firestore.rules`), so route evidence can't be edited afterwards. Previously the route was rebuilt from the latest 100 log entries held in the browser, so a busy run lost older history.
2. **Exact matches build the route.** Searching `GJ01AB1234` (spaces/punctuation/case ignored) returns every sighting of exactly that plate.
3. **Possible matches are suggestions, never automatic.** Plates within one real edit — or up to two OCR-confusable swaps (0/O/Q/D, 1/I/L, 8/B, 5/S, 2/Z, 6/G, U/V) — are listed with *why* they are close ("digit 0 ↔ letter O at position 3") and the differing character highlighted. A person chooses **Same vehicle** (its sightings join the route, marked "includes look-alike") or **Different** (hidden). Decisions are saved per user, apply in both directions, and can be undone.
4. **The route** groups consecutive reads at one camera (within 5 min) into a single stop, then shows each leg between stops with distance and implied speed. Legs that are physically implausible are **flagged, not hidden**: faster than 160 km/h, or seen at two cameras far apart at the same moment — usually a misread or a different vehicle. Stops at cameras with no map location are listed but marked.
5. **Export route CSV** — one row per sighting: timestamp (UTC), camera, department, coordinates, plate as read, searched plate, exact/confirmed look-alike, OCR confidence, source, leg distance/speed, flags. Cells that look like spreadsheet formulas are neutralised.

## Guest mode

With no database, sightings are derived from the in-memory event log (≤100 entries), and match decisions last only for the session.

## Limits

- Sightings are recorded from this version onward; older logs are not back-filled. (Guest mode derives from whatever logs exist.)
- Possible matches are drawn from `plateIndex` (up to 5,000 distinct plates per user); an exact-plate search loads up to 2,000 sightings.
- The 160 km/h and 5-minute thresholds are defaults in `buildRoute`, not yet configurable in the UI.
- Possible-match scoring only knows the look-alike pairs above, and is not tuned on real footage.
- The Firestore rules for the new collections are **not** exercised by any test here (no emulator); verify them in your project before relying on them.
- CSV only. A PDF report is not built yet.
