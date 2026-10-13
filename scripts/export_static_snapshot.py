"""Export a read-only static snapshot of a running local PLUME stack for the GitHub Pages build.

Every file is a verbatim response of the real API (GET only) at export time, plus:
  * chain-proof/<receipt>.json — the same contract reads the receipt page performs in the browser
    (RepairEscrow.getProject + settlement receipt), done here with web3 against the local Anvil node,
    because a static site cannot reach that chain. The page labels these as recorded, not live.
  * files/... — plume rasters cached locally and the stored (synthetic) evidence files.
  * index.json — ids the static build pre-renders, and when/what was exported.

Usage (local stack running):  cd backend && uv run python ../scripts/export_static_snapshot.py [out_dir]
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from web3 import Web3

ROOT = Path(__file__).resolve().parents[1]
API = "http://localhost:8000/api/v1"
RPC = "http://127.0.0.1:8545"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "frontend" / "snapshot"

GET_PROJECT_ABI = json.loads((ROOT / "contracts" / "deployments" / "RepairEscrow.abi.json").read_text())
CHAIN_STATES = [
    "None",
    "Open",
    "Funded",
    "Assigned",
    "Submitted",
    "Verified",
    "Rejected",
    "Inconclusive",
    "EvidenceRequested",
    "Disputed",
    "Paid",
    "Cancelled",
    "Refunded",
]


def key(path: str) -> str:
    """Must match snapshotKey() in frontend/src/lib/snapshot.ts."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", path.lstrip("/")) or "_root"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "api").mkdir(parents=True)
    c = httpx.Client(base_url=API, timeout=60)
    written = 0

    def get(path: str) -> Any:
        nonlocal written
        r = c.get(path)
        r.raise_for_status()
        data = r.json()
        (OUT / "api" / f"{key(path)}.json").write_text(json.dumps(data, separators=(",", ":")))
        written += 1
        return data

    def get_file(path: str) -> bool:
        r = c.get(path)
        if r.status_code != 200:
            return False
        dest = OUT / "files" / path.lstrip("/")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(r.content)
        return True

    meta = get("/meta")
    get("/observations")
    get("/impact")
    get("/methodologies")
    for role in ("provider", "verifier"):
        get(f"/participants?role={role}")

    # Every incident (the map links to all of them) + the full summary list the list page filters in-browser.
    summaries: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = c.get("/incidents", params={"sort": "priority", "limit": 500, "offset": offset}).json()
        summaries += page["items"]
        offset += 500
        if offset >= page["total"]:
            break
    (OUT / "api" / "incidents_all.json").write_text(json.dumps(summaries, separators=(",", ":")))
    incident_codes = [s["code"] for s in summaries]
    for code in incident_codes:
        get(f"/incidents/{code}")
    print(f"incidents: {len(incident_codes)}")

    invs = get("/investigations")["items"]
    for inv in invs:
        get(f"/investigations/{inv['id']}")

    projects = get("/repair-projects")["items"]
    for code in sorted(
        {p["incident_code"] for p in projects} | {f["code"] for f in meta["featured_incidents"]}
    ):
        get(f"/repair-projects?incident={code}")
    receipts: list[str] = []
    for p in projects:
        code = p["code"]
        proj = get(f"/repair-projects/{code}")
        get(f"/repair-projects/{code}/history")
        if proj["evidence"]:
            get(f"/repair-projects/{code}/verification-context")
            for ev in proj["evidence"]:
                for f in ev["manifest"]["files"]:
                    get_file(f"/repair-projects/{code}/evidence/{ev['round']}/files/{f['name']}")
        if proj.get("receipt_id"):
            receipts.append(proj["receipt_id"])

    # Recorded chain reads for each receipt (what the receipt page would read live from the browser).
    w3 = Web3(Web3.HTTPProvider(RPC))
    (OUT / "api" / "chain-proof").mkdir()
    for rid in receipts:
        rc = get(f"/receipts/{rid}")
        ch = rc["payload"]["chain"]
        contract = w3.eth.contract(address=Web3.to_checksum_address(ch["contract"]), abi=GET_PROJECT_ABI)
        p = contract.functions.getProject(int(ch["onchain_project_id"])).call()
        (sponsor, amount, provider, _exp, rnd, state, verifier, _vat, _dw, terms, evidence, digest) = p
        tx = w3.eth.get_transaction_receipt(ch["settlement_tx"])
        proof = {
            "recorded_at": datetime.now(UTC).isoformat(),
            "rpc": f"{RPC} (local Anvil, chain id {w3.eth.chain_id})",
            "block_number_at_read": w3.eth.block_number,
            "state": CHAIN_STATES[state],
            "round": rnd,
            "amount": str(amount),
            "evidenceHash": "0x" + bytes(evidence).hex(),
            "termsHash": "0x" + bytes(terms).hex(),
            "lastDecisionDigest": "0x" + bytes(digest).hex(),
            "provider": provider,
            "verifier": verifier,
            "sponsor": sponsor,
            "settlement": {
                "status": "success" if tx["status"] == 1 else "reverted",
                "blockNumber": str(tx["blockNumber"]),
                "from": tx["from"],
                "to": tx["to"],
                "gasUsed": str(tx["gasUsed"]),
            },
        }
        (OUT / "api" / "chain-proof" / f"{rid}.json").write_text(json.dumps(proof, indent=1))

    # Plume rasters available locally (the live API would fetch others from Carbon Mapper on demand).
    images = 0
    for d in (ROOT / "data" / "snapshots" / "plume-images", ROOT / "data" / "cache" / "plume-images"):
        for png in d.glob("*.png") if d.exists() else []:
            dest = OUT / "files" / "observations" / png.stem / "plume.png"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(png, dest)
            images += 1

    index = {
        "exported_at": datetime.now(UTC).isoformat(),
        "source": "verbatim GET responses of a local PLUME stack (FastAPI + PostGIS + Anvil)",
        "data": meta["data"],
        "chain": meta["chain"],
        "incidents": incident_codes,
        "investigations": [i["id"] for i in invs],
        "projects": [p["code"] for p in projects],
        "receipts": receipts,
        "plume_images": images,
        "api_files": written,
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    print(f"wrote {written} API responses, {images} plume images, {len(receipts)} receipt proof(s) → {OUT}")


if __name__ == "__main__":
    main()
