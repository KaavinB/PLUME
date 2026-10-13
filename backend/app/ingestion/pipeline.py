"""Ingestion: provider records → validated, normalized, de-duplicated observations → incidents."""

from __future__ import annotations

import hashlib
import json
import logging
import statistics
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import Any

from geoalchemy2.elements import WKTElement
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.investigation.clustering import (
    GROUPING_METHOD,
    ClusterParams,
    PointRecord,
    centroid,
    cluster_points,
    compare_with_provider,
    haversine_m,
    spread_m,
)
from app.investigation.scoring import ObservationFacts, breakdown_payload, score_incident
from app.models import Incident, IncidentObservation, IngestionRun, Observation
from app.providers.base import NormalizedObservation
from app.providers.carbonmapper import normalize_carbonmapper_with_reason

log = logging.getLogger(__name__)


def canonical_sha256(obj: Any) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def provider_source_index(
    sources_geojson: dict[str, Any],
) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    """Map plume display id → Carbon Mapper source name, and source name → source summary."""
    by_plume: dict[str, str] = {}
    summaries: dict[str, dict[str, Any]] = {}
    for feat in sources_geojson.get("features", []) or []:
        props = feat.get("properties") or {}
        # The API echoes the request query string onto source_name; keep only the identifier.
        name = str(props.get("source_name") or feat.get("id") or "").split("?")[0]
        if not name:
            continue
        summaries[name] = {
            "source_name": name,
            "sector": props.get("sector"),
            "plume_count": props.get("plume_count"),
            "detection_date_count": props.get("detection_date_count"),
            "observation_date_count": props.get("observation_date_count"),
            "persistence": props.get("persistence"),
            "emission_auto_kg_h": props.get("emission_auto"),
            "emission_uncertainty_auto_kg_h": props.get("emission_uncertainty_auto"),
            "timestamp_min": props.get("timestamp_min"),
            "timestamp_max": props.get("timestamp_max"),
            "basin_name": props.get("basin_name"),
            "country_iso": props.get("country_iso"),
        }
        for pid in props.get("plume_ids") or []:
            by_plume[str(pid)] = name
    return by_plume, summaries


def secondary_dedupe_key(o: NormalizedObservation) -> tuple[str | None, str, float, float]:
    """Catches the same detection re-issued under a different provider id."""
    return (o.instrument, o.observed_at.isoformat(), round(o.longitude, 4), round(o.latitude, 4))


def normalize_batch(
    raw_records: list[dict[str, Any]], provider: str
) -> tuple[list[NormalizedObservation], dict[str, Any]]:
    if provider != "carbonmapper":
        raise ValueError(f"no normalizer registered for {provider}")
    rejected: Counter[str] = Counter()
    seen_ids: set[str] = set()
    seen_secondary: set[tuple[str | None, str, float, float]] = set()
    dup_primary = dup_secondary = 0
    out: list[NormalizedObservation] = []
    for raw in raw_records:
        obs, reason = normalize_carbonmapper_with_reason(raw)
        if obs is None:
            rejected[reason or "unknown"] += 1
            continue
        if obs.external_id in seen_ids:
            dup_primary += 1
            continue
        key2 = secondary_dedupe_key(obs)
        if key2 in seen_secondary:
            dup_secondary += 1
            continue
        seen_ids.add(obs.external_id)
        seen_secondary.add(key2)
        out.append(obs)
    stats = {
        "fetched": len(raw_records),
        "normalized": len(out),
        "rejected": dict(rejected),
        "duplicates_same_id": dup_primary,
        "duplicates_same_detection": dup_secondary,
        "flags": dict(Counter(f for o in out for f in o.validation_flags)),
    }
    return out, stats


def _footprint_wkt(b: tuple[float, float, float, float] | None) -> WKTElement | None:
    if not b:
        return None
    minx, miny, maxx, maxy = b
    return WKTElement(
        f"POLYGON(({minx} {miny},{maxx} {miny},{maxx} {maxy},{minx} {maxy},{minx} {miny}))", srid=4326
    )


