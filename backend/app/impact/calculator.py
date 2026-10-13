"""Methane impact accounting.

  avoided CH4 [kg]  = supported reduction in emission rate [kg/h] × supported duration [h]
  avoided CO2e [kg] = avoided CH4 [kg] × GWP

The supported duration is only the period covered by post-repair measurements — never an assumed
future lifetime. Satellite instantaneous rates are never used as the baseline for a reduction claim.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

CALCULATION_VERSION = "impact-v1"

# IPCC AR6 WG1 Chapter 7, Table 7.15 (100-year GWP). Fossil CH4 includes the CO2 from oxidation.
GWP100 = {
    "fossil": (29.8, 11.0, "IPCC AR6 WG1 Ch.7 Table 7.15 — CH4 (fossil origin) GWP-100 = 29.8 ± 11"),
    "non_fossil": (27.0, 11.0, "IPCC AR6 WG1 Ch.7 Table 7.15 — CH4 (non-fossil origin) GWP-100 = 27.0 ± 11"),
}
GWP_SOURCE_URL = "https://www.ipcc.ch/report/ar6/wg1/chapter/chapter-7/"
FOSSIL_SECTORS = {"1B2", "1B1a", "1A1", "1A2"}


def gwp_for_sector(sector: str | None) -> tuple[str, float, float, str]:
    key = "fossil" if (sector in FOSSIL_SECTORS or sector is None) else "non_fossil"
    v, u, ref = GWP100[key]
    return key, v, u, ref


@dataclass(frozen=True)
class Measurement:
    rate_kg_h: float
    uncertainty_kg_h: float  # 1-sigma
    measured_at: datetime
    method: str


@dataclass(frozen=True)
class ImpactResult:
    calculation_version: str
    status: str  # quantified | not_quantified
    reason: str
    baseline_rate_kg_h: float | None
    baseline_uncertainty_kg_h: float | None
    post_rate_kg_h: float | None
    post_uncertainty_kg_h: float | None
    reduction_rate_kg_h: float | None
    reduction_uncertainty_kg_h: float | None
    supported_duration_h: float | None
    duration_basis: str | None
    ch4_avoided_kg: float | None
    ch4_avoided_kg_low: float | None
    ch4_avoided_kg_high: float | None
    gwp_basis: str
    gwp_value: float
    gwp_reference: str
    gwp_source_url: str
    co2e_avoided_kg: float | None
    co2e_avoided_kg_low: float | None
    co2e_avoided_kg_high: float | None
    assumptions: list[str]
    is_simulated: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def compute_impact(
    sector: str | None,
    pre: Measurement | None,
    post: list[Measurement],
    repair_completed_at: datetime | None,
    is_simulated: bool,
    sigma: float = 1.0,
) -> ImpactResult:
    gwp_key, gwp, _gwp_unc, gwp_ref = gwp_for_sector(sector)
    assumptions = [
        "Reduction = pre-repair measured rate − mean post-repair measured rate (same method).",
        "Duration = time from repair completion to the last post-repair measurement only; no extrapolation.",
        f"Interval shown is ±{sigma:g}σ from measurement uncertainty (combined in quadrature); GWP uncertainty (±11) is reported separately, not propagated.",
        "Satellite plume detections are context for the incident; they are not used as the baseline.",
    ]

    def empty(reason: str) -> ImpactResult:
        return ImpactResult(
            CALCULATION_VERSION,
            "not_quantified",
            reason,
            pre.rate_kg_h if pre else None,
            pre.uncertainty_kg_h if pre else None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            gwp_key,
            gwp,
            gwp_ref,
            GWP_SOURCE_URL,
            None,
            None,
            None,
            assumptions,
            is_simulated,
        )

    if pre is None or not post:
        return empty("Pre- and post-repair measurements are both required to quantify a reduction.")
    if repair_completed_at is None:
        return empty("Repair completion time is not documented.")
    methods = {pre.method, *(m.method for m in post)}
    if len(methods) != 1:
        return empty(f"Measurements use different methods ({', '.join(sorted(methods))}); not comparable.")
    if any(m.measured_at <= repair_completed_at for m in post):
        return empty("A post-repair measurement predates repair completion.")
    if pre.measured_at >= repair_completed_at:
        return empty("The pre-repair measurement was taken after the repair was completed.")
    for m in [pre, *post]:
        if m.rate_kg_h < 0 or m.uncertainty_kg_h < 0 or not math.isfinite(m.rate_kg_h):
            return empty("Invalid measurement value.")

    n = len(post)
    post_mean = sum(m.rate_kg_h for m in post) / n
    post_unc = math.sqrt(sum(m.uncertainty_kg_h**2 for m in post)) / n
    reduction = pre.rate_kg_h - post_mean
    red_unc = math.hypot(pre.uncertainty_kg_h, post_unc)
    if reduction - sigma * red_unc <= 0:
        return empty(
            f"Measured reduction {reduction:,.1f} ± {red_unc:,.1f} kg/h is not distinguishable from zero at {sigma:g}σ."
        )
    last = max(m.measured_at for m in post)
    hours = (last - repair_completed_at).total_seconds() / 3600
    if hours <= 0:
        return empty("No supported post-repair duration.")

    ch4 = reduction * hours
    lo, hi = (reduction - sigma * red_unc) * hours, (reduction + sigma * red_unc) * hours
    return ImpactResult(
        calculation_version=CALCULATION_VERSION,
        status="quantified",
        reason="Reduction supported by comparable pre/post measurements over the documented monitoring period.",
        baseline_rate_kg_h=pre.rate_kg_h,
        baseline_uncertainty_kg_h=pre.uncertainty_kg_h,
        post_rate_kg_h=post_mean,
        post_uncertainty_kg_h=post_unc,
        reduction_rate_kg_h=reduction,
        reduction_uncertainty_kg_h=red_unc,
        supported_duration_h=hours,
        duration_basis=f"{repair_completed_at.isoformat()} → {last.isoformat()} ({n} post-repair measurement(s))",
        ch4_avoided_kg=ch4,
        ch4_avoided_kg_low=lo,
        ch4_avoided_kg_high=hi,
        gwp_basis=gwp_key,
        gwp_value=gwp,
        gwp_reference=gwp_ref,
        gwp_source_url=GWP_SOURCE_URL,
        co2e_avoided_kg=ch4 * gwp,
        co2e_avoided_kg_low=lo * gwp,
        co2e_avoided_kg_high=hi * gwp,
        assumptions=assumptions,
        is_simulated=is_simulated,
    )
