"""Health, metadata, authentication, observations, incidents and investigations."""

from __future__ import annotations

import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import ColumnElement, and_, func, select, text
from sqlalchemy.orm import selectinload

from app.api.deps import SessionDep, SettingsDep, get_incident_or_404
from app.api.serializers import (
    IncidentDetail,
    IncidentSummary,
    ObservationOut,
    UserOut,
    incident_summary,
    investigation_brief,
    obs_out,
    project_brief,
    user_out,
)
from app.auth import current_user, current_user_optional, issue_token
from app.chain.client import ChainError, get_chain
from app.demo import FEATURED_INCIDENTS
from app.investigation.engine import run_investigation
from app.investigation.llm import get_generator
from app.models import Incident, IngestionRun, Investigation, Observation, RepairProject, User
from app.providers.carbonmapper import ATTRIBUTION, CarbonMapperAdapter, ProviderError

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")


# ---------------------------------------------------------------------------- system
@router.get("/health", tags=["system"])
def health(session: SessionDep, settings: SettingsDep) -> dict[str, Any]:
    db_ok = True
    try:
        session.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False
    chain_ok = False
    try:
        chain_ok = get_chain(settings).is_connected()
    except ChainError:
        chain_ok = False
    return {"status": "ok" if db_ok else "degraded", "database": db_ok, "blockchain": chain_ok}


@router.get("/meta", tags=["system"])
def meta(session: SessionDep, settings: SettingsDep) -> dict[str, Any]:
    run = session.scalar(
        select(IngestionRun)
        .where(IngestionRun.finished_at.is_not(None))
        .order_by(IngestionRun.started_at.desc())
    )
    chain_info: dict[str, Any] = {
        "connected": False,
        "name": settings.chain_name,
        "chain_id": settings.chain_id,
    }
    try:
        c = get_chain(settings)
        chain_info.update(
            connected=c.is_connected(),
            contract=c.address,
            explorer=settings.chain_explorer_url,
            chain_time=c.latest_timestamp() if c.is_connected() else None,
        )
    except ChainError as exc:
        chain_info["error"] = str(exc)
    obs_range = session.execute(
        select(func.min(Observation.observed_at), func.max(Observation.observed_at), func.count())
    ).one()
    gen = get_generator(settings)
    return {
        "data": {
            "mode": run.mode if run else "none",
            "source_ref": run.source_ref if run else None,
            "source_sha256": run.source_sha256 if run else None,
            "ingested_at": run.finished_at if run else None,
            "observation_count": obs_range[2],
            "observed_from": obs_range[0],
            "observed_to": obs_range[1],
            "attribution": ATTRIBUTION,
            "label": "Historical environmental data",
        },
        "repair": {"label": "Simulated repair workflow", "simulation": True},
        "chain": {
            **chain_info,
            "label": "Local blockchain" if settings.chain_id == 31337 else "Public testnet",
        },
        "llm": {
            "provider": settings.llm_provider if gen else "none",
            "model": gen.model_identifier if gen else None,
            "fallback": "deterministic template report",
        },
        "demo_mode": settings.demo_mode,
        "featured_incidents": FEATURED_INCIDENTS,
    }


# ---------------------------------------------------------------------------- auth
class DemoLogin(BaseModel):
    persona: str


@router.get("/auth/personas", tags=["auth"], response_model=list[UserOut])
def personas(session: SessionDep, settings: SettingsDep) -> list[UserOut]:
    if not settings.demo_mode:
        return []
    return [
        user_out(u) for u in session.scalars(select(User).where(User.is_demo.is_(True)).order_by(User.id))
    ]


@router.post("/auth/demo-login", tags=["auth"])
def demo_login(body: DemoLogin, session: SessionDep, settings: SettingsDep) -> dict[str, Any]:
    if not settings.demo_mode:
        raise HTTPException(403, "demo login is disabled")
    user = session.get(User, body.persona)
    if user is None or not user.is_demo:
        raise HTTPException(404, "unknown demo persona")
    return {"token": issue_token(user, settings), "user": user_out(user)}


@router.get("/auth/me", tags=["auth"], response_model=UserOut)
def me(user: Annotated[User, Depends(current_user)]) -> UserOut:
    return user_out(user)


@router.get("/participants", tags=["auth"], response_model=list[UserOut])
def participants(session: SessionDep, role: str | None = None) -> list[UserOut]:
    q = select(User).order_by(User.id)
    if role:
        q = q.where(User.role == role)
    return [user_out(u) for u in session.scalars(q)]


