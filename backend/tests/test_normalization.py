from __future__ import annotations

import copy

import pytest

from app.ingestion.pipeline import normalize_batch, provider_source_index
from app.providers.carbonmapper import normalize_carbonmapper, normalize_carbonmapper_with_reason


@pytest.fixture()
def raw(sample: dict) -> dict:
    return copy.deepcopy(
        next(p for p in sample["plumes"] if p.get("emission_auto") and not p.get("hide_emission"))
    )


def test_real_records_normalize(sample: dict) -> None:
    out, stats = normalize_batch(sample["plumes"], "carbonmapper")
    assert stats["fetched"] == len(sample["plumes"])
    assert len(out) == stats["normalized"] > 0
    for o in out:
        assert o.gas == "CH4"
        assert -90 <= o.latitude <= 90 and -180 <= o.longitude <= 180
        assert o.emission_rate_kg_h is None or o.emission_rate_kg_h > 0
        assert o.observed_at.tzinfo is not None
        assert o.source_url.endswith(o.display_id)


def test_preserves_units_uncertainty_geometry_and_ids(raw: dict) -> None:
    o = normalize_carbonmapper(raw)
    assert o is not None
    assert o.emission_rate_kg_h == pytest.approx(raw["emission_auto"])
    assert o.emission_uncertainty_kg_h == pytest.approx(raw["emission_uncertainty_auto"])
    assert (o.longitude, o.latitude) == tuple(raw["geometry_json"]["coordinates"][:2])
    assert o.external_id == raw["id"] and o.display_id == raw["plume_id"]
    assert o.footprint_bounds == tuple(raw["plume_bounds"])


def test_signed_urls_never_retained(raw: dict) -> None:
    raw["plume_png"] = "https://example/x.png?Signature=abc"
    o = normalize_carbonmapper(raw)
    assert o is not None and "plume_png" not in o.raw


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda r: r.update(gas="CO2"), "not_methane"),
        (lambda r: r.update(status="deleted"), "not_published"),
        (lambda r: r.update(scene_timestamp="not-a-date"), "invalid_timestamp"),
        (
            lambda r: r.update(geometry_json={"type": "Point", "coordinates": [200.0, 10.0]}),
            "invalid_coordinates",
        ),
        (lambda r: r.update(geometry_json={"type": "Polygon", "coordinates": []}), "missing_point_geometry"),
        (lambda r: r.update(plume_id=None), "missing_identifier"),
    ],
)
def test_rejections_have_reasons(raw: dict, mutate, reason: str) -> None:  # type: ignore[no-untyped-def]
    mutate(raw)
    obs, why = normalize_carbonmapper_with_reason(raw)
    assert obs is None and why == reason


def test_hidden_emission_is_not_reported(raw: dict) -> None:
    raw["hide_emission"] = True
    o = normalize_carbonmapper(raw)
    assert o is not None and o.emission_rate_kg_h is None and o.emission_uncertainty_kg_h is None
    assert "emission_hidden_by_provider" in o.validation_flags


def test_non_positive_and_nan_rates_dropped(raw: dict) -> None:
    raw["emission_auto"] = 0
    assert normalize_carbonmapper(raw).emission_rate_kg_h is None  # type: ignore[union-attr]
    raw["emission_auto"] = float("nan")
    assert normalize_carbonmapper(raw).emission_rate_kg_h is None  # type: ignore[union-attr]


def test_uncertainty_flags(raw: dict) -> None:
    raw["emission_uncertainty_auto"] = raw["emission_auto"] * 2
    assert "uncertainty_exceeds_estimate" in normalize_carbonmapper(raw).validation_flags  # type: ignore[union-attr]
    raw["emission_uncertainty_auto"] = -1
    o = normalize_carbonmapper(raw)
    assert (
        o is not None
        and o.emission_uncertainty_kg_h is None
        and "negative_uncertainty_discarded" in o.validation_flags
    )


def test_deduplication_is_deterministic(sample: dict) -> None:
    recs = sample["plumes"][:10]
    dup_same_id = copy.deepcopy(recs[0])
    dup_reissued = copy.deepcopy(recs[1])
    dup_reissued["id"] = "00000000-0000-0000-0000-000000000000"  # same detection, different provider id
    out, stats = normalize_batch(recs + [dup_same_id, dup_reissued], "carbonmapper")
    assert stats["duplicates_same_id"] == 1
    assert stats["duplicates_same_detection"] == 1
    assert [o.external_id for o in out] == [o.external_id for o in normalize_batch(recs, "carbonmapper")[0]]


def test_provider_source_names_strip_echoed_query(sample: dict) -> None:
    by_plume, summaries = provider_source_index(sample["sources"])
    assert summaries and all("?" not in n for n in summaries)
    assert all(v in summaries for v in by_plume.values())
