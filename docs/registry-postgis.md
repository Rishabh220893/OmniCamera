# Registry spatial store: PostgreSQL + PostGIS (Model 1)

Model 1 suggests PostgreSQL + PostGIS for the registry. This is built as a **mirror**: Firestore stays the system of record, and a copy of the cameras is kept in PostGIS for the
questions Firestore cannot answer (bounding box, spatial indexes, uncovered zones in the database). It is **off by default** and **fails soft**.

## Why a mirror and not the only store

The app's own screens (add, edit, delete, bulk import, the grid) write cameras straight to Firestore from the browser, under per-user and per-department security rules, and read them back
through live listeners. Making PostGIS the only store would mean rewriting every one of those paths and replacing the rules with server code; that is a migration, not a switch, and it is
the one thing here that could break a working app. A mirror gets the spatial store without touching any of them.

| | Firestore (record) | PostGIS (mirror) |
|---|---|---|
| Written by | The app, the registry API, adapters | The server only, by following Firestore |
| Read by | The app (live), the registry API when the mirror is not healthy | The registry API (`/api/registry/cameras`, `/api/registry/gaps`) while healthy |
| If it is down | The app does not work (as before) | Nothing visible changes: reads fall back to Firestore |

## Turning it on

`REGISTRY_POSTGIS=true`, `DATABASE_URL` (and `DATABASE_SSL=true` for Neon), and the registry API already configured (`FIREBASE_SERVICE_ACCOUNT`). The database role must be allowed to run
`CREATE EXTENSION postgis` (Neon allows it). On start the server, in the background and without delaying start-up, creates the table and indexes (`registry_cameras`, `server/registry/postgis.ts`
`REGISTRY_DDL`), then listens to the Firestore `cameras` collection: the first snapshot is the full copy, later changes are applied in order (upsert, delete) in batches of 400.

`GET /api/registry/status` (registry API key) says whether it is ready, how many rows, the last sync, the error count and the last error.

## What it guarantees (and what tests it)

- **Reads fall back.** `GET /api/registry/cameras` uses PostGIS only while the mirror is ready: initialised, first copy complete, fewer than 3 failures in a row. Any error, or any state other than that, reads Firestore exactly as before. (`tests/registryPostgis.test.ts`: not ready before init and before the first copy; falls back after 3 failures; recovers on a good write.)
- **A bad document does not stop the mirror.** A malformed location, date or text becomes a null column rather than failing the batch. A camera without coordinates is stored without a point.
- **No SQL injection.** Every value is a bound parameter; `LIKE` wildcards in a search are escaped. (Tested with hostile input.)
- **The listener recovers.** A Firestore listener error re-subscribes after 15 s; a mirror that could not prepare its table stays off and does not retry against the database.
- **Off means off.** With the flag unset, no code path touches Postgres for the registry. With the flag set but no `DATABASE_URL` or no Firebase Admin, the server logs one line and starts normally (checked by booting the real server this way).

## Endpoints

- `GET /api/registry/cameras?userId=&bbox=&department=&status=&type=&q=&installedBefore=&format=json|geojson|csv`: the same answer from either store.
- `GET /api/registry/gaps?userId=&radius=300&department=`: uncovered zones computed in the database (a square grid in the area's UTM projection, distance measured on the sphere), the same result shape as the Registry screen's gap report. `503` when the mirror is not ready; the screen computes the same report in the browser.
- `GET /api/registry/status`.

## What is NOT verified

The unit tests use a fake database and a fake Firestore listener. **No real PostGIS database has run this code**: the DDL, the upsert with `ST_GeogFromText`, the bounding-box and filter query, and the
`ST_SquareGrid` gap query are untested against PostGIS. Run the check before turning the flag on:

```
DATABASE_URL=postgres://... DATABASE_SSL=true npm run registry-postgis-check -- --yes
```

It may run `CREATE EXTENSION IF NOT EXISTS postgis`, creates a scratch schema `registry_check_<random>` with the table, writes 5 sample cameras there, checks 11 behaviours (listing, filters, bounding box, update and delete, the gap query, status) and drops the schema, also when a check fails. Without `--yes` it only prints what it would do. `ST_SquareGrid` needs PostGIS 3.1 or newer.

Also unverified: the Firestore listener on a real collection (the first snapshot of tens of thousands of cameras is held in memory while it is applied), drift between the two stores after a long outage of the mirror (a restart re-copies everything; there is no incremental catch-up), and how it behaves under the production read load.

## If something goes wrong

Unset `REGISTRY_POSTGIS` and restart: the server behaves as it did before this was added. The `registry_cameras` table can be dropped at any time; it is rebuilt from Firestore on the next start.

The SQL in `docs/registry-postgis.sql` shows the queries in readable form, for planners and GIS staff.