# ---------------------------------------------------------------------------- observations
def _obs_filters(
    bbox: str | None,
    start: datetime | None,
    end: datetime | None,
    min_rate: float | None,
    max_rate: float | None,
    instruments: list[str] | None,
    sectors: list[str] | None,
) -> list[Any]:
    f: list[Any] = []
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(x) for x in bbox.split(","))
        except ValueError as exc:
            raise HTTPException(422, "bbox must be minLon,minLat,maxLon,maxLat") from exc
        f.append(func.ST_Intersects(Observation.geom, func.ST_MakeEnvelope(minx, miny, maxx, maxy, 4326)))
    if start:
        f.append(Observation.observed_at >= start)
    if end:
        f.append(Observation.observed_at <= end)
    if min_rate is not None:
        f.append(Observation.emission_rate_kg_h >= min_rate)
    if max_rate is not None:
        f.append(Observation.emission_rate_kg_h <= max_rate)
    if instruments:
        f.append(Observation.instrument.in_(instruments))
    if sectors:
        cond: ColumnElement[bool] = Observation.sector.in_([s for s in sectors if s != "none"])
        if "none" in sectors:
            cond = cond | Observation.sector.is_(None)
        f.append(cond)
    return f


@router.get("/observations", tags=["observations"])
def observations_geojson(
    session: SessionDep,
    bbox: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    min_rate: float | None = None,
    max_rate: float | None = None,
    instrument: Annotated[list[str] | None, Query()] = None,
    sector: Annotated[list[str] | None, Query()] = None,
    limit: Annotated[int, Query(le=20000)] = 20000,
) -> dict[str, Any]:
    """GeoJSON FeatureCollection of plume origin points (provider-reported coordinates)."""
    from app.models import IncidentObservation

    q = (
        select(
            Observation.display_id,
            Observation.longitude,
            Observation.latitude,
            Observation.observed_at,
            Observation.emission_rate_kg_h,
            Observation.emission_uncertainty_kg_h,
            Observation.instrument,
            Observation.sector,
            Incident.code,
        )
        .join(IncidentObservation, IncidentObservation.observation_id == Observation.id)
        .join(Incident, Incident.id == IncidentObservation.incident_id)
        .where(and_(True, *_obs_filters(bbox, start, end, min_rate, max_rate, instrument, sector)))
        .order_by(Observation.observed_at.desc())
        .limit(limit)
    )
    feats = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(r.longitude, 6), round(r.latitude, 6)]},
            "properties": {
                "id": r.display_id,
                "t": r.observed_at.strftime("%Y-%m-%d"),
                "ts": int(r.observed_at.timestamp()),
                "rate": None if r.emission_rate_kg_h is None else round(r.emission_rate_kg_h, 1),
                "unc": None if r.emission_uncertainty_kg_h is None else round(r.emission_uncertainty_kg_h, 1),
                "inst": r.instrument,
                "sector": r.sector or "none",
                "incident": r.code,
            },
        }
        for r in session.execute(q)
    ]
    return {"type": "FeatureCollection", "features": feats}


@router.get("/observations/{display_id}", tags=["observations"])
def observation_detail(display_id: str, session: SessionDep) -> dict[str, Any]:
    o = session.scalar(select(Observation).where(Observation.display_id == display_id))
    if o is None:
        raise HTTPException(404, "observation not found")
    from app.models import IncidentObservation

    inc_id = session.scalar(
        select(IncidentObservation.incident_id).where(IncidentObservation.observation_id == o.id)
    )
    inc = session.get(Incident, inc_id) if inc_id else None
    return {
        "observation": obs_out(o).model_dump(mode="json"),
        "raw_metadata": o.raw_metadata,
        "incident": incident_summary(inc).model_dump(mode="json") if inc else None,
    }


