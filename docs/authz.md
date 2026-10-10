# Roles, departments and the access log (gap G8)

Before this, "admin" was a field a user could write on their own profile, and the app wrote `role: 'admin'` on every new
account. Anyone who signed in was an admin. Now a role is a Firebase **custom claim**, which only someone holding the
service account can set.

## Roles

| Role | Can |
|---|---|
| `viewer` | See cameras, events, alerts and alert rules. |
| `operator` | Also edit cameras, acknowledge and resolve alerts, manage their alert rules, start tracking jobs. |
| `admin` | Everything: delete cameras, assign a camera to a gateway, manage gateways, change playback profiles, use the camera adapters (ONVIF, Hikvision, Dahua), read the access log. |

The full table is `server/authz/policy.ts` (`PERMISSIONS`, `GRANTS`); every route asks for a named permission, so there is one
place to change it. An account with a claim `departments: ["traffic"]` is limited to that department's cameras for the
`camera.*`, `event.*` and `alert.*` permissions. An admin with no departments covers all of them (`"*"`). Platform-wide
permissions (gateways, adapters, profiles, users, the access log) ignore departments.

## Giving someone a role

```bash
npm run set-role -- someone@example.org operator traffic water
npm run set-role -- chief@example.org admin
npm run set-role -- --show someone@example.org
```

Needs `FIREBASE_SERVICE_ACCOUNT` (the script also reads `.env.local`, `demo.local`, `scale.local`). The person has to sign in
again. With `AUTHZ_CHECK_REVOKED=true` the server also refuses tokens issued before the change (one extra network call per
request; without it a changed role applies when the token refreshes, within an hour).

## Migration (nothing is locked out on day one)

1. **Accounts without a claim** keep working through the old self-set `role` on their user document: `admin` stays admin,
   anything else is an operator. The server logs one warning per such account. This fallback is on by default.
2. Give the people who matter a claim (`set-role`). A claim always wins over the old field, so an account with a
   `viewer` claim cannot raise itself by editing its own document.
3. `npm run set-role -- --legacy` lists accounts that still rely on the old field; `--legacy --apply` removes the field from
   accounts that already have a claim.
4. When every real account has a claim, set `AUTHZ_LEGACY_ROLE=false` on the server. An account with no claim is then a
   viewer. (The Firestore rules' fallback to the stored field stops mattering once step 3 has removed the fields.)

Changes that come with this:

- `firestore.rules`: nobody can write `role` on their own user document any more; `isAdmin()` accepts the claim, or (only when
  there is no claim) the stored field. **Deploy the rules together with the new app build**: the old app wrote `role` on every
  save and would be refused.
- The app no longer writes `role` and no longer lets a user pick it in Settings (it shows the role read-only). **New accounts
  are operators, not admins**: they can no longer manage the watchlist or delete cameras until someone gives them `admin`.
- Fixed on the way: the events and alerts API stripped the token with a broken pattern (`Bearers+`), so with real sign-in every
  call was refused with 401. All routes now share one token parser.

## Access log

Refusals (wrong role, wrong department, bad or missing token) and every use of a sensitive permission (viewing events and
alerts, handling alerts, tracking, rules, adapters, profiles, gateways, deleting or reassigning cameras, reading the log) are
recorded with who, what, when, the route and the department. They are kept in memory (last 2,000, `GET /api/access-log`, admin
only, `?uid=&allowed=&limit=`) and, when Firestore is configured, saved in batches to the `accessLog` collection (only the
server writes it; the rules deny all client access). If Firestore is unreachable the queue holds 5,000 entries and then drops
the oldest; the response says how many were dropped.

## Not done / not verified

- **Not run against Firebase.** The claims, `set-role`, the batched Firestore log and the new rules were never run (no emulator
  or project in the test environment). The policy, token handling, fallbacks, routes and log queue are tested with fakes
  (`tests/authz.test.ts`). Test the rules in the emulator before deploying them.
- **Department scoping of stored data** is built for cameras, events, alerts, alert rules, faces, the watchlist and logs
  (`docs/admin-users.md`; the rule for who sees which events is `eventScope` in `server/authz/policy.ts`: claims only, '*' means
  every department). Not yet: plate sightings and the plate index, views and searches in the access log.
- Views of camera video, searches in the app and exports are not in the access log (they do not pass through these routes, or
  go straight to Firestore from the browser).
- The registry API (`/api/registry/*`) still uses the shared `REGISTRY_API_KEY`, not a person.
- No screen to manage users or read the access log. No OIDC / single sign-on (Firebase only).
