"""Exit criteria, checked against the committed processed layers of every township."""

import json

import geopandas as gpd
import pytest

from solar_mapper.app_export import APP_DATA_DIR
from solar_mapper.config import CONFIG_DIR, load_township

TOWNSHIPS = sorted(p.stem for p in (CONFIG_DIR / "townships").glob("*.yaml"))


def processed(slug, name):
    path = load_township(slug).processed_dir / name
    if not path.exists():
        pytest.skip(f"run `solar-mapper run --township {slug}` first")
    return path


@pytest.mark.parametrize("slug", TOWNSHIPS)
def test_buildings_layer(slug):
    b = gpd.read_parquet(processed(slug, "buildings.parquet"))
    assert b["height_m"].notna().all() and (b["height_m"] > 0).all()
    assert b["height_source"].isin(["measured", "floors", "type_rule"]).all()
    assert b["height_confidence"].between(0, 1, inclusive="neither").all()
    assert b["role"].isin(["candidate", "residential_programme", "excluded"]).all()
    assert b["id"].is_unique
    assert (b["footprint_m2"] >= 15).all()
    assert b.crs.to_epsg() == 4326
    assert b.is_valid.all()
    assert b.geom_type.isin(["Polygon", "MultiPolygon"]).all()


@pytest.mark.parametrize("slug", TOWNSHIPS)
def test_sites_have_solar_potential(slug):
    s = gpd.read_parquet(processed(slug, "sites.parquet"))
    assert len(s) == len(gpd.read_parquet(processed(slug, "buildings.parquet")))
    cand = s[s["role"] == "candidate"]
    assert (cand["system_kwp"] > 0).all()
    assert (cand["kwh_yr_unshaded"] / cand["system_kwp"]).between(1340, 1360).all()
    assert s["display_name"].notna().all()


@pytest.mark.parametrize("slug", TOWNSHIPS)
def test_app_export_matches_sites(slug):
    path = APP_DATA_DIR / f"{slug}.json"
    if not path.exists():
        pytest.skip(f"run `solar-mapper export-app --township {slug}` first")
    data = json.loads(path.read_text())
    s = gpd.read_parquet(processed(slug, "sites.parquet"))
    assert data["id"] == slug and data["pipeline"] is True
    assert len(data["buildings"]) == len(s)
    assert {"buildings", "parking", "community", "fetchedAt"} <= data.keys()
