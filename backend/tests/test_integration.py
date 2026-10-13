"""Database + API + chain integration tests (PostGIS test DB and a throwaway Anvil)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.ingestion.pipeline import ingest
from app.models import Incident, Observation

pytestmark = pytest.mark.integration


# ------------------------------------------------------------------ ingestion (DB only)
def test_ingestion_is_idempotent(db, sample) -> None:  # type: ignore[no-untyped-def]
    run1 = ingest(db, sample["plumes"], "carbonmapper", "snapshot", "fixture", None, sample["sources"])
    n_obs = db.scalar(select(func.count()).select_from(Observation))
    n_inc = db.scalar(select(func.count()).select_from(Incident))
    run2 = ingest(db, sample["plumes"], "carbonmapper", "snapshot", "fixture", None, sample["sources"])
    assert run1.stats["inserted"] == n_obs == run1.stats["normalized"]
    assert (
        run1.stats["duplicates_same_id"] == len(sample["plumes"]) - n_obs
    )  # fixture repeats one real record
    assert run2.stats["inserted"] == 0 and run2.stats["already_present"] == n_obs
    assert db.scalar(select(func.count()).select_from(Incident)) == n_inc


def test_ingestion_groups_and_compares(ingested, db) -> None:  # type: ignore[no-untyped-def]
    cmp = ingested.stats["incidents"]["provider_comparison"]
    assert cmp["compared_observations"] > 0 and cmp["adjusted_rand_index"] > 0.8
    big = db.scalar(select(Incident).order_by(Incident.observation_count.desc()))
    assert big.observation_count > 10 and big.detection_date_count > 1
    assert big.priority_breakdown["factors"] and 0 <= big.priority_score <= 100
    for inc in db.scalars(select(Incident)):
        assert inc.observation_count == len(inc.observations)


def test_new_observation_attaches_to_existing_incident(ingested, db, sample) -> None:  # type: ignore[no-untyped-def]
    inc = db.scalar(select(Incident).order_by(Incident.observation_count.desc()))
    before = inc.observation_count
    raw = dict(next(p for p in sample["plumes"] if p["plume_id"] == inc.observations[0].display_id))
    raw.update(
        id="11111111-2222-3333-4444-555555555555",
        plume_id="test20260101t000000-Z",
        scene_timestamp="2026-09-01T00:00:00Z",
    )
    ingest(db, [raw], "carbonmapper", "snapshot", "fixture", None, {})
    db.refresh(inc)
    assert inc.observation_count == before + 1


# ------------------------------------------------------------------ API (DB only)
@pytest.fixture()
def client(db):  # type: ignore[no-untyped-def]
    from app.config import get_settings

    get_settings.cache_clear()
    from app.demo import PERSONAS
    from app.main import create_app
    from app.models import User

    for p in PERSONAS:
        db.merge(User(**p, wallet_address=None, is_demo=True))
    db.commit()
    return TestClient(create_app())


def login(client: TestClient, persona: str) -> dict[str, str]:
    r = client.post("/api/v1/auth/demo-login", json={"persona": persona})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_api_observations_and_filters(client, ingested) -> None:  # type: ignore[no-untyped-def]
    fc = client.get("/api/v1/observations").json()
    assert fc["type"] == "FeatureCollection" and len(fc["features"]) == ingested.stats["inserted"]
    f = fc["features"][0]
    assert f["geometry"]["type"] == "Point" and f["properties"]["incident"].startswith("INC-")
    hi = client.get("/api/v1/observations", params={"min_rate": 1000}).json()["features"]
    assert all(x["properties"]["rate"] >= 1000 for x in hi)
    bbox = client.get("/api/v1/observations", params={"bbox": "-101.8,31.8,-101.7,31.9"}).json()["features"]
    assert all(-101.8 <= x["geometry"]["coordinates"][0] <= -101.7 for x in bbox)
    assert client.get("/api/v1/observations", params={"bbox": "nonsense"}).status_code == 422


def test_api_incident_and_investigation(client, ingested) -> None:  # type: ignore[no-untyped-def]
    top = client.get("/api/v1/incidents", params={"sort": "priority", "limit": 1}).json()["items"][0]
    detail = client.get(f"/api/v1/incidents/{top['code']}").json()
    assert detail["observations"] and detail["priority_breakdown"]["factors"]
    assert client.get("/api/v1/incidents/INC-NOPE00").status_code == 404
    # auth
    assert client.post(f"/api/v1/incidents/{top['code']}/investigate").status_code == 401
    assert (
        client.post(
            f"/api/v1/incidents/{top['code']}/investigate", headers=login(client, "observer")
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/incidents/{top['code']}/investigate", headers={"Authorization": "Bearer garbage"}
        ).status_code
        == 401
    )
    r = client.post(f"/api/v1/incidents/{top['code']}/investigate", headers=login(client, "sponsor"))
    assert r.status_code == 201
    rep = r.json()["report"]
    known = {e["id"] for e in rep["evidence_references"]}
    # evidence reference integrity: every cited ref exists
    for f in rep["confirmed_observations"]:
        assert set(f["evidence_refs"]) <= known
    for e in rep["possible_explanations"]:
        assert e["basis_refs"] and set(e["basis_refs"]) <= known
    assert rep["generation"]["kind"] == "template" and "No language model" in rep["generation"]["note"]
    assert rep["grounding"]["passed"]
    assert set(rep["source_observation_ids"]) == {o["display_id"] for o in detail["observations"]}


def test_project_requires_investigation_and_sponsor(client, ingested) -> None:  # type: ignore[no-untyped-def]
    code = client.get("/api/v1/incidents", params={"limit": 1}).json()["items"][0]["code"]
    body = project_body(code)
    assert (
        client.post("/api/v1/repair-projects", json=body, headers=login(client, "sponsor")).status_code == 409
    )
    client.post(f"/api/v1/incidents/{code}/investigate", headers=login(client, "sponsor"))
    assert (
        client.post("/api/v1/repair-projects", json=body, headers=login(client, "provider")).status_code
        == 403
    )
    assert (
        client.post(
            "/api/v1/repair-projects",
            json={**body, "verifier_id": "provider"},
            headers=login(client, "sponsor"),
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/repair-projects",
            json={**body, "funding_amount_eth": "-1"},
            headers=login(client, "sponsor"),
        ).status_code
        == 422
    )


def project_body(code: str, methodology: str = "QUANTIFIED_REDUCTION") -> dict[str, Any]:
    return {
        "incident_id": code,
        "title": "Integration test repair",
        "repair_scope": "Survey and repair components at the plume origin.",
        "site_authorization": "Operator authorization attested (test).",
        "milestones": [{"name": "Repair"}],
        "methodology": methodology,
        "min_monitoring_days": 21,
        "funding_amount_eth": "1.25",
        "provider_id": "provider",
        "verifier_id": "verifier",
    }


# ------------------------------------------------------------------ full on-chain workflow
@pytest.fixture()
def chain_client(settings, db, ingested):  # type: ignore[no-untyped-def]
    from app.demo import seed_demo
    from app.main import create_app

    seed_demo(db)
    return TestClient(create_app())


def _submit(c: TestClient, code: str, h: dict[str, str], drop: str | None = None):  # type: ignore[no-untyped-def]
    tpl = c.get(f"/api/v1/repair-projects/{code}/simulated-evidence", headers=h).json()
    if not tpl["ready"]:
        assert (
            c.post("/api/v1/demo/advance-time", json={"days": tpl["days_to_advance"]}, headers=h).status_code
            == 200
        )
        tpl = c.get(f"/api/v1/repair-projects/{code}/simulated-evidence", headers=h).json()
    payload = tpl["payload"]
    if drop:
        payload = {**payload, "documents": [d for d in payload["documents"] if d["doc_type"] != drop]}
    names = {d["file_name"] for d in payload["documents"]}
    files = [
        ("files", (f["name"], f["content"].encode(), f["media_type"]))
        for f in tpl["files"]
        if f["name"] in names
    ]
    return c.post(
        f"/api/v1/repair-projects/{code}/submit-evidence",
        headers=h,
        data={"payload": json.dumps(payload)},
        files=files,
    )


def test_full_workflow_onchain(chain_client) -> None:  # type: ignore[no-untyped-def]
    c = chain_client
    sp, pv, vf, ob = (login(c, p) for p in ("sponsor", "provider", "verifier", "observer"))
    code = c.get("/api/v1/incidents", params={"sort": "detections", "limit": 1}).json()["items"][0]["code"]
    c.post(f"/api/v1/incidents/{code}/investigate", headers=sp)
    p = c.post("/api/v1/repair-projects", json=project_body(code), headers=sp).json()
    pid = p["code"]
    assert p["status"] == "DRAFT"

    assert c.post(f"/api/v1/repair-projects/{pid}/publish", headers=pv).status_code == 403
    p = c.post(f"/api/v1/repair-projects/{pid}/publish", headers=sp).json()
    assert p["onchain"]["state"] == "OPEN" and p["onchain"]["terms_hash"] == p["terms_hash"]
    p = c.post(f"/api/v1/repair-projects/{pid}/fund", headers=sp).json()
    assert p["onchain"]["state"] == "FUNDED" and p["onchain"]["amount_wei"] == str(125 * 10**16)
    assert c.post(f"/api/v1/repair-projects/{pid}/fund", headers=sp).status_code == 409  # double funding
    assert c.post(f"/api/v1/repair-projects/{pid}/accept", headers=sp).status_code == 403
    c.post(f"/api/v1/repair-projects/{pid}/accept", headers=pv)

    # Round 1: incomplete evidence → VERIFIED blocked → REJECTED → no payout
    assert _submit(c, pid, pv, drop="post_repair_survey").status_code == 200
    ctx = c.get(f"/api/v1/repair-projects/{pid}/verification-context").json()
    assert "documentation_complete" in ctx["blocking"]
    assert (
        c.post(f"/api/v1/repair-projects/{pid}/verify", json={"outcome": "VERIFIED"}, headers=vf).status_code
        == 409
    )
    assert (
        c.post(f"/api/v1/repair-projects/{pid}/verify", json={"outcome": "VERIFIED"}, headers=sp).status_code
        == 403
    )
    r = c.post(
        f"/api/v1/repair-projects/{pid}/verify",
        json={"outcome": "REJECTED", "notes": "missing survey"},
        headers=vf,
    )
    assert r.status_code == 200 and r.json()["project"]["onchain"]["state"] == "REJECTED"
    assert c.post(f"/api/v1/repair-projects/{pid}/release", headers=pv).status_code == 409

    # Round 2: complete evidence → VERIFIED → paid once
    assert _submit(c, pid, pv).status_code == 200
    assert (
        c.post(f"/api/v1/repair-projects/{pid}/verify", json={"outcome": "VERIFIED"}, headers=ob).status_code
        == 403
    )
    r = c.post(
        f"/api/v1/repair-projects/{pid}/verify", json={"outcome": "VERIFIED", "notes": "ok"}, headers=vf
    )
    assert r.status_code == 200
    v = r.json()["verification"]
    assert v["round"] == 2 and v["signature"].startswith("0x") and len(v["eip712_digest"]) == 66
    r = c.post(f"/api/v1/repair-projects/{pid}/release", headers=pv)
    assert r.status_code == 200 and r.json()["status"] == "PAID" and r.json()["onchain"]["state"] == "PAID"
    assert (
        c.post(f"/api/v1/repair-projects/{pid}/release", headers=pv).status_code == 409
    )  # duplicate settlement

    # Reconciliation finds no drift; receipt is consistent with chain events
    rec = c.post(f"/api/v1/repair-projects/{pid}/reconcile").json()
    assert rec["changed"] is False and rec["onchain_state"] == "PAID"
    rid = r.json()["receipt_id"]
    receipt = c.get(f"/api/v1/receipts/{rid}").json()
    assert (
        receipt["payload"]["impact"]["status"] == "quantified"
        and receipt["payload"]["impact"]["is_simulated"]
    )
    names = [e["event"] for e in receipt["history"]["chain_events"]]
    assert (
        names.count("EvidenceSubmitted") == 2
        and names.count("DecisionRecorded") == 2
        and names[-1] == "PaymentReleased"
    )
    ledger = c.get("/api/v1/impact").json()
    assert ledger["real_world_verified_reductions"]["value"] is None
    assert ledger["workflow"]["verified_completion_events"] == 1


def test_reconcile_repairs_db_drift(chain_client, db) -> None:  # type: ignore[no-untyped-def]
    from app.models import RepairProject

    c = chain_client
    sp = login(c, "sponsor")
    code = c.get("/api/v1/incidents", params={"limit": 1}).json()["items"][0]["code"]
    c.post(f"/api/v1/incidents/{code}/investigate", headers=sp)
    pid = c.post("/api/v1/repair-projects", json=project_body(code, "REPAIR_COMPLETION"), headers=sp).json()[
        "code"
    ]
    c.post(f"/api/v1/repair-projects/{pid}/publish", headers=sp)
    c.post(f"/api/v1/repair-projects/{pid}/fund", headers=sp)
    # Simulate a crash after the funding tx mined but before the DB write
    proj = db.scalar(select(RepairProject).where(RepairProject.code == pid))
    proj.status = "OPEN_FOR_FUNDING"
    db.commit()
    rec = c.post(f"/api/v1/repair-projects/{pid}/reconcile").json()
    assert rec["changed"] is True and rec["db_status_after"] == "FUNDED"
    assert c.post(f"/api/v1/repair-projects/{pid}/reconcile").json()["changed"] is False


def test_demo_reset_requires_admin(chain_client) -> None:  # type: ignore[no-untyped-def]
    assert chain_client.post("/api/v1/demo/reset", headers=login(chain_client, "sponsor")).status_code == 403
    assert chain_client.post("/api/v1/demo/reset", headers=login(chain_client, "admin")).status_code == 200


def test_health(chain_client) -> None:  # type: ignore[no-untyped-def]
    h = chain_client.get("/api/v1/health").json()
    assert h == {"status": "ok", "database": True, "blockchain": True}
    assert datetime.now(UTC)  # sanity
