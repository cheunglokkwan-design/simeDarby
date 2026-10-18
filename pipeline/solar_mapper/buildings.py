"""Phase 1 data foundation: clean footprints, infer kind and height, pick candidates."""

from __future__ import annotations

import json
import logging

import geopandas as gpd
import pandas as pd
import shapely

from .boundary import read_boundary
from .candidates import CANDIDATE, PROGRAMME, assign_role, build_flags
from .classify import Evidence, KindRules, elongation, name_kind, place_kind, resolve_kind, weak_kind
from .config import Township, load_assumptions
from .heights import estimate_height
from .io import primary_name, read_overture

log = logging.getLogger(__name__)

BUILDING_COLUMNS = ["id", "names", "sources", "subtype", "class", "height", "num_floors", "is_underground"]

OUTPUT_COLUMNS = [
    "id",
    "building_name",
    "source_dataset",
    "footprint_m2",
    "elongation",
    "overture_class",
    "overture_subtype",
    "kind",
    "kind_source",
    "height_m",
    "storeys",
    "height_source",
    "height_confidence",
    "role",
    "role_reason",
    "data_flags",
    "land_use_name",
    "place_names",
    "lon",
    "lat",
    "geometry",
]


def _first_dataset(sources) -> str | None:
    if sources is None or len(sources) == 0:
        return None
    return sources[0].get("dataset")


def _none_if_nan(value):
    return None if pd.isna(value) else value


def load_footprints(township: Township, boundary_utm, min_m2: float):
    """Footprints whose representative point falls inside the boundary, in UTM."""
    b = read_overture(township.raw_dir / "buildings.parquet", columns=BUILDING_COLUMNS)
    b = b[b.geom_type.isin(["Polygon", "MultiPolygon"])].to_crs(township.utm_epsg)
    b = b[b.representative_point().within(boundary_utm) & ~b["is_underground"].fillna(False)]
    b = b.assign(
        footprint_m2=b.area,
        source_dataset=b["sources"].map(_first_dataset),
        building_name=b["names"].map(primary_name),
    )
    small = b["footprint_m2"] < min_m2
    counts = {"in_boundary": len(b), "dropped_below_min_m2": int(small.sum())}
    keep = b[~small].drop(columns=["names", "sources", "is_underground"])
    return keep.reset_index(drop=True), counts


def land_use_context(buildings: gpd.GeoDataFrame, land_use: gpd.GeoDataFrame, rules: KindRules):
    """Per building: kind of the smallest informative containing land use, its name,
    and whether it sits in a construction zone."""
    lu = land_use[land_use.geom_type.isin(["Polygon", "MultiPolygon"])]
    names = lu["names"].map(primary_name)
    by_class = lu["class"].map(rules.land_use)
    by_name = names.map(lambda n: name_kind(n, rules))
    lu = gpd.GeoDataFrame(
        {
            "lu_area": lu.area,
            "lu_kind": by_class.fillna(by_name),
            "lu_kind_source": by_class.notna().map({True: "land_use", False: "land_use_name"}),
            "lu_name": names,
            "lu_subtype": lu["subtype"],
        },
        geometry=lu.geometry,
        crs=lu.crs,
    )
    points = gpd.GeoDataFrame(geometry=buildings.representative_point(), crs=buildings.crs)
    j = gpd.sjoin(points, lu, predicate="within").sort_values("lu_area")
    out = pd.DataFrame(index=buildings.index)
    informative = j.dropna(subset=["lu_kind"]).groupby(level=0)
    out["land_use_kind"] = informative["lu_kind"].first()
    out["land_use_source"] = informative["lu_kind_source"].first()
    out["land_use_name"] = j.dropna(subset=["lu_name"]).groupby(level=0)["lu_name"].first()
    construction = (j["lu_subtype"] == "construction").groupby(level=0).any()
    out["in_construction_zone"] = construction.reindex(out.index, fill_value=False).astype(bool)
    return out


def places_context(buildings: gpd.GeoDataFrame, places: gpd.GeoDataFrame, snap_m: float):
    """Per building: categories and names of places within ``snap_m`` (nearest building wins)."""
    p = gpd.GeoDataFrame(
        {"category": places["basic_category"], "name": places["names"].map(primary_name)},
        geometry=places.geometry,
        crs=places.crs,
    )
    j = gpd.sjoin_nearest(p, buildings[["geometry"]], max_distance=snap_m)
    grouped = j.groupby("index_right")
    out = pd.DataFrame(index=buildings.index)
    out["place_categories"] = grouped["category"].agg(lambda s: [c if isinstance(c, str) else None for c in s])
    out["place_names"] = grouped["name"].agg(lambda s: "; ".join(n for n in s if isinstance(n, str) and n))
    out["place_categories"] = out["place_categories"].map(lambda v: v if isinstance(v, list) else [])
    return out


