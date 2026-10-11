# Video walls: layouts and session control (gap A10)

Feed > **Control Wall**. A **wall** is a named display (a control-room screen); everyone attached to it sees the same layout, one person at a time controls it.
Code: `src/lib/wallLayout.ts` (presets, geometry, validation, tours; shared by server and screen), `server/wall/{service,routes}.ts`,
`src/components/WallView.tsx`, `src/lib/wallApi.ts`. Tests: `tests/wall.test.ts` (9). Built 2026-10-11 (session 5).

## What it does

| Piece | How it works |
|---|---|
| **Layouts** | Presets 1×1, 2×2, 3×3, 4×4, 1+5, 1+7, 2+8, or a custom grid (up to 8 × 6). Each cell holds a camera or is empty. A saved layout is private to its owner until **shared** with a department; owners (and administrators of the department) change or delete it. |
| **Tours** | A layout can page through up to 500 cameras: a new group (as many as there are cells) every 5 to 3600 s. The group is worked out from the time the layout was set, so every screen on the wall shows the same group. |
| **Walls** | Made by administrators (`user.manage`): name, optional department, `maxViewers` (default 10), `maxLiveTiles` (default 12). A wall with a department is seen only by people of that department; one without is for everyone. |
| **Viewers** | Any number up to `maxViewers`; 429 beyond. A viewer only watches. |
| **One controller** | Needs `camera.edit` (operator and above). A second operator is told who has control (409). Control needs a heartbeat every ~15 s (the screen does it) and runs out after 45 s without one, so a closed laptop does not hold a wall. A person's own second tab replaces their first session. An **administrator can take control by force.** |
| **Live cap** | At most `maxLiveTiles` cells play live (and never more than the media server's own `maxLiveTiles`); the others show refreshed stills. Protects the browser and the camera grid's per-account watch limit. |
| **Audit** | Attach, take, force, release, expiry, layout changes and wall configuration are listed per wall (`GET /api/walls/:id/audit`, administrators; the last 300 in memory). |

Sessions are leases in the same usage store as the federation sessions (`docs/federation-service.md`): with `FEDERATION_STORE=redis` the viewer cap and the single-controller rule hold across server processes. Walls and layouts are in `<VMS_DATA_DIR or .data>/walls.json` (mode 0600). `WALL_ENABLED=false` switches it off.

## Routes

`GET|POST /api/wall-layouts`, `PUT|DELETE /api/wall-layouts/:id`; `GET|POST /api/walls`, `GET|PATCH|DELETE /api/walls/:id`;
`POST /api/walls/:id/sessions` (`{mode: 'viewer'|'controller', force?}`), `POST .../sessions/:sid/heartbeat`, `DELETE .../sessions/:sid?mode=`;
`PUT /api/walls/:id/layout` (`{sessionId, layoutId}` or `{sessionId, spec}`; controller only); `GET /api/walls/:id/audit`. Details at the top of `server/wall/routes.ts`.

## Verified and not verified

- Tested: geometry (cell counts, no overlaps), validation, tours, layout visibility and ownership, wall visibility by department, viewer cap, single controller, expiry, forced takeover, audit, restart, and every status code over real HTTP.
- Screen: opened in the in-app browser against a real dev server with the wall API **mocked in the page** (guest mode has no administrator): took control, switched to 2 × 2, assigned a camera (the simulated feed played). **Not run against a signed-in administrator, a second person, or the real camera grid.**
- The Redis path for sessions is the same unrun Redis store.
- **A layout does not give access to video.** It holds camera ids; a person who cannot see a camera sees "not available to you". The media server's shared viewer password is still the only video gate (A21).
- Viewers learn of a change on their next heartbeat (up to 15 s), not instantly (no push channel yet).
- No screen to rename or delete walls, to set departments or limits, or to read the audit (API only); no drag-to-resize cells; no per-wall cap on a person's own sessions; no pushing a wall to a separate physical display controller.
