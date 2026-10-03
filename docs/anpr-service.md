# ANPR service (plate detection + OCR)

Gemini reading plates off a frame is a general vision model guessing at small, blurry text; it can return plausible plates that are not there. `anpr-service/` replaces that with a dedicated plate **detector** (YOLOv9) and plate **OCR** model, via the open-source [`fast-alpr`](https://github.com/ankandrew/fast-alpr) library, run as a small separate HTTP service. The same code runs on CPU or NVIDIA GPU.

```
Node server ── POST JPEG ──▶ anpr-service ──▶ [{ text, confidence, bbox, ... }]
 (analyzeFrame)                (detector → OCR → Indian-plate correction)
```

## What it does

- `POST /v1/anpr` — body is a raw JPEG/PNG; returns every plate found with `text`, `raw_text`, OCR `confidence` (mean over the characters actually read) and `min_char_confidence`, detector confidence, `bbox`, `format_valid`, `corrected`.
- `GET /healthz` — status and the device in use (`cuda` / `cpu`), so you can confirm the GPU is really being used.
- **Indian plate correction** (`anpr_service/plates.py`): positional fix of look-alike characters (`GJO1AB1234` → `GJ01AB1234`). Conservative: only applied if the result fits the layout, has a real state code and needed ≤2 swaps; otherwise the raw text is returned untouched. `raw_text` is always kept.
- `ANPR_DEVICE=cuda` is **strict** — it refuses to start without a working CUDA provider rather than silently running on CPU. `auto` uses the GPU if available.

## How the Node server uses it

Set `ANPR_SERVICE_URL` (and `ANPR_API_KEY`). `analyzeFrame` — shared by the browser route and the server-side worker — then calls the ANPR service **in parallel** with Gemini:

| Situation | Plates reported |
|---|---|
| ANPR answered | ANPR's plates only, **even if none** (Gemini's guesses are ignored) |
| ANPR configured but failed/timed out | Gemini's plates, `plateSource: "gemini-fallback"` |
| ANPR not configured | Gemini's plates, as before |

Reads below `ANPR_MIN_CONFIDENCE` (default 0.6) are dropped. Each log now stores `plateReads` (plate, confidence, format_valid, corrected) and `plateSource`. The watchlist comparison ignores spaces/punctuation on both sides. `GET /api/analysis/status` reports the ANPR service's health and device.

## Running it

```bash
cd anpr-service
pip install -r requirements.txt            # CPU
# pip install -r requirements-gpu.txt      # NVIDIA GPU (CUDA 12 + cuDNN 9)
ANPR_API_KEY=choose-a-secret ANPR_DEVICE=auto uvicorn anpr_service.main:app --host 0.0.0.0 --port 8000
```

Model weights download on first start (needs outbound internet to GitHub). Docker: see the `Dockerfile` header for the GPU and CPU builds (GPU needs the NVIDIA container toolkit on the host).

Environment: `ANPR_DEVICE` (`auto`|`cuda`|`cpu`), `ANPR_API_KEY`, `ANPR_DETECTOR_MODEL` (default `yolo-v9-t-640-license-plate-end2end`), `ANPR_OCR_MODEL` (default `cct-s-v2-global-model`), `ANPR_DETECTOR_CONF` (0.4), `ANPR_MAX_IMAGE_BYTES`.

Then on the main server: `ANPR_SERVICE_URL=https://<where-it-runs>`, `ANPR_API_KEY=<same secret>`.

## Every-session checklist (ANPR on your own PC through a quick tunnel)

Do this each time you want plate reading with the dedicated service. If you skip it, the app still works and reads plates with Gemini (shown as "unverified").

**Start**

1. **Window A, the service:**
   ```powershell
   cd C:\Users\Risha\OmniCamera\anpr-service
   .\.venv\Scripts\Activate.ps1
   $env:ANPR_API_KEY = "<your ANPR key>"; $env:ANPR_DEVICE = "cpu"
   python -m uvicorn anpr_service.main:app --host 127.0.0.1 --port 8000
   ```
   Wait for `Application startup complete`. Leave the window open.
2. **Window B, the tunnel:** `cloudflared tunnel --url http://localhost:8000`, then copy the `https://….trycloudflare.com` address it prints. **It is new every time.** Leave the window open.
3. **Check it:** `curl.exe https://<that address>/healthz` shows `"status":"ok"`.
4. **Render:** your app service, Environment, set `ANPR_SERVICE_URL` to the new address (no trailing slash), Save. It redeploys in a couple of minutes. `ANPR_API_KEY` stays the same unless you changed it.
5. **Confirm:** `https://<your app>/api/analysis/config` shows `"anpr":true`, and `/api/analysis/status` (with your registry key) shows `anpr.healthy: true`.

**Stop**

- Press Ctrl+C in both windows. Nothing else is needed: an old `ANPR_SERVICE_URL` left on Render simply fails, and after 3 failures the app stops calling it for a minute at a time and reads plates with Gemini.

