# Evaluation

Every number below was measured on 2026‑10‑12 on the build machine (macOS, Apple silicon, Python 3.12, Node 26). PostGIS ran in Docker as a `linux/amd64` image under emulation, which inflates database write times. The API was a single uvicorn process and Anvil ran in automine mode.

Reproduce:
- `make eval`: writes `docs/eval/results.json` with ingestion, grouping and API latency figures and the e2e journey.
- `make gas`: contract gas report.
- `make test`: test counts and coverage.

Items marked **not evaluated** were not measured.

## Data ingestion

| Metric | Value |
|---|---|
| Records retrieved (Carbon Mapper, Permian bbox, CH₄) | **10,098** |
| Normalised / rejected | 10,098 / 0 |
| Duplicates removed (same provider id / re-issued detection) | 0 / 0 |
| Validation flags | 693 rate withheld by provider · 12 uncertainty > estimate · 1 estimate unavailable · 10,098 quality not assessed by provider |
| Detections with a usable rate | 9,404 |
| Normalisation throughput | ~21,700 records/s (0.47 s) |
| End-to-end ingestion (normalise + PostGIS insert + group + score) | 36.4 s → ~277 records/s; the insert (19.6 s) is dominated by the emulated DB |
| Re-ingesting the same snapshot | 0 inserted, 10,098 already present (idempotent; tested) |

## Geospatial grouping

| ε (m) | PLUME groups | ARI vs Carbon Mapper (3,827 sources) | Identical groups |
|---|---|---|---|
| 100 | 4,277 | 0.885 | 3,470 |
| **200 (chosen)** | **3,907** | **0.974** | **3,752** |
| 500 | 3,300 | 0.833 | 2,915 |
| 1000 | 2,460 | 0.572 | 1,807 |

DBSCAN over all 10,098 points: **45 ms**. 820 incidents have detections on ≥ 3 distinct dates.

**What ARI measures:** agreement with Carbon Mapper's own grouping, not with ground truth. No facility-level ground truth was available, so source-identification accuracy is **not evaluated**.

## Investigation engine

| Metric | Value |
|---|---|
| `POST /incidents/{code}/investigate`, 51-detection incident | p50 **6.2 ms**, p95 9.9 ms (n = 20) |
| Engine-internal latency, all stored investigations | p50 1 ms, p95 11 ms (n = 21) |
| Structured-schema validation | 100% (Pydantic; any report that fails validation cannot be stored) |
| Grounding check pass rate (template narratives) | 100% (21/21) |
| Evidence-reference integrity | every cited id exists in `evidence_references` (asserted in `test_api_incident_and_investigation`) |
| Grounding-check detection on adversarial narratives | the unit test catches an invented organisation, an unsupported number and an unknown evidence id |
| LLM narrative quality and latency | **not evaluated** (no API key in the build environment) |
| Prioritisation accuracy | **not evaluated** (no labelled benchmark of real-world outcomes) |

## API latency (local, n = 40 unless noted)

| Endpoint | p50 | p95 |
|---|---|---|
| `GET /health` | 2.5 ms | 4.6 ms |
| `GET /observations` (10,098-feature GeoJSON, 2.4 MB, gzip) | 135 ms (n = 10) | 178 ms |
| `GET /incidents?limit=50` | 4.8 ms | 6.7 ms |
| `GET /incidents/{code}` (51 observations) | 3.3 ms | 4.1 ms |

Availability under load was **not evaluated**; no load test was run.

## Smart contract

| Metric | Value |
|---|---|
| Foundry tests | **39 unit + fuzz tests (512 runs each), 2 invariants (128 runs × 64 calls, 8,192 calls); all pass** |
| Line / statement / branch / function coverage (`RepairEscrow.sol`) | 93.9% / 91.5% / 83.0% / 94.4% |
| Deployment gas | 2,308,225 |
| Lifecycle gas (real receipts, local chain) | `createProject` 133,127 · `fund` 33,255 · `acceptAssignment` 33,012 · `submitEvidence` 57,283 (first) / 40,247 (resubmission) · `recordDecision` 89,641 (first) / 72,539 · `releasePayment` 45,016 |
| Full happy path (create → paid) | ≈ 391k gas over 6 transactions |
| Bytecode size | 11,297 bytes |

## Backend tests

**83 passed** (`pytest`, 10–12 s). They cover:
- normalisation, rejection reasons and de-duplication;
- clustering, scoring, the knowledge base, grounding, impact maths, the state machine and policy checks;
- evidence tamper detection and provider HTTP behaviour (pagination, 429 retry, timeouts, caching);
- snapshot round-trip and LLM fallback;
- PostGIS ingestion idempotency;
- API authentication and authorisation;
- the full on-chain workflow on a throwaway Anvil (rejected round → resubmission → VERIFIED → paid → duplicate settlement blocked);
- DB/chain drift repair.

Statement coverage: **86%** (`app/`). Static checks: ruff clean; mypy clean (36 files).

## End-to-end

| Journey | Result |
|---|---|
| `scripts/e2e_api.py`: 41 checks, including negative authorisation and invalid-state checks | **PASS**, 1.9 s. Per-step timings: publish 149 ms, fund 134 ms, accept 143 ms, submit evidence 151 ms, verify 166 ms, release 176 ms |
| Playwright `journey.spec.ts`: full UI journey from Mission Control → investigation → project → fund → provider evidence → verifier decision → settlement → receipt (5/5 independent chain checks pass in the browser) | **PASS** (10.7 s) |
| Playwright: missing post-repair survey → VERIFIED disabled in UI → REJECTED recorded | **PASS** (2.9 s) |
| Frontend `next build`, `tsc --noEmit`, ESLint | pass |

## Not evaluated

- Real-world repair outcomes (none exist).
- Accuracy of sector attribution or facility matching.
- LLM narrative quality.
- Public-testnet performance.
- Load or availability.
- Mobile layout (the product is desktop-first; pages reflow but were not tested on phones).
- Accessibility audit with assistive technology (semantic roles and labels were added; no audit was run).
