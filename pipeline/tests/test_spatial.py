"""Spatial joins on small synthetic layers (metric CRS, no downloads)."""

import geopandas as gpd
import pytest
from shapely.geometry import Point, box

from solar_mapper.boundary import derive_boundary
from solar_mapper.buildings import land_use_context, places_context
from solar_mapper.classify import KindRules
from solar_mapper.config import load_assumptions

UTM = 32647


@pytest.fixture(scope="module")
def rules():
    return KindRules.from_assumptions(load_assumptions())


def land_use_layer():
    return gpd.GeoDataFrame(
        {
            "names": [{"primary": "Elmina"}, {"primary": "Elmina Crescent"}, {"primary": "Kanopi Residences"}],
            "class": ["residential", "industrial", "construction"],
            "subtype": ["residential", "developed", "construction"],
        },
        geometry=[box(0, 0, 1000, 1000), box(600, 600, 900, 900), box(100, 100, 200, 200)],
        crs=UTM,
    )


def test_smallest_informative_land_use_wins(rules):
    buildings = gpd.GeoDataFrame(
        geometry=[box(10, 10, 20, 20), box(700, 700, 750, 750), box(120, 120, 180, 180)], crs=UTM
    )
    ctx = land_use_context(buildings, land_use_layer(), rules)
    assert ctx["land_use_kind"].tolist() == ["landed_house", "industrial", "apartment"]
    assert ctx["land_use_source"].tolist() == ["land_use", "land_use", "land_use_name"]
    assert ctx["land_use_name"].tolist() == ["Elmina", "Elmina Crescent", "Kanopi Residences"]
    assert ctx["in_construction_zone"].tolist() == [False, False, True]


def test_building_outside_all_land_use(rules):
    ctx = land_use_context(gpd.GeoDataFrame(geometry=[box(5000, 5000, 5010, 5010)], crs=UTM), land_use_layer(), rules)
    assert ctx["land_use_kind"].isna().all()
    assert not ctx["in_construction_zone"].iloc[0]


def test_places_snap_to_nearest_building():
    buildings = gpd.GeoDataFrame(geometry=[box(0, 0, 10, 10), box(11, 0, 21, 10), box(100, 0, 110, 10)], crs=UTM)
    places = gpd.GeoDataFrame(
        {"names": [{"primary": "Cafe A"}, {"primary": "Shop B"}, {"primary": "Far"}], "basic_category": ["cafe", None, "bank"]},
        geometry=[Point(5, 5), Point(22, 5), Point(50, 50)],  # inside, 1 m outside, too far
        crs=UTM,
    )
    ctx = places_context(buildings, places, snap_m=3)
    assert ctx["place_categories"].tolist() == [["cafe"], [None], []]
    assert ctx["place_names"].fillna("").tolist() == ["Cafe A", "Shop B", ""]


def test_boundary_union_fills_holes():
    land_use = gpd.GeoDataFrame(
        {"names": [{"primary": "Elmina West"}, {"primary": "Elmina East"}, {"primary": "Denai Alam"}]},
        geometry=[
            box(0, 0, 1000, 1000).difference(box(400, 400, 600, 600)),  # park enclave as a hole
            box(1000, 0, 2000, 1000),
            box(5000, 5000, 6000, 6000),
        ],
        crs=UTM,
    ).to_crs(4326)
    geom, sources = derive_boundary(land_use.to_crs(UTM), "elmina", 0, UTM)
    assert sources == ["Elmina East", "Elmina West"]
    area = gpd.GeoSeries([geom], crs=4326).to_crs(UTM).area.iloc[0]
    assert area == pytest.approx(2_000_000, rel=1e-3)
