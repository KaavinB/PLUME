# Resume metrics (measured, reproducible)

Each bullet below is backed by a command in this repository. Sources: [EVALUATION.md](EVALUATION.md) and `docs/eval/results.json`.

- Built a geospatial ingestion pipeline (FastAPI, PostGIS, SQLAlchemy). It normalised **10,098 real Carbon Mapper methane plume records** with **0 normalisation failures**, recorded 4 categories of validation flags, and keeps idempotent re-ingestion (0 duplicates inserted on replay). *Command: `make ingest`; test: `test_ingestion_is_idempotent`.*
- Implemented sector-constrained DBSCAN (haversine) grouping into **3,907 candidate sources**. It matches the provider's independent grouping with an **adjusted Rand index of 0.974** and clusters all 10,098 points in **45 ms**. *Command: `make eval`.*
- Designed an explainable 7-factor investigation-priority score and an evidence-grounded report generator: validated Pydantic schema, TF‑IDF retrieval over source-linked guidance, and a grounding checker that rejects invented numbers, organisations and evidence ids. **Investigation API p50 6.2 ms / p95 9.9 ms.**
- Wrote and tested a Solidity escrow with **EIP‑712 verifier attestations**, replay protection, disputes, expiry and a pull-payment fallback. **39 Foundry unit/fuzz tests plus 2 invariants (8,192 randomised calls)**; 94% line coverage; full escrow lifecycle about **391k gas**.
- Integrated backend and chain with transactional state management: row locks, idempotent event indexing, and reconciliation that restores DB state from the chain after a simulated crash (tested).
- Delivered a full-stack app (Next.js 16, MapLibre, TanStack Query, viem) whose receipt page **independently re-verifies contract state from the browser**. End-to-end journey automated with **Playwright (2/2 passing)** and a 41-check API journey.
- Maintained engineering quality: **83 backend tests, 86% coverage**; ruff, mypy, ESLint and tsc clean; GitHub Actions CI for contracts, backend (with PostGIS service) and frontend.
