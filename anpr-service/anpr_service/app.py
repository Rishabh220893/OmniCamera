"""HTTP API: POST a JPEG/PNG, get back the license plates in it."""
import hmac
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Callable

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .engine import PlateEngine, build_default_engine

log = logging.getLogger("anpr")
MAX_IMAGE_BYTES = int(os.environ.get("ANPR_MAX_IMAGE_BYTES", str(12 * 1024 * 1024)))


def create_app(engine_factory: Callable[[], PlateEngine] = build_default_engine, api_key: str | None = None) -> FastAPI:
    key = api_key if api_key is not None else os.environ.get("ANPR_API_KEY") or None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if not key:
            log.warning("ANPR_API_KEY is not set: /v1/anpr accepts requests from anyone who can reach this "
                        "service. Fine on localhost; set a key before exposing it to the internet.")
        app.state.engine = engine_factory()  # loads models once, at startup
        yield

    app = FastAPI(title="OmniSee ANPR service", lifespan=lifespan)

    def require_key(x_anpr_key: str | None = Header(default=None)):
        if key and not (x_anpr_key and hmac.compare_digest(x_anpr_key, key)):
            raise HTTPException(status_code=401, detail="Missing or invalid X-ANPR-Key header")

    @app.get("/healthz")
    def healthz():
        engine: PlateEngine = app.state.engine
        return {"status": "ok", "device": engine.device, "auth_required": bool(key), **engine.description}

    # Inference runs in a worker thread so concurrent requests overlap on the
    # ONNX sessions instead of blocking the event loop.
    @app.post("/v1/anpr", dependencies=[Depends(require_key)])
    async def anpr(request: Request):
        body = await request.body()
        if not body:
            raise HTTPException(status_code=400, detail="Request body must be a JPEG or PNG image")
        if len(body) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail=f"Image larger than {MAX_IMAGE_BYTES} bytes")
        frame = cv2.imdecode(np.frombuffer(body, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(status_code=400, detail="Could not decode image")

        engine: PlateEngine = app.state.engine
        started = time.perf_counter()
        reads = await run_in_threadpool(engine.read, frame)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
        return {
            "plates": [
                {
                    "text": r.text, "raw_text": r.raw_text, "confidence": round(r.confidence, 4),
                    "min_char_confidence": round(r.min_char_confidence, 4),
                    "detection_confidence": round(r.detection_confidence, 4),
                    "bbox": list(r.bbox), "region": r.region,
                    "format_valid": r.format_valid, "corrected": r.corrected,
                }
                for r in reads
            ],
            "image": {"width": int(frame.shape[1]), "height": int(frame.shape[0])},
            "elapsed_ms": elapsed_ms,
            "device": engine.device,
        }

    return app