**Only the address changes each time.** To stop updating it: a named Cloudflare tunnel (needs a domain on Cloudflare), an ngrok fixed address, a rented machine with a fixed address, or the service running as its own always-on Render service.

## The API key (`ANPR_API_KEY`)

**It has nothing to do with the GPU.** It is a shared password that stops strangers from using your ANPR service (and its compute). You invent it — there is nothing to sign up for.

```bash
openssl rand -hex 32        # or any long random string
```

Set the **same value in two places**: on the ANPR service (`ANPR_API_KEY`) and on the main server (`ANPR_API_KEY`, next to `ANPR_SERVICE_URL`). It is sent as the `X-ANPR-Key` header.

| Situation | What happens |
|---|---|
| Key set on both, same value | Normal operation. |
| **No GPU** | Same as above — run the service on CPU (`ANPR_DEVICE=cpu`) and still set a key if it is reachable from the internet. |
| Service has **no key** (unset) | It accepts anyone and logs a warning at startup. Acceptable only on localhost / a private network. If it is reachable from the internet, anyone who finds the URL can use it. |
| Key set on the service, **missing or different on the main server** | Every ANPR call gets a 401. Analysis does **not** stop: plates silently fall back to Gemini (`plateSource: "gemini-fallback"`, shown as "unverified read" in vehicle tracking and in the CSV `Source` column). `GET /api/analysis/status` reports `anpr.healthy: false` with *"rejected the API key"* (it does a real authenticated test call; `/healthz` alone cannot detect this). |
| `ANPR_SERVICE_URL` **unset** (no ANPR service at all) | Gemini reads plates, exactly as before this feature. |

**Fallback plan, in order of preference:** (1) ANPR service on a GPU; (2) ANPR service on CPU — your laptop or any server; (3) no ANPR service — Gemini reads plates (less reliable; reads are labelled so they are not mistaken for dedicated-OCR reads).

## How a rented GPU connects to the app

A rented GPU is just **a remote computer that runs the ANPR service**. The app never "knows" about the GPU; it only calls a URL.

```
 camera feeds ──▶ main app / server (Render etc.) ──HTTPS + X-ANPR-Key──▶ ANPR service on the rented GPU
                          ▲                                                  (plate detector + OCR on the GPU)
                          └──────────── plates + confidence ─────────────────┘
```

**No application code changes are needed after you rent one — only configuration.** The same service code runs on CPU and GPU; `ANPR_DEVICE=cuda` selects the GPU, and the main app only needs two settings: `ANPR_SERVICE_URL` and `ANPR_API_KEY`.

### Step by step

1. **Rent a machine with an NVIDIA GPU and Docker** (a "GPU pod/instance" from a provider; pick any current card — the models are small, so a cheap one is plenty). Note its public address or the HTTPS URL the provider gives you for a port.
2. **Start the service on it** (it downloads the model weights on first start, so it needs outbound internet):
   ```bash
   git clone <your repo> && cd <repo>/anpr-service
   docker build -t omnisee-anpr-gpu .
   docker run -d --gpus all -p 8000:8000 \
     -e ANPR_DEVICE=cuda -e ANPR_API_KEY=<your secret> \
     -v anpr-models:/models omnisee-anpr-gpu
   ```
   `ANPR_DEVICE=cuda` is strict: if the GPU can't be used it **refuses to start with a clear error** instead of silently running slowly on CPU. If that happens (CUDA/driver mismatch), fix it or set `ANPR_DEVICE=auto`/`cpu` to carry on.
3. **Make port 8000 reachable** from the main app: open the port in the provider's console, or use the provider's HTTPS proxy URL, or a Cloudflare tunnel. Prefer HTTPS — the key travels in a header.
4. **Check it from your own machine** (no code changes, just this script):
   ```bash
   ANPR_SERVICE_URL=https://<host-or-url> ANPR_API_KEY=<your secret> \
     node scripts/check-anpr.mjs frame.jpg --cameras 50 --interval 60
   ```
   It reports the device actually in use, whether the key works, the speed on a **real frame** (use one from your cameras), and whether that is enough for your camera count.
5. **Point the main app at it:** set `ANPR_SERVICE_URL` and `ANPR_API_KEY` on the main server (e.g. Render) and redeploy. Confirm with `GET /api/analysis/status` → `anpr.healthy: true`, `anpr.device: "cuda"`.
6. **When you're done, stop or delete the rented machine** — it bills while it exists. After that, either unset `ANPR_SERVICE_URL`, or leave it: the app detects repeated failures, stops calling the dead service for a minute at a time (so frames aren't each delayed by the timeout), and reads plates with Gemini meanwhile (`plateSource: "gemini-fallback"`).

### Exposing the GPU machine with a Cloudflare Tunnel

A tunnel lets the main app reach the ANPR service over HTTPS **without opening any port** on the rented machine: `cloudflared` on the GPU machine makes an outbound connection to Cloudflare, and Cloudflare forwards requests to it.

