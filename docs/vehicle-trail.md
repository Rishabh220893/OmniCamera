# Statewide vehicle trail (gap A18) and plate sightings per department

Events > **Vehicle trail**. Search a plate and see every camera and department that read it, in order, with the distance, time and speed between
cameras, and the legs that cannot be right. Code: `server/trail/{trail,routes}.ts` (built on the shared event store), `src/components/events/TrailView.tsx`,
`src/lib/trailApi.ts`; the route maths is the existing pure code in `src/lib/plateTracking.ts`. Tests: `tests/vehicleTrail.test.ts` (6), the Firestore rules test (7). Built 2026-10-11 (session 5).

## How it works

- Every producer (the analysis worker, gateways, department systems, webhooks, federation clients) emits `plate.read` events with the plate, the camera, its department and its position.
  The trail is those events for one plate, in time order, so a plate read by Traffic and by Police is **one trail** (`GET /api/trail/:plate`).
- **Stops and legs.** Reads at one camera within 5 minutes are one stop. Each leg between stops has a distance (great circle between the cameras), the time, the speed and flags:
  `implausible_speed` (over 160 km/h: a misread or two vehicles), `simultaneous` (two distant cameras at the same moment), `no_location` (a camera has no position).
- **Look-alikes.** Plates one OCR edit away (0/O, 1/I, 8/B and so on) are *suggested*, never merged. A person adds one ("Same vehicle: add to trail", `also=` in the API, at most 5) and its reads join the trail marked as a confirmed look-alike.
- **Evidence.** `format=csv` gives one row per sighting (time, camera, department, position, plate read, confidence, leg figures and flags), spreadsheet-safe.
- **Plate list.** `GET /api/trail/plates` lists the plates read in the period, busiest first, with cameras and departments, filterable by `q`.
- **Period.** 1 to 90 days (default 7, the planning window for cross-department evidence).

## Who sees what

Same scope as the Events tab: an organisation-wide administrator sees every department; someone with departments sees their own; others see their own cameras. **A department you do not cover that
also read the plate is shown as a count only** ("also read in Excise (3)"), never where or when. Look-alike suggestions come from plates in your view.

## Plate sightings per department (the older, per-user store)

The browser tracker in Analytics (`VehicleTracker`) uses the Firestore `plateSightings`, which were per owner. Now a sighting carries the `departmentId` of its camera (stamped by the worker and the app),
`firestore.rules` lets members of that department read it (a person can stamp only a department they work for; administrators any), and the tracker searches the person's departments too.
Verified in the Firebase emulator (`npm run test:rules`). The per-user `plateIndex` (the pool of look-alikes) is still per owner; the new trail takes its look-alikes from the shared events.
Sightings written before this change have no department and stay per owner.

## Verified / not verified

- Tested on the in-memory event store and real HTTP; the screen was opened in the in-app browser with the trail API **mocked in the page** (guest mode): list, route map with a flagged leg, stops and legs, other-department count, look-alike add.
- **Not run:** on the Postgres store with real events, with signed-in department users, or on real plate reads.
- Limits: plate reads are read newest first, 500 at a time, up to 20,000 per query (a longer period says it was cut short). The count of reads in other departments uses the store's text search on the plate, so a read stored with spaces in the plate may be missed.
- A trail shows where a plate was *read*, not where the vehicle went between cameras; gaps are not proof of absence. A flagged leg needs a person to look at the pictures. Face and AFIS/NAFIS matching are not part of it.
- No map tiles: the route is drawn on a plain projection (cameras numbered in order). A tile map would need an outside service and a key.
