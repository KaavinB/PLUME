"""Explainable investigation-priority score.

The score ranks *where to look first*. It is not a measurement of environmental damage, health
risk or total emissions. Each factor is a value in [0, 1] multiplied by a fixed weight; missing
evidence contributes 0 (less evidence → lower priority) and is reported as unavailable.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from datetime import datetime

SCORING_VERSION = "priority-v1"

WEIGHTS: dict[str, float] = {
    "magnitude": 30.0,
    "recurrence": 20.0,
    "provider_persistence": 10.0,
    "corroboration": 10.0,
    "recency": 10.0,
    "measurement_confidence": 10.0,
    "localization": 10.0,
}
assert math.isclose(sum(WEIGHTS.values()), 100.0)

# Magnitude is log-scaled between these bounds (kg/h).
MAG_LOW_KG_H = 50.0
MAG_HIGH_KG_H = 5000.0
RECENCY_HALF_LIFE_DAYS = 365.0
LOCALIZATION_SCALE_M = 150.0


@dataclass(frozen=True)
class ObservationFacts:
    observed_at: datetime
    emission_rate_kg_h: float | None
    emission_uncertainty_kg_h: float | None
    instrument: str | None


@dataclass(frozen=True)
class Factor:
    name: str
    weight: float
    value: float | None  # normalized [0,1]; None if unavailable
    contribution: float
    evidence: str

    def as_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "weight": self.weight,
            "value": None if self.value is None else round(self.value, 4),
            "contribution": round(self.contribution, 2),
            "evidence": self.evidence,
        }


def _clip(x: float) -> float:
    return max(0.0, min(1.0, x))


def score_incident(
    observations: list[ObservationFacts],
    reference_time: datetime,
    spatial_spread_m: float,
    provider_persistence: float | None = None,
) -> tuple[float, list[Factor]]:
    """Return (score 0–100, factors). `reference_time` is fixed (dataset end), so scores reproduce."""
    if not observations:
        raise ValueError("an incident needs at least one observation")
    rates = [o.emission_rate_kg_h for o in observations if o.emission_rate_kg_h is not None]
    factors: list[Factor] = []

    def add(name: str, value: float | None, evidence: str) -> None:
        w = WEIGHTS[name]
        factors.append(Factor(name, w, value, 0.0 if value is None else w * value, evidence))

    # 1. Magnitude: median of quantified rates (robust to a single outlier retrieval)
    if rates:
        med = statistics.median(rates)
        v = _clip(
            math.log10(max(med, MAG_LOW_KG_H) / MAG_LOW_KG_H) / math.log10(MAG_HIGH_KG_H / MAG_LOW_KG_H)
        )
        add("magnitude", v, f"median reported rate {med:,.0f} kg/h over {len(rates)} quantified detection(s)")
    else:
        add("magnitude", None, "no quantified emission rate reported by the provider")

    # 2. Recurrence: distinct UTC dates with a detection (multiple plumes in one scene count once)
    dates = {o.observed_at.date() for o in observations}
    n = len(dates)
    recurrence = {1: 0.0, 2: 0.5, 3: 0.7, 4: 0.85}.get(n, 1.0)
    add(
        "recurrence",
        recurrence,
        f"detections on {n} distinct date(s)"
        + (" — single date, persistence not inferred" if n == 1 else ""),
    )

    # 3. Provider persistence: Carbon Mapper detection-date / overpass-date ratio, if available
    if provider_persistence is not None:
        add(
            "provider_persistence",
            _clip(provider_persistence),
            f"provider-reported persistence {provider_persistence:.2f} (detections ÷ observed overpasses)",
        )
    else:
        add("provider_persistence", None, "provider persistence not available for this grouping")

    # 4. Corroboration by independent instruments
    instruments = {o.instrument for o in observations if o.instrument}
    add(
        "corroboration",
        _clip((len(instruments) - 1) / 2),
        f"{len(instruments)} distinct instrument(s): {', '.join(sorted(instruments)) or 'unknown'}",
    )

    # 5. Recency relative to the dataset reference time
    latest = max(o.observed_at for o in observations)
    age_days = max(0.0, (reference_time - latest).total_seconds() / 86400)
    add(
        "recency",
        0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS),
        f"latest detection {age_days:,.0f} days before dataset reference date",
    )

    # 6. Measurement confidence: 1 − median relative uncertainty
    rel = [
        o.emission_uncertainty_kg_h / o.emission_rate_kg_h
        for o in observations
        if o.emission_rate_kg_h and o.emission_uncertainty_kg_h is not None
    ]
    if rel:
        mr = statistics.median(rel)
        add("measurement_confidence", _clip(1 - mr), f"median relative uncertainty ±{mr:.0%}")
    else:
        add("measurement_confidence", None, "no reported uncertainty")

    # 7. Localization: tight repeated detections → better confidence in where the source is
    if len(observations) == 1:
        add("localization", 0.5, "single detection: plume origin from one retrieval only")
    else:
        add(
            "localization",
            _clip(1 - spatial_spread_m / LOCALIZATION_SCALE_M),
            f"repeat detections within {spatial_spread_m:,.0f} m RMS of the group centroid",
        )

    total = round(sum(f.contribution for f in factors), 2)
    return total, factors


def breakdown_payload(total: float, factors: list[Factor], reference_time: datetime) -> dict[str, object]:
    return {
        "version": SCORING_VERSION,
        "score": total,
        "reference_time": reference_time.isoformat(),
        "factors": [f.as_dict() for f in factors],
        "interpretation": (
            "Operational investigation priority (0–100). Ranks where field investigation is most "
            "likely to be useful; it is not an estimate of environmental or health impact."
        ),
    }
