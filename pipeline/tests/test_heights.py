import math

import pytest

from solar_mapper.config import load_assumptions
from solar_mapper.heights import estimate_height


@pytest.fixture(scope="module")
def a():
    return load_assumptions()


def est(a, height=None, floors=None, kind="landed_house", kind_source="overture_class"):
    return estimate_height(height, floors, kind, kind_source, a["kinds"], a["height_confidence"])


def test_measured_height_wins(a):
    h = est(a, height=24.0, floors=3)
    assert (h.height_m, h.source, h.confidence) == (24.0, "measured", 0.9)
    assert h.storeys == 7  # (24 - 2.0 roof) / 3.3 m per storey


def test_floor_count_next(a):
    h = est(a, floors=3, kind="commercial")
    assert h.source == "floors"
    assert h.height_m == pytest.approx(3 * 3.8 + 1.5)
    assert h.storeys == 3


def test_type_rule_fallback_with_confidence_by_kind_source(a):
    h = est(a, kind="industrial", kind_source="land_use")
    assert h.source == "type_rule"
    assert h.height_m == pytest.approx(11.5)
    assert h.confidence == 0.35


@pytest.mark.parametrize("missing", [None, math.nan, 0])
def test_missing_values_are_skipped(a, missing):
    assert est(a, height=missing, floors=missing).source == "type_rule"


def test_every_kind_and_kind_source_has_rules(a):
    kinds = a["kinds"]
    for kind in ["landed_house", "apartment", "industrial", "unknown"]:
        assert kind in kinds
    for source in a["height_confidence"]["type_rule"]:
        h = est(a, kind="unknown", kind_source=source)
        assert 0 < h.confidence < 1


def test_unknown_kind_falls_back_to_unknown_rule(a):
    assert est(a, kind="not_a_kind").height_m == est(a, kind="unknown").height_m
