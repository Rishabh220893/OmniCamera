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
