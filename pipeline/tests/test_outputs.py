"""Phase 1 exit criteria, checked against the committed processed layer."""

import geopandas as gpd
import pytest

from solar_mapper.config import load_township

PATH = load_township("elmina").processed_dir / "buildings.parquet"
pytestmark = pytest.mark.skipif(not PATH.exists(), reason="run `solar-mapper phase1` first")


@pytest.fixture(scope="module")
def b():
    return gpd.read_parquet(PATH)


def test_every_building_has_height_and_source(b):
    assert b["height_m"].notna().all() and (b["height_m"] > 0).all()
    assert b["height_source"].isin(["measured", "floors", "type_rule"]).all()
    assert b["height_confidence"].between(0, 1, inclusive="neither").all()


def test_roles_and_ids(b):
    assert b["role"].isin(["candidate", "residential_programme", "excluded"]).all()
    assert b["id"].is_unique
    assert (b["footprint_m2"] >= 15).all()


def test_geometry(b):
    assert b.crs.to_epsg() == 4326
    assert b.is_valid.all()
    assert b.geom_type.isin(["Polygon", "MultiPolygon"]).all()
