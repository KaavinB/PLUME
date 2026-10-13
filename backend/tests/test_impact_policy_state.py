from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.impact.calculator import Measurement, compute_impact, gwp_for_sector
from app.repair.evidence import EvidencePayload, store_bundle, verify_bundle
from app.repair.policy import PolicyContext, blocking_failures, evaluate
from app.repair.state_machine import TransitionError, allowed_actions, check_transition

T = datetime(2026, 1, 1, tzinfo=UTC)
M = "ground quantification"


def m(rate: float, unc: float, days: float) -> Measurement:
    return Measurement(rate, unc, T + timedelta(days=days), M)


# ------------------------------------------------------------------ impact
def test_impact_formula_and_units() -> None:
    r = compute_impact(
        "1B2", m(1000, 100, -1), [m(40, 10, 7), m(20, 10, 14)], T + timedelta(days=1), is_simulated=True
    )
    assert r.status == "quantified"
    assert r.reduction_rate_kg_h == pytest.approx(1000 - 30)
    assert r.supported_duration_h == pytest.approx(13 * 24)  # completion (day 1) → last measurement (day 14)
    assert r.ch4_avoided_kg == pytest.approx(970 * 13 * 24)
    assert r.co2e_avoided_kg == pytest.approx(r.ch4_avoided_kg * 29.8)
    assert r.ch4_avoided_kg_low < r.ch4_avoided_kg < r.ch4_avoided_kg_high


def test_gwp_by_origin() -> None:
    assert gwp_for_sector("1B2")[1] == 29.8
    assert gwp_for_sector("6A")[1] == 27.0


def test_no_extrapolation_beyond_monitoring() -> None:
    a = compute_impact("1B2", m(500, 50, -1), [m(10, 5, 2)], T, True)
    b = compute_impact("1B2", m(500, 50, -1), [m(10, 5, 30)], T, True)
    assert b.ch4_avoided_kg / a.ch4_avoided_kg == pytest.approx(30 / 2)


@pytest.mark.parametrize(
    ("pre", "post", "completed", "reason"),
    [
        (None, [m(10, 1, 3)], T, "required"),
        (m(100, 10, -1), [], T, "required"),
        (m(100, 10, -1), [m(10, 1, 3)], None, "not documented"),
        (m(100, 60, -1), [m(60, 60, 3)], T, "not distinguishable"),
        (m(100, 10, -1), [m(10, 1, -0.5)], T, "predates"),
        (m(100, 10, 1), [m(10, 1, 3)], T, "after the repair"),
        (m(100, 10, -1), [Measurement(10, 1, T + timedelta(days=3), "other method")], T, "different methods"),
    ],
)
def test_impact_refuses_unsupported_claims(pre, post, completed, reason) -> None:  # type: ignore[no-untyped-def]
    r = compute_impact("1B2", pre, post, completed, True)
    assert r.status == "not_quantified" and reason in r.reason
    assert r.ch4_avoided_kg is None


# ------------------------------------------------------------------ state machine
def test_happy_path_transitions() -> None:
    s = "DRAFT"
    for action, role in [
        ("publish", "sponsor"),
        ("fund", "sponsor"),
        ("accept", "provider"),
        ("submit_evidence", "provider"),
        ("start_review", "verifier"),
    ]:
        s = check_transition(action, s, role)
    s = check_transition("decide", s, "verifier", "VERIFIED")
    assert check_transition("release", s, "provider") == "PAID"


@pytest.mark.parametrize(
    ("action", "state", "role", "code"),
    [
        ("fund", "DRAFT", "sponsor", 409),
        ("fund", "OPEN_FOR_FUNDING", "provider", 403),
        ("decide", "UNDER_VERIFICATION", "sponsor", 403),
        ("decide", "UNDER_VERIFICATION", "provider", 403),
        ("release", "REJECTED", "provider", 409),
        ("release", "INCONCLUSIVE", "sponsor", 409),
        ("release", "PAID", "provider", 409),
        ("submit_evidence", "PAID", "provider", 409),
        ("cancel", "ASSIGNED", "sponsor", 409),
        ("release", "VERIFIED", "observer", 403),
    ],
)
def test_invalid_transitions_rejected(action: str, state: str, role: str, code: int) -> None:
    with pytest.raises(TransitionError) as e:
        check_transition(action, state, role, "VERIFIED")
    assert e.value.code == code


def test_resubmission_after_rejection_allowed() -> None:
    assert check_transition("submit_evidence", "REJECTED", "provider") == "REPAIR_SUBMITTED"
    assert "submit_evidence" in allowed_actions("ADDITIONAL_EVIDENCE_REQUIRED", "provider")


def test_unknown_outcome_rejected() -> None:
    with pytest.raises(TransitionError):
        check_transition("decide", "UNDER_VERIFICATION", "verifier", "APPROVED")