**1. Start the service so only the tunnel can reach it** (bind to localhost, don't publish the port):

```bash
docker run -d --gpus all -p 127.0.0.1:8000:8000 \
  -e ANPR_DEVICE=cuda -e ANPR_API_KEY=<your secret> -v anpr-models:/models omnisee-anpr-gpu
curl http://127.0.0.1:8000/healthz        # on the GPU machine: should show "device": "cuda"
```

**2. Install `cloudflared` on the GPU machine** (Linux/Debian-based; see Cloudflare's docs if your distro differs):

```bash
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb        # no sudo/root? download the plain binary from the same releases page instead
cloudflared --version
```

**3a. Quick tunnel — fastest, no Cloudflare account, good for a demo:**

```bash
cloudflared tunnel --url http://localhost:8000
```

It prints a URL like `https://random-words.trycloudflare.com`. Keep that process running (`nohup … &` or `tmux`). **The URL changes every time you restart it**, so you must update `ANPR_SERVICE_URL` on the main server (and redeploy) each time. Cloudflare positions quick tunnels for testing, with no uptime guarantee.

**3b. Named tunnel — stable URL, needs a free Cloudflare account and a domain on Cloudflare:**

```bash
cloudflared tunnel login                              # opens a browser link to authorise
cloudflared tunnel create omnisee-anpr                # prints a tunnel ID and writes a credentials file
cloudflared tunnel route dns omnisee-anpr anpr.example.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /root/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: anpr.example.com
    service: http://localhost:8000
  - service: http_status:404
```

```bash
cloudflared tunnel run omnisee-anpr                   # or: sudo cloudflared service install  (runs at boot)
```

(Alternatively create the tunnel in the Cloudflare dashboard under *Zero Trust → Networks → Tunnels* and paste the install command it gives you; menu names change, so follow Cloudflare's current docs.)

**4. Test it from anywhere, then connect the app:**

```bash
curl https://<your-tunnel-url>/healthz
ANPR_SERVICE_URL=https://<your-tunnel-url> ANPR_API_KEY=<your secret> node scripts/check-anpr.mjs frame.jpg
```

Then set `ANPR_SERVICE_URL=https://<your-tunnel-url>` (no trailing path) and `ANPR_API_KEY` on the main server and redeploy.

Notes: the tunnel makes the service **public on the internet**, so `ANPR_API_KEY` is your only protection — always set it. The app sends only the `X-ANPR-Key` header, so Cloudflare Access service-token protection in front of the tunnel is not supported without a code change. If the machine or tunnel goes down the app falls back to Gemini after a few failures (see above).

### What I could and could not verify

- Verified: the service, the app's calls to it, the key handling, the failure fallback and the check script — all against a stand-in model on CPU.
- **Not verified:** the GPU Docker image, `onnxruntime-gpu` + CUDA/cuDNN compatibility on a real card, the real model weights, and real speed/accuracy. The first GPU run is where any of that would show up — `scripts/check-anpr.mjs` and the strict `ANPR_DEVICE=cuda` are there so a problem is visible immediately.

## Where to run it (GPU)

The main app on Render's free plan has no GPU, so this runs elsewhere and the Node server calls it over HTTPS. **Always set `ANPR_API_KEY` when the service is reachable from the internet.**

| Option | Cost | Notes |
|---|---|---|
| Your own machine (CPU, or an NVIDIA GPU if you have one) + a Cloudflare quick tunnel (`cloudflared tunnel --url http://localhost:8000`) | Free, no account needed for quick tunnels | Good for demos; only up while your machine is on |
| Google Colab free tier (T4 GPU) + a tunnel | Free | GPU not guaranteed, sessions are cut off after a while, and serving through a tunnel may be restricted by Colab's terms. Short demos only |
| Hourly GPU rental (RunPod, Vast.ai, Lambda, etc.) | Paid; typically cents to under a dollar per hour for a T4/L4/RTX-class card — check current prices | Needs an account and payment method. Rent only for test/demo day |
| Serverless GPU (e.g. Modal) | Pay per second; some plans include monthly free credits — check current offers | Needs an account; cold starts add latency |
| Cloud VM with GPU (AWS/GCP/Azure) | Paid | GPU quota requests can take time |

You do not need a GPU to start: with the sampling interval this app uses (one frame per camera every few seconds to a minute) the models are small enough that a CPU may keep up for ~50 cameras. **This has not been measured** — every response includes `elapsed_ms`, so run it on your target machine against the real feeds and decide from that.

## Limits

- Accuracy depends on camera resolution, angle and lighting, and on the pretrained OCR model's coverage of Indian plates. It has **not** been evaluated on the hackathon feeds — measure on real footage and tune `ANPR_MIN_CONFIDENCE`.
- The service reads plates, it does not track vehicles; matching a plate across cameras and building routes is a separate step.
- Watchlist matching is exact (after normalisation). Near-miss matching is not implemented, deliberately, to avoid false alerts.
- The GPU Docker image and `onnxruntime-gpu`/CUDA compatibility are untested here; the provider selection is unit-tested and `ANPR_DEVICE=cuda` fails loudly if the GPU isn't usable.
