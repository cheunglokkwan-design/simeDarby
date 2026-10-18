"""Download Overture Maps features for a bounding box.

Reads the public GeoParquet release on S3 anonymously with pyarrow, pushing the
bbox filter down to row-group statistics so only the relevant slices are fetched.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import pyarrow.parquet as pq

from .config import Township

log = logging.getLogger(__name__)

BUCKET = "overturemaps-us-west-2"
REGION = "us-west-2"

# (theme, type) pairs used by the pipeline, keyed by the local file name.
LAYERS = {
    "buildings": ("buildings", "building"),
    "places": ("places", "place"),
    "land_use": ("base", "land_use"),
}


def bbox_filter(bbox: tuple[float, float, float, float]) -> pc.Expression:
    """Features whose bbox intersects ``bbox`` (xmin, ymin, xmax, ymax)."""
    xmin, ymin, xmax, ymax = bbox
    f = pc.field
    return (
        (f("bbox", "xmax") >= xmin)
        & (f("bbox", "xmin") <= xmax)
        & (f("bbox", "ymax") >= ymin)
        & (f("bbox", "ymin") <= ymax)
    )


def fetch_layer(release: str, theme: str, type_: str, bbox) -> pa.Table:
    fs = pafs.S3FileSystem(anonymous=True, region=REGION)
    path = f"{BUCKET}/release/{release}/theme={theme}/type={type_}/"
    dataset = ds.dataset(path, filesystem=fs, format="parquet")
    return dataset.to_table(filter=bbox_filter(bbox))


def download(township: Township, refresh: bool = False) -> dict[str, Path]:
    """Download every layer in ``LAYERS`` for the township; returns local paths."""
    township.raw_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, (theme, type_) in LAYERS.items():
        out = township.raw_dir / f"{name}.parquet"
        if out.exists() and not refresh:
            log.info("%s: using cached %s", name, out)
        else:
            log.info("%s: downloading Overture %s/%s ...", name, theme, type_)
            table = fetch_layer(township.overture_release, theme, type_, township.bbox)
            pq.write_table(table, out)
            log.info("%s: %d features -> %s", name, table.num_rows, out)
        paths[name] = out
    return paths