def ingest(
    session: Session,
    raw_records: list[dict[str, Any]],
    provider: str,
    mode: str,
    source_ref: str,
    source_sha256: str | None,
    sources_geojson: dict[str, Any] | None = None,
    cluster_params: ClusterParams | None = None,
) -> IngestionRun:
    t0 = time.perf_counter()
    run = IngestionRun(provider=provider, mode=mode, source_ref=source_ref, source_sha256=source_sha256)
    session.add(run)
    session.flush()

    normalized, stats = normalize_batch(raw_records, provider)
    by_plume, source_summaries = provider_source_index(sources_geojson or {})
    t_norm = time.perf_counter()

    rows = []
    for o in normalized:
        raw = o.raw
        rows.append(
            {
                "provider": o.provider,
                "external_id": o.external_id,
                "display_id": o.display_id,
                "gas": o.gas,
                "observed_at": o.observed_at,
                "geom": WKTElement(f"POINT({o.longitude} {o.latitude})", srid=4326),
                "footprint": _footprint_wkt(o.footprint_bounds),
                "longitude": o.longitude,
                "latitude": o.latitude,
                "emission_rate_kg_h": o.emission_rate_kg_h,
                "emission_uncertainty_kg_h": o.emission_uncertainty_kg_h,
                "instrument": o.instrument,
                "platform": o.platform,
                "sector": o.sector,
                "quality": o.quality,
                "wind_speed_m_s": o.wind_speed_m_s,
                "scene_id": o.scene_id,
                "source_url": o.source_url,
                "provider_source_name": by_plume.get(o.display_id),
                "validation_flags": list(o.validation_flags),
                "raw_metadata": raw,
                "raw_sha256": canonical_sha256(raw),
                "ingestion_run_id": run.id,
            }
        )
    inserted = 0
    for i in range(0, len(rows), 1000):
        chunk = rows[i : i + 1000]
        stmt = (
            pg_insert(Observation)
            .values(chunk)
            .on_conflict_do_nothing(constraint="uq_observation_provider_external")
            .returning(Observation.id)
        )
        inserted += len(session.execute(stmt).fetchall())
    stats["inserted"] = inserted
    stats["already_present"] = len(rows) - inserted
    t_insert = time.perf_counter()

    incident_stats = build_incidents(session, source_summaries, cluster_params or ClusterParams())
    stats["incidents"] = incident_stats
    t_end = time.perf_counter()
    stats["timing_s"] = {
        "normalize": round(t_norm - t0, 3),
        "insert": round(t_insert - t_norm, 3),
        "cluster_and_score": round(t_end - t_insert, 3),
        "total": round(t_end - t0, 3),
    }
    run.stats = stats
    run.finished_at = datetime.now(UTC)
    session.commit()
    log.info("ingestion complete", extra={"stats": stats})
    return run


def _incident_code(seed: str) -> str:
    return "INC-" + hashlib.sha256(seed.encode()).hexdigest()[:6].upper()


