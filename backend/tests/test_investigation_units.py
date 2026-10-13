from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.investigation.clustering import (
    ClusterParams,
    PointRecord,
    centroid,
    cluster_points,
    compare_with_provider,
    haversine_m,
    spread_m,
)
from app.investigation.knowledge import build_query, load_kb, retrieve
from app.investigation.report import (
    Inference,
    LlmNarrative,
    allowed_numbers,
    find_unsupported_numbers,
    ground_narrative,
)
from app.investigation.scoring import WEIGHTS, ObservationFacts, score_incident

T0 = datetime(2026, 9, 12, tzinfo=UTC)


# ------------------------------------------------------------------ geodesy & clustering
def test_haversine_known_distance() -> None:
    # 0.001° latitude ≈ 111.2 m
    assert haversine_m(-102.0, 32.0, -102.0, 32.001) == pytest.approx(111.2, rel=0.01)


def _p(key: str, lon: float, lat: float, sector: str | None = "1B2", group: str | None = None) -> PointRecord:
    return PointRecord(key, lon, lat, sector, group)


def test_points_within_eps_group_and_far_points_split() -> None:
    pts = [_p("a", -102.0, 32.0), _p("b", -102.0, 32.0009), _p("c", -102.0, 32.01)]  # ~100 m, ~1.1 km
    groups = cluster_points(pts, ClusterParams(eps_m=200))
    assert sorted(sorted(p.key for p in g) for g in groups) == [["a", "b"], ["c"]]


def test_sectors_never_merge() -> None:
    pts = [_p("a", -102.0, 32.0, "1B2"), _p("b", -102.0, 32.0001, "6A")]
    assert len(cluster_points(pts, ClusterParams(eps_m=500))) == 2


