"""Building height cascade: measured height -> floor count -> typical height for the kind."""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class HeightEstimate:
    height_m: float
    storeys: int
    source: str  # measured | floors | type_rule
    confidence: float


def _present(value) -> bool:
    return value is not None and not (isinstance(value, float) and math.isnan(value)) and value > 0


def estimate_height(
    height: float | None,
    num_floors: float | None,
    kind: str,
    kind_source: str,
    kinds: dict,
    confidence: dict,
) -> HeightEstimate:
    """Best available height (m) for one building, with where it came from."""
    k = kinds.get(kind, kinds["unknown"])
    ftf, roof = k["floor_to_floor_m"], k["roof_m"]
    if _present(height):
        storeys = max(1, round((height - roof) / ftf))
        return HeightEstimate(float(height), storeys, "measured", confidence["measured"])
    if _present(num_floors):
        storeys = int(num_floors)
        return HeightEstimate(storeys * ftf + roof, storeys, "floors", confidence["floors"])
    storeys = k["storeys"]
    return HeightEstimate(
        storeys * ftf + roof, storeys, "type_rule", confidence["type_rule"][kind_source]
    )
