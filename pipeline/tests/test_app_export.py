"""The pipeline -> web app contract: export shape and constants shared with src/solar.js."""

import re

import geopandas as gpd
import pytest
from shapely.geometry import Point, box

from solar_mapper.app_export import export_buildings, export_carparks, export_community
from solar_mapper.config import REPO_ROOT, load_assumptions

UTM = 32647


@pytest.fixture(scope="module")
def a():
    return load_assumptions()


def js_object(path, name) -> dict[str, str]:
    """Key/value pairs of a flat `const NAME = { ... }` object literal in a JS file."""
    src = (REPO_ROOT / path).read_text()
    body = re.search(rf"const {name} = \{{(.*?)\}};", src, re.S).group(1)
    body = re.sub(r"//[^\n]*", "", body)
    return dict(re.findall(r"(\w+):\s*([^,\n]+)", body))


def test_every_kind_maps_to_an_app_category(a):
    labels = js_object("src/heights.js", "CATEGORY_LABEL")
    for kind in a["kinds"]:
        assert a["app_export"]["category"][kind] in labels, kind


def test_usable_fractions_match_the_app(a):
    app = {k: float(v) for k, v in js_object("src/solar.js", "USABLE_FRACTION").items()}
    for kind, frac in a["solar"]["usable_fraction"].items():
        assert app[a["app_export"]["category"][kind]] == frac, kind


def test_solar_constants_match_the_app(a):
    app = js_object("src/solar.js", "DEFAULT_ASSUMPTIONS")
    s = a["solar"]
    assert float(app["specificYield"]) == s["specific_yield_kwh_per_kwp"]
    assert float(app["panelDensity"]) == s["panel_density_kwp_per_m2"]
    assert float(app["emissionFactor"]) == s["grid_emission_factor_kg_per_kwh"]


def test_export_buildings(a):
    sites = gpd.GeoDataFrame(
        [
            {
                "id": "b1", "display_name": "Elmina Lakeside Mall", "kind": "retail", "kind_source": "building_name",
                "height_m": 17.0, "storeys": 3, "height_source": "type_rule", "height_confidence": 0.45,
                "footprint_m2": 24775.3, "source_dataset": "OpenStreetMap", "data_flags": "height_estimated;type_inferred",
                "role": "candidate",
            }
        ],
        geometry=[box(101.5, 3.18, 101.501, 3.181)],
        crs=4326,
    )
    (b,) = export_buildings(sites, a["app_export"])
    assert b["category"] == "retail"
    assert b["heightSource"] == "Estimated from building type"
    assert b["dataFlags"] == ["height_estimated", "type_inferred"]
    assert b["polygon"][0] == b["polygon"][-1] and len(b["polygon"]) == 5
    assert b["tags"] == {"name": "Elmina Lakeside Mall"}


def test_export_carparks_keeps_surface_lots_inside_boundary(a):
    boundary = box(0, 0, 1000, 1000)
    infra = gpd.GeoDataFrame(
        {
            "id": ["surface", "multi", "tiny", "outside", "road"],
            "class": ["parking", "parking", "parking", "parking", "motorway"],
            "names": [None] * 5,
            "source_tags": [{"parking": "surface"}, {"parking": "multi-storey"}, {}, {}, {}],
        },
        geometry=[box(10, 10, 60, 60), box(100, 100, 200, 200), box(300, 300, 305, 305), box(2000, 0, 2100, 100), box(0, 0, 500, 20)],
        crs=UTM,
    ).to_crs(4326)
    out = export_carparks(infra, boundary, UTM, a["app_export"]["carparks"])
    assert [c["id"] for c in out] == ["surface"]
    assert out[0]["tags"] == {"parking": "surface"}


def test_export_community_dedupes_school_buildings(a):
    boundary = box(0, 0, 1000, 1000)
    places = gpd.GeoDataFrame(
        {
            "id": ["clinic", "cafe", "sk"],
            "names": [{"primary": "Klinik Elmina"}, {"primary": "Kopi"}, {"primary": "SK Elmina"}],
            "basic_category": ["health_care", "cafe", None],
        },
        geometry=[Point(100, 100), Point(200, 200), Point(500, 500)],
        crs=UTM,
    ).to_crs(4326)
    sites = gpd.GeoDataFrame(
        {"id": ["school-near-sk", "school-alone"], "display_name": ["SK Elmina block", "SJK (C) Regent"],
         "kind": ["education", "education"], "role": ["candidate", "candidate"]},
        geometry=[box(510, 510, 530, 530), box(800, 800, 850, 850)],
        crs=UTM,
    ).to_crs(4326)
    out = export_community(places, sites, boundary, UTM, a["app_export"]["community"])
    assert [c["name"] for c in out] == ["Klinik Elmina", "SK Elmina", "SJK (C) Regent"]
    assert out[1]["type"] == "community"  # matched by name, no category
    assert out[2]["type"] == "school"
