# PLUME

**The planet has bugs. Let's fix them.**

*Detection → Investigation → Funding → Repair → Verification → Proof: an open, programmable repair-funding and verification layer for methane leaks.*

## Inspiration

Software engineers have a habit we take for granted: when something breaks, there's an issue, someone owns it, there's a fix, a review, and a record that it was fixed. Methane leaks have the first part and not much of the rest. Aircraft and satellites now publish thousands of large methane plumes, and UNEP's MARS notifies governments and operators. But from the outside you usually can't tell who was supposed to fix a given leak, who paid, whether it was fixed, or what evidence anyone relied on. We wanted to build the issue tracker, bug bounty and code review for the planet's leaks.

## The climate problem

The IEA estimates that methane is responsible for around 30% of the rise in global temperatures since the Industrial Revolution. Airborne survey studies consistently find that a small fraction of sources contribute a disproportionate share of observed oil-and-gas methane emissions, and many of those sources are fixable. Detection has scaled faster than the coordination and funding of repairs. The gap we target is concrete: an observation exists, but there's no shared, accountable path from that observation to an authorised, funded, independently verified repair.

## What PLUME does

1. **Mission Control** shows 10,098 real Carbon Mapper CH₄ plume detections over the Permian Basin (2019–2026). It offers clustering, filters by date, rate, instrument and sector, geographic search, and the provider's own plume raster for the selected detection, with provenance and uncertainty everywhere.
2. **Investigation** turns an incident into a structured, evidence-cited report: confirmed facts separated from inferences, an explainable priority score, source-linked remediation guidance, limitations and unresolved questions.
3. **Repair bounties:** a sponsor escrows funds against hashed terms. Those terms name an approved provider, an independent verifier, milestones and the evidence policy.
4. **Verification:** the verifier reviews evidence against server-side policy checks and signs an EIP‑712 decision (VERIFIED, REJECTED, INCONCLUSIVE or ADDITIONAL_EVIDENCE_REQUIRED).
5. **Proof:** the contract releases payment only on VERIFIED. An **Impact Receipt** links satellite detection to settlement transaction, and the browser independently re-checks the contract state.

## How it works

- **Data.** We verified the Carbon Mapper OpenAPI spec and used `plumes/annotated` (paginated, with retries and caching) and `sources.geojson`. The data ships as a SHA‑256-tracked snapshot so the demo runs offline. Each record keeps its id, timestamp, units, uncertainty, geometry and raw payload.
- **Backend.** FastAPI, PostGIS, SQLAlchemy and Alembic in a modular monolith. Lifecycle state is protected by row locks, a 14-state machine, role checks and an audit log. A reconciliation endpoint restores database state from the chain, which is authoritative for money.
- **Contract.** `RepairEscrow.sol` (Solidity 0.8.26, OpenZeppelin): EIP‑712 decisions bound to chain, contract, project, round and evidence hash; replay protection; disputes; expiry refunds; a pull-payment fallback; and no admin path to funds.
- **Frontend.** Next.js 16, MapLibre, TanStack Query and viem. A guided demo checklist and one-click persona switching make the multi-party workflow easy to follow.

## AI implementation

We deliberately did not make the investigation a prompt.
- **Deterministic analysis:** data validation; DBSCAN (haversine, ε = 200 m, per sector), which agrees with Carbon Mapper's own grouping at an **adjusted Rand index of 0.974** across all 10,098 detections; a 7-factor explainable priority score; and TF‑IDF retrieval over a curated, source-linked knowledge base (EPA, IEA, UNEP/OGMP, eCFR).
- **Structured output:** a validated Pydantic report.
- **Optional narrative:** Claude, through the Anthropic SDK with structured output, may write only the narrative fields. A grounding checker then rejects any narrative that cites unknown evidence, introduces numbers not in the evidence pack, or names companies, and falls back to a labelled deterministic template.
- **Honesty about the demo:** we had no API key during the build, so every report shown is template-generated and says so.

## Blockchain implementation