@router.get("/observations/{display_id}/plume.png", tags=["observations"], response_class=FileResponse)
def observation_plume_image(display_id: str, session: SessionDep, settings: SettingsDep) -> FileResponse:
    """Provider's plume enhancement raster (PNG), cached locally. Georeferenced by `footprint_bounds`."""
    o = session.scalar(select(Observation).where(Observation.display_id == display_id))
    if o is None:
        raise HTTPException(404, "observation not found")
    for d in (settings.snapshot_dir / "plume-images", settings.cache_dir / "plume-images"):
        p = d / f"{display_id}.png"
        if p.exists():
            return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})
    adapter = CarbonMapperAdapter(
        settings.carbonmapper_base_url, settings.carbonmapper_token, 30, None, max_retries=2
    )
    try:
        url = adapter.fetch_plume(display_id).get("plume_png")
        if not url:
            raise HTTPException(404, "provider has no plume image for this observation")
        r = httpx.get(url, timeout=30)
        r.raise_for_status()
    except (ProviderError, httpx.HTTPError) as exc:
        raise HTTPException(502, f"plume image unavailable (offline or provider error): {exc}") from exc
    out: Path = settings.cache_dir / "plume-images" / f"{display_id}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(r.content)
    return FileResponse(out, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


# ---------------------------------------------------------------------------- incidents
@router.get("/incidents", tags=["incidents"])
def list_incidents(
    session: SessionDep,
    sort: Literal["priority", "recent", "rate", "detections"] = "priority",
    sector: Annotated[list[str] | None, Query()] = None,
    status: str | None = None,
    min_score: float | None = None,
    q: str | None = None,
    limit: Annotated[int, Query(le=500)] = 50,
    offset: int = 0,
) -> dict[str, Any]:
    stmt = select(Incident)
    if sector:
        stmt = stmt.where(Incident.sector.in_(sector))
    if status:
        stmt = stmt.where(Incident.status == status)
    if min_score is not None:
        stmt = stmt.where(Incident.priority_score >= min_score)
    if q:
        stmt = stmt.where(Incident.code.ilike(f"%{q.strip()}%"))
    total = session.scalar(select(func.count()).select_from(stmt.subquery()))
    order_options: dict[str, Any] = {
        "priority": Incident.priority_score.desc(),
        "recent": Incident.last_observed_at.desc(),
        "rate": Incident.median_rate_kg_h.desc().nulls_last(),
        "detections": Incident.detection_date_count.desc(),
    }
    order = order_options[sort]
    rows = session.scalars(stmt.order_by(order, Incident.code).limit(limit).offset(offset)).all()
    return {"total": total, "items": [incident_summary(i).model_dump(mode="json") for i in rows]}


@router.get("/incidents/{ref}", tags=["incidents"], response_model=IncidentDetail)
def incident_detail(ref: str, session: SessionDep) -> IncidentDetail:
    inc = get_incident_or_404(session, ref)
    invs = session.scalars(
        select(Investigation)
        .where(Investigation.incident_id == inc.id)
        .order_by(Investigation.created_at.desc())
    ).all()
    projects = session.scalars(
        select(RepairProject)
        .where(RepairProject.incident_id == inc.id)
        .order_by(RepairProject.created_at.desc())
    ).all()
    s = incident_summary(inc)
    return IncidentDetail(
        **s.model_dump(),
        spatial_spread_m=inc.spatial_spread_m,
        priority_breakdown=inc.priority_breakdown,
        grouping_method=inc.grouping_method,
        grouping_params=inc.grouping_params,
        provider_source_context=inc.provider_source_context,
        observations=[obs_out(o) for o in inc.observations],
        investigations=[investigation_brief(i) for i in invs],
        repair_projects=[project_brief(p) for p in projects],
    )


@router.post("/incidents/{ref}/investigate", tags=["investigations"], status_code=201)
def investigate(
    ref: str, session: SessionDep, settings: SettingsDep, user: Annotated[User, Depends(current_user)]
) -> dict[str, Any]:
    if user.role == "observer":
        raise HTTPException(403, "observers have read-only access")
    inc = session.scalar(
        select(Incident)
        .options(selectinload(Incident.observations))
        .where(Incident.id == get_incident_or_404(session, ref).id)
    )
    assert inc is not None
    t0 = time.perf_counter()
    inv = run_investigation(session, inc, settings, get_generator(settings), requested_by=user.id)
    log.info(
        "investigation complete",
        extra={"incident": inc.code, "kind": inv.report_kind, "ms": int((time.perf_counter() - t0) * 1000)},
    )
    return {"id": str(inv.id), "incident_id": str(inc.id), "report": inv.report}


@router.get("/investigations", tags=["investigations"])
def list_investigations(session: SessionDep, limit: Annotated[int, Query(le=200)] = 50) -> dict[str, Any]:
    rows = session.execute(
        select(Investigation, Incident.code, Incident.priority_score, Incident.sector)
        .join(Incident, Incident.id == Investigation.incident_id)
        .order_by(Investigation.created_at.desc())
        .limit(limit)
    ).all()
    return {
        "items": [
            {
                **investigation_brief(inv),
                "incident_code": code,
                "priority_score": score,
                "sector": sector,
                "summary": inv.report.get("summary"),
                "grounding_passed": inv.report.get("grounding", {}).get("passed"),
            }
            for inv, code, score, sector in rows
        ]
    }


@router.get("/investigations/{inv_id}", tags=["investigations"])
def get_investigation(
    inv_id: str, session: SessionDep, _: Annotated[User | None, Depends(current_user_optional)]
) -> dict[str, Any]:
    import uuid as _uuid

    try:
        inv = session.get(Investigation, _uuid.UUID(inv_id))
    except ValueError as exc:
        raise HTTPException(404, "investigation not found") from exc
    if inv is None:
        raise HTTPException(404, "investigation not found")
    return {
        **investigation_brief(inv),
        "incident_id": str(inv.incident_id),
        "report": inv.report,
        "inputs_digest": inv.inputs_digest,
    }


_ = (IncidentSummary, ObservationOut, project_brief)
