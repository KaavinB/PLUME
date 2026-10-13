"""Investigation pipeline: validate → contextualise grouping → prioritise → retrieve guidance → report.

Steps 1–4 are deterministic computations over stored observations. Step 5 asks an LLM (if
configured) to write narrative fields from the computed evidence pack, then checks that output
for grounding. Without an LLM, a deterministic template writes the narrative and says so.
"""

from __future__ import annotations

import logging
import statistics
import time
import uuid
from collections import Counter
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy.orm import Session

from app.config import Settings
from app.ingestion.pipeline import canonical_sha256
from app.investigation.knowledge import KbEntry, build_query, load_kb, retrieve
from app.investigation.llm import LlmUnavailable, NarrativeGenerator
from app.investigation.report import (
    Confidence,
    EvidenceRef,
    Fact,
    GenerationInfo,
    GroundingResult,
    Inference,
    InvestigationReport,
    LlmNarrative,
    RateSummary,
    SourceMatch,
    SuggestedAction,
    UncertaintySummary,
    ValidationCheck,
    ground_narrative,
)
from app.models import Incident, Investigation, Observation
from app.providers.base import sector_label

log = logging.getLogger(__name__)

INSTRUMENT_LABELS = {
    "GAO": "GAO (airborne imaging spectrometer)",
    "ang": "AVIRIS-NG (airborne)",
    "av3": "AVIRIS-3 (airborne)",
    "emi": "EMIT (ISS)",
    "tan": "Tanager-1 (satellite)",
    "ssc": "SSC",
}


def _fmt(v: float | None, digits: int = 0) -> str:
    return "n/a" if v is None else f"{v:,.{digits}f}"


# ------------------------------------------------------------------------------ step 1
def validate_observations(obs: list[Observation], now: datetime) -> list[ValidationCheck]:
    checks: list[ValidationCheck] = []

    def add(name: str, ok: bool, detail: str, warn_only: bool = False) -> None:
        checks.append(
            ValidationCheck(
                name=name, status="pass" if ok else ("warn" if warn_only else "fail"), detail=detail
            )
        )

    bad_coords = [o.display_id for o in obs if not (-90 <= o.latitude <= 90 and -180 <= o.longitude <= 180)]
    add(
        "coordinates_valid",
        not bad_coords,
        "all plume origins within WGS84 bounds" if not bad_coords else f"invalid: {bad_coords}",
    )
    future = [o.display_id for o in obs if o.observed_at > now]
    add(
        "timestamps_valid",
        not future,
        "all observation timestamps parse and are not in the future"
        if not future
        else f"future-dated: {future}",
    )
    non_ch4 = [o.display_id for o in obs if o.gas != "CH4"]
    add(
        "gas_is_methane",
        not non_ch4,
        "all records are CH4 detections" if not non_ch4 else f"non-CH4: {non_ch4}",
    )
    q = [o for o in obs if o.emission_rate_kg_h is not None]
    add(
        "emission_units",
        True,
        f"{len(q)}/{len(obs)} detections carry a provider emission estimate in kg/h; "
        f"{len(obs) - len(q)} have no usable estimate and are excluded from rate statistics",
    )
    no_unc = [o for o in q if o.emission_uncertainty_kg_h is None]
    add(
        "uncertainty_present",
        not no_unc,
        "every quantified estimate has a reported uncertainty"
        if not no_unc
        else f"{len(no_unc)} quantified estimate(s) lack uncertainty",
        warn_only=True,
    )
    wide = [
        o.display_id
        for o in q
        if o.emission_rate_kg_h is not None
        and o.emission_uncertainty_kg_h is not None
        and o.emission_uncertainty_kg_h > o.emission_rate_kg_h
    ]
    add(
        "uncertainty_bounded",
        not wide,
        "no estimate has uncertainty larger than the estimate"
        if not wide
        else f"uncertainty exceeds estimate for {len(wide)} detection(s)",
        warn_only=True,
    )
    unassessed = sum(1 for o in obs if o.quality is None)
    add(
        "provider_quality",
        unassessed == 0,
        "provider quality flags present"
        if unassessed == 0
        else f"provider did not assign a quality flag to {unassessed}/{len(obs)} detection(s)",
        warn_only=True,
    )
    keys = Counter((o.instrument, o.observed_at, round(o.longitude, 4), round(o.latitude, 4)) for o in obs)
    dupes = sum(c - 1 for c in keys.values() if c > 1)
    add(
        "duplicate_records",
        dupes == 0,
        "no duplicate detections" if dupes == 0 else f"{dupes} duplicate detection(s)",
    )
    same_scene = Counter(o.scene_id for o in obs if o.scene_id)
    multi = sum(1 for c in same_scene.values() if c > 1)
    add(
        "same_scene_multiplicity",
        multi == 0,
        "each detection comes from a different scene"
        if multi == 0
        else f"{multi} scene(s) contain more than one plume in this group; counted once for recurrence",
        warn_only=True,
    )
    add(
        "raw_payload_retained",
        all(o.raw_sha256 for o in obs),
        "raw provider payload stored with SHA-256 digest for audit",
    )
    return checks


