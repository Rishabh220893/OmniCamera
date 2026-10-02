"""Plate detection + OCR engine (wraps fast-alpr) with explicit GPU selection."""
import logging
import os
from dataclasses import dataclass, field
from typing import Protocol, Sequence

import numpy as np

from .plates import interpret_plate, mean_confidence

log = logging.getLogger("anpr")


@dataclass(frozen=True)
class PlateRead:
    text: str
    raw_text: str
    confidence: float
    min_char_confidence: float
    detection_confidence: float
    bbox: tuple[int, int, int, int]
    region: str | None
    format_valid: bool
    corrected: bool


class PlateEngine(Protocol):
    device: str
    description: dict

    def read(self, frame_bgr: np.ndarray) -> list[PlateRead]: ...


def select_providers(device: str, available: Sequence[str]) -> list[str]:
    """Choose ONNX Runtime execution providers.

    `cuda` is strict: if the GPU provider isn't usable it raises instead of
    silently running on CPU, so a mis-built GPU image is noticed immediately.
    """
    device = device.lower()
    has_cuda = "CUDAExecutionProvider" in available
    if device == "cpu":
        return ["CPUExecutionProvider"]
    if device == "cuda":
        if not has_cuda:
            raise RuntimeError(
                "ANPR_DEVICE=cuda but ONNX Runtime has no CUDAExecutionProvider "
                f"(available: {list(available)}). Install fast-alpr[onnx-gpu] and a matching CUDA/cuDNN."
            )
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if device == "auto":
        return ["CUDAExecutionProvider", "CPUExecutionProvider"] if has_cuda else ["CPUExecutionProvider"]
    raise ValueError(f"ANPR_DEVICE must be auto, cuda or cpu (got {device!r})")


@dataclass
class FastAlprEngine:
    """Adapter from a fast_alpr.ALPR instance to PlateRead objects."""

    alpr: object
    device: str = "cpu"
    description: dict = field(default_factory=dict)

    def read(self, frame_bgr: np.ndarray) -> list[PlateRead]:
        reads: list[PlateRead] = []
        for result in self.alpr.predict(frame_bgr):  # type: ignore[attr-defined]
            ocr = result.ocr
            if ocr is None or not ocr.text:
                continue
            interpreted = interpret_plate(ocr.text)
            if not interpreted.text:
                continue
            mean, low = mean_confidence(ocr.confidence, len(ocr.text))
            box = result.detection.bounding_box
            reads.append(PlateRead(
                text=interpreted.text, raw_text=interpreted.raw_text,
                confidence=mean, min_char_confidence=low,
                detection_confidence=float(result.detection.confidence),
                bbox=(int(box.x1), int(box.y1), int(box.x2), int(box.y2)),
                region=ocr.region, format_valid=interpreted.format_valid, corrected=interpreted.corrected,
            ))
        return reads


def build_default_engine() -> FastAlprEngine:
    """Build the real engine from environment variables (downloads models on first run)."""
    import onnxruntime as ort
    from fast_alpr import ALPR

    requested = os.environ.get("ANPR_DEVICE", "auto")
    providers = select_providers(requested, ort.get_available_providers())
    on_gpu = providers[0] == "CUDAExecutionProvider"
    detector_model = os.environ.get("ANPR_DETECTOR_MODEL", "yolo-v9-t-640-license-plate-end2end")
    ocr_model = os.environ.get("ANPR_OCR_MODEL", "cct-s-v2-global-model")
    conf = float(os.environ.get("ANPR_DETECTOR_CONF", "0.4"))

    alpr = ALPR(
        detector_model=detector_model,  # type: ignore[arg-type]
        detector_conf_thresh=conf,
        detector_providers=providers,
        ocr_model=ocr_model,  # type: ignore[arg-type]
        ocr_device="cuda" if on_gpu else "cpu",
        ocr_providers=providers,
    )
    log.info("ANPR engine ready: detector=%s ocr=%s providers=%s", detector_model, ocr_model, providers)
    return FastAlprEngine(
        alpr=alpr, device="cuda" if on_gpu else "cpu",
        description={"detector": detector_model, "ocr": ocr_model, "providers": providers},
    )
