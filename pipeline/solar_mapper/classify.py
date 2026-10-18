"""Infer each building's kind (what it is used for) from the evidence available.

Evidence, strongest first: a specific Overture building class or subtype, keywords in
the building's name, places (POIs) inside the footprint, the smallest containing
land-use polygon (plus a footprint-shape test for terrace rows), a generic
"residential" tag, and finally size.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

import numpy as np
import shapely


def _invert(mapping: dict[str, list[str]] | None) -> dict[str, str]:
    return {value: kind for kind, values in (mapping or {}).items() for value in values}


@dataclass(frozen=True)
class KindRules:
    class_strong: dict[str, str]
    class_weak: dict[str, str]
    subtype_strong: dict[str, str]
    subtype_weak: dict[str, str]
    land_use: dict[str, str]
    place_specific: dict[str, str]
    name_patterns: tuple[tuple[re.Pattern, str], ...]
    min_commercial_places: int
    large_footprint_m2: float
    house_max_m2_in_residential_area: float
    terrace_min_elongation: float

    @classmethod
    def from_assumptions(cls, a: dict) -> KindRules:
        b = a["buildings"]
        return cls(
            class_strong=_invert(a["overture_class"]["strong"]),
            class_weak=_invert(a["overture_class"]["weak"]),
            subtype_strong=_invert(a["overture_subtype"]["strong"]),
            subtype_weak=_invert(a["overture_subtype"]["weak"]),
            land_use=_invert(a["land_use_class"]),
            place_specific=_invert(a["places"]["specific"]),
            name_patterns=tuple(
                (re.compile(rf"\b{re.escape(word)}\b", re.IGNORECASE), kind)
                for kind, words in a["name_keywords"].items()
                for word in words
            ),
            min_commercial_places=a["places"]["min_commercial_places"],
            large_footprint_m2=b["large_footprint_m2"],
            house_max_m2_in_residential_area=b["house_max_m2_in_residential_area"],
            terrace_min_elongation=b["terrace_min_elongation"],
        )


@dataclass(frozen=True)
class Evidence:
    footprint_m2: float
    elongation: float = 1.0
    overture_class: str | None = None
    overture_subtype: str | None = None
    name_kind: str | None = None  # from keywords in the building's own name
    places_kind: str | None = None
    land_use_kind: str | None = None
    land_use_source: str = "land_use"  # land_use | land_use_name


def name_kind(name: str | None, rules: KindRules) -> str | None:
    """Kind implied by keywords in a name, e.g. 'Surau Al-Hidayah' -> religious."""
    if not isinstance(name, str) or not name:
        return None
    for pattern, kind in rules.name_patterns:
        if pattern.search(name):
            return kind
    return None


def place_kind(categories: list[str | None], rules: KindRules) -> str | None:
    """Kind implied by the places inside a footprint, or None if inconclusive."""
    specific = [rules.place_specific[c] for c in categories if c in rules.place_specific]
    if specific:
        return Counter(specific).most_common(1)[0][0]
    if len(categories) >= rules.min_commercial_places:
        return "commercial"
    return None


def weak_kind(e: Evidence, rules: KindRules) -> str | None:
    """Kind from a generic tag such as building=residential, if that is all we have."""
    if e.overture_class is not None:
        return rules.class_weak.get(e.overture_class)
    return rules.subtype_weak.get(e.overture_subtype)


def resolve_kind(e: Evidence, rules: KindRules) -> tuple[str, str]:
    """Return (kind, kind_source) for one building."""
    if e.overture_class in rules.class_strong:
        return rules.class_strong[e.overture_class], "overture_class"
    if e.overture_class is None and e.overture_subtype in rules.subtype_strong:
        return rules.subtype_strong[e.overture_subtype], "overture_subtype"
    if e.name_kind is not None:
        return e.name_kind, "building_name"
    if e.places_kind is not None:
        return e.places_kind, "place"
    if e.land_use_kind is not None and e.land_use_kind != "landed_house":
        return e.land_use_kind, e.land_use_source
    if e.land_use_kind == "landed_house":
        # Inside a residential area: house-sized footprints are houses, long thin ones
        # are terrace rows; big compact ones (clubhouse? surau? apartment?) stay open.
        if e.footprint_m2 < rules.house_max_m2_in_residential_area:
            return "landed_house", e.land_use_source
        if e.elongation >= rules.terrace_min_elongation:
            return "landed_house", "land_use_shape"
    weak = weak_kind(e, rules)
    if weak is not None:
        return weak, "overture_class_weak"
    if e.footprint_m2 < rules.large_footprint_m2:
        return "landed_house", "size"
    return "unknown", "size"


def elongation(geoms) -> np.ndarray:
    """Long side / short side of each geometry's minimum rotated rectangle."""
    rects = shapely.oriented_envelope(np.asarray(geoms))
    out = np.ones(len(rects))
    for i, rect in enumerate(rects):
        if rect.geom_type != "Polygon":
            continue
        xy = np.asarray(rect.exterior.coords)
        sides = np.hypot(*np.diff(xy[:3], axis=0).T)
        if sides.min() > 0:
            out[i] = sides.max() / sides.min()
    return out
