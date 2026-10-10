# Users, departments and camera allotment (federation plan A5, first part)

The existing demo is untouched: Google sign-in, **Bypass Login (Guest Demo)** and the existing administrator work exactly as before.
This adds a second way in and a way for an administrator to set up several departments on the same installation.

## What an administrator can do

In **Settings** (administrators only, not in the offline guest demo) a new section, *Users, departments & camera access*:

1. **Create departments** (a name such as `Traffic Police`). A department can be deleted only when it has no users and no cameras.
2. **Create people**: a username, a password (8+ characters), a role (Operator, Viewer or Admin) and a department. The administrator
   gives the person the username and password. Passwords can be reset, accounts disabled or deleted from the same table.
3. **Give cameras to a department**: pick the department, tick cameras (with a filter), *Give to department*; *Take back* removes them.

## What the people see

| Who | Signs in with | Sees |
|---|---|---|
| An administrator whose role is a claim, with no department listed (organisation-wide) | Google, or username + password | **Every camera, and the events, alerts and department rules of every department and of cameras that have none**, whoever owns them; they can acknowledge and resolve any alert. |
| An administrator with departments listed | as above | Every camera; the events, alerts and rules of the departments listed. |
| The existing demo administrator (role from the old self-set field, no claim) | Google, as now | **Every camera in the system**. Events and alerts on cameras they own, as before: the old field is not trusted to open other people's data. Give them a claim (`npm run set-role`) to see everything. |
| A person created by an administrator | **Username + password** (new form on the sign-in screen) | The cameras given to their department, nothing else; the events and alerts raised on those cameras, whoever registered them; they can acknowledge and resolve those alerts. Operators may also edit the department's cameras; Viewers only look. |
| Anyone else with Google or the guest demo | as now | As now. |

A person an administrator created never gets the starter camera that a new Google account gets; they have no cameras until some are given to their department.

## How it works

- **Username to account.** Firebase Auth identifies accounts by e-mail, so `rakesh.m` is stored as `rakesh.m@omnisee.local` (`src/lib/username.ts`; the sign-in form and the server use the same function). Nobody sees or uses that address.
- **Roles and departments** are Firebase custom claims on the account (`role`, `departments`), written by the server only (`server/admin/`), as in `docs/authz.md`. The account's `users/{uid}` document records `managed: true`, `username` and `departmentId` (also server-written; the rules refuse clients those fields).
- **Cameras.** A camera document gets `departmentId` (set only by an administrator through the server). The Firestore rules let it be read by its owner, any administrator, and members of that department; edited by the owner, an administrator, or a department Operator/Admin; deleted by an administrator. The app opens one query per source (all cameras for an administrator; own cameras plus one per department for everyone else) and merges them.
- **Events and alerts** carry the camera's department (`departmentId` when set), so `GET /api/events`, `GET /api/alerts` and acknowledge/resolve work by department for people whose department comes from a claim (`server/events`, rule in `eventScope` in `server/authz/policy.ts`). An account still on the old self-set role is not department-scoped, so nobody's existing view changed.
- **Alert rules per department.** `POST /api/alert-rules` with `"department": "Traffic"` makes the department's rule: it fires for every event on that department's cameras, whoever owns the camera, and its alerts are the department's (one alert per camera and window, whichever owner's events raise it). A department's operators and administrators list, edit, test and delete it; a viewer only lists it; a person can make rules only for departments they work for (an organisation-wide administrator: any). The rule's department cannot be changed. Personal rules work as before and still fire for the cameras a person owns. Stored with owner key `dept:<name>`, `createdBy` records who wrote it.
- **Faces, plates and logs per department** (`departmentId` on the Firestore documents). A person who works for exactly one department and may edit its data saves new faces for it (Operator or Admin) and new watchlist plates for it (Admin only), so everyone in the department sees them; anyone else saves for themselves as before (Settings says which). Logs carry the `departmentId` of their camera, so a department's members see the Feed history of its cameras. The analysis worker and regional gateways use the owner's faces and plates **plus** the camera's department's (department faces first; at most six faces go to the model). The rules (`firestore.rules`): members read; faces by Operators and Admins of the department, plates by Admins who cover it; a log's `departmentId` must equal the one on its camera's own document, so a log cannot be tagged into a department its camera is not in; sharing is fixed when a document is created. The rules are tested in the Firebase emulator (`npm run test:rules`).
- **API** (admin only, in the access log; see `docs/openapi.yaml`): `/api/admin/departments`, `/api/admin/users`, `/api/admin/cameras`, `/api/admin/cameras/allot`. Passwords are accepted on creation and reset and never returned or logged. An administrator cannot disable, demote or delete their own account through these routes. Only accounts created here can be changed here; the directory never touches Google accounts.

## To switch it on (one console setting)

In the Firebase console: **Authentication > Sign-in method > Email/Password > Enable**. Without it, creating a user fails with a message that says so and the sign-in screen says username sign-in "is not switched on for this project yet". Then deploy `firestore.rules` **together with** this build of the app (the app now sends the rules' new fields; the old rules would refuse the department queries).

The server needs Firebase Admin (`FIREBASE_SERVICE_ACCOUNT`), as for the rest of the admin features. Nothing else is configured.

## Not verified, and limits

- **Firebase.** Tested: the username mapping, all validation, the directory behaviour and every admin route (against an in-memory directory with the same behaviour), department-scoped events/alerts/rules end to end (store, engine, routes; the Postgres store against a real Postgres), the sign-in screen in a browser. The faces, watchlist and logs rules were run in the Firestore **emulator** (`tests/firestoreRules.test.ts`: department reads by equality query, who may write, tagging logs only with their camera's department, nothing private opened). **Not tested:** the Firebase Auth user creation, the claims taking effect after sign-in on a real project, the admin panel and the new face/plate/log listeners in a browser against Firebase, and Email/Password sign-in itself.
- A person's claims are read at sign-in; after an administrator changes their role or department they are signed out (tokens revoked) and see the change on the next sign-in. Cameras given or taken back appear at once.
- **An administrator who covers every department sees faces, plates and logs of their own** in the app; the all-department view of what happened is the events and alerts API. (An unfiltered Firestore query over everyone's faces cannot be allowed by the rules without exposing personal ones, so a server route would be needed.) An administrator with departments listed sees those departments' faces, plates and logs beside their own.
- **Plate sightings and the plate index** (Full Panel tracking) are still per-owner. A plate seen on a department's camera is in the department's events and logs, but the vehicle-search history belongs to the camera's owner.
- Server-side analysis of an allotted camera still runs under the owner's account (their Gemini quota); it now also uses the department's faces and plates.
- A person with several departments saves new faces and plates for themselves (there is no department picker yet); a department's documents can be read by all its members regardless.
- Existing faces, plates and logs have no `departmentId`: they stay personal until re-created for a department. Logs written before this change are not visible to the department.
- Nothing checks that the department named on a department rule exists; an organisation-wide administrator who mistypes a name makes a rule that never fires.
- Deleting a department's user does not remove cameras they registered themselves (they stay with their owner id). Renaming a department is not offered (its name is its id).
- No password policy beyond length, no forced change on first sign-in, no lockout other than Firebase's own throttling, no audit entry for *who gave which camera to whom* beyond the access-log line per call.