# ------------------------------------------------------------------------------ steps 2–4
def build_evidence(
    incident: Incident, obs: list[Observation], kb_hits: list[tuple[KbEntry, float]]
) -> tuple[
    list[EvidenceRef],
    list[Fact],
    list[SuggestedAction],
    list[SourceMatch],
    RateSummary,
    UncertaintySummary,
    dict[str, Any],
]:
    refs: list[EvidenceRef] = [
        EvidenceRef(
            id=f"OBS:{o.display_id}",
            kind="observation",
            label=f"{o.display_id} · {o.observed_at:%Y-%m-%d} · {INSTRUMENT_LABELS.get(o.instrument or '', o.instrument)} · "
            + (
                f"{o.emission_rate_kg_h:,.0f} ± {_fmt(o.emission_uncertainty_kg_h)} kg/h"
                if o.emission_rate_kg_h
                else "no emission estimate"
            ),
            url=o.source_url,
        )
        for o in obs
    ]
    ctx = incident.provider_source_context or {}
    sources: dict[str, Any] = ctx.get("sources", {})
    for name, s in sources.items():
        refs.append(
            EvidenceRef(
                id=f"SRC:{name}",
                kind="provider_source",
                label=f"Carbon Mapper source grouping {name}: {s.get('plume_count')} plume(s), persistence {s.get('persistence')}",
                url=f"https://api.carbonmapper.org/api/v1/catalog/source/{name}",
            )
        )
    refs.append(
        EvidenceRef(
            id="CALC:priority", kind="calculation", label="PLUME investigation priority (priority-v1)"
        )
    )
    refs.append(
        EvidenceRef(
            id="CALC:grouping",
            kind="calculation",
            label=f"{incident.grouping_method} {incident.grouping_params}",
        )
    )
    for e, _ in kb_hits:
        refs.append(
            EvidenceRef(
                id=f"KB:{e.id}",
                kind="knowledge",
                label=f"{e.title} — {e.sources[0]['publisher']}",
                url=e.sources[0]["url"],
            )
        )

    rates = [o.emission_rate_kg_h for o in obs if o.emission_rate_kg_h is not None]
    rel = [
        o.emission_uncertainty_kg_h / o.emission_rate_kg_h
        for o in obs
        if o.emission_rate_kg_h and o.emission_uncertainty_kg_h is not None
    ]
    rate = RateSummary(
        median=statistics.median(rates) if rates else None,
        maximum=max(rates) if rates else None,
        minimum=min(rates) if rates else None,
        quantified_detections=len(rates),
        total_detections=len(obs),
        basis="Provider-reported instantaneous emission estimates (Carbon Mapper emission_auto, kg/h) at the time of each overpass. These are snapshots, not time-averaged emission rates.",
    )
    unc = UncertaintySummary(
        median_relative_uncertainty=statistics.median(rel) if rel else None,
        max_reported_uncertainty_kg_h=max(
            (o.emission_uncertainty_kg_h for o in obs if o.emission_uncertainty_kg_h is not None),
            default=None,
        ),
        basis="Provider-reported 1-sigma uncertainty of each emission estimate (emission_uncertainty_auto).",
    )

    obs_refs = [f"OBS:{o.display_id}" for o in obs]
    instruments = sorted({o.instrument for o in obs if o.instrument})
    dates = sorted({o.observed_at.date() for o in obs})
    facts = [
        Fact(
            statement=f"{len(obs)} CH4 plume detection(s) were grouped within {incident.grouping_params.get('eps_m')} m of each other "
            f"(RMS spread {incident.spatial_spread_m:,.0f} m) around {incident.latitude:.4f}°N, {abs(incident.longitude):.4f}°{'W' if incident.longitude < 0 else 'E'}.",
            evidence_refs=obs_refs + ["CALC:grouping"],
        ),
        Fact(
            statement=f"Detections occurred on {len(dates)} distinct date(s) between {dates[0]} and {dates[-1]}, by {len(instruments)} instrument(s): "
            + ", ".join(INSTRUMENT_LABELS.get(i, i) for i in instruments)
            + ".",
            evidence_refs=obs_refs,
        ),
    ]
    if rates:
        facts.append(
            Fact(
                statement=f"The provider reports emission estimates for {len(rates)} of {len(obs)} detection(s): median {_fmt(rate.median)} kg/h, "
                f"range {_fmt(rate.minimum)}–{_fmt(rate.maximum)} kg/h"
                + (
                    f", median relative uncertainty ±{unc.median_relative_uncertainty:.0%}."
                    if unc.median_relative_uncertainty is not None
                    else "."
                ),
                evidence_refs=[f"OBS:{o.display_id}" for o in obs if o.emission_rate_kg_h is not None],
            )
        )
    else:
        facts.append(
            Fact(
                statement="The provider does not report a usable emission estimate for any detection in this group.",
                evidence_refs=obs_refs,
            )
        )
    facts.append(
        Fact(
            statement=f"The provider assigns sector {incident.sector or 'none'} ({sector_label(incident.sector)}) to this location.",
            evidence_refs=obs_refs,
        )
    )
    primary = ctx.get("primary")
    if primary and primary in sources:
        s = sources[primary]
        facts.append(
            Fact(
                statement=f"Carbon Mapper's own source grouping {primary} reports detections on {s.get('detection_date_count')} of "
                f"{s.get('observation_date_count')} observed overpass dates (persistence {float(s.get('persistence') or 0):.2f}).",
                evidence_refs=[f"SRC:{primary}"],
            )
        )

    matches = [
        SourceMatch(
            kind="provider_source_grouping",
            identifier=name,
            description=f"Carbon Mapper DBSCAN source ({s.get('sector')}), {s.get('plume_count')} plume(s) {s.get('timestamp_min')} → {s.get('timestamp_max')}. "
            "This is a provider grouping, not an identified facility or operator.",
            evidence_refs=[f"SRC:{name}"],
        )
        for name, s in sources.items()
    ]

    actions = [
        SuggestedAction(
            action=e.title,
            rationale=e.guidance,
            knowledge_refs=[f"KB:{e.id}"],
            suggested_evidence=list(e.suggested_evidence),
        )
        for e, _ in kb_hits
    ]

    pack = {
        "incident": {
            "code": incident.code,
            "latitude": round(incident.latitude, 5),
            "longitude": round(incident.longitude, 5),
            "sector_code": incident.sector,
            "sector": sector_label(incident.sector),
            "detections": len(obs),
            "distinct_detection_dates": len(dates),
            "first_detection": str(dates[0]),
            "last_detection": str(dates[-1]),
            "instruments": instruments,
            "spatial_spread_m": round(incident.spatial_spread_m),
        },
        "emission_rate_kg_h": {
            "median": None if rate.median is None else round(rate.median),
            "max": None if rate.maximum is None else round(rate.maximum),
            "min": None if rate.minimum is None else round(rate.minimum),
            "quantified_detections": len(rates),
            "median_relative_uncertainty": None
            if unc.median_relative_uncertainty is None
            else round(unc.median_relative_uncertainty, 2),
            "note": rate.basis,
        },
        "provider_source_grouping": {
            k: {
                kk: v
                for kk, v in s.items()
                if kk
                in (
                    "plume_count",
                    "detection_date_count",
                    "observation_date_count",
                    "persistence",
                    "timestamp_min",
                    "timestamp_max",
                )
            }
            for k, s in sources.items()
        },
        "priority": incident.priority_breakdown,
        "confirmed_facts": [f.model_dump() for f in facts],
        "candidate_guidance": [
            {"id": f"KB:{e.id}", "title": e.title, "guidance": e.guidance} for e, _ in kb_hits
        ],
        "evidence_references": [r.id for r in refs],
    }
    return refs, facts, actions, matches, rate, unc, pack


