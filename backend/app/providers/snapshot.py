"""Version-controlled snapshots of genuinely retrieved provider data.

A snapshot preserves the exact request, retrieval time, attribution and raw records (minus
short-lived signed URLs) so the application can run offline without fabricating anything.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.providers.base import NormalizedObservation
from app.providers.carbonmapper import ATTRIBUTION, CarbonMapperAdapter, normalize_carbonmapper

SNAPSHOT_SCHEMA = "plume.snapshot.v1"


def build_carbonmapper_snapshot(
    adapter: CarbonMapperAdapter,
    out_path: Path,
    region_name: str,
    bbox: tuple[float, float, float, float],
    datetime_range: str | None = None,
) -> dict[str, Any]:
    items = adapter.fetch_observations(bbox=bbox, datetime_range=datetime_range, use_cache=True)
    sources = adapter.fetch_sources(bbox=bbox)
    payload = {
        "schema": SNAPSHOT_SCHEMA,
        "provider": "carbonmapper",
        "region": region_name,
        "retrieved_at": datetime.now(UTC).isoformat(),
        "request": {
            "plumes": {
                "endpoint": f"{adapter.base_url}/catalog/plumes/annotated",
                "params": {"plume_gas": "CH4", "bbox": list(bbox), "datetime": datetime_range},
            },
            "sources": {
                "endpoint": f"{adapter.base_url}/catalog/sources.geojson",
                "params": {"plume_gas": "CH4", "bbox": list(bbox)},
            },
        },
        "attribution": ATTRIBUTION,
        "license_url": "https://carbonmapper.org/terms",
        "notes": "Signed asset URLs were removed because they expire. Records are otherwise unmodified.",
        "plume_count": len(items),
        "plumes": items,
        "sources": sources,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    payload_digest = hashlib.sha256(raw).hexdigest()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(gzip.compress(raw, compresslevel=9, mtime=0))
    return {"path": str(out_path), "plumes": len(items), "sha256": payload_digest}


class SnapshotAdapter:
    """Reads a snapshot file and normalizes it with the originating provider's normalizer."""

    name = "snapshot"

    def __init__(self, path: Path) -> None:
        self.path = path
        with gzip.open(path, "rb") as fh:
            self.payload: dict[str, Any] = json.loads(fh.read())
        if self.payload.get("schema") != SNAPSHOT_SCHEMA:
            raise ValueError(f"Unsupported snapshot schema in {path}")

    @property
    def provider(self) -> str:
        return str(self.payload["provider"])

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.path.read_bytes()).hexdigest()

    def fetch_observations(self, **_: Any) -> list[dict[str, Any]]:
        return list(self.payload["plumes"])

    def sources(self) -> dict[str, Any]:
        return dict(self.payload.get("sources") or {})

    def normalize(self, raw: dict[str, Any]) -> NormalizedObservation | None:
        if self.provider == "carbonmapper":
            return normalize_carbonmapper(raw)
        raise ValueError(f"No normalizer for provider {self.provider}")
