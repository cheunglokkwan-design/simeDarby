"""Phase 2: rooftop solar potential, before shading.

usable roof = footprint x usable fraction (by kind)
system kWp  = usable roof x panel density
kWh/yr      = kWp x specific yield          (Phase 4 multiplies in the unshaded fraction)
tCO2/yr     = kWh x grid emission factor / 1000

Same formula and constants as the solar-demo app (src/solar.js scoreSites).
"""

from __future__ import annotations

import json
import logging

import geopandas as gpd
import pandas as pd

from .candidates import CANDIDATE, PROGRAMME
from .config import Township

log = logging.getLogger(__name__)

SOLAR_COLUMNS = [
    "display_name",
    "usable_fraction",
    "usable_roof_m2",
    "system_kwp",
    "kwh_yr_unshaded",
    "co2_t_yr_unshaded",
]


def display_name(row) -> str:
    """Building name, else its first place, else '<kind> in <land use>'."""
    if isinstance(row.building_name, str) and row.building_name:
        return row.building_name
    if isinstance(row.place_names, str) and row.place_names:
        return row.place_names.split("; ")[0]
    label = "Unclassified building" if row.kind == "unknown" else row.kind.replace("_", " ").capitalize()
    if isinstance(row.land_use_name, str) and row.land_use_name:
        return f"{label} in {row.land_use_name}"
    return label


def _append_flag(flags: pd.Series, mask: pd.Series, flag: str) -> pd.Series:
    added = flags.where(flags == "", flags + ";") + flag
    return flags.where(~mask, added)


def add_solar_potential(b: gpd.GeoDataFrame, cfg: dict) -> gpd.GeoDataFrame:
    """Append Phase 2 columns; ``cfg`` is the ``solar`` block of assumptions.yaml."""
    frac = b["kind"].map(cfg["usable_fraction"])
    missing = sorted(b.loc[frac.isna(), "kind"].unique())
    if missing:
        raise ValueError(f"solar.usable_fraction has no value for kinds: {missing}")
    usable = b["footprint_m2"] * frac
    kwp = usable * cfg["panel_density_kwp_per_m2"]
    kwh = kwp * cfg["specific_yield_kwh_per_kwp"]
    out = b.assign(
        display_name=[display_name(r) for r in b.itertuples(index=False)],
        usable_fraction=frac,
        usable_roof_m2=usable.round(1),
        system_kwp=kwp.round(1),
        kwh_yr_unshaded=kwh.round(0),
        co2_t_yr_unshaded=(kwh * cfg["grid_emission_factor_kg_per_kwh"] / 1000).round(2),
    )
    out["data_flags"] = _append_flag(out["data_flags"], kwp < cfg["min_system_kwp"], "below_min_system")
    return out


def _totals(df: pd.DataFrame) -> dict:
    return {
        "buildings": len(df),
        "roof_m2": round(float(df["footprint_m2"].sum())),
        "usable_roof_m2": round(float(df["usable_roof_m2"].sum())),
        "system_kwp": round(float(df["system_kwp"].sum())),
        "mwh_yr_unshaded": round(float(df["kwh_yr_unshaded"].sum()) / 1000),
        "co2_t_yr_unshaded": round(float(df["co2_t_yr_unshaded"].sum())),
    }


def summarise_solar(s: pd.DataFrame, cfg: dict, township: Township, top_n: int = 10) -> dict:
    cand = s[s["role"] == CANDIDATE]
    top = cand.sort_values("kwh_yr_unshaded", ascending=False).head(top_n)
    cand_kwp = float(cand["system_kwp"].sum())
    return {
        "township": township.name,
        "assumptions": {
            "specific_yield_kwh_per_kwp": cfg["specific_yield_kwh_per_kwp"],
            "panel_density_kwp_per_m2": cfg["panel_density_kwp_per_m2"],
            "grid_emission_factor_kg_per_kwh": cfg["grid_emission_factor_kg_per_kwh"],
            "shading": "not applied (Phase 4)",
        },
        "candidates": {
            **_totals(cand),
            "by_kind": {k: _totals(g) for k, g in cand.groupby("kind")},
            "multiple_of_sdp_existing_rooftop_pv": round(cand_kwp / cfg["sdp_existing_rooftop_kwp"], 1),
        },
        "residential_programme": _totals(s[s["role"] == PROGRAMME]),
        "below_min_system": int(s["data_flags"].str.contains("below_min_system").sum()),
        "top_candidates": [
            {
                "id": r.id,
                "name": r.display_name,
                "kind": r.kind,
                "roof_m2": round(r.footprint_m2),
                "system_kwp": r.system_kwp,
                "mwh_yr_unshaded": round(r.kwh_yr_unshaded / 1000, 1),
                "data_flags": r.data_flags,
            }
            for r in top.itertuples(index=False)
        ],
    }


def write_solar_outputs(s: gpd.GeoDataFrame, summary: dict, township: Township) -> dict:
    d = township.processed_dir
    paths = {
        "parquet": d / "sites.parquet",
        "geojson": d / "sites.geojson",
        "summary": d / "phase2_summary.json",
    }
    s.to_parquet(paths["parquet"], index=False)
    paths["geojson"].write_text(s.to_json(drop_id=True))
    paths["summary"].write_text(json.dumps(summary, indent=2) + "\n")
    for p in paths.values():
        log.info("wrote %s", p)
    return paths
