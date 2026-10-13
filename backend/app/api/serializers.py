"""Response shapes. Kept explicit so the API contract is stable and documented."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel

from app.models import Evidence, Incident, Investigation, Observation, RepairProject, User, Verification
from app.providers.base import sector_label


class UserOut(BaseModel):
    id: str
    display_name: str
    organization: str
    role: str
    wallet_address: str | None
    is_demo: bool


def user_out(u: User) -> UserOut:
    return UserOut(
        id=u.id,
        display_name=u.display_name,
        organization=u.organization,
        role=u.role,
        wallet_address=u.wallet_address,
        is_demo=u.is_demo,
    )


class ObservationOut(BaseModel):
    id: str
    display_id: str
    provider: str
    external_id: str
    gas: str
    observed_at: datetime
    longitude: float
    latitude: float
    emission_rate_kg_h: float | None
    emission_uncertainty_kg_h: float | None
    instrument: str | None
    platform: str | None
    sector: str | None
    sector_label: str
    quality: str | None
    wind_speed_m_s: float | None
    footprint_bounds: list[float] | None
    source_url: str
    provider_source_name: str | None
    validation_flags: list[str]
    raw_sha256: str
    ingested_at: datetime


def obs_out(o: Observation, include_bounds: bool = True) -> ObservationOut:
    b = o.raw_metadata.get("plume_bounds") if include_bounds else None
    return ObservationOut(
        id=str(o.id),
        display_id=o.display_id,
        provider=o.provider,
        external_id=o.external_id,
        gas=o.gas,
        observed_at=o.observed_at,
        longitude=o.longitude,
        latitude=o.latitude,
        emission_rate_kg_h=o.emission_rate_kg_h,
        emission_uncertainty_kg_h=o.emission_uncertainty_kg_h,
        instrument=o.instrument,
        platform=o.platform,
        sector=o.sector,
        sector_label=sector_label(o.sector),
        quality=o.quality,
        wind_speed_m_s=o.wind_speed_m_s,
        footprint_bounds=b if isinstance(b, list) else None,
        source_url=o.source_url,
        provider_source_name=o.provider_source_name,
        validation_flags=list(o.validation_flags or []),
        raw_sha256=o.raw_sha256,
        ingested_at=o.ingested_at,
    )


class IncidentSummary(BaseModel):
    id: str
    code: str
    status: str
    longitude: float
    latitude: float
    sector: str | None
    sector_label: str
    observation_count: int
    detection_date_count: int
    instrument_count: int
    first_observed_at: datetime
    last_observed_at: datetime
    max_rate_kg_h: float | None
    median_rate_kg_h: float | None
    priority_score: float


def incident_summary(i: Incident) -> IncidentSummary:
    return IncidentSummary(
        id=str(i.id),
        code=i.code,
        status=i.status,
        longitude=i.longitude,
        latitude=i.latitude,
        sector=i.sector,
        sector_label=sector_label(i.sector),
        observation_count=i.observation_count,
        detection_date_count=i.detection_date_count,
        instrument_count=i.instrument_count,
        first_observed_at=i.first_observed_at,
        last_observed_at=i.last_observed_at,
        max_rate_kg_h=i.max_rate_kg_h,
        median_rate_kg_h=i.median_rate_kg_h,
        priority_score=i.priority_score,
    )


class IncidentDetail(IncidentSummary):
    spatial_spread_m: float
    priority_breakdown: dict[str, Any]
    grouping_method: str
    grouping_params: dict[str, Any]
    provider_source_context: dict[str, Any]
    observations: list[ObservationOut]
    investigations: list[dict[str, Any]]
    repair_projects: list[dict[str, Any]]


def investigation_brief(inv: Investigation) -> dict[str, Any]:
    return {
        "id": str(inv.id),
        "created_at": inv.created_at,
        "report_kind": inv.report_kind,
        "model_identifier": inv.model_identifier,
        "latency_ms": inv.latency_ms,
    }


def project_brief(p: RepairProject) -> dict[str, Any]:
    return {
        "id": str(p.id),
        "code": p.code,
        "title": p.title,
        "status": p.status,
        "funding_amount_wei": str(p.funding_amount_wei),
        "created_at": p.created_at,
        "updated_at": p.updated_at,
        "incident_id": str(p.incident_id),
        "onchain_project_id": p.onchain_project_id,
        "is_simulation": p.is_simulation,
    }


def evidence_out(e: Evidence) -> dict[str, Any]:
    return {
        "id": str(e.id),
        "round": e.round,
        "submitted_by": e.submitted_by,
        "content_hash": e.content_hash,
        "manifest": e.manifest,
        "is_simulated": e.is_simulated,
        "tx_hash": e.tx_hash,
        "submitted_at": e.submitted_at,
    }


def verification_out(v: Verification) -> dict[str, Any]:
    return {
        "id": str(v.id),
        "round": v.round,
        "verifier_id": v.verifier_id,
        "outcome": v.outcome,
        "methodology": v.methodology,
        "policy_checks": v.policy_checks,
        "notes": v.notes,
        "impact": v.impact,
        "eip712_digest": v.eip712_digest,
        "signature": v.signature,
        "tx_hash": v.tx_hash,
        "decided_at": v.decided_at,
    }
