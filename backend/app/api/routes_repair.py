"""Repair projects, verification, impact ledger, receipts and demo controls."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal, TypeVar

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, select

from app.api.deps import ChainDep, SessionDep, SettingsDep, get_incident_or_404, get_project_or_404
from app.api.serializers import evidence_out, incident_summary, project_brief, user_out, verification_out
from app.auth import current_user, current_user_optional, require_role
from app.chain.client import ChainError
from app.demo import advance_chain_time, reset_demo, simulated_evidence
from app.models import (
    AuditEvent,
    ChainEvent,
    Evidence,
    ImpactReceipt,
    Incident,
    IngestionRun,
    Investigation,
    Observation,
    RepairProject,
    User,
    Verification,
)
from app.repair import service
from app.repair.evidence import EvidencePayload
from app.repair.policy import METHODOLOGIES, blocking_failures
from app.repair.state_machine import allowed_actions

router = APIRouter(prefix="/api/v1")
T = TypeVar("T")


def _run[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except service.ServiceError as exc:
        raise HTTPException(exc.code, str(exc)) from exc


# ---------------------------------------------------------------------------- schemas
class Milestone(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)


class ProjectCreate(BaseModel):
    incident_id: str
    title: str = Field(min_length=5, max_length=200)
    repair_scope: str = Field(min_length=20, max_length=4000)
    site_authorization: str = Field(
        min_length=10, max_length=2000, description="Sponsor attestation of operator authorization"
    )
    milestones: list[Milestone] = Field(min_length=1, max_length=10)
    methodology: Literal["REPAIR_COMPLETION", "QUANTIFIED_REDUCTION"]
    min_monitoring_days: float = Field(default=21, ge=0, le=365)
    additional_requirements: str = Field(default="", max_length=2000)
    funding_amount_eth: str = Field(pattern=r"^\d+(\.\d{1,18})?$")
    provider_id: str
    verifier_id: str
    expires_in_days: int = Field(default=120, ge=1, le=730)
    dispute_window_hours: float = Field(default=0, ge=0, le=720)


class DecisionIn(BaseModel):
    outcome: Literal["VERIFIED", "REJECTED", "INCONCLUSIVE", "ADDITIONAL_EVIDENCE_REQUIRED"]
    notes: str = Field(default="", max_length=4000)


class DisputeIn(BaseModel):
    reason: str = Field(min_length=5, max_length=2000)


# ---------------------------------------------------------------------------- read
def _project_view(session: Any, chain: Any, p: RepairProject, user: User | None) -> dict[str, Any]:
    incident = session.get(Incident, p.incident_id)
    users = {
        u.id: user_out(u).model_dump()
        for u in session.scalars(
            select(User).where(User.id.in_([p.sponsor_id, p.provider_id, p.verifier_id]))
        )
    }
    evidence = session.scalars(
        select(Evidence).where(Evidence.project_id == p.id).order_by(Evidence.round)
    ).all()
    verifs = session.scalars(
        select(Verification).where(Verification.project_id == p.id).order_by(Verification.round)
    ).all()
    receipt = session.scalar(select(ImpactReceipt.id).where(ImpactReceipt.project_id == p.id))
    onchain: dict[str, Any] | None = None
    if chain is not None and p.onchain_project_id is not None:
        try:
            oc = chain.get_project(p.onchain_project_id)
            onchain = {
                "state": oc.state.name,
                "round": oc.round,
                "amount_wei": str(oc.amount),
                "evidence_hash": oc.evidence_hash,
                "terms_hash": oc.terms_hash,
                "last_decision_digest": oc.last_decision_digest,
                "expires_at": oc.expires_at,
                "verified_at": oc.verified_at,
                "dispute_window": oc.dispute_window,
                "escrow_balance_wei": str(chain.balance(chain.address)),
                "chain_time": chain.latest_timestamp(),
            }
        except Exception as exc:  # noqa: BLE001 — show degraded state rather than failing the page
            onchain = {"error": str(exc)}
    actions: list[str] = []
    if user is not None:
        role_owner = {"sponsor": p.sponsor_id, "provider": p.provider_id, "verifier": p.verifier_id}
        if role_owner.get(user.role) == user.id or user.role == "admin":
            actions = allowed_actions(p.status, user.role)
    return {
        **project_brief(p),
        "repair_scope": p.repair_scope,
        "site_authorization": p.site_authorization,
        "milestones": p.milestones,
        "evidence_policy": p.evidence_policy,
        "expires_at": p.expires_at,
        "dispute_window_s": p.dispute_window_s,
        "terms": p.terms,
        "terms_hash": p.terms_hash,
        "chain_id": p.chain_id,
        "contract_address": p.contract_address,
        "evidence_round": p.evidence_round,
        "funded_at_chain": p.funded_at_chain,
        "last_reconciled_at": p.last_reconciled_at,
        "investigation_id": str(p.investigation_id) if p.investigation_id else None,
        "incident": incident_summary(incident).model_dump(mode="json") if incident else None,
        "participants": {
            "sponsor": users.get(p.sponsor_id),
            "provider": users.get(p.provider_id),
            "verifier": users.get(p.verifier_id),
        },
        "evidence": [evidence_out(e) for e in evidence],
        "verifications": [verification_out(v) for v in verifs],
        "receipt_id": receipt,
        "onchain": onchain,
        "allowed_actions": actions,
    }


def _chain_or_none(settings: Any) -> Any:
    from app.chain.client import get_chain

    try:
        c = get_chain(settings)
        return c if c.is_connected() else None
    except ChainError:
        return None


@router.get("/methodologies", tags=["repair"])
def methodologies() -> dict[str, Any]:
    return METHODOLOGIES


@router.get("/repair-projects", tags=["repair"])
def list_projects(
    session: SessionDep, status: str | None = None, incident: str | None = None
) -> dict[str, Any]:
    q = select(RepairProject).order_by(RepairProject.updated_at.desc())
    if status:
        q = q.where(RepairProject.status == status)
    if incident:
        q = q.where(RepairProject.incident_id == get_incident_or_404(session, incident).id)
    items = []
    for p in session.scalars(q):
        inc = session.get(Incident, p.incident_id)
        items.append(
            {
                **project_brief(p),
                "incident_code": inc.code if inc else None,
                "sponsor_id": p.sponsor_id,
                "provider_id": p.provider_id,
                "verifier_id": p.verifier_id,
                "methodology": p.evidence_policy.get("methodology"),
            }
        )
    return {"items": items}


@router.get("/repair-projects/{ref}", tags=["repair"])
def get_project(
    ref: str,
    session: SessionDep,
    settings: SettingsDep,
    user: Annotated[User | None, Depends(current_user_optional)],
) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    return _project_view(session, _chain_or_none(settings), p, user)


@router.get("/repair-projects/{ref}/history", tags=["repair"])
def project_history(ref: str, session: SessionDep, settings: SettingsDep) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    audit = session.scalars(
        select(AuditEvent).where(AuditEvent.resource_id == str(p.id)).order_by(AuditEvent.id)
    ).all()
    events = (
        session.scalars(
            select(ChainEvent)
            .where(
                ChainEvent.onchain_project_id == p.onchain_project_id,
                ChainEvent.contract_address == (p.contract_address or ""),
            )
            .order_by(ChainEvent.block_number, ChainEvent.log_index)
        ).all()
        if p.onchain_project_id is not None
        else []
    )
    return {
        "audit": [
            {
                "id": a.id,
                "actor": a.actor_id,
                "action": a.action,
                "previous_state": a.previous_state,
                "new_state": a.new_state,
                "details": a.details,
                "tx_hash": a.chain_tx_hash,
                "at": a.created_at,
            }
            for a in audit
        ],
        "chain_events": [
            {
                "event": e.event_name,
                "args": e.args,
                "tx_hash": e.tx_hash,
                "block": e.block_number,
                "log_index": e.log_index,
                "block_time": e.block_timestamp,
            }
            for e in events
        ],
        "explorer": settings.chain_explorer_url,
    }


@router.get(
    "/repair-projects/{ref}/evidence/{round_}/files/{name}", tags=["repair"], response_class=FileResponse
)
def evidence_file(ref: str, round_: int, name: str, session: SessionDep) -> FileResponse:
    p = get_project_or_404(session, ref)
    ev = session.scalar(select(Evidence).where(Evidence.project_id == p.id, Evidence.round == round_))
    if ev is None:
        raise HTTPException(404, "evidence round not found")
    entry = next((f for f in ev.manifest.get("files", []) if f["name"] == name), None)
    if entry is None:
        raise HTTPException(404, "file not in manifest")
    path = Path(ev.storage_reference) / entry["stored_as"]
    if not path.exists():
        raise HTTPException(410, "stored file missing")
    return FileResponse(path, media_type=entry["media_type"], filename=entry["name"])


# ---------------------------------------------------------------------------- write
@router.post("/repair-projects", tags=["repair"], status_code=201)
def create_project(
    body: ProjectCreate,
    session: SessionDep,
    settings: SettingsDep,
    user: Annotated[User, Depends(require_role("sponsor"))],
) -> dict[str, Any]:
    inc = get_incident_or_404(session, body.incident_id)
    data = body.model_dump()
    data["incident_id"] = inc.id
    data["milestones"] = [m.model_dump() for m in body.milestones]
    p = _run(lambda: service.create_draft(session, settings, _chain_or_none(settings), user, data))
    return _project_view(session, _chain_or_none(settings), p, user)


def _action(name: str, fn: Callable[..., Any]) -> Callable[..., dict[str, Any]]:
    def endpoint(
        ref: str, session: SessionDep, chain: ChainDep, user: Annotated[User, Depends(current_user)]
    ) -> dict[str, Any]:
        p = get_project_or_404(session, ref)
        _run(lambda: fn(session, chain, user, p.id))
        session.expire_all()
        return _project_view(session, chain, session.get(RepairProject, p.id), user)  # type: ignore[arg-type]

    endpoint.__name__ = f"project_{name}"
    return endpoint


for _name, _fn, _doc in [
    ("publish", service.publish, "Sponsor: register the project in the escrow contract (createProject)."),
    ("fund", service.fund, "Sponsor: deposit the agreed test-network funds into escrow."),
    ("accept", service.accept, "Provider: accept the assignment on-chain."),
    (
        "release",
        service.release,
        "Any participant: release escrow after a VERIFIED decision and issue the Impact Receipt.",
    ),
    ("cancel", service.cancel, "Sponsor: cancel before assignment (refunds escrow if funded)."),
    ("refund", service.refund_expired, "Sponsor: reclaim escrow after expiry without verification."),
]:
    router.add_api_route(
        f"/repair-projects/{{ref}}/{_name}",
        _action(_name, _fn),
        methods=["POST"],
        tags=["repair"],
        description=_doc,
    )


@router.post("/repair-projects/{ref}/start-review", tags=["verification"])
def start_review(
    ref: str, session: SessionDep, settings: SettingsDep, user: Annotated[User, Depends(current_user)]
) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    _run(lambda: service.start_review(session, user, p.id))
    return _project_view(session, _chain_or_none(settings), p, user)


@router.post("/repair-projects/{ref}/submit-evidence", tags=["repair"])
async def submit_evidence(
    ref: str,
    session: SessionDep,
    settings: SettingsDep,
    chain: ChainDep,
    user: Annotated[User, Depends(current_user)],
    payload: Annotated[str, Form(description="EvidencePayload JSON")],
    files: Annotated[list[UploadFile] | None, File()] = None,
) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    try:
        parsed = EvidencePayload.model_validate(json.loads(payload))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(422, f"invalid evidence payload: {exc}") from exc
    blobs = [(f.filename or "file", await f.read(), f.content_type) for f in (files or [])]
    ev = _run(lambda: service.submit_evidence(session, settings, chain, user, p.id, parsed, blobs))
    return {"evidence": evidence_out(ev), "project": _project_view(session, chain, p, user)}


@router.get("/repair-projects/{ref}/simulated-evidence", tags=["repair"])
def simulated_evidence_template(
    ref: str, session: SessionDep, chain: ChainDep, user: Annotated[User, Depends(current_user)]
) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    if user.id != p.provider_id:
        raise HTTPException(403, "only the assigned provider can prepare evidence")
    inc = session.get(Incident, p.incident_id)
    assert inc is not None
    return simulated_evidence(p, inc, datetime.fromtimestamp(chain.latest_timestamp(), UTC))


@router.get("/repair-projects/{ref}/verification-context", tags=["verification"])
def verification_context(ref: str, session: SessionDep, chain: ChainDep) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    ctx = _run(lambda: service.evaluate_policy(session, chain, p))
    session.rollback()  # read-only evaluation; release any row state
    inc = session.get(Incident, p.incident_id)
    inv = session.get(Investigation, p.investigation_id) if p.investigation_id else None
    return {
        "checks": [c.as_dict() for c in ctx["checks"]],
        "blocking": [c.id for c in blocking_failures(ctx["checks"])],
        "impact_preview": ctx["impact"].as_dict(),
        "evidence": evidence_out(ctx["evidence"]),
        "chain_time": ctx["chain_now"].isoformat(),
        "incident": incident_summary(inc).model_dump(mode="json") if inc else None,
        "observations": [
            {
                "display_id": o.display_id,
                "observed_at": o.observed_at,
                "rate": o.emission_rate_kg_h,
                "unc": o.emission_uncertainty_kg_h,
                "instrument": o.instrument,
                "url": o.source_url,
            }
            for o in (inc.observations if inc else [])
        ],
        "post_funding_observations": [
            o.display_id
            for o in (inc.observations if inc else [])
            if p.funded_at_chain and o.observed_at > p.funded_at_chain
        ],
        "investigation_summary": inv.report.get("summary") if inv else None,
        "methodology": METHODOLOGIES[p.evidence_policy["methodology"]],
        "satellite_note": "No satellite observation is used as proof of repair. A later overpass without a detected plume would not "
        "demonstrate that the emission stopped (detection limits, timing, cloud cover, coverage).",
    }


@router.post("/repair-projects/{ref}/verify", tags=["verification"])
def verify(
    ref: str,
    body: DecisionIn,
    session: SessionDep,
    chain: ChainDep,
    user: Annotated[User, Depends(current_user)],
) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    v = _run(lambda: service.decide(session, chain, user, p.id, body.outcome, body.notes))
    return {"verification": verification_out(v), "project": _project_view(session, chain, p, user)}


@router.post("/repair-projects/{ref}/dispute", tags=["repair"])
def dispute(
    ref: str,
    body: DisputeIn,
    session: SessionDep,
    chain: ChainDep,
    user: Annotated[User, Depends(current_user)],
) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    _run(lambda: service.dispute(session, chain, user, p.id, body.reason))
    return _project_view(session, chain, p, user)


@router.post("/repair-projects/{ref}/reconcile", tags=["repair"])
def reconcile(ref: str, session: SessionDep, chain: ChainDep) -> dict[str, Any]:
    p = get_project_or_404(session, ref)
    return _run(lambda: service.reconcile(session, chain, p.id))


# ---------------------------------------------------------------------------- impact & receipts
@router.get("/impact", tags=["impact"])
def impact_ledger(session: SessionDep) -> dict[str, Any]:
    obs_count = session.scalar(select(func.count()).select_from(Observation)) or 0
    quantified = (
        session.scalar(
            select(func.count()).select_from(Observation).where(Observation.emission_rate_kg_h.is_not(None))
        )
        or 0
    )
    incidents = session.scalar(select(func.count()).select_from(Incident)) or 0
    persistent = (
        session.scalar(select(func.count()).select_from(Incident).where(Incident.detection_date_count >= 3))
        or 0
    )
    investigations = session.scalar(select(func.count()).select_from(Investigation)) or 0
    by_status = dict(
        session.execute(select(RepairProject.status, func.count()).group_by(RepairProject.status)).all()
    )
    funded_states = {
        "FUNDED",
        "ASSIGNED",
        "REPAIR_SUBMITTED",
        "UNDER_VERIFICATION",
        "VERIFIED",
        "PAID",
        "REJECTED",
        "INCONCLUSIVE",
        "ADDITIONAL_EVIDENCE_REQUIRED",
        "DISPUTED",
    }
    funded = sum(c for s, c in by_status.items() if s in funded_states)
    escrow_wei = (
        session.scalar(
            select(func.coalesce(func.sum(RepairProject.funding_amount_wei), 0)).where(
                RepairProject.status.in_(funded_states)
            )
        )
        or 0
    )
    submissions = session.scalar(select(func.count()).select_from(Evidence)) or 0
    decisions = dict(
        session.execute(select(Verification.outcome, func.count()).group_by(Verification.outcome)).all()
    )
    receipts = session.scalars(select(ImpactReceipt).order_by(ImpactReceipt.created_at.desc())).all()
    quantified_receipts = [r for r in receipts if r.impact_estimate.get("status") == "quantified"]
    run = session.scalar(select(IngestionRun).order_by(IngestionRun.started_at.desc()))
    return {
        "real_data": {
            "label": "Historical observations (real, provider-reported)",
            "observations_ingested": obs_count,
            "observations_with_emission_estimate": quantified,
            "incidents": incidents,
            "incidents_with_detections_on_3plus_dates": persistent,
            "investigations_completed": investigations,
            "ingestion": run.stats if run else None,
        },
        "workflow": {
            "label": "Repair workflow (simulated projects on a test network)",
            "projects_by_status": by_status,
            "projects_funded_testnet": funded,
            "escrow_committed_test_wei": str(escrow_wei),
            "repair_submissions": submissions,
            "verification_decisions": decisions,
            "verified_completion_events": decisions.get("VERIFIED", 0),
            "receipts_issued": len(receipts),
        },
        "simulated_reductions": {
            "label": "Quantified reductions from SIMULATED evidence — not real-world outcomes",
            "receipts_with_quantified_reduction": len(quantified_receipts),
            "ch4_avoided_kg": sum(r.impact_estimate.get("ch4_avoided_kg") or 0 for r in quantified_receipts),
            "co2e_avoided_kg": sum(
                r.impact_estimate.get("co2e_avoided_kg") or 0 for r in quantified_receipts
            ),
            "methodology": "Σ (pre − post measured rate) × documented post-repair monitoring hours; GWP-100 per IPCC AR6.",
        },
        "real_world_verified_reductions": {
            "label": "Real-world verified reductions",
            "value": None,
            "note": "None. PLUME has not coordinated any real repair.",
        },
        "receipts": [
            {
                "id": r.id,
                "project_id": str(r.project_id),
                "created_at": r.created_at,
                "status": r.impact_estimate.get("status"),
                "ch4_avoided_kg": r.impact_estimate.get("ch4_avoided_kg"),
                "tx": r.chain_tx_hash,
            }
            for r in receipts
        ],
    }


@router.get("/receipts/{rid}", tags=["impact"])
def get_receipt(rid: str, session: SessionDep, settings: SettingsDep) -> dict[str, Any]:
    r = session.get(ImpactReceipt, rid.upper())
    if r is None:
        raise HTTPException(404, "receipt not found")
    p = session.get(RepairProject, r.project_id)
    history = project_history(p.code, session, settings) if p else {}
    inv = session.get(Investigation, p.investigation_id) if p and p.investigation_id else None
    return {
        "id": r.id,
        "created_at": r.created_at,
        "payload": r.payload,
        "payload_sha256": r.payload_sha256,
        "project_code": p.code if p else None,
        "project_id": str(r.project_id),
        "history": history,
        "investigation": {
            "id": str(inv.id),
            "summary": inv.report.get("summary"),
            "kind": inv.report_kind,
            "model": inv.model_identifier,
        }
        if inv
        else None,
        "explorer": settings.chain_explorer_url,
    }


# ---------------------------------------------------------------------------- demo controls
class AdvanceTime(BaseModel):
    days: float = Field(gt=0, le=120)


@router.post("/demo/advance-time", tags=["demo"])
def demo_advance_time(
    body: AdvanceTime, settings: SettingsDep, chain: ChainDep, user: Annotated[User, Depends(current_user)]
) -> dict[str, Any]:
    if not settings.demo_mode or chain.chain_id != 31337:
        raise HTTPException(403, "simulated time is only available in demo mode on the local chain")
    if user.role == "observer":
        raise HTTPException(403, "observers have read-only access")
    return advance_chain_time(chain, body.days)


@router.post("/demo/reset", tags=["demo"])
def demo_reset(
    session: SessionDep, settings: SettingsDep, user: Annotated[User, Depends(require_role("admin"))]
) -> dict[str, Any]:
    if not settings.demo_mode or settings.chain_id != 31337:
        raise HTTPException(403, "reset is only available in demo mode on the local chain")
    return reset_demo(session)


_ = Observation
