# Deployment guide

How to stand up every service so that the latest version works end to end. Do the sections in order; each ends with a check.

## 0. What runs where

| Service | What it does | Where it runs | Required? |
|---|---|---|---|
| **Firebase** (Auth + Firestore) | Sign-in, cameras, logs, plate sightings, rules | Google Firebase, project `omni-camera`, database `(default)` | Yes |
| **Main app** (Express server + React UI) | UI, camera proxies, Gemini analysis, server-side analysis worker, registry API | Render (or any Node host) | Yes |
| **Gemini API** | Scene analysis (people, vehicles, alerts) | Google AI | Yes |
| **ANPR service** | Licence-plate detection + reading | A machine you control (CPU or GPU), reached over HTTPS | Recommended (otherwise Gemini reads plates, less reliably) |
| **Cloudflare Tunnel** | Lets the main app reach the ANPR machine without opening ports | On the ANPR machine | Only if that machine has no public address |
| **Camera grid** (`cctv.corp8.cloud`) | The organiser's simulated camera feeds | Organiser | Yes (credentials needed) |
| **Google Sheets** | Optional log export | Google | No |

**Accounts you need:** Google/Firebase, Render (or another host), a Google AI Studio key, the grid's stream email + password, and — only if using the ANPR service — a GPU or CPU machine (+ optionally Cloudflare).

---

## 1. Firebase