# ------------------------------------------------------------------ evidence & policy
def payload(docs: list[str], measurements: bool = True) -> EvidencePayload:
    return EvidencePayload.model_validate(
        {
            "is_simulated": True,
            "site_authorization_ref": "SIM-AUTH-1",
            "repair_record": {
                "work_summary": "Replaced a failed seal on a tank hatch.",
                "components_repaired": ["seal"],
                "started_at": (T - timedelta(days=2)).isoformat(),
                "completed_at": (T - timedelta(days=1)).isoformat(),
                "performed_by": "Test Provider",
            },
            "documents": [{"doc_type": d, "title": d, "description": "", "file_name": None} for d in docs],
            "measurements": {
                "method": M,
                "pre_repair": {
                    "rate_kg_h": 1000,
                    "uncertainty_kg_h": 100,
                    "measured_at": (T - timedelta(days=3)).isoformat(),
                },
                "post_repair": [
                    {
                        "rate_kg_h": 30,
                        "uncertainty_kg_h": 10,
                        "measured_at": (T + timedelta(days=d)).isoformat(),
                    }
                    for d in (7, 25)
                ],
            }
            if measurements
            else None,
            "notes": "",
        }
    )


def test_bundle_commitment_detects_tampering(tmp_path: Path) -> None:
    commit, manifest, path = store_bundle(
        tmp_path,
        "RP-T",
        1,
        {"project_code": "RP-T"},
        payload(["work_order"]),
        [("a.txt", b"hello", "text/plain")],
    )
    assert verify_bundle(path, commit)[0]
    stored = Path(path) / manifest["files"][0]["stored_as"]
    stored.write_bytes(b"tampered")
    ok, why = verify_bundle(path, commit)
    assert not ok and "changed" in why


def test_bundle_rejects_disallowed_media(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        store_bundle(
            tmp_path, "RP-T", 1, {}, payload(["work_order"]), [("x.exe", b"MZ", "application/x-msdownload")]
        )


def ctx(p: EvidencePayload, **over) -> PolicyContext:  # type: ignore[no-untyped-def]
    pd = p.model_dump(mode="json")
    meas = pd["measurements"]
    impact = compute_impact(
        "1B2",
        Measurement(
            meas["pre_repair"]["rate_kg_h"],
            meas["pre_repair"]["uncertainty_kg_h"],
            datetime.fromisoformat(meas["pre_repair"]["measured_at"]),
            M,
        )
        if meas
        else None,
        [
            Measurement(x["rate_kg_h"], x["uncertainty_kg_h"], datetime.fromisoformat(x["measured_at"]), M)
            for x in (meas or {}).get("post_repair", [])
        ],
        datetime.fromisoformat(pd["repair_record"]["completed_at"]),
        True,
    )
    base = dict(
        methodology="QUANTIFIED_REDUCTION",
        min_monitoring_days=21,
        payload=pd,
        funded_at=T - timedelta(days=5),
        now=T + timedelta(days=30),
        provider_is_project_provider=True,
        provider_approved_onchain=True,
        verifier_approved_onchain=True,
        verifier_wallet="0xV",
        provider_wallet="0xP",
        sponsor_wallet="0xS",
        verifier_org="Lab",
        provider_org="Contractor",
        evidence_integrity=(True, "ok"),
        impact=impact,
        project_is_simulation=True,
    )
    base.update(over)
    return PolicyContext(**base)  # type: ignore[arg-type]


FULL = ["work_order", "pre_repair_survey", "post_repair_survey", "measurement_report"]


def test_policy_passes_complete_evidence() -> None:
    assert blocking_failures(evaluate(ctx(payload(FULL)))) == []


@pytest.mark.parametrize(
    ("over", "check"),
    [
        ({"provider_approved_onchain": False}, "provider_authorized"),
        ({"verifier_wallet": "0xP"}, "verifier_independent"),
        ({"verifier_org": "Contractor"}, "verifier_independent"),
        ({"evidence_integrity": (False, "mismatch")}, "evidence_hash_consistent"),
        ({"funded_at": T + timedelta(days=1)}, "timestamps_valid"),
        ({"min_monitoring_days": 60}, "monitoring_period"),
    ],
)
def test_policy_blocks(over: dict, check: str) -> None:
    assert check in [c.id for c in blocking_failures(evaluate(ctx(payload(FULL), **over)))]


def test_missing_document_blocks() -> None:
    assert "documentation_complete" in [c.id for c in blocking_failures(evaluate(ctx(payload(FULL[:-1]))))]


def test_completion_methodology_makes_no_reduction_claim() -> None:
    checks = evaluate(ctx(payload(FULL[:3], measurements=False), methodology="REPAIR_COMPLETION"))
    assert not blocking_failures(checks)
    assert next(c for c in checks if c.id == "reduction_claim").status == "n/a"
