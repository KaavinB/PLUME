from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chain.client import ChainClient, ChainError, get_chain
from app.config import Settings, get_settings
from app.db import get_session
from app.models import Incident, RepairProject

SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


def chain_dep(settings: SettingsDep) -> ChainClient:
    try:
        chain = get_chain(settings)
    except ChainError as exc:
        raise HTTPException(503, f"blockchain unavailable: {exc}") from exc
    if not chain.is_connected():
        raise HTTPException(503, f"blockchain RPC not reachable at {settings.chain_rpc_url}")
    return chain


ChainDep = Annotated[ChainClient, Depends(chain_dep)]


def get_incident_or_404(session: Session, ref: str) -> Incident:
    inc: Incident | None = None
    try:
        inc = session.get(Incident, uuid.UUID(ref))
    except ValueError:
        inc = session.scalar(select(Incident).where(Incident.code == ref.upper()))
    if inc is None:
        raise HTTPException(404, "incident not found")
    return inc


def get_project_or_404(session: Session, ref: str) -> RepairProject:
    p: RepairProject | None = None
    try:
        p = session.get(RepairProject, uuid.UUID(ref))
    except ValueError:
        p = session.scalar(select(RepairProject).where(RepairProject.code == ref.upper()))
    if p is None:
        raise HTTPException(404, "repair project not found")
    return p