def sector_confidence(incident: Incident, obs: list[Observation]) -> tuple[Confidence, str]:
    if not incident.sector or incident.sector in ("NA", "NULL", "other"):
        return "low", "The provider did not assign a sector; facility type must be confirmed on the ground."
    agree = sum(1 for o in obs if o.sector == incident.sector)
    if agree == len(obs) and incident.detection_date_count >= 2:
        return (
            "medium",
            f"All {len(obs)} detections carry provider sector {incident.sector} across multiple dates. Sector is a provider attribution based on location, not an on-site confirmation.",
        )
    return (
        "low",
        "Sector is a provider attribution from a limited number of detections and has not been confirmed on site.",
    )


# ------------------------------------------------------------------------------ step 5 (template)
def template_narrative(
    incident: Incident, obs: list[Observation], rate: RateSummary, kb_hits: list[tuple[KbEntry, float]]
) -> LlmNarrative:
    dates = sorted({o.observed_at.date() for o in obs})
    n_dates = len(dates)
    obs_refs = [f"OBS:{o.display_id}" for o in obs][:10]
    ctx = incident.provider_source_context or {}
    primary = ctx.get("primary")
    src = (ctx.get("sources") or {}).get(primary) if primary else None
    persistence = float(src["persistence"]) if src and src.get("persistence") is not None else None
    sector = sector_label(incident.sector)

    when = (
        f"on {dates[0]}"
        if n_dates == 1
        else f"on {n_dates} distinct dates between {dates[0]} and {dates[-1]}"
    )
    where = (
        "at a location to which the provider assigns no sector"
        if sector == "Not assigned"
        else f"at a location the provider attributes to {sector.lower()}"
    )
    summary = f"Incident {incident.code} groups {len(obs)} methane plume detection(s) {when} {where}. "
    if rate.median is not None:
        summary += f"The provider's median instantaneous emission estimate is {rate.median:,.0f} kg/h across {rate.quantified_detections} quantified detection(s). "
    else:
        summary += "No usable emission estimate is available. "
    if n_dates == 1:
        summary += "With detections on a single date, persistence cannot be inferred. "
    elif persistence is not None:
        summary += f"Carbon Mapper reports detections on {persistence:.0%} of observed overpass dates for the matching source grouping. "
    summary += f"The investigation priority is {incident.priority_score:.1f}/100; the operator, facility and emitting component are not identified by these data."

    explanations: list[Inference] = []
    refs_src = [f"SRC:{primary}"] if primary else []
    if incident.sector == "1B2":
        if n_dates >= 3 and (persistence is None or persistence >= 0.5):
            explanations.append(
                Inference(
                    statement="Repeated detections across many dates are consistent with a persistent emission source such as an unrepaired leak or continuous venting at oil and gas equipment near the plume origin.",
                    basis_refs=obs_refs + refs_src,
                    confidence="medium",
                )
            )
        if persistence is not None and persistence < 1.0:
            explanations.append(
                Inference(
                    statement="Overpasses without a detection suggest the emission may be intermittent (e.g. tank flashing, maintenance events or combustion-device malfunctions), or below the detection threshold at those times.",
                    basis_refs=refs_src or obs_refs,
                    confidence="low",
                )
            )
        if n_dates == 1:
            explanations.append(
                Inference(
                    statement="A single-date detection may reflect a one-off release (e.g. a maintenance blowdown or upset) or a persistent source observed only once; the data cannot distinguish these.",
                    basis_refs=obs_refs,
                    confidence="low",
                )
            )
    elif incident.sector == "6A":
        explanations.append(
            Inference(
                statement="Detections at a location attributed to a landfill are consistent with fugitive landfill gas from areas with incomplete gas collection or cover integrity issues.",
                basis_refs=obs_refs + refs_src,
                confidence="low" if n_dates < 3 else "medium",
            )
        )
    else:
        explanations.append(
            Inference(
                statement="The emitting activity cannot be characterised from the available attribution; on-site confirmation of the facility type is needed first.",
                basis_refs=obs_refs,
                confidence="low",
            )
        )
    if rate.maximum and rate.median and rate.maximum > 3 * rate.median:
        explanations.append(
            Inference(
                statement="The spread between the largest and median estimates indicates variable emission strength between overpasses, measurement variability, or both.",
                basis_refs=obs_refs,
                confidence="low",
            )
        )

    steps = [
        "Confirm the facility at the plume origin, its operator and who holds authority to approve work on site (permit records, site visit).",
        "Notify the responsible operator and reference any existing regulatory or MARS notification for this location.",
    ]
    steps += [f"Evaluate: {e.title.lower()} ({'KB:' + e.id})." for e, _ in kb_hits if "*" not in e.sectors][
        :3
    ]
    steps.append(
        "Agree a verification method before work starts: a post-repair ground survey and, where feasible, quantified site measurements."
    )

    questions = ["Which facility and operator are responsible for the emission at this location?"]
    if n_dates == 1:
        questions.append("Is the source persistent? Additional overpasses or a ground survey are needed.")
    else:
        questions.append(
            "Is the source still emitting? The latest detection predates the investigation and non-detections are not proof of repair."
        )
    questions.append(
        "Which specific equipment is emitting? Remote sensing cannot resolve individual components."
    )

    return LlmNarrative(
        summary=summary,
        possible_explanations=explanations,
        next_investigation_steps=steps,
        unresolved_questions=questions,
    )


