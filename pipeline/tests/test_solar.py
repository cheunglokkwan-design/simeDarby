import geopandas as gpd
import pytest
from shapely.geometry import box

from solar_mapper.config import load_assumptions, load_township
from solar_mapper.solar import add_solar_potential, summarise_solar


@pytest.fixture(scope="module")
def a():
    return load_assumptions()


def sites(rows):
    defaults = {"building_name": None, "place_names": None, "land_use_name": None, "data_flags": "", "role": "candidate"}
    data = [{**defaults, **r} for r in rows]
    return gpd.GeoDataFrame(data, geometry=[box(0, 0, 1, 1)] * len(data), crs=32647)


def test_formula_matches_solar_demo(a):
    # solar-demo scoreSites: kwp = area * USABLE_FRACTION * panelDensity; kwh = kwp * specificYield
    s = add_solar_potential(sites([{"id": "x", "kind": "industrial", "footprint_m2": 10_000}]), a["solar"])
    r = s.iloc[0]
    assert r.usable_fraction == 0.75
    assert r.usable_roof_m2 == 7500
    assert r.system_kwp == pytest.approx(1350.0)  # 7500 m2 * 0.18 kWp/m2
    assert r.kwh_yr_unshaded == pytest.approx(1_822_500)  # 1350 kWp * 1350 kWh/kWp
    assert r.co2_t_yr_unshaded == pytest.approx(1381.46, abs=0.01)  # * 0.758 kg/kWh / 1000


def test_every_kind_has_a_usable_fraction(a):
    assert set(a["kinds"]) <= set(a["solar"]["usable_fraction"])


def test_unknown_kind_is_an_error(a):
    with pytest.raises(ValueError, match="no value for kinds"):
        add_solar_potential(sites([{"id": "x", "kind": "spaceport", "footprint_m2": 100}]), a["solar"])


def test_small_systems_are_flagged(a):
    s = add_solar_potential(
        sites(
            [
                {"id": "tiny", "kind": "landed_house", "footprint_m2": 20, "data_flags": "height_estimated"},
                {"id": "ok", "kind": "landed_house", "footprint_m2": 120},
            ]
        ),
        a["solar"],
    )
    assert s["data_flags"].tolist() == ["height_estimated;below_min_system", ""]


def test_display_name_fallbacks(a):
    s = add_solar_potential(
        sites(
            [
                {"id": "1", "kind": "retail", "footprint_m2": 100, "building_name": "Elmina Lakeside Mall"},
                {"id": "2", "kind": "commercial", "footprint_m2": 100, "place_names": "Kopi A; Bakery B"},
                {"id": "3", "kind": "industrial", "footprint_m2": 100, "land_use_name": "Elmina Crescent"},
                {"id": "4", "kind": "landed_house", "footprint_m2": 100},
            ]
        ),
        a["solar"],
    )
    assert s["display_name"].tolist() == [
        "Elmina Lakeside Mall",
        "Kopi A",
        "Industrial in Elmina Crescent",
        "Landed house",
    ]


def test_summary_splits_roles_and_ranks_top(a):
    s = add_solar_potential(
        sites(
            [
                {"id": "big", "kind": "industrial", "footprint_m2": 10_000},
                {"id": "small", "kind": "retail", "footprint_m2": 1_000},
                {"id": "home", "kind": "landed_house", "footprint_m2": 150, "role": "residential_programme"},
            ]
        ),
        a["solar"],
    )
    summary = summarise_solar(s, a["solar"], load_township("elmina"), top_n=1)
    assert summary["candidates"]["buildings"] == 2
    assert summary["candidates"]["system_kwp"] == round(1350 + 117)
    assert summary["residential_programme"]["buildings"] == 1
    assert [t["id"] for t in summary["top_candidates"]] == ["big"]
