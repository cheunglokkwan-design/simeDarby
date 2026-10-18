"""Street View spot-check of estimated heights (Phase 1 exit criterion).

``make_sheet`` draws a fixed random sample for teammates to verify by eye;
``score_sheet`` reports how many estimates were within one storey once filled in.
"""

from __future__ import annotations

import pandas as pd

from .candidates import CANDIDATE, PROGRAMME

SHEET_COLUMNS = [
    "id",
    "role",
    "kind",
    "kind_source",
    "height_source",
    "storeys",
    "height_m",
    "lat",
    "lon",
    "street_view_url",
    "map_url",
    "observed_storeys",
    "notes",
]


def make_sheet(b: pd.DataFrame, n_candidates: int = 12, n_programme: int = 8, seed: int = 42):
    """Sample weighted towards candidates, since their heights drive shading results."""
    parts = [
        b[b["role"] == CANDIDATE].sample(min(n_candidates, (b["role"] == CANDIDATE).sum()), random_state=seed),
        b[b["role"] == PROGRAMME].sample(min(n_programme, (b["role"] == PROGRAMME).sum()), random_state=seed),
    ]
    s = pd.concat(parts).copy()
    s["street_view_url"] = [
        f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lon}"
        for lat, lon in zip(s["lat"], s["lon"])
    ]
    s["map_url"] = [
        f"https://www.google.com/maps/search/?api=1&query={lat},{lon}" for lat, lon in zip(s["lat"], s["lon"])
    ]
    s["observed_storeys"] = ""
    s["notes"] = ""
    return s[SHEET_COLUMNS].reset_index(drop=True)


def score_sheet(sheet: pd.DataFrame, tolerance: int = 1) -> dict:
    observed = pd.to_numeric(sheet["observed_storeys"], errors="coerce")
    filled = sheet[observed.notna()]
    err = (filled["storeys"] - observed[observed.notna()]).abs()
    within = int((err <= tolerance).sum())
    return {
        "checked": len(filled),
        "within_tolerance": within,
        "share_within_tolerance": round(within / len(filled), 3) if len(filled) else None,
        "mean_abs_storey_error": round(float(err.mean()), 2) if len(filled) else None,
    }
