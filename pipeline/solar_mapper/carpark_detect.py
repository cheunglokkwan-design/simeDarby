"""Find unmapped car parks by detecting parked vehicles in aerial imagery.

1. Search area: ground within `search_buffer_m` of candidate roofs (malls, factories,
   schools, ...), where canopy-sized car parks sit. Housing streets are left out.
2. Imagery: XYZ tiles (Esri World Imagery by default) stitched into square chips.
3. Detection: a pretrained aerial-imagery detector (Ultralytics YOLO OBB trained on DOTA v1,
   classes "small vehicle" / "large vehicle"); no training needed.
4. Car parks: vehicles within `cluster_eps_m` of each other are linked into lots, padded to
   cover the bays, building roofs removed. Lots that are mostly cars along a street, too small,
   too narrow, or already mapped are dropped.

Already-mapped car parks double as a check of the detector: the summary reports how many
of them it found vehicles in.
"""

from __future__ import annotations

import json
import logging
import math
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import geopandas as gpd
import numpy as np
import pyarrow.parquet as pq
import pandas as pd
import shapely
from shapely.geometry import Polygon, box
from shapely.prepared import prep

from .boundary import read_boundary
from .config import Township, load_assumptions
from .io import read_overture
from .overture import fetch_layer

log = logging.getLogger(__name__)

TILE = 256
USER_AGENT = "SolarOpportunityMapper/0.1 (university hackathon research prototype)"


# ---------- Web Mercator tile maths ----------

def lonlat_to_pixel(lon: float, lat: float, z: int) -> tuple[float, float]:
    """Global pixel coordinates at zoom z (256 px tiles)."""
    n = TILE * 2**z
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def pixel_to_lonlat(px: float, py: float, z: int) -> tuple[float, float]:
    n = TILE * 2**z
    lon = px / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))
    return lon, lat


def tile_polygon(x: int, y: int, z: int) -> Polygon:
    lon0, lat0 = pixel_to_lonlat(x * TILE, (y + 1) * TILE, z)
    lon1, lat1 = pixel_to_lonlat((x + 1) * TILE, y * TILE, z)
    return box(lon0, lat0, lon1, lat1)


