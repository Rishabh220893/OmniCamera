"""
Reference inference service for OmniSee (docs/inference-service.md). It implements the contract in server/analytics/remoteInference.ts:

  POST /v1/infer   { image: <base64 JPEG>, tasks: ["person","vehicle","face"] }
                   -> { model, ms, detections: [{label, score, box:[x,y,w,h] in 0..1}], faces: [{box, score, embedding}] }
  GET  /health     -> { status, model, device }

*** NOT RUN. *** This file was written without a GPU, the models or the packages installed on the machine it was written on; nothing in it has been
executed. The platform's side of the contract is tested against a mock server (tests/inferenceAnalyzers.test.ts); this is the other side, as a starting
point for whoever runs it on a GPU host. Expect to fix small things on first start.

Environment: INFERENCE_API_KEY (Bearer token; unset = open, only for a closed network), INFERENCE_MODEL (default yolov8n.pt), INFERENCE_DEVICE (cpu | cuda:0),
INFERENCE_FACES (on | off, default off), INFERENCE_MAX_IMAGE_MB (default 8).
"""
import base64
import os
import time

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

MODEL_NAME = os.environ.get("INFERENCE_MODEL", "yolov8n.pt")
DEVICE = os.environ.get("INFERENCE_DEVICE", "cpu")
API_KEY = os.environ.get("INFERENCE_API_KEY", "")
FACES_ON = os.environ.get("INFERENCE_FACES", "off").lower() == "on"
MAX_BYTES = int(float(os.environ.get("INFERENCE_MAX_IMAGE_MB", "8")) * 1024 * 1024)

# COCO classes we report, under the labels the platform counts.
PERSON = {"person"}
VEHICLES = {"car", "truck", "bus", "motorcycle", "bicycle"}

app = FastAPI(title="OmniSee inference service")
_detector = None
_faces = None


def detector():
    global _detector
    if _detector is None:
        from ultralytics import YOLO  # imported late so /health can answer while the weights download
        _detector = YOLO(MODEL_NAME)
    return _detector


def face_model():
    global _faces
    if _faces is None:
        from insightface.app import FaceAnalysis
        _faces = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider" if DEVICE.startswith("cuda") else "CPUExecutionProvider"])
        _faces.prepare(ctx_id=0 if DEVICE.startswith("cuda") else -1, det_size=(640, 640))
    return _faces


class InferRequest(BaseModel):
    image: str
    tasks: list[str] = ["person", "vehicle"]


def check_key(authorization: str | None):
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="bad key")


@app.get("/health")
def health(authorization: str | None = Header(default=None)):
    check_key(authorization)
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE, "faces": FACES_ON}


@app.post("/v1/infer")
def infer(req: InferRequest, authorization: str | None = Header(default=None)):
    check_key(authorization)
    started = time.time()
    try:
        raw = base64.b64decode(req.image, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="image is not base64")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="image too large")
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="image is not a picture")
    h, w = img.shape[:2]

    wanted = set()
    if "person" in req.tasks:
        wanted |= PERSON
    if "vehicle" in req.tasks:
        wanted |= VEHICLES
    detections = []
    if wanted:
        result = detector().predict(img, device=DEVICE, verbose=False, conf=0.25)[0]
        names = result.names
        for b in result.boxes:
            label = names[int(b.cls)]
            if label not in wanted:
                continue
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0])
            detections.append({"label": label, "score": float(b.conf), "box": [x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h]})

    faces = []
    if "face" in req.tasks and FACES_ON:
        for f in face_model().get(img):
            x1, y1, x2, y2 = (float(v) for v in f.bbox)
            faces.append({"box": [x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h], "score": float(f.det_score), "embedding": [float(v) for v in f.normed_embedding]})

    return {"model": MODEL_NAME + ("+insightface" if FACES_ON else ""), "ms": int((time.time() - started) * 1000), "detections": detections, "faces": faces}
