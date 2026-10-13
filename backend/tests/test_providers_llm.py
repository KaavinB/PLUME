from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from app.investigation.llm import LlmUnavailable
from app.investigation.report import Inference, LlmNarrative
from app.providers.carbonmapper import CarbonMapperAdapter, ProviderError
from app.providers.snapshot import SnapshotAdapter, build_carbonmapper_snapshot


def adapter(handler, **kw: Any) -> CarbonMapperAdapter:  # type: ignore[no-untyped-def]
    a = CarbonMapperAdapter(client=httpx.Client(transport=httpx.MockTransport(handler)), **kw)
    return a


def test_pagination_collects_all_pages(sample: dict) -> None:
    items = sample["plumes"][:25]
    seen: list[int] = []

    def handler(req: httpx.Request) -> httpx.Response:
        off, lim = int(req.url.params["offset"]), int(req.url.params["limit"])
        seen.append(off)
        assert req.url.params["plume_gas"] == "CH4" and len(req.url.params.get_list("bbox")) == 4
        return httpx.Response(200, json={"bbox_count": len(items), "items": items[off : off + lim]})

    out = adapter(handler).fetch_observations(
        bbox=(-104.5, 31.0, -101.0, 33.5), page_size=10, use_cache=False
    )
    assert len(out) == 25 and seen == [0, 10, 20]
    assert all("plume_png" not in i for i in out)


def test_rate_limit_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("time.sleep", lambda s: None)
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(429, headers={"Retry-After": "1"})
        return httpx.Response(200, json={"items": []})

    assert adapter(handler).fetch_observations(bbox=(0, 0, 1, 1), use_cache=False) == []
    assert calls["n"] == 3


def test_persistent_errors_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("time.sleep", lambda s: None)
    with pytest.raises(ProviderError):
        adapter(lambda r: httpx.Response(503), max_retries=2).fetch_observations(
            bbox=(0, 0, 1, 1), use_cache=False
        )
    with pytest.raises(ProviderError):
        adapter(lambda r: httpx.Response(400, text="bad")).fetch_observations(
            bbox=(0, 0, 1, 1), use_cache=False
        )

    def timeout(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    with pytest.raises(ProviderError, match="timed out"):
        adapter(timeout, max_retries=2).fetch_observations(bbox=(0, 0, 1, 1), use_cache=False)


def test_responses_are_cached(tmp_path: Path) -> None:
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"items": []})

    a = adapter(handler, cache_dir=tmp_path)
    a.fetch_observations(bbox=(0, 0, 1, 1))
    a.fetch_observations(bbox=(0, 0, 1, 1))
    assert calls["n"] == 1


def test_snapshot_round_trip(sample: dict, tmp_path: Path) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("sources.geojson"):
            return httpx.Response(200, json=sample["sources"])
        return httpx.Response(200, json={"items": sample["plumes"]})

    out = tmp_path / "snap.json.gz"
    meta = build_carbonmapper_snapshot(adapter(handler), out, "test", (-104.5, 31.0, -101.0, 33.5))
    snap = SnapshotAdapter(out)
    assert meta["plumes"] == len(sample["plumes"]) == len(snap.fetch_observations())
    assert snap.provider == "carbonmapper" and snap.payload["attribution"].startswith("Data: Carbon Mapper")
    assert snap.normalize(snap.fetch_observations()[0]) is not None
    assert len(snap.sha256) == 64


# ------------------------------------------------------------------ LLM adapter behaviour
class FakeGenerator:
    model_identifier = "fake/model"

    def __init__(self, narrative: LlmNarrative | None = None, fail: bool = False) -> None:
        self.narrative, self.fail = narrative, fail

    def generate(self, pack: dict) -> LlmNarrative:
        if self.fail:
            raise LlmUnavailable("provider down")
        assert "evidence_references" in pack and "confirmed_facts" in pack
        return self.narrative  # type: ignore[return-value]


@pytest.mark.integration
def test_llm_grounded_narrative_is_used(ingested, db) -> None:  # type: ignore[no-untyped-def]
    from sqlalchemy import select

    from app.config import get_settings
    from app.investigation.engine import run_investigation
    from app.models import Incident

    inc = db.scalar(select(Incident).order_by(Incident.observation_count.desc()))
    ref = f"OBS:{inc.observations[0].display_id}"
    good = LlmNarrative(
        summary=f"Incident {inc.code} has repeated detections.",
        possible_explanations=[
            Inference(statement="Possible persistent source.", basis_refs=[ref], confidence="medium")
        ],
        next_investigation_steps=["Confirm the facility on the ground."],
        unresolved_questions=["Which component is emitting?"],
    )
    inv = run_investigation(db, inc, get_settings(), FakeGenerator(good))
    assert inv.report_kind == "llm" and inv.report["generation"]["model_identifier"] == "fake/model"


@pytest.mark.integration
def test_llm_ungrounded_or_failed_falls_back_to_template(ingested, db) -> None:  # type: ignore[no-untyped-def]
    from sqlalchemy import select

    from app.config import get_settings
    from app.investigation.engine import run_investigation
    from app.models import Incident

    inc = db.scalar(select(Incident).order_by(Incident.observation_count.desc()))
    bad = LlmNarrative(
        summary="Acme Petroleum LLC leaks 123,456 kg/h.",
        possible_explanations=[
            Inference(statement="valve 7 failed", basis_refs=["OBS:invented"], confidence="high")
        ],
        next_investigation_steps=[],
        unresolved_questions=[],
    )
    inv = run_investigation(db, inc, get_settings(), FakeGenerator(bad))
    assert inv.report_kind == "template" and "rejected by grounding check" in inv.report["generation"]["note"]
    inv2 = run_investigation(db, inc, get_settings(), FakeGenerator(fail=True))
    assert inv2.report_kind == "template" and "unavailable" in inv2.report["generation"]["note"]
