# Central Registry API

API-based onboarding for the OmniSee camera registry (Sentinel Mesh Model 1 — mandatory foundation). Intended for trusted server-to-server integrations that need to onboard, update, or remove cameras without going through the app UI.

## Status

Disabled by default. Every route returns `501 { "error": "Registry API is not configured..." }` until the server has:

- `FIREBASE_SERVICE_ACCOUNT` — a JSON string of a Firebase service account with Firestore access (see `.env.example`). This lets the server write to the registry with the Admin SDK, bypassing the per-user Firestore rules that govern normal app access.
- `REGISTRY_API_KEY` (recommended for any non-local deployment) — a shared secret. When set, every request must include it as the `X-Registry-Api-Key` header, or the API returns `401`.

## Authentication

```
X-Registry-Api-Key: <your shared secret>
```

## Data model

A camera record matches the `CameraConfig` shape used by the app (see `src/types.ts`), plus a server-assigned `id`. Registry-relevant fields:

| Field | Type | Notes |
|---|---|---|
| `name` | string | required |
| `department` | string | owning department |
| `ownership` | string | owning body / contractor |
| `cameraType` | `fixed \| ptz \| dome \| bullet \| other` | |
| `connectivityStatus` | `online \| offline \| degraded \| unknown` | |
| `maintenanceStatus` | `operational \| needs_maintenance \| decommissioned` | |
| `installDate` | string (ISO date) | used by the gap-analysis "ageing infrastructure" report |
| `storageDetails` | string | free text, e.g. "NVR local, 30-day retention" |
| `location` | `{ lat: number, lng: number }` | plots the camera on the Registry map |

Every write is recorded in the `registryAudit` collection (`source: "api"`), visible to Admin-role users in the app's Registry tab.

## Endpoints

### `GET /api/registry/cameras?userId=<uid>`
Lists every camera owned by `userId`.

```bash
curl -H "X-Registry-Api-Key: $KEY" \
  "https://your-deployment/api/registry/cameras?userId=abc123"
```

### `POST /api/registry/cameras`
Creates one camera.

```bash
curl -X POST -H "X-Registry-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "userId": "abc123",
    "name": "MG Road Junction",
    "department": "Traffic Police",
    "ownership": "Municipal Corporation",
    "cameraType": "ptz",
    "connectivityStatus": "online",
    "maintenanceStatus": "operational",
    "installDate": "2023-06-15",
    "storageDetails": "NVR local, 30-day retention",
    "location": { "lat": 12.9716, "lng": 77.5946 }
  }' \
  https://your-deployment/api/registry/cameras
```
Returns `201 { "id": "<new-doc-id>" }`.

### `PATCH /api/registry/cameras/:id`
Updates one or more fields on an existing camera. `userId` is required in the body and must match the camera's owner.

```bash
curl -X PATCH -H "X-Registry-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{ "userId": "abc123", "connectivityStatus": "offline" }' \
  https://your-deployment/api/registry/cameras/<camera-id>
```

### `DELETE /api/registry/cameras/:id?userId=<uid>`
Removes a camera and its future references. Audited as a `delete`.

```bash
curl -X DELETE -H "X-Registry-Api-Key: $KEY" \
  "https://your-deployment/api/registry/cameras/<camera-id>?userId=abc123"
```

## Bulk onboarding without the API

The Registry tab in the app also accepts a CSV upload (Admin accounts only) using the same field names as the table above (`lat`/`lng` instead of a nested `location`). See `docs/sample-cameras.csv` for a ready-to-import example — it's the same dataset the "Sample onboarded camera-metadata dataset" deliverable refers to.

## Errors

| Status | Meaning |
|---|---|
| `400` | Missing required field (`userId`, `name`, etc.) |
| `401` | Missing/incorrect `X-Registry-Api-Key` |
| `404` | Camera not found, or not owned by the given `userId` |
| `501` | Registry API not configured on this deployment |