LIMITATIONS = [
    "Emission estimates are instantaneous snapshots at overpass time and must not be multiplied by an assumed duration to estimate total emissions.",
    "Plume origin coordinates locate the source to roughly tens to hundreds of metres depending on instrument resolution; they do not identify the operator, facility or component.",
    "Grouping nearby detections into one incident is a proximity-based hypothesis; co-located facilities may be merged and a single facility may be split.",
    "Absence of a detection on a later overpass does not demonstrate that an emission stopped (detection thresholds, clouds, timing and coverage).",
    "Provider quality flags were not assigned to these records; the provider's processing may change in later data versions.",
    "The priority score ranks where investigation is most useful; it is not an estimate of climate or health impact.",
]


def run_investigation(
    session: Session,
    incident: Incident,
    settings: Settings,
    generator: NarrativeGenerator | None,
    requested_by: str | None = None,
) -> Investigation:
    t0 = time.perf_counter()
    obs = sorted(incident.observations, key=lambda o: o.observed_at)
    if not obs:
        raise ValueError("incident has no observations")
    now = datetime.now(UTC)
    kb = load_kb()
    ctx = incident.provider_source_context or {}
    primary = ctx.get("primary")
    pers = ((ctx.get("sources") or {}).get(primary) or {}).get("persistence") if primary else None
    query = build_query(incident.sector, incident.detection_date_count, pers, incident.median_rate_kg_h)
    kb_hits = retrieve(kb, incident.sector, query, k=5)

    checks = validate_observations(obs, now)
    refs, facts, actions, matches, rate, unc, pack = build_evidence(incident, obs, kb_hits)
    known = {r.id for r in refs}
    evidence_text = " ".join([str(pack)] + [f.statement for f in facts] + [r.label for r in refs])

    narrative: LlmNarrative | None = None
    kind: Literal["llm", "template"] = "template"
    model_id = "plume-template-v1"
    note = "Narrative generated by PLUME's deterministic template from computed evidence. No language model was used."
    grounding: GroundingResult | None = None
    if generator is not None:
        try:
            candidate = generator.generate(pack)
            g = ground_narrative(candidate, known, evidence_text)
            if g.passed:
                narrative, grounding, kind, model_id = candidate, g, "llm", generator.model_identifier
                note = "Narrative written by a language model from the computed evidence pack and checked for evidence grounding."
            else:
                log.warning(
                    "llm narrative failed grounding; using template", extra={"grounding": g.model_dump()}
                )
                note = f"Language-model narrative rejected by grounding check ({len(g.unknown_refs)} unknown refs, {len(g.unsupported_numbers)} unsupported numbers, {len(g.named_entity_flags)} named entities); template used instead."
        except LlmUnavailable as exc:
            log.warning("llm unavailable; using template", extra={"error": str(exc)})
            note = (
                f"Language model unavailable ({exc}); narrative generated by PLUME's deterministic template."
            )
    if narrative is None:
        narrative = template_narrative(incident, obs, rate, kb_hits)
        grounding = ground_narrative(narrative, known, evidence_text)
    assert grounding is not None

    conf, conf_basis = sector_confidence(incident, obs)
    latency_ms = int((time.perf_counter() - t0) * 1000)
    inv_id = uuid.uuid4()
    report = InvestigationReport(
        incident_id=str(incident.id),
        incident_code=incident.code,
        investigation_id=str(inv_id),
        source_observation_ids=[o.display_id for o in obs],
        summary=narrative.summary,
        data_validation=checks,
        confirmed_observations=facts,
        possible_explanations=narrative.possible_explanations,
        observed_emission_rate=rate,
        measurement_uncertainty=unc,
        potential_sector={"code": incident.sector, "label": sector_label(incident.sector)},
        sector_confidence=conf,
        sector_confidence_basis=conf_basis,
        possible_source_matches=matches,
        prioritization_score=incident.priority_score,
        prioritization_breakdown=incident.priority_breakdown,
        suggested_actions=actions,
        next_investigation_steps=narrative.next_investigation_steps,
        unresolved_questions=narrative.unresolved_questions,
        limitations=LIMITATIONS,
        evidence_references=refs,
        grounding=grounding,
        generation=GenerationInfo(
            kind=kind, model_identifier=model_id, generated_at=now, latency_ms=latency_ms, note=note
        ),  # type: ignore[arg-type]
    )
    inv = Investigation(
        id=inv_id,
        incident_id=incident.id,
        report=report.model_dump(mode="json"),
        report_kind=kind,
        model_identifier=model_id,
        inputs_digest=canonical_sha256(pack),
        latency_ms=latency_ms,
        requested_by=requested_by,
    )
    session.add(inv)
    if incident.status == "open":
        incident.status = "investigated"
    session.commit()
    return inv