1. **Project:** the app is wired to project `omni-camera` and database `(default)` (see `firebase-applet-config.json`, `.firebaserc`). If you use your own project, replace `firebase-applet-config.json` with your web-app config and update `.firebaserc`.
2. **Authentication:** Firebase console → *Authentication → Sign-in method* → enable **Google**. Then *Settings → Authorized domains* → add your app's domain (e.g. `your-app.onrender.com`) — sign-in fails on a domain that isn't listed.
3. **Firestore:** *Firestore Database* → create the database in the `(default)` database if it doesn't exist.
4. **Deploy the security rules** (required — the new collections `plateSightings`, `plateIndex`, `plateMatchDecisions` are blocked until you do; without them sightings silently fail to save and vehicle search stays empty):
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules --project omni-camera
   ```
   Note: the rules were reviewed but **never run against a real project or the emulator** — see check 1.6.
5. **Server (Admin) credentials** — needed for the registry API and the server-side worker: *Project settings → Service accounts → Generate new private key*. You'll paste the whole JSON as the `FIREBASE_SERVICE_ACCOUNT` value in step 3. Treat it as a secret; never commit it.

**Check:** sign in on the deployed app; create a camera; refresh — it persists. In the Firebase console the Rules tab shows the new `plateSightings` rule.

---

## 2. Gemini API key

Google AI Studio → *Get API key* → create a key → this is `GEMINI_API_KEY`. It is used only on the server (never sent to the browser).

---

## 3. Main app on Render

### 3a. Create the service

- **Blueprint (recommended):** *New + → Blueprint* → pick this repo; `render.yaml` defines a Node web service (`npm install --include=dev && npm run build`, start `npm start`).
- The server listens on `$PORT` when Render sets it (otherwise 3000). If a deploy ever reports "no open port detected", set `PORT` explicitly.

### 3b. Environment variables

| Variable | Required | Value / purpose |
|---|---|---|
| `GEMINI_API_KEY` | **Yes** | From step 2 |
| `STREAM_EMAIL`, `STREAM_PASSWORD` | **Yes (do this)** | The camera grid's credentials. Without them the server falls back to credentials **hard-coded in `server.ts`** — rotate that password with the organiser and set the new one here |
| `FIREBASE_SERVICE_ACCOUNT` | For registry API + server-side analysis | The service-account JSON from step 1.5 (whole JSON as one value) |
| `REGISTRY_API_KEY` | If `FIREBASE_SERVICE_ACCOUNT` is set | Make one up (`openssl rand -hex 32`); required header `X-Registry-Api-Key` for `/api/registry/*` and `/api/analysis/status` |
| `SERVER_ANALYSIS` | For server-side analysis | `true` (also needs `FIREBASE_SERVICE_ACCOUNT` + `GEMINI_API_KEY`) |
| `ANALYSIS_CONCURRENCY` | Optional | Parallel capture+analysis jobs (default 4). Rule of thumb: cameras × seconds per analysis ÷ interval (`docs/onboarding.md`) |
| `ANALYSIS_DISTRIBUTED` | Only with >1 instance | `true` on **every** instance (shared Firestore lease) |
| `ANALYSIS_LEASE_MS` | Optional | Lease length, default 120000; must exceed your slowest capture+analysis |
| `ANPR_SERVICE_URL` | For dedicated plate reading | `https://…` address of the ANPR service (step 4). Leave unset to use Gemini for plates |
| `ANPR_API_KEY` | With `ANPR_SERVICE_URL` | Same secret you gave the ANPR service |
| `ANPR_MIN_CONFIDENCE` | Optional | Drop plate reads below this (default 0.6) — tune on real footage |
| `ANPR_TIMEOUT_MS` | Optional | Per-call timeout (default 8000) |
| `GOOGLE_SHEETS_CREDENTIALS`, `GOOGLE_SHEETS_SPREADSHEET_ID` | Optional | Sheets export (step 6) |

### 3c. Plan matters for server-side analysis

The worker only runs while the server process is awake. Render's **free** web services spin down when idle (I believe after ~15 minutes without traffic), so with `SERVER_ANALYSIS=true` use an **always-on paid instance** — otherwise cameras stop being analysed whenever the app sleeps. Also confirm the instance has enough memory/CPU for ffmpeg at your `ANALYSIS_CONCURRENCY`.

### 3d. ffmpeg (required for server-side capture)

After the first deploy open `https://<your-app>/api/analysis/config`:

- `"ffmpeg": true` → fine.
- `"ffmpeg": false` → Render's Node runtime has no ffmpeg. Switch to the Docker build in the repo's `Dockerfile`: create (or edit) the web service with **Runtime = Docker**, Dockerfile path `./Dockerfile`, same environment variables. The Dockerfile has **not been built in my environment** (no Docker daemon) — check the first build log.

**Check:** `https://<your-app>/api/analysis/config` returns `{"enabled":true,"anpr":…,"ffmpeg":true}` (`enabled` is `true` only when `SERVER_ANALYSIS=true` and the Firebase + Gemini settings are present — look in the logs for `[ANALYSIS]` lines).

---

## 4. ANPR service (plate reading)

Pick one place to run it. All options use the same code; see `docs/anpr-service.md` for detail.

| Option | When |
|---|---|
| **CPU on your own machine/server** | Start here — the plate models are small and a CPU may be enough (measure first) |
| **Rented GPU** | If `scripts/check-anpr.mjs` shows the CPU is too slow for your camera count |

1. **Pick the API key:** `openssl rand -hex 32`. You'll set this same value on the service and on Render.
2. **Run it** (Docker shown; or `pip install -r requirements.txt` then `uvicorn anpr_service.main:app --host 0.0.0.0 --port 8000` from `anpr-service/`):
   - GPU: `docker build -t omnisee-anpr-gpu anpr-service && docker run -d --gpus all -p 127.0.0.1:8000:8000 -e ANPR_DEVICE=cuda -e ANPR_API_KEY=<key> -v anpr-models:/models omnisee-anpr-gpu`
   - CPU: `docker build --build-arg BASE=python:3.11-slim --build-arg REQS=requirements.txt -t omnisee-anpr anpr-service && docker run -d -p 127.0.0.1:8000:8000 -e ANPR_DEVICE=cpu -e ANPR_API_KEY=<key> -v anpr-models:/models omnisee-anpr`
   - First start downloads model weights (needs outbound internet). `ANPR_DEVICE=cuda` refuses to start if the GPU can't be used.
3. **Check locally:** `curl http://127.0.0.1:8000/healthz` → `"status":"ok"`, `"device":"cuda"` (or `"cpu"`), `"auth_required":true`.
4. **Expose it** with a Cloudflare Tunnel (below) or a public address.
5. **Connect Render:** set `ANPR_SERVICE_URL` and `ANPR_API_KEY`, redeploy.

### Cloudflare Tunnel for the ANPR machine

Full commands are in `docs/anpr-service.md` ("Exposing the GPU machine with a Cloudflare Tunnel"). Summary:

1. Bind the container to localhost only (`-p 127.0.0.1:8000:8000`, as above).
2. Install `cloudflared` on that machine.
3. **Quick tunnel (demo):** `cloudflared tunnel --url http://localhost:8000` → copy the `https://….trycloudflare.com` URL. It changes on every restart, so update `ANPR_SERVICE_URL` on Render each time.
4. **Named tunnel (stable URL; needs a Cloudflare account and a domain):** `cloudflared tunnel login` → `tunnel create` → `config.yml` pointing a hostname at `http://localhost:8000` → `tunnel route dns` → `tunnel run`.
5. The tunnel makes the service public: **`ANPR_API_KEY` is mandatory.**

**Check (from your own computer):**
```bash
ANPR_SERVICE_URL=https://<url> ANPR_API_KEY=<key> node scripts/check-anpr.mjs frame.jpg --cameras 50 --interval 60
```
It must show: reachable, the expected device, "API key accepted", plates in your frame, and a verdict on speed. Then on Render: `GET /api/analysis/status` (header `X-Registry-Api-Key`) → `anpr.healthy: true`.

**If it isn't set up / is down:** the app reads plates with Gemini instead (`plateSource: "gemini-fallback"`, shown as "unverified read"); after 3 consecutive failures it stops calling the service for a minute at a time.

---

## 5. Camera grid

1. Put the grid email/password in `STREAM_EMAIL` / `STREAM_PASSWORD` on Render (server paths: snapshots, server-side analysis, catalogue).
2. In the app: **Settings → stream access** — enter the same email/password (browser paths: live tiles, WHEP/HLS).
3. **Registry → Onboard grid cameras.** Read the banner: if it says the built-in list of 30 was used, the real catalogue wasn't reachable — recheck the credentials and run again.
4. To analyse on the server: **Registry → Analyze all on server** (button appears only when the worker is enabled), or per camera in Settings.

---

## 6. Optional: Google Sheets export

1. Google Cloud console → create a service account, enable the Sheets API, create a JSON key.
2. Create a spreadsheet and **share it with the service account's email** (editor).
3. Set `GOOGLE_SHEETS_CREDENTIALS` (the JSON) and `GOOGLE_SHEETS_SPREADSHEET_ID` on Render.
4. Browser-produced logs are appended; **server-produced logs are not** (not built).

---

## 7. Optional: more than one server instance

1. `ANALYSIS_DISTRIBUTED=true` on **every** instance, same Firestore project, same `FIREBASE_SERVICE_ACCOUNT`.
2. Keep instance clocks within a few seconds (normal NTP is fine).
3. Check `GET /api/analysis/status` on each: `distributed: true`, differing `instanceId`s, and `skippedClaims` rising on the one that loses races.

---

## 8. End-to-end verification (do in this order)

| # | Check | Expect |
|---|---|---|
| 1 | Open the app, sign in with Google | Lands in the app; camera persists on refresh |
| 2 | `/api/analysis/config` | `ffmpeg: true`; `enabled: true` if using the worker |
| 3 | Registry → Onboard grid cameras | Banner "Catalogue lists N cameras. N added…" (not the built-in-list warning) |
| 4 | Feed tab | Tiles go live |
| 5 | Registry → Analyze all on server (or per-camera toggle), wait one interval | New entries appear in the **Logs** tab without any browser tab doing the capture |
| 6 | Logs tab → Vehicle tracking → search a plate that was seen | Sightings, a route, and (if cameras have coordinates) legs with km and km/h. If nothing ever appears, the Firestore rules (1.4) are probably not deployed |
| 7 | `/api/analysis/status` (with registry key) | `anpr.healthy: true` and the expected device; `overdue`/`maxLagSeconds` near 0 |
| 8 | Route CSV export | Downloads `route-<PLATE>.csv` with source and flags columns |
| 9 | Stop the ANPR machine briefly | Analysis keeps working; new plate reads show "unverified read" |

---

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Google sign-in fails on the deployed site | The app's domain isn't in Firebase *Authorized domains* |
| Vehicle tracking is always empty | Firestore rules not deployed, or no plates were detected yet; check the browser console for permission errors |
| Onboarding warns it used the built-in list | Stream credentials wrong/missing, or the grid is unreachable from the server |
| `ffmpeg: false` | Use the Docker deploy (3d) |
| Cameras analysed far less often than their interval | `maxLagSeconds` growing → raise `ANALYSIS_CONCURRENCY` (or lengthen the interval / add an instance) |
| Plate reads all marked "unverified" | ANPR service unreachable or key mismatch; `/api/analysis/status` shows which |
| Server-side analysis stops overnight | The (free) Render instance went to sleep (3c) |
| Firestore bills grow | Each analysis writes a log, a camera update, sightings (and lease transactions if distributed); watch usage and lengthen the interval |

## 10. Security notes

- The "Admin" role is a profile field a user can set for themselves in Settings (pilot-scale stand-in, see `firestore.rules`) — not a real security boundary.
- Rotate the grid password that is hard-coded in `server.ts`; the old value stays in git history.
- Never commit `.env`, the Firebase service-account JSON, or API keys.
