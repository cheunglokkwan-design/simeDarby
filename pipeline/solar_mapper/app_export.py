"""Export pipeline output in the format the web app loads (public/data/<township>.json).

Same top-level shape as the app's OpenStreetMap snapshots ({buildings, parking, community}),
but each building also carries the pipeline's category, height and provenance, which
src/solar.js buildSites uses instead of re-deriving them from OSM tags.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import MultiPolygon, shape

from .boundary import read_boundary
from .config import REPO_ROOT, Township, load_assumptions
from .io import primary_name, read_overture

log = logging.getLogger(__name__)

APP_DATA_DIR = REPO_ROOT / "public" / "data"


def _ring(geom) -> list[list[float]]:
    """Exterior ring as [[lon, lat], ...]; the largest part of a MultiPolygon."""
    if isinstance(geom, MultiPolygon):
        geom = max(geom.geoms, key=lambda g: g.area)
    return [[round(x, 7), round(y, 7)] for x, y in geom.exterior.coords]


def _tag_dict(source_tags) -> dict:
    if source_tags is None:
        return {}
    if isinstance(source_tags, dict):
        return source_tags
    return dict(source_tags)


def export_buildings(sites: gpd.GeoDataFrame, cfg: dict) -> list[dict]:
    category = cfg["category"]
    label = cfg["height_source_label"]
    sdp_assets = {n.lower() for n in cfg["sdp_assets"]}
    out = []
    for r in sites.itertuples(index=False):
        b = {
            "id": r.id,
            "polygon": _ring(r.geometry),
            "tags": {"name": r.display_name},
            "category": category[r.kind],
            "kind": r.kind,
            "kindSource": r.kind_source,
            "height": r.height_m,
            "levels": int(r.storeys),
            "heightSource": label[r.height_source],
            "heightConfidence": r.height_confidence,
            "footprintM2": r.footprint_m2,
            "footprintSource": r.source_dataset,
            "dataFlags": [f for f in r.data_flags.split(";") if f],
            "role": r.role,
        }
        if r.display_name.lower() in sdp_assets:
            b["sdpAsset"] = True
        out.append(b)
    return out


def export_carparks(infra: gpd.GeoDataFrame, boundary_utm, utm_epsg: int, cfg: dict) -> list[dict]:
    p = infra[(infra["class"] == "parking") & infra.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    tags = p["source_tags"].map(_tag_dict)
    structured = tags.map(lambda t: t.get("parking") in cfg["exclude_parking_types"] or "building" in t)
    p = p[~structured]
    utm = p.to_crs(utm_epsg)
    keep = utm.representative_point().within(boundary_utm) & (utm.area >= cfg["min_area_m2"])
    p = p[keep]
    return [
        {
            "id": r.id,
            "polygon": _ring(r.geometry),
            "tags": {k: v for k, v in (("name", primary_name(r.names)), ("parking", _tag_dict(r.source_tags).get("parking"))) if v},
        }
        for r in p.itertuples(index=False)
    ]


def export_community(
    places: gpd.GeoDataFrame, sites: gpd.GeoDataFrame, boundary_utm, utm_epsg: int, cfg: dict
) -> list[dict]:
    """Schools, clinics and similar: matching places, plus school/hospital buildings
    from the pipeline that no such place already marks."""
    names = places["names"].map(primary_name)
    words = "|".join(re.escape(w) for w in cfg["name_keywords"])
    by_name = names.fillna("").str.contains(rf"\b(?:{words})\b", case=False, regex=True)
    p = places[places["basic_category"].isin(cfg["categories"]) | by_name].assign(name=names)
    p = p[p.to_crs(utm_epsg).geometry.within(boundary_utm)]
    out = [
        {
            "id": f"place/{r.id}",
            "name": _str_or_none(r.name),
            "type": (_str_or_none(r.basic_category) or "community").replace("_", " "),
            "position": [round(r.geometry.x, 7), round(r.geometry.y, 7)],
        }
        for r in p.itertuples(index=False)
    ]
    b = sites[sites["kind"].isin(cfg["building_kinds"]) & (sites["role"] != "excluded")]
    if len(b):
        b_utm = gpd.GeoDataFrame(b[["id", "display_name", "kind"]], geometry=b.to_crs(utm_epsg).representative_point())
        if len(p):
            near = gpd.sjoin_nearest(b_utm, p.to_crs(utm_epsg)[["geometry"]], max_distance=cfg["dedupe_m"])
            b_utm = b_utm[~b_utm.index.isin(near.index)]
        for r in b_utm.set_crs(utm_epsg).to_crs(4326).itertuples(index=False):
            out.append(
                {
                    "id": r.id,
                    "name": r.display_name,
                    "type": "school" if r.kind == "education" else "hospital or clinic",
                    "position": [round(r.geometry.x, 7), round(r.geometry.y, 7)],
                }
            )
    return out


def export_detected(processed_dir: Path) -> tuple[list[dict], list[list[float]]]:
    """Car parks and vehicles found by `solar-mapper detect-carparks`, if it has been run."""
    lots, vehicles = [], []
    lots_path = processed_dir / "detected_carparks.geojson"
    if lots_path.exists():
        for i, f in enumerate(json.loads(lots_path.read_text())["features"]):
            n = int(f["properties"]["vehicles"])
            lots.append(
                {
                    "id": f"detected/{i}",
                    "polygon": _ring(shape(f["geometry"])),
                    "tags": {"name": f"Car park (AI-detected, {n} vehicles)", "source": "detected", "vehicles": n},
                }
            )
    vehicles_path = processed_dir / "detected_vehicles.geojson"
    if vehicles_path.exists():
        for f in json.loads(vehicles_path.read_text())["features"]:
            lon, lat = f["geometry"]["coordinates"]
            vehicles.append([round(lon, 6), round(lat, 6)])
    return lots, vehicles


def export_app(township: Township, out_dir: Path = APP_DATA_DIR) -> Path:
    a = load_assumptions()["app_export"]
    utm = township.utm_epsg
    boundary_utm = gpd.GeoSeries([read_boundary(township)], crs=4326).to_crs(utm).iloc[0]
    sites = gpd.read_parquet(township.processed_dir / "sites.parquet")
    infra = read_overture(township.raw_dir / "infrastructure.parquet", ["id", "class", "names", "source_tags"])
    places = read_overture(township.raw_dir / "places.parquet", ["id", "names", "basic_category"])
    places = places[places.geom_type == "Point"]
    detected_lots, vehicles = export_detected(township.processed_dir)
    data = {
        "id": township.slug,
        "fetchedAt": township.overture_release[:10],
        "source": f"Overture Maps {township.overture_release} (OSM + Google + Microsoft footprints), solar-mapper pipeline",
        "pipeline": True,
        "buildings": export_buildings(sites, a),
        "parking": export_carparks(infra, boundary_utm, utm, a["carparks"]) + detected_lots,
        "community": export_community(places, sites, boundary_utm, utm, a["community"]),
        "vehicles": vehicles,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{township.slug}.json"
    path.write_text(json.dumps(data, separators=(",", ":"), default=_json_default, allow_nan=False))
    log.info(
        "wrote %s: %d buildings, %d car parks (%d AI-detected), %d community sites",
        path, len(data["buildings"]), len(data["parking"]), len(detected_lots), len(data["community"]),
    )
    return path


def _str_or_none(value) -> str | None:
    return value if isinstance(value, str) and value else None


def _json_default(value):
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        return value.item()
    raise TypeError(f"not JSON serialisable: {type(value)}")
