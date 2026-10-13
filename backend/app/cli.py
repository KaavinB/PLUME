"""Operational commands: `uv run python -m app.cli <command>`."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from sqlalchemy import select

from app.config import get_settings
from app.db import session_factory
from app.ingestion.pipeline import ingest
from app.investigation.clustering import ClusterParams
from app.logging_setup import configure_logging
from app.models import IngestionRun
from app.providers.carbonmapper import CarbonMapperAdapter
from app.providers.snapshot import SnapshotAdapter, build_carbonmapper_snapshot

log = logging.getLogger("plume.cli")

DEFAULT_SNAPSHOT = "carbonmapper_permian_ch4.json.gz"
PERMIAN_BBOX = (-104.5, 31.0, -101.0, 33.5)


def cmd_ingest_snapshot(args: argparse.Namespace) -> int:
    s = get_settings()
    path = Path(args.path) if args.path else s.snapshot_dir / DEFAULT_SNAPSHOT
    adapter = SnapshotAdapter(path)
    sha = adapter.sha256
    with session_factory()() as session:
        prior = session.scalar(
            select(IngestionRun).where(
                IngestionRun.source_sha256 == sha, IngestionRun.finished_at.is_not(None)
            )
        )
        if prior and not args.force:
            print(
                json.dumps({"skipped": True, "reason": "snapshot already ingested", "run_id": str(prior.id)})
            )
            return 0
        run = ingest(
            session,
            adapter.fetch_observations(),
            provider=adapter.provider,
            mode="snapshot",
            source_ref=str(path.relative_to(s.snapshot_dir.parent.parent))
            if path.is_relative_to(s.snapshot_dir.parent.parent)
            else str(path),
            source_sha256=sha,
            sources_geojson=adapter.sources(),
            cluster_params=ClusterParams(eps_m=args.eps_m),
        )
        print(json.dumps({"run_id": str(run.id), "stats": run.stats}, indent=2, default=str))
    return 0


def cmd_ingest_live(args: argparse.Namespace) -> int:
    s = get_settings()
    adapter = CarbonMapperAdapter(
        s.carbonmapper_base_url, s.carbonmapper_token, s.http_timeout_s, s.cache_dir
    )
    bbox = tuple(float(x) for x in args.bbox.split(","))
    assert len(bbox) == 4
    raw = adapter.fetch_observations(bbox=bbox, datetime_range=args.datetime, use_cache=not args.no_cache)  # type: ignore[arg-type]
    sources = adapter.fetch_sources(bbox=bbox)  # type: ignore[arg-type]
    with session_factory()() as session:
        run = ingest(
            session,
            raw,
            provider="carbonmapper",
            mode="live",
            source_ref=f"{s.carbonmapper_base_url}/catalog/plumes/annotated bbox={args.bbox}",
            source_sha256=None,
            sources_geojson=sources,
            cluster_params=ClusterParams(eps_m=args.eps_m),
        )
        print(json.dumps({"run_id": str(run.id), "stats": run.stats}, indent=2, default=str))
    return 0


def cmd_build_snapshot(args: argparse.Namespace) -> int:
    s = get_settings()
    adapter = CarbonMapperAdapter(s.carbonmapper_base_url, s.carbonmapper_token, 180, s.cache_dir)
    bbox = tuple(float(x) for x in args.bbox.split(","))
    out = Path(args.out) if args.out else s.snapshot_dir / DEFAULT_SNAPSHOT
    print(json.dumps(build_carbonmapper_snapshot(adapter, out, args.region, bbox), indent=2))  # type: ignore[arg-type]
    return 0


def cmd_seed_demo(args: argparse.Namespace) -> int:
    from app.demo import seed_demo

    with session_factory()() as session:
        print(json.dumps(seed_demo(session), indent=2, default=str))
    return 0


def cmd_reset_demo(args: argparse.Namespace) -> int:
    from app.demo import reset_demo

    s = get_settings()
    if not s.demo_mode or s.chain_id != 31337:
        print("reset-demo is only permitted with PLUME_DEMO_MODE=true on the local Anvil chain (31337)")
        return 2
    with session_factory()() as session:
        print(json.dumps(reset_demo(session), indent=2, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    configure_logging()
    p = argparse.ArgumentParser(prog="plume")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("ingest-snapshot", help="load a version-controlled provider snapshot")
    a.add_argument("--path")
    a.add_argument("--eps-m", type=float, default=200.0)
    a.add_argument("--force", action="store_true")
    a.set_defaults(fn=cmd_ingest_snapshot)

    b = sub.add_parser("ingest-live", help="fetch from the Carbon Mapper API and ingest")
    b.add_argument("--bbox", default=",".join(map(str, PERMIAN_BBOX)))
    b.add_argument("--datetime", default=None)
    b.add_argument("--eps-m", type=float, default=200.0)
    b.add_argument("--no-cache", action="store_true")
    b.set_defaults(fn=cmd_ingest_live)

    c = sub.add_parser("build-snapshot", help="fetch from Carbon Mapper and write a snapshot file")
    c.add_argument("--bbox", default=",".join(map(str, PERMIAN_BBOX)))
    c.add_argument("--region", default="Permian Basin (TX/NM, USA)")
    c.add_argument("--out")
    c.set_defaults(fn=cmd_build_snapshot)

    d = sub.add_parser("seed-demo", help="create demo personas (local chain only)")
    d.set_defaults(fn=cmd_seed_demo)
    e = sub.add_parser("reset-demo", help="delete repair projects/investigations (local demo only)")
    e.set_defaults(fn=cmd_reset_demo)

    args = p.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
