"""Reproducible measurements for EVALUATION.md / RESUME_METRICS.md.

Requires the running stack (API :8000, Postgres, Anvil) with the snapshot ingested.
Usage: uv run --project backend python scripts/benchmark.py [--n 50] [--out docs/eval/results.json]
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def pct(values: list[float], p: float) -> float:
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[lo] + (s[hi] - s[lo]) * (k - lo), 2)


def timed(fn, n: int) -> dict[str, float]:  # type: ignore[no-untyped-def]
    xs = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        xs.append((time.perf_counter() - t0) * 1000)
    return {"n": n, "p50_ms": pct(xs, 0.5), "p95_ms": pct(xs, 0.95), "max_ms": round(max(xs), 2), "mean_ms": round(statistics.mean(xs), 2)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--out", default=str(ROOT / "docs" / "eval" / "results.json"))
    args = ap.parse_args()
    c = httpx.Client(base_url=args.base + "/api/v1", timeout=60)
    results: dict[str, Any] = {
        "measured_at": datetime.now(UTC).isoformat(),
        "machine": f"{platform.system()} {platform.machine()} · Python {platform.python_version()}",
        "note": "Local single-process uvicorn; PostGIS in Docker (linux/amd64 image under emulation on Apple silicon); Anvil automine.",
    }

    # ---------------------------------------------------------------- data
    from sqlalchemy import func, select

    from app.db import session_factory
    from app.investigation.clustering import ClusterParams, PointRecord, cluster_points, compare_with_provider
    from app.models import Incident, IngestionRun, Observation

    with session_factory()() as s:
        run = s.scalar(select(IngestionRun).order_by(IngestionRun.started_at.asc()))
        st = run.stats if run else {}
        n_obs = s.scalar(select(func.count()).select_from(Observation)) or 0
        results["ingestion"] = {
            "source": run.source_ref if run else None,
            "source_sha256": run.source_sha256 if run else None,
            "records_fetched": st.get("fetched"),
            "normalized": st.get("normalized"),
            "rejected": st.get("rejected"),
            "duplicates_same_id": st.get("duplicates_same_id"),
            "duplicates_same_detection": st.get("duplicates_same_detection"),
            "validation_flags": st.get("flags"),
            "timing_s": st.get("timing_s"),
            "throughput_records_per_s_end_to_end": round(st["fetched"] / st["timing_s"]["total"], 1) if st.get("timing_s") else None,
            "normalize_records_per_s": round(st["fetched"] / max(st["timing_s"]["normalize"], 1e-9), 1) if st.get("timing_s") else None,
            "observations_in_db": n_obs,
            "incidents_in_db": s.scalar(select(func.count()).select_from(Incident)),
            "grouping": st.get("incidents", {}),
        }
        rows = s.execute(select(Observation.id, Observation.longitude, Observation.latitude, Observation.sector, Observation.provider_source_name)).all()
        pts = [PointRecord(str(r[0]), r[1], r[2], r[3], r[4]) for r in rows]
    t0 = time.perf_counter()
    groups = cluster_points(pts, ClusterParams())
    cluster_ms = (time.perf_counter() - t0) * 1000
    sweep = {}
    for eps in (100, 200, 500, 1000):
        cmp = compare_with_provider(cluster_points(pts, ClusterParams(eps_m=eps)))
        sweep[str(eps)] = {"groups": cmp.our_groups, "adjusted_rand_index": round(cmp.adjusted_rand_index or 0, 4), "identical_groups": cmp.exact_group_matches}
    results["grouping_performance"] = {"points": len(pts), "groups": len(groups), "dbscan_ms": round(cluster_ms, 1), "eps_sweep_vs_carbon_mapper": sweep, "provider_groups": cmp.provider_groups}

    # ---------------------------------------------------------------- API latency
    tok = c.post("/auth/demo-login", json={"persona": "sponsor"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    top = c.get("/incidents", params={"limit": 1}).json()["items"][0]["code"]
    lat = {
        "GET /health": timed(lambda: c.get("/health").raise_for_status(), args.n),
        "GET /observations (10k GeoJSON)": timed(lambda: c.get("/observations").raise_for_status(), max(10, args.n // 5)),
        "GET /incidents?limit=50": timed(lambda: c.get("/incidents", params={"limit": 50}).raise_for_status(), args.n),
        f"GET /incidents/{top}": timed(lambda: c.get(f"/incidents/{top}").raise_for_status(), args.n),
        f"POST /incidents/{top}/investigate": timed(lambda: c.post(f"/incidents/{top}/investigate", headers=h).raise_for_status(), max(10, args.n // 2)),
    }
    results["api_latency"] = lat
    inv = c.get("/investigations", params={"limit": 200}).json()["items"]
    results["investigation_engine_latency_ms"] = {
        "n": len(inv),
        "p50": pct([i["latency_ms"] for i in inv], 0.5),
        "p95": pct([i["latency_ms"] for i in inv], 0.95),
        "report_kinds": sorted({i["report_kind"] for i in inv}),
        "grounding_pass_rate": round(sum(1 for i in inv if i["grounding_passed"]) / max(len(inv), 1), 4),
    }

    # ---------------------------------------------------------------- e2e API journey
    t0 = time.perf_counter()
    proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "e2e_api.py"), "--base", args.base], capture_output=True, text=True)
    results["e2e_api_journey"] = {
        "passed": proc.returncode == 0,
        "duration_s": round(time.perf_counter() - t0, 2),
        "checks_passed": proc.stdout.count("✓"),
        "checks_failed": proc.stdout.count("✗"),
        "step_timings_ms": json.loads(next((ln.split("Timings (ms):", 1)[1] for ln in proc.stdout.splitlines() if "Timings (ms):" in ln), "{}")),
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(results, indent=2, default=str))
    print(json.dumps(results, indent=2, default=str))
    return 0 if results["e2e_api_journey"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
