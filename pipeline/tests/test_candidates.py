import pandas as pd
import pytest

from solar_mapper.candidates import CANDIDATE, EXCLUDED, PROGRAMME, assign_role, build_flags
from solar_mapper.config import load_assumptions
from solar_mapper.spotcheck import score_sheet


@pytest.fixture(scope="module")
def rules():
    return load_assumptions()["candidates"]


@pytest.mark.parametrize(
    "kind, roof, expected",
    [
        ("industrial", 5000, (CANDIDATE, "")),
        ("unknown", 900, (CANDIDATE, "")),
        ("apartment", 1500, (CANDIDATE, "")),
        ("industrial", 40, (EXCLUDED, "roof_too_small")),
        ("minor", 5000, (EXCLUDED, "minor_structure")),
        ("landed_house", 1500, (PROGRAMME, "")),
    ],
)
def test_assign_role(rules, kind, roof, expected):
    assert assign_role(kind, roof, rules) == expected


def test_flags():
    assert build_flags("measured", "industrial", "overture_class", "OpenStreetMap", False, False) == ""
    flags = build_flags("type_rule", "unknown", "size", "Google Open Buildings", True, True).split(";")
    assert flags == ["height_estimated", "type_unknown", "tag_overridden", "ml_footprint", "construction_zone"]
    assert "type_inferred" in build_flags("type_rule", "retail", "land_use", None, False, False)


def test_score_sheet_counts_only_filled_rows():
    sheet = pd.DataFrame({"storeys": [2, 2, 3, 1], "observed_storeys": [2, 4, "", 1]})
    assert score_sheet(sheet) == {
        "checked": 3,
        "within_tolerance": 2,
        "share_within_tolerance": 0.667,
        "mean_abs_storey_error": 0.67,
    }
