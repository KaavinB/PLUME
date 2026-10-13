"""Relational schema (PostgreSQL + PostGIS)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from geoalchemy2 import Geometry
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_uuid() -> uuid.UUID:
    return uuid.uuid4()


ROLES = ("observer", "sponsor", "provider", "verifier", "admin")


class User(Base):
    """Demo persona or registered participant. Wallet address is the on-chain identity."""

    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(200))
    organization: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(32))
    wallet_address: Mapped[str | None] = mapped_column(String(42), unique=True)
    hd_index: Mapped[int | None] = mapped_column(Integer)  # demo-key derivation index (local chain only)
    is_demo: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (CheckConstraint(f"role IN {ROLES}", name="ck_users_role"),)


class IngestionRun(Base):
    __tablename__ = "ingestion_runs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    provider: Mapped[str] = mapped_column(String(64))
    mode: Mapped[str] = mapped_column(String(16))  # snapshot | live
    source_ref: Mapped[str] = mapped_column(Text)
    source_sha256: Mapped[str | None] = mapped_column(String(64))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stats: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class Observation(Base):
    __tablename__ = "observations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    provider: Mapped[str] = mapped_column(String(64))
    external_id: Mapped[str] = mapped_column(String(128))
    display_id: Mapped[str] = mapped_column(String(128), index=True)
    gas: Mapped[str] = mapped_column(String(8))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    geom: Mapped[Any] = mapped_column(Geometry("POINT", srid=4326, spatial_index=True))
    footprint: Mapped[Any | None] = mapped_column(Geometry("POLYGON", srid=4326, spatial_index=False))
    longitude: Mapped[float] = mapped_column(Float)
    latitude: Mapped[float] = mapped_column(Float)
    emission_rate_kg_h: Mapped[float | None] = mapped_column(Float)
    emission_uncertainty_kg_h: Mapped[float | None] = mapped_column(Float)
    instrument: Mapped[str | None] = mapped_column(String(32), index=True)
    platform: Mapped[str | None] = mapped_column(String(64))
    sector: Mapped[str | None] = mapped_column(String(16), index=True)
    quality: Mapped[str | None] = mapped_column(String(32))
    wind_speed_m_s: Mapped[float | None] = mapped_column(Float)
    scene_id: Mapped[str | None] = mapped_column(String(64))
    source_url: Mapped[str] = mapped_column(Text)
    provider_source_name: Mapped[str | None] = mapped_column(String(128), index=True)
    validation_flags: Mapped[list[str]] = mapped_column(ARRAY(String(64)), default=list)
    raw_metadata: Mapped[dict[str, Any]] = mapped_column(JSONB)
    raw_sha256: Mapped[str] = mapped_column(String(64))
    ingestion_run_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ingestion_runs.id"))
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        UniqueConstraint("provider", "external_id", name="uq_observation_provider_external"),
        CheckConstraint("gas = 'CH4'", name="ck_observation_ch4"),
        CheckConstraint(
            "emission_rate_kg_h IS NULL OR emission_rate_kg_h > 0", name="ck_observation_rate_positive"
        ),
        CheckConstraint(
            "latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180", name="ck_obs_coords"
        ),
    )


class Incident(Base):
    """A candidate emission source: one or more observations grouped by the clustering pipeline."""

    __tablename__ = "incidents"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    status: Mapped[str] = mapped_column(String(32), default="open", index=True)
    geom: Mapped[Any] = mapped_column(Geometry("POINT", srid=4326, spatial_index=True))
    longitude: Mapped[float] = mapped_column(Float)
    latitude: Mapped[float] = mapped_column(Float)
    sector: Mapped[str | None] = mapped_column(String(16), index=True)
    observation_count: Mapped[int] = mapped_column(Integer)
    detection_date_count: Mapped[int] = mapped_column(Integer)
    instrument_count: Mapped[int] = mapped_column(Integer)
    first_observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    max_rate_kg_h: Mapped[float | None] = mapped_column(Float)
    median_rate_kg_h: Mapped[float | None] = mapped_column(Float)
    spatial_spread_m: Mapped[float] = mapped_column(Float, default=0.0)
    priority_score: Mapped[float] = mapped_column(Float, index=True)
    priority_breakdown: Mapped[dict[str, Any]] = mapped_column(JSONB)
    grouping_method: Mapped[str] = mapped_column(String(64))
    grouping_params: Mapped[dict[str, Any]] = mapped_column(JSONB)
    provider_source_names: Mapped[list[str]] = mapped_column(ARRAY(String(128)), default=list)
    provider_source_context: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    observations: Mapped[list[Observation]] = relationship(
        secondary="incident_observations", order_by="Observation.observed_at"
    )


class IncidentObservation(Base):
    __tablename__ = "incident_observations"
    incident_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("incidents.id", ondelete="CASCADE"), primary_key=True
    )
    observation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("observations.id", ondelete="CASCADE"), primary_key=True, unique=True
    )


class Investigation(Base):
    __tablename__ = "investigations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    incident_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("incidents.id"), index=True)
    report: Mapped[dict[str, Any]] = mapped_column(JSONB)
    report_kind: Mapped[str] = mapped_column(String(16))  # llm | template
    model_identifier: Mapped[str] = mapped_column(String(128))
    inputs_digest: Mapped[str] = mapped_column(String(64))
    latency_ms: Mapped[int] = mapped_column(Integer)
    requested_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


PROJECT_STATES = (
    "DRAFT",
    "OPEN_FOR_FUNDING",
    "FUNDED",
    "ASSIGNED",
    "REPAIR_SUBMITTED",
    "UNDER_VERIFICATION",
    "VERIFIED",
    "PAID",
    "REJECTED",
    "ADDITIONAL_EVIDENCE_REQUIRED",
    "INCONCLUSIVE",
    "DISPUTED",
    "CANCELLED",
    "EXPIRED",
)


class RepairProject(Base):
    __tablename__ = "repair_projects"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    incident_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("incidents.id"), index=True)
    investigation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("investigations.id"))
    sponsor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    provider_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    verifier_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(200))
    repair_scope: Mapped[str] = mapped_column(Text)
    site_authorization: Mapped[str] = mapped_column(Text)
    milestones: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    evidence_policy: Mapped[dict[str, Any]] = mapped_column(JSONB)
    funding_amount_wei: Mapped[Decimal] = mapped_column(Numeric(78, 0))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    dispute_window_s: Mapped[int] = mapped_column(Integer, default=0)
    terms: Mapped[dict[str, Any]] = mapped_column(JSONB)
    terms_hash: Mapped[str] = mapped_column(String(66))
    status: Mapped[str] = mapped_column(String(40), index=True)
    is_simulation: Mapped[bool] = mapped_column(default=True)
    chain_id: Mapped[int | None] = mapped_column(Integer)
    contract_address: Mapped[str | None] = mapped_column(String(42))
    onchain_project_id: Mapped[int | None] = mapped_column(Integer)
    evidence_round: Mapped[int] = mapped_column(Integer, default=0)
    funded_at_chain: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )  # block time of funding tx
    last_reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    version: Mapped[int] = mapped_column(Integer, default=1)

    __mapper_args__ = {"version_id_col": version}
    __table_args__ = (
        CheckConstraint(f"status IN {PROJECT_STATES}", name="ck_project_status"),
        CheckConstraint("funding_amount_wei > 0", name="ck_project_amount_positive"),
        CheckConstraint(
            "provider_id <> verifier_id AND sponsor_id <> verifier_id", name="ck_verifier_independent"
        ),
        UniqueConstraint("chain_id", "contract_address", "onchain_project_id", name="uq_project_onchain"),
    )

    incident: Mapped[Incident] = relationship()


class Evidence(Base):
    __tablename__ = "evidence"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("repair_projects.id"), index=True)
    round: Mapped[int] = mapped_column(Integer)
    submitted_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    evidence_type: Mapped[str] = mapped_column(String(64))
    content_hash: Mapped[str] = mapped_column(String(66))
    manifest: Mapped[dict[str, Any]] = mapped_column(JSONB)
    storage_reference: Mapped[str] = mapped_column(Text)
    is_simulated: Mapped[bool] = mapped_column(default=True)
    tx_hash: Mapped[str | None] = mapped_column(String(66))
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (UniqueConstraint("project_id", "round", name="uq_evidence_round"),)


VERIFICATION_OUTCOMES = ("VERIFIED", "REJECTED", "INCONCLUSIVE", "ADDITIONAL_EVIDENCE_REQUIRED")


class Verification(Base):
    __tablename__ = "verifications"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=new_uuid)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("repair_projects.id"), index=True)
    evidence_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("evidence.id"))
    round: Mapped[int] = mapped_column(Integer)
    verifier_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    outcome: Mapped[str] = mapped_column(String(40))
    methodology: Mapped[str] = mapped_column(String(64))
    policy_checks: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    notes: Mapped[str] = mapped_column(Text, default="")
    measurement_inputs: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    impact: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    eip712_digest: Mapped[str] = mapped_column(String(66))
    signature: Mapped[str] = mapped_column(Text)
    tx_hash: Mapped[str | None] = mapped_column(String(66))
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    __table_args__ = (
        CheckConstraint(f"outcome IN {VERIFICATION_OUTCOMES}", name="ck_verification_outcome"),
        UniqueConstraint("project_id", "round", name="uq_verification_round"),
    )


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_id: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(64))
    resource_type: Mapped[str] = mapped_column(String(32))
    resource_id: Mapped[str] = mapped_column(String(64), index=True)
    previous_state: Mapped[str | None] = mapped_column(String(40))
    new_state: Mapped[str | None] = mapped_column(String(40))
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    chain_tx_hash: Mapped[str | None] = mapped_column(String(66))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class ChainEvent(Base):
    """Indexed contract logs. (chain, tx, log_index) uniqueness makes reconciliation idempotent."""

    __tablename__ = "chain_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    chain_id: Mapped[int] = mapped_column(Integer)
    contract_address: Mapped[str] = mapped_column(String(42))
    block_number: Mapped[int] = mapped_column(Integer)
    tx_hash: Mapped[str] = mapped_column(String(66))
    log_index: Mapped[int] = mapped_column(Integer)
    event_name: Mapped[str] = mapped_column(String(64))
    onchain_project_id: Mapped[int | None] = mapped_column(Integer, index=True)
    args: Mapped[dict[str, Any]] = mapped_column(JSONB)
    block_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("chain_id", "tx_hash", "log_index", name="uq_chain_event"),)


class ImpactReceipt(Base):
    __tablename__ = "impact_receipts"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("repair_projects.id"), unique=True)
    verification_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("verifications.id"))
    evidence_digest: Mapped[str] = mapped_column(String(66))
    calculation_version: Mapped[str] = mapped_column(String(32))
    impact_estimate: Mapped[dict[str, Any]] = mapped_column(JSONB)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    payload_sha256: Mapped[str] = mapped_column(String(64))
    chain_tx_hash: Mapped[str] = mapped_column(String(66))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


Index("ix_incident_priority_desc", Incident.priority_score.desc())