def tiles_covering(area_4326, z: int) -> set[tuple[int, int]]:
    """Tiles at zoom z that intersect a lon/lat geometry."""
    xmin, ymin, xmax, ymax = area_4326.bounds
    px0, py0 = lonlat_to_pixel(xmin, ymax, z)
    px1, py1 = lonlat_to_pixel(xmax, ymin, z)
    prepared = prep(area_4326)
    return {
        (x, y)
        for x in range(int(px0 // TILE), int(px1 // TILE) + 1)
        for y in range(int(py0 // TILE), int(py1 // TILE) + 1)
        if prepared.intersects(tile_polygon(x, y, z))
    }


def chip_blocks(tiles: Iterable[tuple[int, int]], k: int) -> list[tuple[int, int]]:
    """k x k tile blocks (by block index) that contain at least one needed tile."""
    return sorted({(x // k, y // k) for x, y in tiles})


# ---------- imagery ----------

def tile_fetcher(url_template: str, cache_dir: Path) -> Callable[[int, int, int], bytes | None]:
    """Returns fetch(z, x, y) -> image bytes (cached on disk) or None if unavailable."""

    def fetch(z: int, x: int, y: int) -> bytes | None:
        path = cache_dir / str(z) / str(x) / f"{y}.jpg"
        if path.exists():
            return path.read_bytes()
        req = urllib.request.Request(url_template.format(z=z, x=x, y=y), headers={"User-Agent": USER_AGENT})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                    if not r.headers.get("Content-Type", "").startswith("image"):
                        return None
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                return data
            except OSError as e:
                if attempt == 2:
                    log.warning("tile %s/%s/%s failed: %s", z, x, y, e)
        return None

    return fetch


def stitch(block: tuple[int, int], k: int, z: int, fetch):
    """k x k tiles of a block as one RGB image (missing tiles grey)."""
    import io

    from PIL import Image

    img = Image.new("RGB", (TILE * k, TILE * k), (128, 128, 128))
    bx, by = block
    for dx in range(k):
        for dy in range(k):
            data = fetch(z, bx * k + dx, by * k + dy)
            if data:
                img.paste(Image.open(io.BytesIO(data)).convert("RGB"), (dx * TILE, dy * TILE))
    return img


# ---------- detector ----------

@dataclass(frozen=True)
class Detection:
    x: float  # pixel centre within the chip
    y: float
    confidence: float
    label: str


def ultralytics_detector(model_name: str, labels: list[str], min_confidence: float, imgsz: int):
    """Pretrained Ultralytics OBB model (weights download on first use)."""
    from ultralytics import YOLO  # optional dependency: pip install -e ".[detect]"

    model = YOLO(model_name)
    wanted = {i for i, n in model.names.items() if n in labels}

    def detect(image) -> list[Detection]:
        out = []
        for r in model.predict(image, imgsz=imgsz, conf=min_confidence, verbose=False):
            if r.obb is None:
                continue
            for (cx, cy, *_), conf, cls in zip(r.obb.xywhr.tolist(), r.obb.conf.tolist(), r.obb.cls.tolist()):
                if int(cls) in wanted:
                    out.append(Detection(cx, cy, conf, model.names[int(cls)]))
        return out

    return detect


def detect_vehicles(blocks, k: int, z: int, fetch, detect) -> gpd.GeoDataFrame:
    """Run the detector on every chip; vehicles as lon/lat points."""
    rows = []
    for i, block in enumerate(blocks):
        image = stitch(block, k, z, fetch)
        x0, y0 = block[0] * k * TILE, block[1] * k * TILE
        for d in detect(image):
            lon, lat = pixel_to_lonlat(x0 + d.x, y0 + d.y, z)
            rows.append({"confidence": round(d.confidence, 3), "label": d.label, "lon": lon, "lat": lat})
        if i % 20 == 0:
            log.info("chip %d/%d: %d vehicles so far", i + 1, len(blocks), len(rows))
    # Blocks tile the plane without overlap, so each vehicle is seen once.
    df = pd.DataFrame(rows, columns=["confidence", "label", "lon", "lat"])
    return gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df["lon"], df["lat"]), crs=4326)


# ---------- vehicles -> car parks ----------

def cluster_carparks(cars, buildings, streets, mapped, cfg: dict) -> tuple[gpd.GeoDataFrame, Counter]:
    """Link nearby vehicles into lots. All inputs in a metric CRS (GeoSeries / GeoDataFrame).

    Returns (kept lots with vehicle counts, Counter of drop reasons).
    """
    crs = cars.crs
    reasons: Counter = Counter()
    if cars.empty:
        return gpd.GeoDataFrame({"vehicles": []}, geometry=[], crs=crs), reasons
    blobs = shapely.union_all(cars.geometry.buffer(cfg["cluster_eps_m"] / 2).to_numpy())
    parts = list(getattr(blobs, "geoms", [blobs]))
    car_tree = shapely.STRtree(cars.geometry.to_numpy())
    building_tree = shapely.STRtree(buildings.to_numpy()) if len(buildings) else None
    street_lines = shapely.union_all(streets.to_numpy()) if len(streets) else None
    mapped_union = shapely.union_all(mapped.to_numpy()) if len(mapped) else None
    kept = []
    for part in parts:
        idx = car_tree.query(part, predicate="intersects")
        n = len(idx)
        if n < cfg["min_vehicles"]:
            reasons["too_few_vehicles"] += 1
            continue
        if street_lines is not None:
            near_street = shapely.dwithin(cars.geometry.to_numpy()[idx], street_lines, cfg["street_distance_m"])
            if near_street.mean() > cfg["street_share_max"]:
                reasons["street_parking"] += 1
                continue
        lot = part.buffer(cfg["pad_m"]).simplify(1.0)
        if building_tree is not None:
            roofs = buildings.to_numpy()[building_tree.query(lot, predicate="intersects")]
            if len(roofs):
                lot = lot.difference(shapely.union_all(roofs))
        if lot.is_empty:
            reasons["on_roofs"] += 1
            continue
        lot = max(getattr(lot, "geoms", [lot]), key=lambda g: g.area)
        if lot.area < cfg["min_area_m2"]:
            reasons["too_small"] += 1
            continue
        rect = shapely.oriented_envelope(lot)
        sides = np.hypot(*np.diff(np.asarray(rect.exterior.coords)[:3], axis=0).T)
        if sides.min() < cfg["min_width_m"]:
            reasons["too_narrow"] += 1
            continue
        if mapped_union is not None and lot.intersection(mapped_union).area / lot.area > cfg["mapped_overlap_max"]:
            reasons["already_mapped"] += 1
            continue
        kept.append({"vehicles": n, "geometry": lot})
    return gpd.GeoDataFrame(kept or None, columns=["vehicles", "geometry"], crs=crs), reasons


def mapped_found(cars, mapped, min_vehicles: int) -> int:
    """How many mapped car parks contain at least `min_vehicles` detected vehicles."""
    if cars.empty or not len(mapped):
        return 0
    hits = gpd.sjoin(cars[["geometry"]], gpd.GeoDataFrame(geometry=mapped.reset_index(drop=True)), predicate="within")
    return int((hits.groupby("index_right").size() >= min_vehicles).sum())


# ---------- orchestration ----------

STREET_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street"}


def _roads(township: Township) -> gpd.GeoDataFrame:
    path = township.raw_dir / "roads.parquet"
    if not path.exists():
        log.info("roads: downloading Overture transportation/segment ...")
        pq.write_table(fetch_layer(township.overture_release, "transportation", "segment", township.bbox), path)
    return read_overture(path, ["class", "subtype"])


def run_detection(township: Township, detect=None, fetch=None, max_chips: int | None = None) -> dict:
    cfg = load_assumptions()["carpark_detection"]
    utm = township.utm_epsg
    z, k = cfg["zoom"], cfg["chip_tiles"]
    boundary = read_boundary(township)

    sites = gpd.read_parquet(township.processed_dir / "sites.parquet")
    candidates = sites[sites["role"] == "candidate"].to_crs(utm)
    boundary_utm = gpd.GeoSeries([boundary], crs=4326).to_crs(utm).iloc[0]
    area = shapely.union_all(candidates.buffer(cfg["search_buffer_m"]).to_numpy()).intersection(boundary_utm.buffer(50))
    area_4326 = gpd.GeoSeries([area], crs=utm).to_crs(4326).iloc[0]
    tiles = tiles_covering(area_4326, z)
    blocks = chip_blocks(tiles, k)
    if max_chips:
        blocks = blocks[:max_chips]
    log.info("search area %.2f km2: %d tiles, %d chips of %dx%d", area.area / 1e6, len(tiles), len(blocks), k, k)

    fetch = fetch or tile_fetcher(cfg["tiles_url"], township.raw_dir / "tiles")
    detect = detect or ultralytics_detector(cfg["model"], cfg["vehicle_labels"], cfg["min_confidence"], k * TILE)
    cars = detect_vehicles(blocks, k, z, fetch, detect)
    cars = cars[cars.within(area_4326)] if len(cars) else cars

    infra = read_overture(township.raw_dir / "infrastructure.parquet", ["class"])
    mapped = infra[(infra["class"] == "parking") & infra.geom_type.isin(["Polygon", "MultiPolygon"])].to_crs(utm).geometry
    roads = _roads(township)
    streets = roads[roads["class"].isin(STREET_CLASSES) & roads.geom_type.isin(["LineString", "MultiLineString"])]
    lots, reasons = cluster_carparks(
        cars.to_crs(utm), sites.to_crs(utm).geometry, streets.to_crs(utm).geometry, mapped, cfg
    )

    d = township.processed_dir
    (d / "detected_vehicles.geojson").write_text(cars.to_json(drop_id=True))
    out = lots.to_crs(4326)
    out["area_m2"] = lots.area.round(0)
    (d / "detected_carparks.geojson").write_text(out.to_json(drop_id=True))
    summary = {
        "township": township.name,
        "imagery": cfg["tiles_url"],
        "model": cfg["model"],
        "zoom": z,
        "search_area_km2": round(area.area / 1e6, 2),
        "tiles": len(tiles),
        "chips_run": len(blocks),
        "vehicles_detected": int(len(cars)),
        "carparks_detected": int(len(lots)),
        "detected_area_m2": round(float(lots.area.sum())),
        "dropped": dict(reasons),
        "mapped_carparks": int(len(mapped)),
        "mapped_carparks_with_vehicles": mapped_found(cars.to_crs(utm), mapped, cfg["min_vehicles"]),
    }
    (d / "carpark_detection_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    log.info("detected %d car parks from %d vehicles", summary["carparks_detected"], summary["vehicles_detected"])
    return summary
