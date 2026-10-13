# PLUME demo script (≈ 4.5 minutes)

**Arc:** Detection → Investigation → Funding → Repair → Verification → Proof

**Before recording:**
- Run `make demo-reset`, then restart `make api`.
- Open http://localhost:3000 at 1512 × 900 or wider and sign out (guest view).
- Keep a second tab on http://localhost:8000/docs in case a judge asks about the API.

**Legend:**
- **[REAL]** executes real code on real historical data.
- **[CHAIN]** sends a real transaction to the local Anvil chain.
- **[SIM]** uses simulated repair inputs.

---

### 0:00 – 0:25 · The problem
**Screen:** Mission Control, intro card over the Permian Basin map.

**Say:** "Every dot here is a real methane plume, more than ten thousand of them, detected over the Permian Basin by aircraft and satellites and published by Carbon Mapper. Detecting leaks isn't the hard part anymore. The hard part is the next question: who fixes this, who pays, and how does anyone know it was fixed? PLUME is the workflow that comes after detection."

**Point at:** the top-bar mode pills — *Data: Historical*, *Repair: Simulated*, *Chain: Anvil*. "We label what's real and what's simulated everywhere."

### 0:25 – 0:55 · Detection [REAL]
**Click:** **Show the demo incident**. The map flies to INC‑32893D.

**Say:** "This is a single candidate source: 51 detections on 28 different days by five independent instruments. That's Carbon Mapper's own plume image, drawn where they put it. The drawer separates what we *know*, a plume detected at this point at this rate, from what we *infer*, that these detections share a source, and from what nobody knows from space: the operator or the faulty component."

**Point at:** the provider link ("every record links back to its source"), and the priority bars ("why it scores 81 out of 100, the third-highest of 3,907 candidate sources").

### 0:55 – 1:35 · Investigation [REAL]
**Click:** top right **Acting as → Sponsor**. Then **Investigate incident → Run investigation**.

**Say:** "The investigation is mostly computation, not a chatbot. It validates the records, groups them with DBSCAN (our grouping matches Carbon Mapper's own at an adjusted Rand index of 0.97), scores priority with factors you can see, and retrieves remediation guidance from EPA, IEA and UNEP sources."

**Point at:**
- *Confirmed observations* vs *Possible explanations*, each citing evidence ids.
- The confidence badges.
- *Grounding check passed*.

"If an LLM is configured, it only writes the narrative, and we reject it if it invents a number, an evidence id or a company. Today it's the deterministic template, and the report says so."

### 1:35 – 2:10 · Funding [SIM + CHAIN]
**Click:** **Create repair project** → (form is prefilled) **Review terms** → **Create draft project** → **Publish & fund escrow**.

**Say:** "A sponsor — think of a municipal climate fund or an operator's own budget — defines authorised scope, milestones, the evidence the verifier will require, an approved repair provider and an independent verifier. The terms are hashed, and the hash and the funds go into an escrow contract. The contract itself refuses unapproved providers and any verifier who's also a party."

**Point at:** the escrow panel — on-chain state FUNDED, terms-hash check mark, two transaction hashes in the audit trail.

### 2:10 – 2:45 · Repair [SIM + CHAIN]
**Click:** **Act as provider → Accept assignment**. Then **Fast-forward 30 days** (the 28-day monitoring window needs elapsed chain time) → **Submit evidence on-chain**.

**Say:** "The provider accepts on-chain and submits evidence. Here it's a clearly labelled synthetic package: work order, surveys, and pre- and post-repair site measurements. Every file is hashed, and the hash of the whole manifest is committed on-chain. Swap a single byte afterwards and verification fails."

### 2:45 – 3:35 · Verification [SIM + CHAIN]
**Click:** **Act as verifier → Open verification workbench**.

**Say:** "The independent verifier sees everything: the original satellite record, the repair record, every document and the measurements. Server-side policy checks confirm the documentation is complete, the provider is authorised, the parties are independent, the timestamps are consistent, the stored files match the on-chain hash, and the reduction exceeds measurement uncertainty."

**Point at:** the impact formula. "Reduction times the *documented* monitoring hours only, times the IPCC AR6 GWP. It's computed from synthetic measurements, and it's labelled that way."

**Point at:** the satellite note. "And one thing we never accept as proof: a later satellite pass that doesn't see a plume."

**Click:** **Verified** → type a note → **Sign & record decision**.

**Say:** "The verifier signs an EIP‑712 message bound to this project, this evidence hash and this review round. A rejected or inconclusive decision can never pay out, and an old signature can't be replayed."

*(Optional, 15 s — emphasise for judges: in a second project, untick "Post-repair survey" before submitting. Verified becomes disabled and a Rejected decision is recorded on-chain.)*

### 3:35 – 4:10 · Settlement and proof [CHAIN]
**Click:** **Continue to project → Release escrow to provider → View proof**.

**Say:** "Only now does the contract release the funds, exactly once, and only to the named provider. And anyone can inspect exactly how that decision was made."

**Point at:**
- The *Independent chain check*: five green checks read straight from the chain by your browser, not by our server.
- Then expand the View Proof timeline: original observation → source → investigation → repair → evidence commitment → signed decision → contract state → payment → methodology.

### 4:10 – 4:30 · Close
**Click:** **Impact Ledger** in the left rail.

**Say:** "Real observations, simulated workflow activity and modelled reductions are kept in separate columns. Real-world verified reductions: none. We haven't fixed a real leak yet, and we won't pretend otherwise. What we've built is the missing coordination layer: detection, investigation, funding, repair, verification and proof, all inspectable."

**Final line:** **"We don't just track emissions. We help turn evidence into action."**

---

**What executes real code:** everything except the repair itself. Data ingestion, grouping, scoring, report generation, policy checks, hashing, EIP‑712 signing, every contract call, the receipt, and the browser-side chain check are all live.

**What is simulated:** the organisations, the repair work, the evidence documents, the site measurements, the funds (local test ETH) and the elapsed time (Anvil clock).
