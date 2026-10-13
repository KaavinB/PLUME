"""Structured investigation report schema and evidence-grounding checks."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

REPORT_SCHEMA_VERSION = "investigation-report-v1"
Confidence = Literal["low", "medium", "high"]


class EvidenceRef(BaseModel):
    id: str  # e.g. "OBS:<display_id>", "KB:<entry>", "SRC:<provider source>", "CALC:<name>"
    kind: Literal["observation", "provider_source", "knowledge", "calculation", "dataset"]
    label: str
    url: str | None = None


class Fact(BaseModel):
    statement: str
    evidence_refs: list[str]


class Inference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    statement: str
    basis_refs: list[str] = Field(description="EvidenceRef ids supporting this inference")
    confidence: Confidence


class SuggestedAction(BaseModel):
    action: str
    rationale: str
    knowledge_refs: list[str]
    suggested_evidence: list[str]


class SourceMatch(BaseModel):
    kind: Literal["provider_source_grouping"]
    identifier: str
    description: str
    evidence_refs: list[str]


class ValidationCheck(BaseModel):
    name: str
    status: Literal["pass", "warn", "fail"]
    detail: str


class RateSummary(BaseModel):
    median: float | None
    maximum: float | None
    minimum: float | None
    unit: Literal["kg/h"] = "kg/h"
    quantified_detections: int
    total_detections: int
    basis: str


class UncertaintySummary(BaseModel):
    median_relative_uncertainty: float | None
    max_reported_uncertainty_kg_h: float | None
    basis: str


class GroundingResult(BaseModel):
    checked_fields: list[str]
    unknown_refs: list[str]
    unsupported_numbers: list[str]
    named_entity_flags: list[str]
    passed: bool


class GenerationInfo(BaseModel):
    kind: Literal["llm", "template"]
    model_identifier: str
    generated_at: datetime
    latency_ms: int
    note: str


class InvestigationReport(BaseModel):
    schema_version: str = REPORT_SCHEMA_VERSION
    incident_id: str
    incident_code: str
    investigation_id: str
    source_observation_ids: list[str]
    summary: str
    data_validation: list[ValidationCheck]
    confirmed_observations: list[Fact]
    possible_explanations: list[Inference]
    observed_emission_rate: RateSummary
    measurement_uncertainty: UncertaintySummary
    potential_sector: dict[str, str | None]
    sector_confidence: Confidence
    sector_confidence_basis: str
    possible_source_matches: list[SourceMatch]
    prioritization_score: float
    prioritization_breakdown: dict[str, object]
    suggested_actions: list[SuggestedAction]
    next_investigation_steps: list[str]
    unresolved_questions: list[str]
    limitations: list[str]
    evidence_references: list[EvidenceRef]
    grounding: GroundingResult
    generation: GenerationInfo


class LlmNarrative(BaseModel):
    """The only part of the report a language model may write. Everything else is computed."""

    model_config = ConfigDict(extra="forbid")
    summary: str = Field(description="3-5 sentence executive summary using only the supplied evidence")
    possible_explanations: list[Inference]
    next_investigation_steps: list[str]
    unresolved_questions: list[str]


# ----------------------------------------------------------------------------- grounding
_NUM = re.compile(r"(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?%?")
# Organisation-like tokens the model must not introduce (operators/contractors are never in evidence).
_ENTITY = re.compile(
    r"\b[A-Z][A-Za-z&]+(?:\s+[A-Z][A-Za-z&]+)*\s+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co|LP|Operating|Energy|Resources|Petroleum)\b\.?"
)


def _to_float(tok: str) -> float | None:
    t = tok.replace(",", "").rstrip("%")
    try:
        return float(t)
    except ValueError:
        return None


def allowed_numbers(evidence_text: str) -> set[float]:
    out: set[float] = set()
    for tok in _NUM.findall(evidence_text):
        v = _to_float(tok)
        if v is None:
            continue
        out.add(v)
        if tok.endswith("%"):
            out.add(v / 100)
        elif 0 < abs(v) <= 1:
            out.add(round(v * 100, 4))  # fraction rendered as a percentage
    return out


def find_unsupported_numbers(text: str, allowed: set[float], rel_tol: float = 0.01) -> list[str]:
    bad: list[str] = []
    for tok in _NUM.findall(text):
        v = _to_float(tok)
        if v is None or abs(v) <= 10:  # small counts/ordinals are not treated as quantitative claims
            continue
        if not any(abs(v - a) <= max(abs(a) * rel_tol, 0.5) for a in allowed):
            bad.append(tok)
    return bad


def ground_narrative(narrative: LlmNarrative, known_refs: set[str], evidence_text: str) -> GroundingResult:
    texts = [
        ("summary", narrative.summary),
        *[
            (f"possible_explanations[{i}]", e.statement)
            for i, e in enumerate(narrative.possible_explanations)
        ],
        *[(f"next_investigation_steps[{i}]", s) for i, s in enumerate(narrative.next_investigation_steps)],
        *[(f"unresolved_questions[{i}]", s) for i, s in enumerate(narrative.unresolved_questions)],
    ]
    unknown = sorted(
        {r for e in narrative.possible_explanations for r in e.basis_refs if r not in known_refs}
    )
    allowed = allowed_numbers(evidence_text)
    unsupported: list[str] = []
    entities: list[str] = []
    for field, t in texts:
        unsupported += [f"{field}: {n}" for n in find_unsupported_numbers(t, allowed)]
        entities += [f"{field}: {m.group(0)}" for m in _ENTITY.finditer(t) if m.group(0) not in evidence_text]
    no_basis = [i for i, e in enumerate(narrative.possible_explanations) if not e.basis_refs]
    unknown += [f"possible_explanations[{i}]: no basis_refs" for i in no_basis]
    return GroundingResult(
        checked_fields=[f for f, _ in texts],
        unknown_refs=unknown,
        unsupported_numbers=unsupported,
        named_entity_flags=entities,
        passed=not unknown and not unsupported and not entities,
    )
