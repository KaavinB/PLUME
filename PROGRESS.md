# Progress log

**2026-10-12**
- Repo reconnaissance: empty directory; Docker, uv, Node 26, Python 3.12 available; Foundry installed; no LLM key or cloud credentials.
- Verified the Carbon Mapper OpenAPI spec. Built the adapter and pulled a real snapshot: 10,098 CH₄ plumes and 3,827 provider sources (Permian Basin).
- PostGIS schema with Alembic. Ingestion: normalise/validate/dedupe → DBSCAN incidents (ARI 0.974 vs provider) → explainable priority.
- Investigation engine with curated source-linked KB, Pydantic report, grounding checks, Claude adapter and labelled template fallback.
- RepairEscrow.sol with 39 unit/fuzz tests and 2 invariants; deploy script; web3.py chain client with an EIP‑712 cross-check.
- Repair workflow service, verification policy, impact calculator, receipts, reconciliation. API e2e journey passes 41/41.
- Next.js frontend: all nine screens; full journey verified manually in Chrome.
- Fixed a hydration mismatch (client gate) and a map sizing issue (maplibre CSS vs Tailwind layers).
- Tests: backend 83 passed (86% coverage); Playwright 2/2; ruff, mypy, ESLint and tsc clean; `next build` OK.
- Docs written from measured results (docs/eval/results.json).

**Done since:** narrated demo video (`demo-video/`), read-only static snapshot on GitHub Pages.

**Open:** Base Sepolia deployment (needs a funded key) · live LLM run (needs a key) · cloud hosting of the live stack.
