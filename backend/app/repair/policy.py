"""Verification policy checks evaluated server-side before a verifier may sign VERIFIED."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any, Literal

from app.impact.calculator import ImpactResult

METHODOLOGIES: dict[str, dict[str, Any]] = {
    "REPAIR_COMPLETION": {
        "label": "Verified repair completion",
        "description": "Documented repair plus an independent post-repair survey. No quantified emission reduction is claimed.",
        "required_documents": ["work_order", "pre_repair_survey", "post_repair_survey"],
        "requires_measurements": False,
    },
    "QUANTIFIED_REDUCTION": {
        "label": "Verified quantified reduction",
        "description": "Repair completion plus comparable pre/post site measurements demonstrating a reduction beyond measurement uncertainty.",
        "required_documents": ["work_order", "pre_repair_survey", "post_repair_survey", "measurement_report"],
        "requires_measurements": True,
    },
}

Status = Literal["pass", "fail", "warn", "n/a"]
_INCOMPARABLE = (
    "different methods",
    "predates repair",
    "taken after the repair",
    "Invalid measurement",
    "not documented",
)


@dataclass(frozen=True)
class PolicyCheck:
    id: str
    label: str
    status: Status
    required: bool
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PolicyContext:
    methodology: str
    min_monitoring_days: float
    payload: dict[str, Any]
    funded_at: datetime | None
    now: datetime
    provider_is_project_provider: bool
    provider_approved_onchain: bool
    verifier_approved_onchain: bool
    verifier_wallet: str
    provider_wallet: str
    sponsor_wallet: str
    verifier_org: str
    provider_org: str
    evidence_integrity: tuple[bool, str]
    impact: ImpactResult
    project_is_simulation: bool


def evaluate(ctx: PolicyContext) -> list[PolicyCheck]:
    m = METHODOLOGIES[ctx.methodology]
    p = ctx.payload
    checks: list[PolicyCheck] = []

    present = {d["doc_type"] for d in p.get("documents", [])}
    missing = [d for d in m["required_documents"] if d not in present]
    checks.append(
        PolicyCheck(
            "documentation_complete",
            "Required repair documentation present",
            "pass" if not missing else "fail",
            True,
            f"all of {', '.join(m['required_documents'])} provided"
            if not missing
            else f"missing: {', '.join(missing)}",
        )
    )

    authorized = (
        ctx.provider_is_project_provider
        and ctx.provider_approved_onchain
        and bool(p.get("site_authorization_ref"))
    )
    checks.append(
        PolicyCheck(
            "provider_authorized",
            "Provider is the assigned, approved provider with site authorization",
            "pass" if authorized else "fail",
            True,
            "evidence submitted by the project's provider; provider approved in the escrow registry; site authorization reference supplied"
            if authorized
            else "provider not assigned, not approved on-chain, or no site authorization reference",
        )
    )

    independent = (
        ctx.verifier_wallet.lower() not in {ctx.provider_wallet.lower(), ctx.sponsor_wallet.lower()}
        and ctx.verifier_org.strip().lower() != ctx.provider_org.strip().lower()
        and ctx.verifier_approved_onchain
    )
    checks.append(
        PolicyCheck(
            "verifier_independent",
            "Verifier is approved and independent of provider and sponsor",
            "pass" if independent else "fail",
            True,
            "distinct wallet and organisation; verifier approved in the escrow registry"
            if independent
            else "verifier shares identity/organisation with a party or is not approved",
        )
    )

    rr = p.get("repair_record", {})
    problems: list[str] = []
    try:
        started = datetime.fromisoformat(rr["started_at"])
        completed = datetime.fromisoformat(rr["completed_at"])
        if completed > ctx.now:
            problems.append("repair completion is in the future")
        if ctx.funded_at and started < ctx.funded_at:
            problems.append("repair started before the escrow was funded")
        for meas in (p.get("measurements") or {}).get("post_repair", []):
            if datetime.fromisoformat(meas["measured_at"]) > ctx.now:
                problems.append("a measurement is in the future")
    except (KeyError, ValueError):
        problems.append("repair timestamps missing or invalid")
    checks.append(
        PolicyCheck(
            "timestamps_valid",
            "Repair and measurement timestamps are consistent",
            "pass" if not problems else "fail",
            True,
            "; ".join(problems) or "repair window follows funding; no future-dated records",
        )
    )

    ok, detail = ctx.evidence_integrity
    checks.append(
        PolicyCheck(
            "evidence_hash_consistent",
            "Stored evidence matches the on-chain commitment",
            "pass" if ok else "fail",
            True,
            detail,
        )
    )

    if m["requires_measurements"]:
        meas = p.get("measurements")
        imp = ctx.impact
        checks.append(
            PolicyCheck(
                "measurements_comparable",
                "Pre/post measurements are comparable",
                "pass" if meas and not any(k in imp.reason for k in _INCOMPARABLE) else "fail",
                True,
                f"single method: {meas['method']}" if meas else "no measurements supplied",
            )
        )
        checks.append(
            PolicyCheck(
                "reduction_supported",
                "Reduction exceeds measurement uncertainty",
                "pass" if imp.status == "quantified" else "fail",
                True,
                imp.reason,
            )
        )
        days = (imp.supported_duration_h or 0) / 24
        checks.append(
            PolicyCheck(
                "monitoring_period",
                f"Post-repair monitoring covers ≥ {ctx.min_monitoring_days:g} day(s)",
                "pass" if days >= ctx.min_monitoring_days else "fail",
                True,
                f"{days:.1f} day(s) of post-repair measurements",
            )
        )
    else:
        checks.append(
            PolicyCheck(
                "reduction_claim",
                "Quantified reduction",
                "n/a",
                False,
                "methodology verifies repair completion only; no emission-reduction quantity will be recorded",
            )
        )

    checks.append(
        PolicyCheck(
            "non_detection_not_used",
            "Satellite non-detection not treated as proof",
            "pass",
            False,
            "absence of later plume detections is not used as evidence of repair",
        )
    )
    if ctx.project_is_simulation or p.get("is_simulated"):
        checks.append(
            PolicyCheck(
                "simulation_disclosed",
                "Simulation disclosed",
                "warn",
                False,
                "evidence is a labelled simulation; the outcome demonstrates the workflow, not a real-world repair",
            )
        )
    return checks


def blocking_failures(checks: list[PolicyCheck]) -> list[PolicyCheck]:
    return [c for c in checks if c.required and c.status == "fail"]
