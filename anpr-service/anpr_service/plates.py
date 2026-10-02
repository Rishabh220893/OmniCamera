"""Plate-text normalisation and Indian-format correction (pure functions).

OCR models confuse look-alike characters (0/O, 1/I, 8/B, 5/S ...). Indian
registration plates have a rigid layout, so a misread can often be repaired
by position:

    SS D{1,2} L{1,3} NNNN  e.g. GJ 01 AB 1234, DL 1S AB 1234  (state, district, series, number)
    YY BH NNNN L{1,2}      e.g. 22 BH 1234 AA   (Bharat series)

Correction is deliberately conservative: it only returns a changed string if
the result fits the layout, uses a real state/UT code, and needed at most
`MAX_SUBSTITUTIONS` swaps. Otherwise the normalised raw text is returned
untouched, so non-Indian or unreadable plates are never "repaired" into
something plausible but wrong.
"""
import re
from dataclasses import dataclass

# Valid RTO state / union-territory codes.
STATE_CODES = frozenset(
    "AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS UK UP WB".split()
)

MAX_SUBSTITUTIONS = 2

_TO_DIGIT = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8", "G": "6"}
_TO_LETTER = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G"}

# Anything matching this with a real state code is accepted as-is and never
# "repaired" (e.g. Delhi's DL1SAB1234 must not become DL15AB1234).
_STANDARD_RE = re.compile(r"^[A-Z]{2}(?:0[1-9]|[1-9]\d?)[A-Z]{1,3}\d{4}$")
# Repairs assume the common two-digit district layout.
_TWO_DIGIT_RE = re.compile(r"^[A-Z]{2}\d{2}[A-Z]{1,3}\d{4}$")
_BH_RE = re.compile(r"^\d{2}BH\d{4}[A-Z]{1,2}$")


def normalize_plate(text: str) -> str:
    """Uppercase and keep only A-Z / 0-9."""
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


@dataclass(frozen=True)
class PlateText:
    text: str          # corrected if a safe correction exists, else normalised raw
    raw_text: str      # normalised OCR output, before correction
    format_valid: bool  # fits an Indian layout with a real state code (after correction)
    corrected: bool


def _fits(text: str) -> bool:
    if _BH_RE.match(text):
        return True
    return bool(_STANDARD_RE.match(text)) and text[:2] in STATE_CODES


def _repair_standard(text: str) -> str | None:
    """Positional repair for the standard layout; None if it can't fit."""
    n = len(text)
    if not 9 <= n <= 11:
        return None
    series_len = n - 8
    # (index range, wanted class) for each position
    wanted = ["L"] * 2 + ["D"] * 2 + ["L"] * series_len + ["D"] * 4
    out, swaps = [], 0
    for ch, kind in zip(text, wanted):
        if kind == "L":
            if ch.isdigit():
                ch = _TO_LETTER.get(ch, ch)
                swaps += 1
        else:
            if ch.isalpha():
                ch = _TO_DIGIT.get(ch, ch)
                swaps += 1
        out.append(ch)
    candidate = "".join(out)
    if swaps > MAX_SUBSTITUTIONS or not _TWO_DIGIT_RE.match(candidate) or candidate[:2] not in STATE_CODES:
        return None
    return candidate


def interpret_plate(raw: str) -> PlateText:
    normalised = normalize_plate(raw)
    if _fits(normalised):
        return PlateText(normalised, normalised, True, False)
    repaired = _repair_standard(normalised)
    if repaired is not None:
        return PlateText(repaired, normalised, True, True)
    return PlateText(normalised, normalised, False, False)


def mean_confidence(confidence: float | list[float] | None, text_len: int) -> tuple[float, float]:
    """(mean, min) over the characters actually read.

    The OCR returns one probability per character *slot*; slots beyond the
    plate's length are padding, so they are excluded rather than inflating
    the score.
    """
    if confidence is None:
        return 0.0, 0.0
    if isinstance(confidence, (int, float)):
        c = float(confidence)
        return c, c
    values = [float(v) for v in confidence[: max(text_len, 1)]]
    if not values:
        return 0.0, 0.0
    return sum(values) / len(values), min(values)
