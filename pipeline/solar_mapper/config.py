"""Paths, township definitions and modelling assumptions."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
PIPELINE_DIR = REPO_ROOT / "pipeline"
CONFIG_DIR = PIPELINE_DIR / "config"
DATA_DIR = REPO_ROOT / "data"


@dataclass(frozen=True)
class Township:
    slug: str
    name: str
    overture_release: str
    bbox: tuple[float, float, float, float]  # xmin, ymin, xmax, ymax
    utm_epsg: int
    boundary: dict  # {method: land_use_names, name_pattern, buffer_m} or {method: bbox, bbox}

    @property
    def raw_dir(self) -> Path:
        return DATA_DIR / "raw" / self.slug

    @property
    def processed_dir(self) -> Path:
        return DATA_DIR / "processed" / self.slug

    @property
    def boundary_path(self) -> Path:
        return CONFIG_DIR / "boundaries" / f"{self.slug}.geojson"


def load_township(slug: str) -> Township:
    with open(CONFIG_DIR / "townships" / f"{slug}.yaml") as f:
        raw = yaml.safe_load(f)
    b = raw["bbox"]
    return Township(
        slug=raw["slug"],
        name=raw["name"],
        overture_release=raw["overture_release"],
        bbox=(b["xmin"], b["ymin"], b["xmax"], b["ymax"]),
        utm_epsg=raw["utm_epsg"],
        boundary=raw["boundary"],
    )


@cache
def load_assumptions() -> dict:
    with open(CONFIG_DIR / "assumptions.yaml") as f:
        return yaml.safe_load(f)
