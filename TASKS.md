# PLUME — Tasks & acceptance criteria

Legend: [x] done & verified · [~] partial · [ ] not started

## P0 — must work
- [x] Real methane observations: 10,098 Carbon Mapper CH4 plumes (Permian), snapshot + live adapter — `make ingest`
- [x] Normalization / validation / dedupe with rejection reasons and flags — ingestion stats in `ingestion_runs`
- [x] Incident grouping (DBSCAN haversine, per sector) + comparison with Carbon Mapper grouping (ARI 0.974)
- [x] Explainable priority score (7 weighted factors, reproducible reference time)
- [x] Investigation engine: validation → evidence → KB retrieval (TF-IDF over curated, source-linked KB) → report; LLM adapter + grounding check; labelled template fallback
- [x] RepairEscrow contract (EIP-712 decisions, replay protection, disputes, expiry, pull-payment fallback) — 39 unit/fuzz tests + 2 invariants
- [x] Backend workflow: draft → publish → fund → accept → evidence → review → policy-gated decision → release → receipt; reconcile from chain
- [x] API e2e journey incl. negative authorization paths — `scripts/e2e_api.py` PASS
- [x] Frontend: Mission Control map, incident drawer, investigation workbench, project creation/detail, verification workbench, ledger, receipt + View Proof (verified in browser)
- [x] Backend pytest suite — 83 tests, 86% coverage, incl. on-chain workflow on throwaway Anvil
- [x] Playwright journey — 2/2 passing
- [x] Docs: README, ARCHITECTURE, SCIENTIFIC_METHODOLOGY, SECURITY, EVALUATION, DEVPOST_SUBMISSION, DEMO_SCRIPT, RESUME_METRICS

## P1
- [ ] Base Sepolia deployment (needs a funded testnet key — not available in this environment)
- [ ] LLM narrative with real provider (needs ANTHROPIC_API_KEY — adapter implemented, untested live)
- [x] CI workflow (.github/workflows/ci.yml) — written, not yet run on GitHub

## P2 (not started)
- [ ] Participant wallets (wagmi) instead of custodial demo signing
- [ ] Multi-verifier dispute arbitration
- [ ] Direct NASA EMIT L2B adapter (EMIT detections currently arrive via Carbon Mapper)
- [x] Read-only static snapshot on GitHub Pages (`scripts/build_pages.sh`), smoke-tested with `demo-video/scripts/check-pages.mjs`
- [ ] Cloud deployment of the live stack (Vercel + Cloud Run + managed PostGIS)
