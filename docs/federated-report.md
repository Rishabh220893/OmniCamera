# Federated analytics report (gap A26)

Events > **Report**. Every department's events side by side, and what only shows when they are looked at together. Code: `server/reports/federated.ts`
(figures, CSV, printable page), `server/reports/routes.ts`, `src/components/events/ReportView.tsx`, `src/lib/reportApi.ts`. Tests: `tests/federatedReport.test.ts` (6). Built 2026-10-11 (session 5).

## What is in it

| Part | Content |
|---|---|
| Headline | Events, cameras reporting, systems reporting, incidents (and how many cross departments), events by severity |
| Departments | Per department: events, by severity, most common types, busiest cameras, plate reads, last event, the systems that reported and when; **video held** (the department's retention and storage, and how many events in the period are already older than that: the video behind them is probably gone) |
| Across departments | Incidents by kind, open, and crossing departments; **plates read by more than one department** |
| Systems reporting | Each source (analyzers, connectors, webhooks, gateways), its events, its departments, its last event: a quiet system stands out |
| When | Events by hour of day (in the viewer's time zone) and by day |
| Limits | A list of what the report cannot say, printed with it |

Formats: the screen, **Printable report** (one self-contained HTML page with no scripts or outside files, served with a locked-down Content-Security-Policy; print it or save it as PDF from the browser), and **CSV** (one row per department; a cell that starts like a spreadsheet formula is prefixed so it shows as text).

## Who sees what

Same rules as the Events tab and incidents (`docs/admin-users.md`, `docs/incidents.md`):
- an organisation-wide administrator sees every department in detail;
- someone with departments sees those in detail, and **every other department as a name and an event count, nothing more** (the count is the only use of an unscoped read);
- a **plate read in several departments is named only when every department that read it is one the viewer covers**; otherwise it appears as "hidden (another department)";
- someone with no department sees their own cameras' events; their cameras that were given to a department show under it.

## API

`GET /api/reports/federated` (permission `event.view`): `days` (1 to 90, default 7, the planning window for cross-department evidence in `docs/federation-plan.md`) or `from` and `to` (at most 90 days apart);
`department` (one you cover, else 403); `tz` (minutes ahead of UTC, default 330); `format=json|csv|html`.

## Not verified, and limits

- Computed on request from the event and incident stores: events are read newest first, 500 at a time, **up to 20,000 per report**; a longer period says it is cut short and covers the newest events only. Heavy use would want SQL aggregates (a Postgres query per figure) and a cache; not built.
- Tested on the in-memory stores and real HTTP. **Not run on the Postgres stores, on real department data, or in the browser** (the screen type-checks; it was not opened).
- The incident figures come from the incident store's newest 200 incidents in scope.
- It counts stored events, not what the cameras saw; a department whose system sends nothing looks quiet. Video retention figures are the departments' own stated numbers (Settings > departments), not measured.
- Not built: scheduled or e-mailed reports, comparison with the previous period, a PDF written by the server (the browser prints the page), per-camera detail beyond the top five.
