"""Evidence bundles: schema, content-addressed storage and the keccak256 commitment sent on-chain."""

from __future__ import annotations

import hashlib
import json
import mimetypes
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from web3 import Web3

DocType = Literal[
    "work_order",
    "pre_repair_survey",
    "post_repair_survey",
    "measurement_report",
    "photo",
    "site_authorization",
    "other",
]
MAX_FILE_BYTES = 10 * 1024 * 1024
ALLOWED_MEDIA = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "text/csv",
    "text/plain",
    "application/json",
    "text/markdown",
}


class MeasurementIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rate_kg_h: float = Field(ge=0)
    uncertainty_kg_h: float = Field(ge=0)
    measured_at: datetime


class MeasurementsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    method: str = Field(min_length=3, max_length=200)
    pre_repair: MeasurementIn
    post_repair: list[MeasurementIn] = Field(min_length=1, max_length=50)


class RepairRecordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    work_summary: str = Field(min_length=10, max_length=4000)
    components_repaired: list[str] = Field(default_factory=list, max_length=50)
    started_at: datetime
    completed_at: datetime
    performed_by: str = Field(min_length=2, max_length=200)

    @field_validator("completed_at")
    @classmethod
    def _after_start(cls, v: datetime, info: Any) -> datetime:
        start = info.data.get("started_at")
        if start and v < start:
            raise ValueError("completed_at precedes started_at")
        return v


class DocumentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doc_type: DocType
    title: str = Field(min_length=2, max_length=200)
    description: str = Field(default="", max_length=4000)
    file_name: str | None = None


class EvidencePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_simulated: bool
    site_authorization_ref: str = Field(min_length=3, max_length=500)
    repair_record: RepairRecordIn
    documents: list[DocumentIn] = Field(min_length=1, max_length=50)
    measurements: MeasurementsIn | None = None
    notes: str = Field(default="", max_length=4000)


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str, ensure_ascii=False).encode()


def keccak_hex(data: bytes) -> str:
    return "0x" + Web3.keccak(data).hex().removeprefix("0x")


def store_bundle(
    root: Path,
    project_code: str,
    round_: int,
    header: dict[str, Any],
    payload: EvidencePayload,
    files: list[tuple[str, bytes, str | None]],
) -> tuple[str, dict[str, Any], str]:
    """Write files + manifest under root/project/round. Returns (keccak commitment, manifest, path)."""
    d = root / project_code / f"round-{round_}"
    d.mkdir(parents=True, exist_ok=True)
    file_entries: list[dict[str, Any]] = []
    for name, content, media in files:
        if len(content) > MAX_FILE_BYTES:
            raise ValueError(f"{name} exceeds {MAX_FILE_BYTES} bytes")
        media = media or mimetypes.guess_type(name)[0] or "application/octet-stream"
        if media not in ALLOWED_MEDIA:
            raise ValueError(f"{name}: media type {media} not accepted")
        safe = Path(name).name
        digest = hashlib.sha256(content).hexdigest()
        (d / f"{digest[:16]}-{safe}").write_bytes(content)
        file_entries.append(
            {
                "name": safe,
                "sha256": digest,
                "size": len(content),
                "media_type": media,
                "stored_as": f"{digest[:16]}-{safe}",
            }
        )
    manifest = {
        "schema": "plume.evidence.v1",
        **header,
        "round": round_,
        "payload": payload.model_dump(mode="json"),
        "files": sorted(file_entries, key=lambda f: f["sha256"]),
    }
    raw = canonical_json(manifest)
    (d / "manifest.json").write_bytes(raw)
    return keccak_hex(raw), manifest, str(d)


def verify_bundle(path: str, expected_commitment: str) -> tuple[bool, str]:
    """Recompute file digests and the manifest commitment from storage."""
    d = Path(path)
    mf = d / "manifest.json"
    if not mf.exists():
        return False, "manifest missing from evidence storage"
    raw = mf.read_bytes()
    manifest = json.loads(raw)
    for f in manifest.get("files", []):
        p = d / f["stored_as"]
        if not p.exists():
            return False, f"file {f['name']} missing"
        if hashlib.sha256(p.read_bytes()).hexdigest() != f["sha256"]:
            return False, f"file {f['name']} content changed after submission"
    if canonical_json(manifest) != raw:
        return False, "manifest is not canonical"
    actual = keccak_hex(raw)
    if actual.lower() != expected_commitment.lower():
        return (
            False,
            f"manifest commitment {actual[:12]}… does not match on-chain {expected_commitment[:12]}…",
        )
    return (
        True,
        f"{len(manifest.get('files', []))} file digest(s) and manifest commitment match the on-chain evidence hash",
    )
