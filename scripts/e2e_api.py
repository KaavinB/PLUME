"""End-to-end API journey against a running stack (API + Postgres + Anvil).

Exercises: incident → investigation → project → publish → fund → accept → (simulated time) →
evidence → verifier review → policy-gated decision → settlement → receipt, plus negative checks:
unauthorized actions, blocked payout after rejection, duplicate settlement, replay-safe resubmission.

Usage: uv run --project backend python scripts/e2e_api.py [--base http://localhost:8000] [--incident INC-32893D]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

import httpx

FAILURES: list[str] = []
TIMINGS: dict[str, float] = {}


def check(cond: bool, msg: str) -> None:
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        FAILURES.append(msg)


class Api:
    def __init__(self, base: str) -> None:
        self.c = httpx.Client(base_url=base + "/api/v1", timeout=120)
        self.tokens: dict[str, str] = {}

    def login(self, persona: str) -> None:
        r = self.c.post("/auth/demo-login", json={"persona": persona})
        r.raise_for_status()
        self.tokens[persona] = r.json()["token"]

    def req(self, method: str, path: str, as_: str | None = None, label: str | None = None, **kw: Any) -> httpx.Response:
        h = {"Authorization": f"Bearer {self.tokens[as_]}"} if as_ else {}
        t0 = time.perf_counter()
        r = self.c.request(method, path, headers=h, **kw)
        if label:
            TIMINGS[label] = round((time.perf_counter() - t0) * 1000, 1)
        return r


def run_project(api: Api, incident: str, methodology: str, reject_first: bool) -> str:
    print(f"\n== Project on {incident} ({methodology}, reject_first={reject_first})")
    r = api.req("POST", "/repair-projects", as_="sponsor", json={
        "incident_id": incident, "title": "Simulated LDAR repair", "repair_scope": "Locate and repair emitting components at the plume origin; re-survey.",
        "site_authorization": "Operator written authorization on file (simulated).",
        "milestones": [{"name": "Repair"}, {"name": "Verification"}], "methodology": methodology,
        "min_monitoring_days": 21, "funding_amount_eth": "1.5", "provider_id": "provider", "verifier_id": "verifier",
    })
    check(r.status_code == 409, f"cannot create project before investigation → {r.status_code}")
    r = api.req("POST", f"/incidents/{incident}/investigate", as_="sponsor", label="investigate")
    check(r.status_code == 201, f"investigation generated → {r.status_code}")
    rep = r.json()["report"]
    check(rep["grounding"]["passed"], "report grounding check passed")
    check(len(rep["confirmed_observations"]) > 0 and len(rep["possible_explanations"]) > 0, "report separates facts and inferences")

    body = {
        "incident_id": incident, "title": "Simulated LDAR repair", "repair_scope": "Locate and repair emitting components at the plume origin; re-survey.",
        "site_authorization": "Operator written authorization on file (simulated).",
        "milestones": [{"name": "Repair"}, {"name": "Verification"}], "methodology": methodology,
        "min_monitoring_days": 21, "funding_amount_eth": "1.5", "provider_id": "provider", "verifier_id": "verifier",
    }
    r = api.req("POST", "/repair-projects", as_="provider", json=body)
    check(r.status_code == 403, f"provider cannot create projects → {r.status_code}")
    r = api.req("POST", "/repair-projects", as_="sponsor", json={**body, "provider_id": "contractor-unapproved"})
    created_unapproved = r.json()
    check(r.status_code == 201, "draft with unapproved contractor can be drafted")
    r = api.req("POST", f"/repair-projects/{created_unapproved['id']}/publish", as_="sponsor")
    check(r.status_code == 409 and "ParticipantNotApproved" in r.text, f"contract rejects unapproved provider → {r.status_code} {r.text[:80]}")

    r = api.req("POST", "/repair-projects", as_="sponsor", json=body, label="create_draft")
    check(r.status_code == 201, f"project drafted → {r.status_code}")
    pid = r.json()["id"]
    check(api.req("POST", f"/repair-projects/{pid}/fund", as_="sponsor").status_code == 409, "cannot fund a DRAFT")
    r = api.req("POST", f"/repair-projects/{pid}/publish", as_="sponsor", label="publish_tx")
    check(r.status_code == 200 and r.json()["status"] == "OPEN_FOR_FUNDING", "published on-chain")
    check(api.req("POST", f"/repair-projects/{pid}/fund", as_="provider").status_code == 403, "provider cannot fund")
    r = api.req("POST", f"/repair-projects/{pid}/fund", as_="sponsor", label="fund_tx")
    check(r.status_code == 200 and r.json()["onchain"]["state"] == "FUNDED", "escrow funded (chain state FUNDED)")
    check(api.req("POST", f"/repair-projects/{pid}/fund", as_="sponsor").status_code == 409, "double funding rejected")
    check(api.req("POST", f"/repair-projects/{pid}/accept", as_="contractor-unapproved").status_code == 403, "other provider cannot accept")
    r = api.req("POST", f"/repair-projects/{pid}/accept", as_="provider", label="accept_tx")
    check(r.status_code == 200 and r.json()["status"] == "ASSIGNED", "provider accepted")

    tpl = api.req("GET", f"/repair-projects/{pid}/simulated-evidence", as_="provider").json()
    if not tpl["ready"]:
        r = api.req("POST", "/demo/advance-time", as_="provider", json={"days": tpl["days_to_advance"]})
        check(r.status_code == 200, f"advanced simulated chain clock {tpl['days_to_advance']} days")
        tpl = api.req("GET", f"/repair-projects/{pid}/simulated-evidence", as_="provider").json()
    check(tpl["ready"], "simulated evidence timeline is in the past on chain time")

    def submit(payload: dict[str, Any], label: str | None = None) -> httpx.Response:
        files = [("files", (f["name"], f["content"].encode(), f["media_type"])) for f in tpl["files"]]
        return api.req("POST", f"/repair-projects/{pid}/submit-evidence", as_="provider", label=label,
                       data={"payload": json.dumps(payload)}, files=files)

    check(api.req("POST", f"/repair-projects/{pid}/submit-evidence", as_="sponsor",
                  data={"payload": json.dumps(tpl["payload"])}).status_code == 403, "sponsor cannot submit evidence")
    bad = {**tpl["payload"], "is_simulated": False}
    check(submit(bad).status_code == 422, "unlabelled evidence rejected for a simulated project")

    payload = tpl["payload"]
    if reject_first:
        weak = {**payload, "documents": [d for d in payload["documents"] if d["doc_type"] != "post_repair_survey"]}
        r = submit(weak)
        check(r.status_code == 200, "incomplete evidence submitted (round 1)")
        api.req("POST", f"/repair-projects/{pid}/start-review", as_="verifier")
        ctx = api.req("GET", f"/repair-projects/{pid}/verification-context", as_="verifier").json()
        check("documentation_complete" in ctx["blocking"], "policy flags missing post-repair survey")
        r = api.req("POST", f"/repair-projects/{pid}/verify", as_="verifier", json={"outcome": "VERIFIED"})
        check(r.status_code == 409, "VERIFIED blocked while required checks fail")
        r = api.req("POST", f"/repair-projects/{pid}/verify", as_="verifier", json={"outcome": "REJECTED", "notes": "post-repair survey missing"})
        check(r.status_code == 200 and r.json()["project"]["onchain"]["state"] == "REJECTED", "rejection recorded on-chain")
        r = api.req("POST", f"/repair-projects/{pid}/release", as_="provider")
        check(r.status_code == 409, "rejected project cannot be paid")

    r = submit(payload, label="submit_evidence_tx")
    check(r.status_code == 200, f"complete evidence submitted → {r.status_code} {r.text[:120] if r.status_code != 200 else ''}")
    r = api.req("POST", f"/repair-projects/{pid}/verify", as_="sponsor", json={"outcome": "VERIFIED"})
    check(r.status_code == 403, "sponsor cannot verify")
    r = api.req("POST", f"/repair-projects/{pid}/verify", as_="provider", json={"outcome": "VERIFIED"})
    check(r.status_code == 403, "provider cannot verify own work")
    api.req("POST", f"/repair-projects/{pid}/start-review", as_="verifier")
    ctx = api.req("GET", f"/repair-projects/{pid}/verification-context", as_="verifier", label="verification_context").json()
    check(ctx["blocking"] == [], f"all required policy checks pass (blocking={ctx['blocking']})")
    r = api.req("POST", f"/repair-projects/{pid}/verify", as_="verifier", json={"outcome": "VERIFIED", "notes": "Documentation complete; reduction exceeds uncertainty."}, label="verify_tx")
    check(r.status_code == 200 and r.json()["project"]["onchain"]["state"] == "VERIFIED", "VERIFIED decision recorded on-chain (EIP-712)")
    r = api.req("POST", f"/repair-projects/{pid}/release", as_="provider", label="release_tx")
    check(r.status_code == 200 and r.json()["status"] == "PAID", "escrow released to provider")
    check(r.json()["onchain"]["state"] == "PAID", "chain state PAID")
    rid = r.json()["receipt_id"]
    check(bool(rid), f"impact receipt issued {rid}")
    r = api.req("POST", f"/repair-projects/{pid}/release", as_="provider")
    check(r.status_code == 409, "duplicate settlement rejected")
    r = api.req("POST", f"/repair-projects/{pid}/reconcile")
    check(r.status_code == 200 and r.json()["changed"] is False, "backend and chain states reconcile (no drift)")
    rc = api.req("GET", f"/receipts/{rid}", label="receipt").json()
    check(rc["payload"]["chain"]["settlement_tx"].startswith("0x"), "receipt links settlement transaction")
    check(len(rc["history"]["chain_events"]) >= 6, f"receipt exposes on-chain audit trail ({len(rc['history']['chain_events'])} events)")
    print("  receipt impact:", {k: rc["payload"]["impact"].get(k) for k in ("status", "reduction_rate_kg_h", "supported_duration_h", "ch4_avoided_kg", "co2e_avoided_kg")})
    return pid


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--incident", default="INC-32893D")
    args = ap.parse_args()
    api = Api(args.base)
    print("== Health / data")
    check(api.c.get("/health").json()["status"] == "ok", "health ok")
    fc = api.c.get("/observations").json()
    check(len(fc["features"]) > 1000, f"{len(fc['features'])} real observations served as GeoJSON")
    for p in ("sponsor", "provider", "verifier", "observer", "contractor-unapproved", "admin"):
        api.login(p)
    r = api.req("POST", "/demo/reset", as_="admin")
    check(r.status_code == 200, "demo state reset (local chain only)")
    check(api.req("POST", "/demo/reset", as_="sponsor").status_code == 403, "only admin may reset demo state")
    check(api.req("POST", f"/incidents/{args.incident}/investigate", as_="observer").status_code == 403, "observer is read-only")
    run_project(api, args.incident, "QUANTIFIED_REDUCTION", reject_first=True)
    print("\nTimings (ms):", json.dumps(TIMINGS))
    print(f"\n{'PASS' if not FAILURES else 'FAIL'}: {len(FAILURES)} failure(s)")
    for f in FAILURES:
        print("  -", f)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
