import cv2
import numpy as np
import pytest
from fast_alpr import ALPR
from fast_alpr.base import BaseDetector, BaseOCR, OcrResult
from fastapi.testclient import TestClient
from open_image_models.detection.core.base import DetectionResult

from anpr_service.app import create_app
from anpr_service.engine import FastAlprEngine, select_providers


class StubDetector(BaseDetector):
    def __init__(self, boxes):
        self.boxes = boxes

    def predict(self, frame):
        return [DetectionResult.from_detection_data(b, 0.93, "license_plate") for b in self.boxes]


class StubOCR(BaseOCR):
    def __init__(self, outputs):
        self.outputs = list(outputs)

    def predict(self, cropped):
        return self.outputs.pop(0)


def make_engine(boxes, outputs):
    # The real ALPR class (crop + detector/OCR plumbing), with stand-in models.
    return FastAlprEngine(alpr=ALPR(detector=StubDetector(boxes), ocr=StubOCR(outputs)), device="cpu",
                          description={"detector": "stub", "ocr": "stub", "providers": ["CPUExecutionProvider"]})


def jpeg(w=320, h=200):
    ok, buf = cv2.imencode(".jpg", np.full((h, w, 3), 127, dtype=np.uint8))
    assert ok
    return buf.tobytes()


def test_engine_maps_results_and_repairs_text():
    engine = make_engine(
        [(10, 20, 110, 60), (200, 100, 300, 150)],
        [OcrResult("GJO1AB1234", [0.9, 0.9, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 1.0, 1.0], region="India", region_confidence=0.8),
         None],
    )
    reads = engine.read(np.zeros((200, 320, 3), dtype=np.uint8))
    assert len(reads) == 1, "plates with no OCR result are dropped"
    r = reads[0]
    assert (r.text, r.raw_text, r.corrected, r.format_valid) == ("GJ01AB1234", "GJO1AB1234", True, True)
    assert r.bbox == (10, 20, 110, 60)
    assert r.detection_confidence == pytest.approx(0.93)
    assert r.min_char_confidence == pytest.approx(0.5)
    assert r.region == "India"


def test_api_returns_plates_and_image_info():
    engine = make_engine([(5, 5, 90, 40)], [OcrResult("MH12AB3456", 0.88)])
    with TestClient(create_app(lambda: engine, api_key="")) as client:
        res = client.post("/v1/anpr", content=jpeg(), headers={"Content-Type": "image/jpeg"})
        assert res.status_code == 200
        body = res.json()
        assert body["plates"][0]["text"] == "MH12AB3456"
        assert body["plates"][0]["confidence"] == pytest.approx(0.88)
        assert body["image"] == {"width": 320, "height": 200}
        assert body["device"] == "cpu" and body["elapsed_ms"] >= 0
        health = client.get("/healthz").json()
        assert health["status"] == "ok" and health["providers"] == ["CPUExecutionProvider"]


def test_api_no_plates_is_an_empty_list_not_an_error():
    with TestClient(create_app(lambda: make_engine([], []), api_key="")) as client:
        res = client.post("/v1/anpr", content=jpeg())
        assert res.status_code == 200 and res.json()["plates"] == []


def test_api_key_enforced_on_inference_not_health():
    engine = make_engine([], [])
    with TestClient(create_app(lambda: engine, api_key="s3cret")) as client:
        assert client.post("/v1/anpr", content=jpeg()).status_code == 401
        assert client.post("/v1/anpr", content=jpeg(), headers={"X-ANPR-Key": "nope"}).status_code == 401
        assert client.post("/v1/anpr", content=jpeg(), headers={"X-ANPR-Key": "s3cret"}).status_code == 200
        assert client.get("/healthz").status_code == 200


def test_api_rejects_bad_input():
    with TestClient(create_app(lambda: make_engine([], []), api_key="")) as client:
        assert client.post("/v1/anpr", content=b"").status_code == 400
        assert client.post("/v1/anpr", content=b"not an image").status_code == 400


def test_provider_selection():
    cpu_only = ["AzureExecutionProvider", "CPUExecutionProvider"]
    gpu = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert select_providers("cpu", gpu) == ["CPUExecutionProvider"]
    assert select_providers("auto", cpu_only) == ["CPUExecutionProvider"]
    assert select_providers("auto", gpu) == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert select_providers("cuda", gpu) == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    with pytest.raises(RuntimeError, match="CUDAExecutionProvider"):
        select_providers("cuda", cpu_only)  # strict: never silently fall back to CPU
    with pytest.raises(ValueError):
        select_providers("tpu", gpu)
