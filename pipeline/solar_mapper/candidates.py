"""Decide which buildings get the full solar analysis in later phases."""

from __future__ import annotations

CANDIDATE = "candidate"
PROGRAMME = "residential_programme"
EXCLUDED = "excluded"


def assign_role(kind: str, roof_m2: float, rules: dict) -> tuple[str, str]:
    """Return (role, reason). ``rules`` is the ``candidates`` block of assumptions.yaml."""
    if kind in rules["excluded_kinds"]:
        return EXCLUDED, f"{kind}_structure"
    if kind in rules["programme_kinds"]:
        return PROGRAMME, ""
    if roof_m2 < rules["min_roof_m2"]:
        return EXCLUDED, "roof_too_small"
    return CANDIDATE, ""


def build_flags(
    height_source: str,
    kind: str,
    kind_source: str,
    source_dataset: str | None,
    in_construction_zone: bool,
    class_overridden: bool,
) -> str:
    """Semicolon-separated data-quality flags shown to users next to each site."""
    flags = []
    if height_source != "measured":
        flags.append("height_estimated")
    if kind == "unknown":
        flags.append("type_unknown")
    elif kind_source not in ("overture_class", "overture_subtype"):
        flags.append("type_inferred")
    if class_overridden:
        flags.append("tag_overridden")
    if source_dataset in ("Google Open Buildings", "Microsoft ML Buildings"):
        flags.append("ml_footprint")
    if in_construction_zone:
        flags.append("construction_zone")
    return ";".join(flags)