def classify_buildings(b: gpd.GeoDataFrame, a: dict) -> gpd.GeoDataFrame:
    rules = KindRules.from_assumptions(a)
    records = []
    for row in b.itertuples(index=False):
        evidence = Evidence(
            footprint_m2=row.footprint_m2,
            elongation=row.elongation,
            overture_class=_none_if_nan(row.overture_class),
            overture_subtype=_none_if_nan(row.overture_subtype),
            name_kind=name_kind(_none_if_nan(row.building_name), rules),
            places_kind=place_kind(row.place_categories, rules),
            land_use_kind=_none_if_nan(row.land_use_kind),
            land_use_source=_none_if_nan(row.land_use_source) or "land_use",
        )
        kind, kind_source = resolve_kind(evidence, rules)
        h = estimate_height(
            row.height, row.num_floors, kind, kind_source, a["kinds"], a["height_confidence"]
        )
        role, reason = assign_role(kind, row.footprint_m2, a["candidates"])
        weak = weak_kind(evidence, rules)
        overridden = weak is not None and kind_source != "overture_class_weak" and kind != weak
        records.append(
            {
                "kind": kind,
                "kind_source": kind_source,
                "height_m": round(h.height_m, 1),
                "storeys": h.storeys,
                "height_source": h.source,
                "height_confidence": h.confidence,
                "role": role,
                "role_reason": reason,
                "data_flags": build_flags(
                    h.source, kind, kind_source, row.source_dataset, row.in_construction_zone, overridden
                ),
            }
        )
    return b.join(pd.DataFrame(records, index=b.index))


def run_phase1(township: Township) -> tuple[gpd.GeoDataFrame, dict]:
    a = load_assumptions()
    utm = township.utm_epsg
    boundary_utm = gpd.GeoSeries([read_boundary(township)], crs=4326).to_crs(utm).iloc[0]

    b, counts = load_footprints(township, boundary_utm, a["buildings"]["min_footprint_m2"])
    b = b.rename(columns={"class": "overture_class", "subtype": "overture_subtype"})
    b["elongation"] = elongation(b.geometry.to_numpy()).round(2)
    # Clip first: polygons reaching far beyond the bbox give NaN areas once reprojected to UTM.
    land_use = read_overture(township.raw_dir / "land_use.parquet").clip(township.bbox).to_crs(utm)
    places = read_overture(township.raw_dir / "places.parquet", ["names", "basic_category"]).to_crs(utm)
    b = b.join(land_use_context(b, land_use, KindRules.from_assumptions(a)))
    b = b.join(places_context(b, places, a["buildings"]["place_snap_m"]))
    b = classify_buildings(b, a)

    b["footprint_m2"] = b["footprint_m2"].round(1)
    centroids = b.representative_point().to_crs(4326)
    b["lon"], b["lat"] = centroids.x.round(6), centroids.y.round(6)
    out = b.to_crs(4326)[OUTPUT_COLUMNS]
    out = out.set_geometry(shapely.set_precision(out.geometry.to_numpy(), 1e-7))
    return out, summarise(out, township, counts, boundary_utm.area)


def _counts(series: pd.Series) -> dict:
    return {str(k): int(v) for k, v in series.value_counts().items()}


def summarise(b: gpd.GeoDataFrame, township: Township, counts: dict, boundary_m2: float) -> dict:
    flags = b["data_flags"].str.split(";").explode()
    cand = b[b["role"] == CANDIDATE]
    prog = b[b["role"] == PROGRAMME]
    by_kind = cand.groupby("kind")["footprint_m2"].agg(["count", "sum"])
    return {
        "township": township.name,
        "overture_release": township.overture_release,
        "boundary_area_km2": round(boundary_m2 / 1e6, 2),
        "footprints": {**counts, "analysed": len(b)},
        "by_source_dataset": _counts(b["source_dataset"]),
        "by_kind": _counts(b["kind"]),
        "by_kind_source": _counts(b["kind_source"]),
        "by_height_source": _counts(b["height_source"]),
        "by_role": _counts(b["role"]),
        "data_flags": _counts(flags[flags != ""]),
        "mean_height_confidence": round(float(b["height_confidence"].mean()), 3),
        "candidates": {
            "count": len(cand),
            "roof_m2": round(float(cand["footprint_m2"].sum())),
            "by_kind": {k: {"count": int(r["count"]), "roof_m2": round(r["sum"])} for k, r in by_kind.iterrows()},
        },
        "residential_programme": {"buildings": len(prog), "roof_m2": round(float(prog["footprint_m2"].sum()))},
    }


def write_outputs(b: gpd.GeoDataFrame, summary: dict, township: Township) -> dict:
    d = township.processed_dir
    d.mkdir(parents=True, exist_ok=True)
    paths = {
        "parquet": d / "buildings.parquet",
        "summary": d / "phase1_summary.json",
    }
    b.to_parquet(paths["parquet"], index=False)
    paths["summary"].write_text(json.dumps(summary, indent=2) + "\n")
    for p in paths.values():
        log.info("wrote %s", p)
    return paths
