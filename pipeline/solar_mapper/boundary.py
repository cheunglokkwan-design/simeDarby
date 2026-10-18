"""Approximate township boundary from named Overture land-use polygons."""

from __future__ import annotations

import json

import geopandas as gpd
import shapely
from shapely.geometry import MultiPolygon, Polygon, box, mapping

from .config import Township
from .io import primary_name, read_overture


def fill_holes(geom):
    """Drop interior rings so enclaves (parks, lakes, schools) stay inside."""
    if isinstance(geom, Polygon):
        return Polygon(geom.exterior)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([Polygon(p.exterior) for p in geom.geoms])
    return geom


def derive_boundary(land_use: gpd.GeoDataFrame, pattern: str, buffer_m: float, utm_epsg: int):
    """Union of land-use polygons whose primary name contains ``pattern``.

    Returns (boundary in EPSG:4326, names of the source polygons).
    """
    names = land_use["names"].map(primary_name)
    match = land_use[names.str.contains(pattern, case=False, na=False)]
    match = match[match.geom_type.isin(["Polygon", "MultiPolygon"])]
    if match.empty:
        raise ValueError(f"no land-use polygons named like {pattern!r}")
    merged = shapely.union_all(match.to_crs(utm_epsg).geometry.buffer(buffer_m).to_numpy())
    merged = fill_holes(merged)
    boundary = gpd.GeoSeries([merged], crs=utm_epsg).to_crs(4326).iloc[0]
    return boundary, sorted(names[match.index].unique())


def write_boundary(township: Township) -> gpd.GeoDataFrame:
    cfg = township.boundary
    if cfg["method"] == "bbox":
        b = cfg["bbox"]
        geom, sources = box(b["xmin"], b["ymin"], b["xmax"], b["ymax"]), []
        method = "rectangle from the township config (no named outline in open data)"
    elif cfg["method"] == "land_use_names":
        land_use = read_overture(township.raw_dir / "land_use.parquet")
        geom, sources = derive_boundary(land_use, cfg["name_pattern"], cfg["buffer_m"], township.utm_epsg)
        method = (
            f"union of Overture {township.overture_release} land_use polygons named like "
            f"'{cfg['name_pattern']}', holes filled, buffered {cfg['buffer_m']} m"
        )
    else:
        raise ValueError(f"unknown boundary method {cfg['method']!r}")
    area_km2 = gpd.GeoSeries([geom], crs=4326).to_crs(township.utm_epsg).area.iloc[0] / 1e6
    feature = {
        "type": "Feature",
        "properties": {
            "township": township.name,
            "method": method,
            "approximate": True,
            "area_km2": round(area_km2, 2),
            "source_polygons": sources,
        },
        "geometry": mapping(shapely.set_precision(geom, 1e-6)),
    }
    township.boundary_path.parent.mkdir(parents=True, exist_ok=True)
    with open(township.boundary_path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": [feature]}, f, indent=1)
    return gpd.GeoDataFrame([feature["properties"]], geometry=[geom], crs=4326)


def read_boundary(township: Township):
    return gpd.read_file(township.boundary_path).geometry.iloc[0]