def test_clustering_is_order_independent() -> None:
    pts = [_p(str(i), -102 + (i % 7) * 0.0005, 32 + (i // 7) * 0.0005) for i in range(40)]
    a = cluster_points(pts, ClusterParams())
    b = cluster_points(list(reversed(pts)), ClusterParams())
    assert [sorted(p.key for p in g) for g in a] == [sorted(p.key for p in g) for g in b]


def test_centroid_and_spread() -> None:
    pts = [_p("a", -102.0, 32.0), _p("b", -102.0, 32.002)]
    lon, lat = centroid(pts)
    assert lat == pytest.approx(32.001, abs=1e-6) and lon == pytest.approx(-102.0, abs=1e-6)
    assert spread_m(pts) == pytest.approx(111.2, rel=0.02)
    assert spread_m(pts[:1]) == 0.0


def test_provider_comparison_perfect_agreement() -> None:
    pts = [
        _p("a", -102.0, 32.0, group="S1"),
        _p("b", -102.0, 32.0005, group="S1"),
        _p("c", -101.0, 31.0, group="S2"),
    ]
    cmp = compare_with_provider(cluster_points(pts, ClusterParams()))
    assert cmp.adjusted_rand_index == pytest.approx(1.0)
    assert cmp.exact_group_matches == 2


# ------------------------------------------------------------------ scoring
def facts(
    n_dates: int, rate: float | None = 1000, unc: float | None = 200, instruments: tuple[str, ...] = ("GAO",)
) -> list[ObservationFacts]:
    return [
        ObservationFacts(T0 - timedelta(days=30 * i), rate, unc, instruments[i % len(instruments)])
        for i in range(n_dates)
    ]


def test_score_bounds_and_weights_sum() -> None:
    assert sum(WEIGHTS.values()) == pytest.approx(100)
    score, factors = score_incident(facts(5, instruments=("GAO", "emi", "tan")), T0, 20, 1.0)
    assert 0 <= score <= 100
    assert score == pytest.approx(sum(f.contribution for f in factors), abs=0.01)
    assert all(0 <= (f.value or 0) <= 1 for f in factors)


def test_score_is_reproducible() -> None:
    a = score_incident(facts(3), T0, 50, 0.5)
    b = score_incident(facts(3), T0, 50, 0.5)
    assert a[0] == b[0]


def test_single_detection_not_treated_as_persistent() -> None:
    _, f = score_incident(facts(1), T0, 0, None)
    rec = next(x for x in f if x.name == "recurrence")
    assert rec.value == 0 and "persistence not inferred" in rec.evidence


def test_missing_evidence_lowers_priority() -> None:
    with_rate, _ = score_incident(facts(3), T0, 30, 0.8)
    without_rate, f = score_incident(facts(3, rate=None, unc=None), T0, 30, 0.8)
    assert without_rate < with_rate
    assert next(x for x in f if x.name == "magnitude").value is None


def test_more_recurrence_and_magnitude_increase_priority() -> None:
    assert score_incident(facts(6), T0, 30, None)[0] > score_incident(facts(2), T0, 30, None)[0]
    assert (
        score_incident(facts(3, rate=4000, unc=400), T0, 30, None)[0]
        > score_incident(facts(3, rate=100, unc=10), T0, 30, None)[0]
    )


def test_empty_incident_rejected() -> None:
    with pytest.raises(ValueError):
        score_incident([], T0, 0)


# ------------------------------------------------------------------ knowledge base
def test_every_kb_entry_is_sourced() -> None:
    kb = load_kb()
    assert kb.entries
    for e in kb.entries:
        assert e.sources and all(s["url"].startswith("https://") for s in e.sources)


def test_retrieval_respects_sector() -> None:
    kb = load_kb()
    landfill = retrieve(kb, "6A", build_query("6A", 3, 1.0, 200), k=5)
    assert any(e.id.startswith("KB-LF") for e, _ in landfill)
    assert not any(e.id.startswith("KB-OG") for e, _ in landfill)
    og = retrieve(kb, "1B2", build_query("1B2", 5, 0.7, 1500), k=5)
    assert any(e.id == "KB-OG-LDAR" for e, _ in og)


def test_unassigned_sector_gets_attribution_guidance() -> None:
    hits = retrieve(load_kb(), None, build_query(None, 1, None, 2000), k=5)
    assert any(e.id == "KB-X-ATTRIBUTION" for e, _ in hits)


# ------------------------------------------------------------------ grounding
EVIDENCE = "median 1,404 kg/h over 40 detections; persistence 0.78; 28 dates; OBS:x"


def test_numbers_must_come_from_evidence() -> None:
    allowed = allowed_numbers(EVIDENCE)
    assert find_unsupported_numbers("median of 1,404 kg/h on 28 dates (78%)", allowed) == []
    assert find_unsupported_numbers("about 25,000 tonnes per year", allowed) == ["25,000"]


def test_grounding_flags_unknown_refs_entities_and_numbers() -> None:
    n = LlmNarrative(
        summary="Acme Energy LLC operates the site emitting 9,999 kg/h.",
        possible_explanations=[Inference(statement="leak", basis_refs=["OBS:missing"], confidence="low")],
        next_investigation_steps=["survey"],
        unresolved_questions=["who?"],
    )
    g = ground_narrative(n, {"OBS:x"}, EVIDENCE)
    assert not g.passed
    assert "OBS:missing" in g.unknown_refs
    assert any("9,999" in u for u in g.unsupported_numbers)
    assert any("Acme Energy" in e for e in g.named_entity_flags)


def test_grounding_passes_for_supported_text() -> None:
    n = LlmNarrative(
        summary="Detections on 28 dates with a median of 1,404 kg/h.",
        possible_explanations=[
            Inference(statement="persistent source", basis_refs=["OBS:x"], confidence="medium")
        ],
        next_investigation_steps=["Confirm the operator."],
        unresolved_questions=["Is it still emitting?"],
    )
    assert ground_narrative(n, {"OBS:x"}, EVIDENCE).passed
