"""Repair project workflow: authorization → lifecycle check → contract transaction → state + audit.

Every state-changing action locks the project row (SELECT … FOR UPDATE) so concurrent or repeated
requests cannot both pass the lifecycle check. On-chain actions are sent before the database is
updated; if the database write fails after a mined transaction, `reconcile` restores consistency
from the chain, which is authoritative for funding and settlement state.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from hexbytes import HexBytes
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.chain.client import (
    CHAIN_TO_STATUS,
    ChainClient,
    ChainError,
    ChainState,
    Outcome,
    TxResult,
    canonical_status,
)
from app.config import Settings
from app.impact.calculator import Measurement, compute_impact
from app.models import (
    AuditEvent,
    ChainEvent,
    Evidence,
    ImpactReceipt,
    Incident,
    Investigation,
    RepairProject,
    User,
    Verification,
)
from app.repair import policy as policy_mod
from app.repair.evidence import EvidencePayload, canonical_json, keccak_hex, store_bundle, verify_bundle
from app.repair.state_machine import TransitionError, check_transition

log = logging.getLogger(__name__)
WEI = Decimal(10) ** 18


class ServiceError(Exception):
    def __init__(self, message: str, code: int = 400) -> None:
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------- helpers
def _audit(
    session: Session,
    actor: User | None,
    action: str,
    project: RepairProject,
    prev: str | None,
    new: str | None,
    details: dict[str, Any] | None = None,
    tx: str | None = None,
) -> None:
    session.add(
        AuditEvent(
            actor_id=actor.id if actor else None,
            action=action,
            resource_type="repair_project",
            resource_id=str(project.id),
            previous_state=prev,
            new_state=new,
            details=details or {},
            chain_tx_hash=tx,
        )
    )


def _index(session: Session, chain: ChainClient, tx: TxResult) -> None:
    for ev in tx.events:
        _upsert_event(session, chain, ev, datetime.fromtimestamp(tx.block_timestamp, UTC))


def _upsert_event(session: Session, chain: ChainClient, ev: dict[str, Any], ts: datetime | None) -> None:
    args = {k: (str(v) if isinstance(v, int) and abs(v) > 2**53 else v) for k, v in ev["args"].items()}
    stmt = (
        pg_insert(ChainEvent)
        .values(
            chain_id=chain.chain_id,
            contract_address=chain.address,
            block_number=ev["block_number"],
            tx_hash=ev["tx_hash"],
            log_index=ev["log_index"],
            event_name=ev["event"],
            onchain_project_id=int(ev["args"]["projectId"]) if "projectId" in ev["args"] else None,
            args=args,
            block_timestamp=ts,
        )
        .on_conflict_do_nothing(constraint="uq_chain_event")
    )
    session.execute(stmt)


def lock_project(session: Session, project_id: uuid.UUID) -> RepairProject:
    p = session.scalar(select(RepairProject).where(RepairProject.id == project_id).with_for_update())
    if p is None:
        raise ServiceError("repair project not found", 404)
    return p


def _require_participant(user: User, project: RepairProject, *, as_: str) -> None:
    owner = {"sponsor": project.sponsor_id, "provider": project.provider_id, "verifier": project.verifier_id}[
        as_
    ]
    if user.id != owner:
        raise ServiceError(f"only this project's {as_} may perform this action", 403)


def _hd(user: User) -> int:
    if user.hd_index is None:
        raise ServiceError("user has no on-chain signing identity", 400)
    return user.hd_index


def _transition(action: str, project: RepairProject, user: User, outcome: str | None = None) -> str:
    try:
        return check_transition(action, project.status, user.role, outcome)
    except TransitionError as exc:
        raise ServiceError(str(exc), exc.code) from exc


def _send(chain: ChainClient, hd: int, fn: str, *args: Any, value: int = 0) -> TxResult:
    try:
        return chain.transact(hd, fn, *args, value=value)
    except ChainError as exc:
        raise ServiceError(str(exc), 409) from exc


def _chain_now(chain: ChainClient) -> datetime:
    return datetime.fromtimestamp(chain.latest_timestamp(), UTC)


def _require_chain_state(chain: ChainClient, project: RepairProject, expected: ChainState) -> None:
    if project.onchain_project_id is None:
        raise ServiceError("project is not on-chain", 409)
    actual = chain.get_project(project.onchain_project_id).state
    if actual != expected:
        raise ServiceError(f"on-chain state is {actual.name}, expected {expected.name}; run reconcile", 409)


# --------------------------------------------------------------------------- creation
def create_draft(
    session: Session, settings: Settings, chain: ChainClient | None, sponsor: User, data: dict[str, Any]
) -> RepairProject:
    if sponsor.role != "sponsor":
        raise ServiceError("only sponsors can create repair projects", 403)
    incident = session.get(Incident, data["incident_id"])
    if incident is None:
        raise ServiceError("incident not found", 404)
    investigation = session.scalar(
        select(Investigation)
        .where(Investigation.incident_id == incident.id)
        .order_by(Investigation.created_at.desc())
    )
    if investigation is None:
        raise ServiceError("an incident must be investigated before a repair project can be created", 409)
    provider = session.get(User, data["provider_id"])
    verifier = session.get(User, data["verifier_id"])
    if provider is None or provider.role != "provider":
        raise ServiceError("provider must be a registered repair provider", 422)
    if verifier is None or verifier.role != "verifier":
        raise ServiceError("verifier must be a registered independent verifier", 422)
    if len({sponsor.id, provider.id, verifier.id}) != 3 or verifier.organization == provider.organization:
        raise ServiceError("sponsor, provider and verifier must be independent parties", 422)
    methodology = data["methodology"]
    if methodology not in policy_mod.METHODOLOGIES:
        raise ServiceError("unknown verification methodology", 422)
    amount_wei = int(Decimal(str(data["funding_amount_eth"])) * WEI)
    if amount_wei <= 0 or amount_wei >= 2**96:
        raise ServiceError("funding amount out of range", 422)
    expires_at = datetime.now(UTC) + timedelta(days=int(data["expires_in_days"]))
    # Chain time may run ahead of wall time in the local simulation; expiry is measured on-chain.
    if chain is not None:
        expires_at = max(expires_at, _chain_now(chain) + timedelta(days=int(data["expires_in_days"])))

    policy = {
        "methodology": methodology,
        **policy_mod.METHODOLOGIES[methodology],
        "min_monitoring_days": float(data.get("min_monitoring_days", 7)),
        "additional_requirements": data.get("additional_requirements", ""),
    }
    code = "RP-" + secrets.token_hex(3).upper()
    terms = {
        "schema": "plume.terms.v1",
        "project_code": code,
        "incident": {"code": incident.code, "id": str(incident.id)},
        "investigation_id": str(investigation.id),
        "source_observations": [o.display_id for o in incident.observations],
        "title": data["title"],
        "repair_scope": data["repair_scope"],
        "site_authorization": data["site_authorization"],
        "milestones": data["milestones"],
        "evidence_policy": policy,
        "funding_amount_wei": str(amount_wei),
        "sponsor_wallet": sponsor.wallet_address,
        "provider_wallet": provider.wallet_address,
        "verifier_wallet": verifier.wallet_address,
        "expires_at": expires_at.isoformat(),
        "dispute_window_s": int(data.get("dispute_window_hours", 0) * 3600),
        "chain_id": settings.chain_id,
        "is_simulation": True,
        "disclaimer": "Simulated repair project on a test network. Not real-world funding.",
    }
    project = RepairProject(
        code=code,
        incident_id=incident.id,
        investigation_id=investigation.id,
        sponsor_id=sponsor.id,
        provider_id=provider.id,
        verifier_id=verifier.id,
        title=data["title"],
        repair_scope=data["repair_scope"],
        site_authorization=data["site_authorization"],
        milestones=data["milestones"],
        evidence_policy=policy,
        funding_amount_wei=Decimal(amount_wei),
        expires_at=expires_at,
        dispute_window_s=terms["dispute_window_s"],
        terms=terms,
        terms_hash=keccak_hex(canonical_json(terms)),
        status="DRAFT",
        is_simulation=True,
    )
    session.add(project)
    session.flush()
    _audit(session, sponsor, "create_draft", project, None, "DRAFT", {"terms_hash": project.terms_hash})
    if incident.status in ("open", "investigated"):
        incident.status = "repair_project"
    session.commit()
    return project


# --------------------------------------------------------------------------- on-chain lifecycle
def publish(session: Session, chain: ChainClient, user: User, project_id: uuid.UUID) -> RepairProject:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="sponsor")
    new = _transition("publish", p, user)
    provider = session.get(User, p.provider_id)
    verifier = session.get(User, p.verifier_id)
    assert provider and verifier
    tx = _send(
        chain,
        _hd(user),
        "createProject",
        provider.wallet_address,
        verifier.wallet_address,
        int(p.funding_amount_wei),
        HexBytes(p.terms_hash),
        int(p.expires_at.timestamp()),
        p.dispute_window_s,
    )
    created = next(e for e in tx.events if e["event"] == "ProjectCreated")
    prev = p.status
    p.onchain_project_id = int(created["args"]["projectId"])
    p.chain_id = chain.chain_id
    p.contract_address = chain.address
    p.status = new
    _index(session, chain, tx)
    _audit(
        session,
        user,
        "publish",
        p,
        prev,
        new,
        {"onchain_project_id": p.onchain_project_id, "gas_used": tx.gas_used},
        tx.tx_hash,
    )
    session.commit()
    return p


def fund(session: Session, chain: ChainClient, user: User, project_id: uuid.UUID) -> RepairProject:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="sponsor")
    new = _transition("fund", p, user)
    _require_chain_state(chain, p, ChainState.OPEN)
    tx = _send(chain, _hd(user), "fund", p.onchain_project_id, value=int(p.funding_amount_wei))
    prev, p.status = p.status, new
    p.funded_at_chain = datetime.fromtimestamp(tx.block_timestamp, UTC)
    _index(session, chain, tx)
    _audit(
        session,
        user,
        "fund",
        p,
        prev,
        new,
        {"amount_wei": str(p.funding_amount_wei), "gas_used": tx.gas_used},
        tx.tx_hash,
    )
    session.commit()
    return p


def accept(session: Session, chain: ChainClient, user: User, project_id: uuid.UUID) -> RepairProject:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="provider")
    new = _transition("accept", p, user)
    tx = _send(chain, _hd(user), "acceptAssignment", p.onchain_project_id)
    prev, p.status = p.status, new
    _index(session, chain, tx)
    _audit(session, user, "accept_assignment", p, prev, new, {"gas_used": tx.gas_used}, tx.tx_hash)
    session.commit()
    return p


def submit_evidence(
    session: Session,
    settings: Settings,
    chain: ChainClient,
    user: User,
    project_id: uuid.UUID,
    payload: EvidencePayload,
    files: list[tuple[str, bytes, str | None]],
) -> Evidence:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="provider")
    new = _transition("submit_evidence", p, user)
    if p.is_simulation and not payload.is_simulated:
        raise ServiceError("this is a simulated project: evidence must be flagged is_simulated=true", 422)
    declared = {d.file_name for d in payload.documents if d.file_name}
    uploaded = {name for name, _, _ in files}
    if declared - uploaded:
        raise ServiceError(f"declared files not uploaded: {sorted(declared - uploaded)}", 422)
    round_ = p.evidence_round + 1
    header = {
        "project_code": p.code,
        "onchain_project_id": p.onchain_project_id,
        "chain_id": p.chain_id,
        "contract": p.contract_address,
        "submitted_by_wallet": user.wallet_address,
        "terms_hash": p.terms_hash,
    }
    try:
        commitment, manifest, path = store_bundle(
            settings.evidence_dir, p.code, round_, header, payload, files
        )
    except ValueError as exc:
        raise ServiceError(str(exc), 422) from exc
    tx = _send(chain, _hd(user), "submitEvidence", p.onchain_project_id, HexBytes(commitment))
    onchain_round = next(int(e["args"]["round"]) for e in tx.events if e["event"] == "EvidenceSubmitted")
    if onchain_round != round_:
        log.warning("evidence round drift", extra={"db": round_, "chain": onchain_round})
    ev = Evidence(
        project_id=p.id,
        round=onchain_round,
        submitted_by=user.id,
        evidence_type="repair_completion",
        content_hash=commitment,
        manifest=manifest,
        storage_reference=path,
        is_simulated=payload.is_simulated,
        tx_hash=tx.tx_hash,
    )
    session.add(ev)
    prev = p.status
    p.status, p.evidence_round = new, onchain_round
    _index(session, chain, tx)
    _audit(
        session,
        user,
        "submit_evidence",
        p,
        prev,
        new,
        {"round": onchain_round, "evidence_hash": commitment, "files": len(files)},
        tx.tx_hash,
    )
    session.commit()
    return ev


def start_review(session: Session, user: User, project_id: uuid.UUID) -> RepairProject:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="verifier")
    new = _transition("start_review", p, user)
    prev, p.status = p.status, new
    _audit(session, user, "start_review", p, prev, new, {"round": p.evidence_round})
    session.commit()
    return p


def latest_evidence(session: Session, project: RepairProject) -> Evidence | None:
    return session.scalar(
        select(Evidence).where(Evidence.project_id == project.id).order_by(Evidence.round.desc())
    )


def _impact_from_payload(project: RepairProject, sector: str | None, payload: dict[str, Any]) -> Any:
    meas = payload.get("measurements")
    pre = post = None
    if meas:
        pre = Measurement(
            meas["pre_repair"]["rate_kg_h"],
            meas["pre_repair"]["uncertainty_kg_h"],
            datetime.fromisoformat(meas["pre_repair"]["measured_at"]),
            meas["method"],
        )
        post = [
            Measurement(
                m["rate_kg_h"],
                m["uncertainty_kg_h"],
                datetime.fromisoformat(m["measured_at"]),
                meas["method"],
            )
            for m in meas["post_repair"]
        ]
    completed = payload.get("repair_record", {}).get("completed_at")
    return compute_impact(
        sector,
        pre,
        post or [],
        datetime.fromisoformat(completed) if completed else None,
        is_simulated=bool(payload.get("is_simulated")) or project.is_simulation,
    )


def evaluate_policy(session: Session, chain: ChainClient, project: RepairProject) -> dict[str, Any]:
    ev = latest_evidence(session, project)
    if ev is None:
        raise ServiceError("no evidence submitted", 409)
    onchain = chain.get_project(project.onchain_project_id) if project.onchain_project_id else None
    integrity = verify_bundle(ev.storage_reference, onchain.evidence_hash if onchain else "0x")
    if onchain and onchain.state != ChainState.DISPUTED and onchain.round != ev.round:
        integrity = (
            False,
            f"latest stored evidence round {ev.round} differs from on-chain round {onchain.round}",
        )
    sponsor = session.get(User, project.sponsor_id)
    provider = session.get(User, project.provider_id)
    verifier = session.get(User, project.verifier_id)
    assert sponsor and provider and verifier
    payload = ev.manifest["payload"]
    incident = session.get(Incident, project.incident_id)
    impact = _impact_from_payload(project, incident.sector if incident else None, payload)
    ctx = policy_mod.PolicyContext(
        methodology=project.evidence_policy["methodology"],
        min_monitoring_days=float(project.evidence_policy.get("min_monitoring_days", 0)),
        payload=payload,
        funded_at=project.funded_at_chain,
        now=_chain_now(chain),
        provider_is_project_provider=ev.submitted_by == provider.id,
        provider_approved_onchain=chain.is_approved_provider(provider.wallet_address or ""),
        verifier_approved_onchain=chain.is_approved_verifier(verifier.wallet_address or ""),
        verifier_wallet=verifier.wallet_address or "",
        provider_wallet=provider.wallet_address or "",
        sponsor_wallet=sponsor.wallet_address or "",
        verifier_org=verifier.organization,
        provider_org=provider.organization,
        evidence_integrity=integrity,
        impact=impact,
        project_is_simulation=project.is_simulation,
    )
    checks = policy_mod.evaluate(ctx)
    return {"evidence": ev, "checks": checks, "impact": impact, "chain_now": ctx.now, "onchain": onchain}


def decide(
    session: Session,
    chain: ChainClient,
    user: User,
    project_id: uuid.UUID,
    outcome: str,
    notes: str,
) -> Verification:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="verifier")
    new = _transition("decide", p, user, outcome)
    ctx = evaluate_policy(session, chain, p)
    checks, impact, ev = ctx["checks"], ctx["impact"], ctx["evidence"]
    blocking = policy_mod.blocking_failures(checks)
    if outcome == "VERIFIED" and blocking:
        raise ServiceError(
            "VERIFIED is not permitted while required policy checks fail: "
            + ", ".join(c.id for c in blocking),
            409,
        )
    onchain = ctx["onchain"]
    assert onchain is not None
    methodology = p.evidence_policy["methodology"]
    impact_dict = (
        impact.as_dict()
        if (outcome == "VERIFIED" and methodology == "QUANTIFIED_REDUCTION")
        else {
            **impact.as_dict(),
            "status": "not_quantified",
            "reason": impact.reason
            if methodology == "QUANTIFIED_REDUCTION"
            else "Methodology verifies repair completion only.",
        }
    )
    report = {
        "schema": "plume.verification.v1",
        "project_code": p.code,
        "onchain_project_id": p.onchain_project_id,
        "round": onchain.round,
        "evidence_hash": onchain.evidence_hash,
        "outcome": outcome,
        "methodology": methodology,
        "policy_checks": [c.as_dict() for c in checks],
        "impact": impact_dict,
        "notes": notes,
        "verifier_wallet": user.wallet_address,
        "chain_time": ctx["chain_now"].isoformat(),
    }
    report_hash = keccak_hex(canonical_json(report))
    assert p.onchain_project_id is not None
    deadline = int(ctx["chain_now"].timestamp()) + 3600
    typed = chain.typed_decision(
        p.onchain_project_id, onchain.round, onchain.evidence_hash, Outcome[outcome], report_hash, deadline
    )
    try:
        digest, signature = chain.sign_decision(_hd(user), typed)
    except ChainError as exc:
        raise ServiceError(str(exc), 500) from exc
    # Any account may relay a signed decision; the verifier relays its own here.
    m = typed["message"]
    tx = _send(
        chain,
        _hd(user),
        "recordDecision",
        m["projectId"],
        m["round"],
        HexBytes(m["evidenceHash"]),
        m["outcome"],
        HexBytes(m["reportHash"]),
        m["deadline"],
        HexBytes(signature),
    )
    v = Verification(
        project_id=p.id,
        evidence_id=ev.id,
        round=onchain.round,
        verifier_id=user.id,
        outcome=outcome,
        methodology=methodology,
        policy_checks=[c.as_dict() for c in checks],
        notes=notes,
        measurement_inputs=ev.manifest["payload"].get("measurements") or {},
        impact={**impact_dict, "report": report, "report_hash": report_hash, "typed_data": typed},
        eip712_digest=digest,
        signature=signature,
        tx_hash=tx.tx_hash,
    )
    session.add(v)
    prev, p.status = p.status, new
    _index(session, chain, tx)
    _audit(
        session,
        user,
        "record_decision",
        p,
        prev,
        new,
        {"outcome": outcome, "round": onchain.round, "digest": digest, "report_hash": report_hash},
        tx.tx_hash,
    )
    session.commit()
    return v


def release(
    session: Session, chain: ChainClient, user: User, project_id: uuid.UUID
) -> tuple[RepairProject, ImpactReceipt]:
    p = lock_project(session, project_id)
    if user.id not in (p.sponsor_id, p.provider_id, p.verifier_id) and user.role != "admin":
        raise ServiceError("only project participants may trigger settlement", 403)
    new = _transition("release", p, user)
    _require_chain_state(chain, p, ChainState.VERIFIED)
    tx = _send(chain, _hd(user), "releasePayment", p.onchain_project_id)
    prev, p.status = p.status, new
    _index(session, chain, tx)
    released = next(e for e in tx.events if e["event"] == "PaymentReleased")
    _audit(
        session,
        user,
        "release_payment",
        p,
        prev,
        new,
        {"amount_wei": str(released["args"]["amount"]), "pushed": released["args"]["pushed"]},
        tx.tx_hash,
    )
    session.flush()
    receipt = build_receipt(session, chain, p, tx)
    session.commit()
    return p, receipt


def dispute(
    session: Session, chain: ChainClient, user: User, project_id: uuid.UUID, reason: str
) -> RepairProject:
    p = lock_project(session, project_id)
    if user.id not in (p.sponsor_id, p.provider_id):
        raise ServiceError("only the sponsor or provider may dispute", 403)
    new = _transition("dispute", p, user)
    reason_hash = "0x" + hashlib.sha256(reason.encode()).hexdigest()
    tx = _send(chain, _hd(user), "dispute", p.onchain_project_id, HexBytes(reason_hash))
    prev, p.status = p.status, new
    p.evidence_round = next(int(e["args"]["newRound"]) for e in tx.events if e["event"] == "ProjectDisputed")
    _index(session, chain, tx)
    _audit(session, user, "dispute", p, prev, new, {"reason": reason, "reason_hash": reason_hash}, tx.tx_hash)
    session.commit()
    return p


def cancel(session: Session, chain: ChainClient, user: User, project_id: uuid.UUID) -> RepairProject:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="sponsor")
    new = _transition("cancel", p, user)
    tx_hash = None
    if p.onchain_project_id is not None:
        tx = _send(chain, _hd(user), "cancel", p.onchain_project_id)
        _index(session, chain, tx)
        tx_hash = tx.tx_hash
    prev, p.status = p.status, new
    _audit(session, user, "cancel", p, prev, new, {}, tx_hash)
    session.commit()
    return p


def refund_expired(session: Session, chain: ChainClient, user: User, project_id: uuid.UUID) -> RepairProject:
    p = lock_project(session, project_id)
    _require_participant(user, p, as_="sponsor")
    new = _transition("refund_expired", p, user)
    tx = _send(chain, _hd(user), "refundExpired", p.onchain_project_id)
    prev, p.status = p.status, new
    _index(session, chain, tx)
    _audit(session, user, "refund_expired", p, prev, new, {}, tx.tx_hash)
    session.commit()
    return p


# --------------------------------------------------------------------------- reconciliation
def reconcile(session: Session, chain: ChainClient, project_id: uuid.UUID) -> dict[str, Any]:
    """Idempotently index contract events and align DB status with the on-chain state."""
    p = lock_project(session, project_id)
    if p.onchain_project_id is None:
        session.commit()
        return {"changed": False, "reason": "not on-chain"}
    from_block = int(chain.deployment.get("deployBlock", 0))
    events = [e for e in chain.logs_since(from_block) if e["args"].get("projectId") == p.onchain_project_id]
    for e in events:
        _upsert_event(session, chain, e, None)
    onchain = chain.get_project(p.onchain_project_id)
    allowed = CHAIN_TO_STATUS[onchain.state]
    changed = p.status not in allowed
    result: dict[str, Any] = {
        "onchain_state": onchain.state.name,
        "db_status_before": p.status,
        "events_seen": len(events),
    }
    if changed:
        prev = p.status
        p.status = canonical_status(onchain.state)
        p.evidence_round = onchain.round
        _audit(
            session,
            None,
            "reconcile",
            p,
            prev,
            p.status,
            {"source": "chain", "onchain_state": onchain.state.name},
        )
    p.last_reconciled_at = datetime.now(UTC)
    result.update({"changed": changed, "db_status_after": p.status})
    session.commit()
    return result


# --------------------------------------------------------------------------- receipts
def build_receipt(
    session: Session, chain: ChainClient, project: RepairProject, settlement: TxResult
) -> ImpactReceipt:
    existing = session.scalar(select(ImpactReceipt).where(ImpactReceipt.project_id == project.id))
    if existing:
        return existing
    verification = session.scalar(
        select(Verification)
        .where(Verification.project_id == project.id, Verification.outcome == "VERIFIED")
        .order_by(Verification.round.desc())
    )
    if verification is None:
        raise ServiceError("no VERIFIED decision recorded", 409)
    evidence = session.get(Evidence, verification.evidence_id)
    incident = session.get(Incident, project.incident_id)
    assert evidence and incident
    impact = {k: v for k, v in verification.impact.items() if k not in ("report", "typed_data")}
    payload = {
        "schema": "plume.impact-receipt.v1",
        "label": "Impact Receipt — not a carbon credit; not tradable; simulated repair on a test network",
        "incident": {
            "id": str(incident.id),
            "code": incident.code,
            "latitude": incident.latitude,
            "longitude": incident.longitude,
            "sector": incident.sector,
            "observation_sources": [
                {
                    "id": o.display_id,
                    "provider": o.provider,
                    "observed_at": o.observed_at.isoformat(),
                    "url": o.source_url,
                    "emission_rate_kg_h": o.emission_rate_kg_h,
                    "uncertainty_kg_h": o.emission_uncertainty_kg_h,
                }
                for o in incident.observations
            ],
        },
        "repair_project": {
            "id": str(project.id),
            "code": project.code,
            "title": project.title,
            "scope": project.repair_scope,
            "terms_hash": project.terms_hash,
            "is_simulation": project.is_simulation,
        },
        "verification": {
            "result": verification.outcome,
            "methodology": verification.methodology,
            "round": verification.round,
            "eip712_digest": verification.eip712_digest,
            "decision_tx": verification.tx_hash,
            "policy_checks": verification.policy_checks,
            "decided_at": verification.decided_at.isoformat(),
        },
        "evidence": {
            "hash": evidence.content_hash,
            "round": evidence.round,
            "is_simulated": evidence.is_simulated,
            "submission_tx": evidence.tx_hash,
        },
        "impact": impact,
        "chain": {
            "network": chain.settings.chain_name,
            "chain_id": chain.chain_id,
            "contract": chain.address,
            "onchain_project_id": project.onchain_project_id,
            "settlement_tx": settlement.tx_hash,
            "settlement_block": settlement.block_number,
            "settled_at_chain_time": datetime.fromtimestamp(settlement.block_timestamp, UTC).isoformat(),
        },
    }
    raw = canonical_json(payload)
    digest = hashlib.sha256(raw).hexdigest()
    receipt = ImpactReceipt(
        id="RCPT-" + digest[:10].upper(),
        project_id=project.id,
        verification_id=verification.id,
        evidence_digest=evidence.content_hash,
        calculation_version=str(impact.get("calculation_version", "impact-v1")),
        impact_estimate=impact,
        payload=payload,
        payload_sha256=digest,
        chain_tx_hash=settlement.tx_hash,
    )
    session.add(receipt)
    _audit(
        session,
        None,
        "issue_receipt",
        project,
        project.status,
        project.status,
        {"receipt_id": receipt.id, "payload_sha256": digest},
    )
    return receipt