def build_incidents(
    session: Session, source_summaries: dict[str, dict[str, Any]], params: ClusterParams
) -> dict[str, Any]:
    """Group observations not yet assigned to an incident.

    New observations within `eps_m` of an existing incident centroid with the same sector are
    attached to it; the remainder are clustered into new incidents. Existing incidents (which may be
    referenced by repair projects) are never deleted or split.
    """
    assigned = select(IncidentObservation.observation_id)
    pending = session.scalars(select(Observation).where(Observation.id.not_in(assigned))).all()
    if not pending:
        return {"new_observations": 0, "new_incidents": 0, "attached_to_existing": 0}

    reference_time = session.scalar(select(func.max(Observation.observed_at)))
    assert reference_time is not None

    existing = session.scalars(select(Incident)).all()
    existing_by_sector: dict[str | None, list[Incident]] = defaultdict(list)
    for inc in existing:
        existing_by_sector[inc.sector].append(inc)

    touched: dict[Any, Incident] = {}
    remainder: list[Observation] = []
    for o in pending:
        match = None
        for inc in existing_by_sector.get(o.sector, []):
            if haversine_m(o.longitude, o.latitude, inc.longitude, inc.latitude) <= params.eps_m:
                match = inc
                break
        if match is not None:
            session.add(IncidentObservation(incident_id=match.id, observation_id=o.id))
            touched[match.id] = match
        else:
            remainder.append(o)

    obs_by_key = {str(o.id): o for o in remainder}
    points = [
        PointRecord(
            key=str(o.id),
            longitude=o.longitude,
            latitude=o.latitude,
            sector=o.sector,
            provider_group=o.provider_source_name,
        )
        for o in remainder
    ]
    groups = cluster_points(points, params)
    comparison = compare_with_provider(groups)

    new_incidents = 0
    for g in groups:
        members = [obs_by_key[p.key] for p in g]
        seed = min(m.external_id for m in members)
        inc = Incident(
            code=_incident_code(seed),
            grouping_method=GROUPING_METHOD,
            grouping_params=params.as_dict(),
        )
        _refresh_incident(inc, members, source_summaries, reference_time)
        session.add(inc)
        session.flush()
        for m in members:
            session.add(IncidentObservation(incident_id=inc.id, observation_id=m.id))
        new_incidents += 1

    session.flush()
    for inc in touched.values():
        session.refresh(inc)
        _refresh_incident(inc, list(inc.observations), source_summaries, reference_time)

    return {
        "new_observations": len(pending),
        "attached_to_existing": len(pending) - len(remainder),
        "new_incidents": new_incidents,
        "grouping_params": params.as_dict(),
        "provider_comparison": {
            "compared_observations": comparison.compared_points,
            "adjusted_rand_index": comparison.adjusted_rand_index,
            "plume_groups": comparison.our_groups,
            "provider_source_groups": comparison.provider_groups,
            "identical_groups": comparison.exact_group_matches,
        },
    }


def _refresh_incident(
    inc: Incident,
    members: list[Observation],
    source_summaries: dict[str, dict[str, Any]],
    reference_time: datetime,
) -> None:
    pts = [PointRecord(str(m.id), m.longitude, m.latitude, m.sector) for m in members]
    lon, lat = centroid(pts)
    spread = spread_m(pts)
    rates = [m.emission_rate_kg_h for m in members if m.emission_rate_kg_h is not None]
    names = sorted({m.provider_source_name for m in members if m.provider_source_name})
    name_counts = Counter(m.provider_source_name for m in members if m.provider_source_name)
    primary = name_counts.most_common(1)[0][0] if name_counts else None
    context = {n: source_summaries[n] for n in names if n in source_summaries}
    persistence = None
    if primary and primary in source_summaries:
        p = source_summaries[primary].get("persistence")
        persistence = float(p) if isinstance(p, int | float) else None

    facts = [
        ObservationFacts(m.observed_at, m.emission_rate_kg_h, m.emission_uncertainty_kg_h, m.instrument)
        for m in members
    ]
    score, factors = score_incident(facts, reference_time, spread, persistence)

    inc.geom = WKTElement(f"POINT({lon} {lat})", srid=4326)
    inc.longitude, inc.latitude = lon, lat
    sectors = Counter(m.sector for m in members)
    inc.sector = sectors.most_common(1)[0][0]
    inc.observation_count = len(members)
    inc.detection_date_count = len({m.observed_at.date() for m in members})
    inc.instrument_count = len({m.instrument for m in members if m.instrument})
    inc.first_observed_at = min(m.observed_at for m in members)
    inc.last_observed_at = max(m.observed_at for m in members)
    inc.max_rate_kg_h = max(rates) if rates else None
    inc.median_rate_kg_h = statistics.median(rates) if rates else None
    inc.spatial_spread_m = spread
    inc.priority_score = score
    inc.priority_breakdown = breakdown_payload(score, factors, reference_time)
    inc.provider_source_names = names
    inc.provider_source_context = {"primary": primary, "sources": context}
