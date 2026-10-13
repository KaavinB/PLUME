"""Provider adapter contract and the normalized observation record shared by all providers."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

# IPCC 2006 source-category codes used by Carbon Mapper's `sector` field.
SECTOR_LABELS: dict[str, str] = {
    "1B2": "Oil & gas",
    "1B1a": "Coal mining",
    "6A": "Solid waste (landfill)",
    "6B": "Wastewater",
    "4B": "Livestock / manure management",
    "1A1": "Energy industries (power)",
    "1A2": "Manufacturing industries",
    "other": "Other",
    "NA": "Not assigned",
    "NULL": "Not assigned",
}


def sector_label(code: str | None) -> str:
    if not code:
        return "Not assigned"
    return SECTOR_LABELS.get(code, code)


@dataclass(frozen=True)
class NormalizedObservation:
    """One plume detection as reported by a provider, normalized to PLUME's schema.

    `emission_rate_kg_h` is only populated when the provider reports a quantified emission rate in
    kg/h. Concentration enhancements (ppm·m) are never converted into rates here.
    """

    provider: str
    external_id: str  # provider's stable identifier (e.g. Carbon Mapper plume UUID)
    display_id: str  # human-facing id (e.g. "emi20250808t144501p10004-A")
    gas: str
    observed_at: datetime
    longitude: float
    latitude: float
    emission_rate_kg_h: float | None
    emission_uncertainty_kg_h: float | None
    instrument: str | None
    platform: str | None
    sector: str | None
    quality: str | None
    footprint_bounds: tuple[float, float, float, float] | None  # (minx, miny, maxx, maxy) of plume raster
    wind_speed_m_s: float | None
    source_url: str
    scene_id: str | None
    raw: dict[str, Any] = field(default_factory=dict, hash=False, compare=False)
    validation_flags: tuple[str, ...] = ()


class ObservationProvider(Protocol):
    name: str

    def fetch_observations(self, **query: Any) -> list[dict[str, Any]]:
        """Return provider-native records (raw payloads)."""
        ...

    def normalize(self, raw: dict[str, Any]) -> NormalizedObservation | None:
        """Normalize a single raw record. Returns None for records that must be excluded."""
        ...