- **Why a chain:** sponsors, contractors and verifiers need a commitment none of them can quietly rewrite.
- **What the contract enforces:**
  - only the named verifier's signature over the *current* evidence hash and round can unlock payment;
  - rejected or inconclusive outcomes can't pay;
  - settlement happens once;
  - the admin can't touch escrow.
- **Testing:** 39 Foundry unit and fuzz tests plus invariant tests over 8,192 randomised calls. The happy path costs about 391k gas.
- **What it can't do:** the chain can't observe methane, and we say so on screen. It makes the verifier's judgement attributable, tamper-evident and binding on the money.

## Climate impact

PLUME targets the step after detection: getting authorised repairs funded and proven. Its impact accounting is deliberately conservative:
- reduction = (pre − post measured rate) × *documented* monitoring hours × IPCC AR6 GWP‑100;
- it refuses to quantify a reduction when measurements aren't comparable or don't exceed uncertainty;
- it never extrapolates;
- it never treats a missed satellite detection as proof of repair.

Our demo computes a reduction from **synthetic** measurements and labels it as such. Our ledger reports real-world verified reductions as **none**, because that's true.

## Innovation

The novelty isn't detection. It's the **programmable accountability layer** on top of existing observation systems:
- explainable incident prioritisation;
- escrowed repair bounties tied to hashed terms;
- evidence commitments;
- independent EIP‑712 verification;
- auditable, exactly-once payment release;
- public Impact Receipts that anyone can re-verify against the chain from their browser.

## Practical adoption

A credible first customer is a **municipal landfill operator or regional methane fund** coordinating authorised gas-collection repairs:
- the operator (or fund) sponsors;
- its existing contractor is the provider;
- an accredited inspection firm verifies.

The data model is sector-agnostic. Oil & gas LDAR, landfills, wastewater and livestock all use the same workflow, with the same knowledge base and verification methodologies. PLUME requires site authorisation and approved providers; it coordinates authorised work, never vigilante repair.

## Challenges

- **Being scientifically honest under demo pressure.** Instantaneous rates aren't annual emissions. Proximity isn't identity. Non-detection isn't repair. We encoded each of these as a rule, a refusal or a label, not just a footnote.
- **Time.** A meaningful reduction needs weeks of post-repair monitoring, but a demo has minutes. We advance the *local chain's* clock, so contract expiry, funding time and evidence timestamps all stay consistent instead of faking dates.
- **Keeping backend and chain consistent.** We solved it with row locks, idempotent event indexing and chain-authoritative reconciliation (tested by simulating a crash).
- **API drift.** We built against the live Carbon Mapper OpenAPI spec and found that `source_name` echoes the request's query string, so we normalise it.

## What we actually accomplished

- A working, locally runnable product. One command bootstraps PostGIS, Anvil, the real data snapshot, the contract and the demo personas.
- **83 backend tests (86% coverage)**, including a full on-chain workflow against a throwaway Anvil.
- **39 Foundry tests plus invariants.**
- **2 Playwright journeys** through the real UI.
- A **41-check API journey**.
- ruff, mypy, ESLint and tsc clean, with CI.
- Measured performance: investigation API p50 6 ms; 10k-point clustering in 45 ms.

**Try it:** [read-only snapshot of the app](https://kaavinb.github.io/PLUME/) (GitHub Pages; exported from a local run; actions disabled) · [demo video](https://kaavinb.github.io/PLUME/demo/plume-demo-final.mp4) · run it live locally with `make bootstrap && make dev`.

**Not done:**
- no public testnet or cloud deployment of the API, database or chain (no funded key or credentials in our environment; exact commands are documented). The hosted site is a static snapshot, not the live system;
- the LLM path hasn't been run against a live model;
- single-verifier disputes only.

## What's next

Participant wallets and wallet login · Base Sepolia deployment · multi-verifier arbitration · direct NASA EMIT and IMEO adapters · OGI-survey and continuous-monitor evidence formats · a landfill-operator pilot with real, authorised repairs.

> **We don't just track emissions. We help turn evidence into action.**

*Data: Carbon Mapper (carbonmapper.org). Simulated repair projects use test-network funds only.*
