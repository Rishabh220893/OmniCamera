import pytest

from anpr_service.plates import interpret_plate, mean_confidence, normalize_plate


def test_normalize_strips_and_uppercases():
    assert normalize_plate(" gj-01 ab·1234 ") == "GJ01AB1234"
    assert normalize_plate("") == ""


@pytest.mark.parametrize("raw", ["GJ01AB1234", "gj 01 ab 1234", "MH12A1234", "KA05MNP1234", "22BH1234AA", "DL1CAB1234", "DL1SAB1234"])
def test_valid_plates_are_untouched(raw):
    p = interpret_plate(raw)
    assert p.format_valid and not p.corrected
    assert p.text == normalize_plate(raw)


@pytest.mark.parametrize("misread,expected", [
    ("GJO1AB1234", "GJ01AB1234"),    # O in a digit slot
    ("GJ0IAB1234", "GJ01AB1234"),    # I in a digit slot
    ("GJ01ABI234", "GJ01AB1234"),    # I in a digit slot, number part
    ("GJ01AB123B", "GJ01AB1238"),    # B in a digit slot
    ("GJ01A81234", "GJ01AB1234"),    # 8 in a letter slot
    ("6J01AB1234", "GJ01AB1234"),    # 6 in a state-letter slot
])
def test_positional_repair(misread, expected):
    p = interpret_plate(misread)
    assert p.text == expected
    assert p.format_valid


def test_repair_limited_to_two_swaps():
    p = interpret_plate("GJOIA8123B")  # 4 confusions -> refuse
    assert not p.corrected and not p.format_valid
    assert p.text == "GJOIA8123B"


def test_unknown_state_is_not_repaired_into_validity():
    p = interpret_plate("XX01AB1234")
    assert not p.format_valid
    assert p.text == "XX01AB1234"


def test_non_indian_plate_passes_through_normalised():
    p = interpret_plate("ABC-1234")
    assert p.text == "ABC1234" and not p.format_valid and not p.corrected


def test_mean_confidence_ignores_padding_slots():
    mean, low = mean_confidence([0.9, 0.8, 0.7, 1.0, 1.0, 1.0], text_len=3)
    assert mean == pytest.approx(0.8)
    assert low == pytest.approx(0.7)
    assert mean_confidence(0.5, 4) == (0.5, 0.5)
    assert mean_confidence(None, 4) == (0.0, 0.0)
    assert mean_confidence([], 4) == (0.0, 0.0)
