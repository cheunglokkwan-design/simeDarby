"""Read raw Overture parquet into GeoDataFrames."""

from __future__ import annotations

from pathlib import Path

import geopandas as gpd
import pyarrow.parquet as pq
import shapely


def read_overture(path: Path, columns: list[str] | None = None) -> gpd.GeoDataFrame:
    """Load an Overture parquet file, decoding the WKB ``geometry`` column."""
    if columns is not None and "geometry" not in columns:
        columns = [*columns, "geometry"]
    df = pq.read_table(path, columns=columns).to_pandas()
    geom = shapely.from_wkb(df.pop("geometry").to_numpy())
    return gpd.GeoDataFrame(df, geometry=geom, crs="EPSG:4326")


def primary_name(names) -> str | None:
    """Overture ``names`` struct -> primary name (or None)."""
    if isinstance(names, dict):
        return names.get("primary")
    return None
