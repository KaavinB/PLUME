# PLUME demo video — verification report

Generated 2026-10-13T01:17:07.789Z by `demo-video/scripts/assemble.mjs` from the run in `output/work/run-log.json`.

## Deliverables

| File | What it is |
|---|---|
| `plume-demo-final.mp4` | 1920×1080 H264 @ 30 fps, AAC 48000 Hz, **270.00 s**, 37.0 MB, 8 chapters, soft English subtitles (off by default) |
| `subtitles.srt` | 64 phrase-level cues timed from Whisper word timestamps of the actual Kokoro clips |
| `plume-demo-narration.wav` | The final mixed narration track (48 kHz PCM), sample-aligned with the MP4 |
| `playwright-automation/` | Copy of the Argo/Playwright scripts that drove the real UI (`demos/*.demo.ts`, `demos/lib/plume.ts`) and the pipeline scripts |

## How it was recorded

- **Stack** (`scripts/prepare-stack.sh`): fresh Anvil chain → `make demo-reset` (fresh RepairEscrow deployment, projects cleared, personas re-seeded) → API restarted → production build of the web app. Health: ✓ API ok (db + chain) · contract 0x5FbDB2315678afecb367f032d93F642f64180aa3 has code · demo incident clean · web 200
- **Preflight** (`scripts/preflight.mjs`): ✓ guest landing OK: intro card, "Acting as Guest (read-only)", mode bar [Data Historical · snapshot Repair Simulated Chain Anvil (local) · 2026-10-13 Reports template], 10,098 detections, map σ=17.7 with 1163 amber marker px · output/work/preflight-landing.png
- **Capture**: Argo 0.41.0, system Chrome (headless), 1600×900 CSS px at device scale 2 (3200×1800 CDP frames), lanczos-downscaled to 1920×1080. Eight captures, one per scene, each a real end-to-end run against the live local stack; UI state is handed from one capture to the next.
- **Voice**: Kokoro-82M (fp32, local), voice `af_heart`, speed 1.05. Every clip fits its scene window; scripts hold each scene until its clip has finished.
- **Disclosure band**: a 34 px band under the app (the app viewport is 866 px tall) carries the scene number and REAL / SIM / CHAIN / MODELLED / TEMPLATE tags. It never covers the UI. The app's own mode bar (Data · Historical, Repair · Simulated, Chain · Anvil local) is visible throughout.

## Capture attempts

| Scene | Window | Attempts | Result |
|---|---|---|---|
| Problem | 0:00–0:25 | 1 | ok |
| Detection | 0:25–0:55 | 1 | ok |
| Investigation | 0:55–1:35 | 1 | ok |
| Funding | 1:35–2:10 | 1 | ok |
| Repair | 2:10–2:45 | 1 | ok |
| Verification | 2:45–3:35 | 1 | ok |
| Settlement & Proof | 3:35–4:10 | 1 | ok |
| Closing | 4:10–4:30 | 1 | ok |

## Assertions checked during recording

**Problem**
- ✓ guest landing: intro card, Guest (read-only), mode bar Historical / Simulated / Anvil, 10,098 detections
- ✓ map rendered (520×420 px region): σ=28.7, 4581 amber marker px

**Detection**
- ✓ INC-32893D: drawer shows 51 detections on 28 dates, priority 81.4/100; provider plume raster fetched (HTTP 200)
- ✓ map rendered (250×200 px region): σ=56.1, 713 amber marker px, 9115 plume-raster px

**Investigation**
- ✓ acting as Avery Sponsor (sponsor)
- ✓ investigation d5d5b3dc-1c45-45dd-97a5-169355c047e7 stored: template narrative, grounding passed, 5 confirmed facts / 3 explanations, 59 evidence refs

**Funding**
- ✓ RP-F76EFA: 2 contract transaction(s) mined with status 1 on Anvil (ProjectCreated, ProjectFunded)
- ✓ RP-F76EFA: status FUNDED, on-chain state FUNDED, on-chain terms hash equals stored terms hash, escrow 2500000000000000000 wei

**Repair**
- ✓ chain clock advanced on Anvil: Chain Anvil (local) · 2026-10-13 → Chain Anvil (local) · 2026-11-12
- ✓ RP-F76EFA: 4 contract transaction(s) mined with status 1 on Anvil (ProjectCreated, ProjectFunded, AssignmentAccepted, EvidenceSubmitted)
- ✓ RP-F76EFA: REPAIR_SUBMITTED; simulated evidence round 1, manifest hash on-chain equals stored content hash

**Verification**
- ✓ RP-F76EFA: 10 policy checks evaluated server-side, 0 failing, impact preview "quantified"
- ✓ RP-F76EFA: 5 contract transaction(s) mined with status 1 on Anvil (ProjectCreated, ProjectFunded, AssignmentAccepted, EvidenceSubmitted, DecisionRecorded)
- ✓ RP-F76EFA: VERIFIED recorded on-chain; contract's last decision digest equals the verifier's EIP-712 digest 0x7fed066c03…

**Settlement & Proof**
- ✓ RP-F76EFA: 6 contract transaction(s) mined with status 1 on Anvil (ProjectCreated, ProjectFunded, AssignmentAccepted, EvidenceSubmitted, DecisionRecorded, PaymentReleased)
- ✓ RP-F76EFA: escrow released (PaymentReleased), on-chain state PAID, receipt RCPT-9B9301B331 issued
- ✓ RCPT-9B9301B331: browser-side viem check 5/5 pass (state Paid, evidence hash, terms hash, decision digest, settlement tx success)

**Closing**
- ✓ ledger: 10098 real observations; 1 receipt(s); modelled 727.3 t CH₄ from synthetic evidence; real-world verified reductions: none

## Transactions shown (local Anvil, chain id 31337)

Every hash below was read back with `eth_getTransactionReceipt` from Anvil after the capture: status `0x1`, sent to the escrow contract.

| First shown in | Event | Tx hash | Block |
|---|---|---|---|
| funding | ProjectCreated | `0x8ffd78bd3337dfe04e27b34ea6d3392607ae8c9871e06ca8b7e9802852a4beb2` | 2 |
| funding | ProjectFunded | `0x62225d1963c5489d9a1353189b693eeb37b7c422803f261779f39a9c3f2a6a46` | 3 |
| repair | AssignmentAccepted | `0x077850594e8b4c87edd7d005cc4aacde5ff396908618e991b44a45f810cc35aa` | 4 |
| repair | EvidenceSubmitted | `0xe9a541fdaac8de403a7d908da9c7751264116c5eaa2ed8f5d697482cc16a0cdc` | 6 |
| verification | DecisionRecorded | `0x70dbdef8cad60d1882b8aa0011ecaba6a6edd526a6a38319eb93705ce42eda5c` | 7 |
| settlement | PaymentReleased | `0x683d1ffe2365a631a0977b9e5ebcfb2470d756d424435b6b5697dde8d2a86e41` | 8 |

## Narration timing (no clipped words)

| Clip | Starts | Length | Ends | Next scene/part starts | Spare | Transcript match |
|---|---|---|---|---|---|---|
| plume-01-problem/problem | 0.01 s | 21.65 s | 21.66 s | 25.00 s | 3.34 s ✓ | 100% |
| plume-02-detection/labels | 25.01 s | 3.58 s | 28.58 s | 29.52 s | 0.94 s ✓ | 100% |
| plume-02-detection/detection | 29.52 s | 20.88 s | 50.40 s | 55.00 s | 4.60 s ✓ | 98% |
| plume-03-investigation/investigate | 55.01 s | 19.10 s | 74.11 s | 74.41 s | 0.30 s ✓ | 95% |
| plume-03-investigation/report | 74.41 s | 16.68 s | 91.09 s | 95.00 s | 3.91 s ✓ | 100% |
| plume-04-funding/terms | 95.01 s | 14.07 s | 109.09 s | 111.18 s | 2.10 s ✓ | 97% |
| plume-04-funding/escrow | 111.18 s | 14.07 s | 125.26 s | 130.00 s | 4.74 s ✓ | 100% |
| plume-05-repair/accept | 130.06 s | 9.00 s | 139.06 s | 139.57 s | 0.51 s ✓ | 96% |
| plume-05-repair/evidence | 139.57 s | 16.25 s | 155.82 s | 165.00 s | 9.18 s ✓ | 98% |
| plume-06-verification/review | 165.01 s | 19.10 s | 184.11 s | 185.01 s | 0.90 s ✓ | 97% |
| plume-06-verification/impact | 185.01 s | 13.20 s | 198.21 s | 198.51 s | 0.30 s ✓ | 93% |
| plume-06-verification/sign | 198.51 s | 13.30 s | 211.81 s | 215.00 s | 3.19 s ✓ | 100% |
| plume-07-settlement/release | 215.02 s | 10.25 s | 225.27 s | 225.57 s | 0.30 s ✓ | 100% |
| plume-07-settlement/proof | 225.57 s | 18.23 s | 243.80 s | 250.00 s | 6.20 s ✓ | 98% |
| plume-08-closing/ledger | 250.02 s | 12.20 s | 262.22 s | 262.52 s | 0.30 s ✓ | 96% |
| plume-08-closing/close | 262.52 s | 4.05 s | 266.57 s | 270.00 s | 3.43 s ✓ | 100% |

Transcript match = share of scripted words that Whisper (whisper-base.en, local) recovered in order from the Kokoro clip — an automated intelligibility check (the clips were not listened to by a person during this build). Scripted words Whisper did not return:

- plume-02-detection/detection: "mapper's"
- plume-03-investigation/investigate: "dbscan", "mapper's"
- plume-04-funding/terms: "authorised"
- plume-05-repair/accept: "elapsed"
- plume-05-repair/evidence: "labelled"
- plume-06-verification/review: "authorised"
- plume-06-verification/impact: "ar6", "labelled"
- plume-07-settlement/proof: "signed"
- plume-08-closing/ledger: "modelled"

## Rendered-file checks

- Duration 270.00 s (target 270 s). Captures trimmed to their windows; padding needed: none.
- Black frames (blackdetect, ≥ 0.3 s): **none**.
- Static stretches ≥ 4 s (freezedetect): 0.0 s for 8.3 s, 15.2 s for 5.4 s, 81.2 s for 6.5 s, 160.6 s for 4.4 s, 179.0 s for 5.0 s, 189.6 s for 5.4 s, 228.8 s for 4.2 s, 258.2 s for 4.1 s. (A static stretch is a held screen while narration continues, not a stall; each was checked in the manual review.)
- Loudness (EBU R128): integrated -16.3 LUFS; peak -1.2 dBFS.

## Manual review

Reviewed by inspecting stills from the rendered MP4: a contact sheet with one frame every 5 s (54 frames, `output/work/review/sheet-*.png`), plus frame-by-frame stills around scene cuts and page loads. The audio was **not** listened to by a person. Narration was checked automatically: clip timing against the scene windows above, and a Whisper transcript of every clip against the script.

| Check | Result |
|---|---|
| Blank or black screens | None. blackdetect found nothing. The only loading state on camera is the Impact Receipt route skeleton for about 0.3 s (3:47.3–3:47.7) after "View proof" is clicked. The first take showed it for 1.4 s; that take was discarded, and all captures now open each route once off camera so the code is cached. |
| Map and plume graphics | Rendered in both map scenes. The preflight and scene 1 pixel checks found amber rate markers over the basemap. Scene 2 counted more than 9,000 plume-raster pixels from Carbon Mapper's image for `av320241001t172751-M` (AVIRIS‑3, 2024‑10‑01, 5,636 kg/h), zoomed in at 0:40–0:55. |
| Missing steps | None. Every DEMO_SCRIPT step is on screen, in order: guest Mission Control → demo incident → known vs inferred → sponsor investigation → report (facts and explanations, template badge, grounding passed) → create, review, publish and fund → provider accepts → Anvil clock fast-forward → submit synthetic evidence → verifier workbench (all policy checks pass, impact formula, satellite note) → sign VERIFIED → release → receipt (5/5 browser chain checks, proof timeline expanded) → Impact Ledger → closing card. |
| Narration drift and clipping | None. Each clip starts at its scene mark and ends before the next mark (table above); actions are cued to Whisper word times, e.g. "Show the demo incident" before "This is one candidate source", the plume zoom on "plume image", and "Sign & record decision" on "Rejected or inconclusive…". |
| Labels and disclosures | The app's mode bar (Data · Historical, Repair · Simulated, Chain · Anvil local) and the disclosure band are visible in every frame except the closing card, which carries its own disclosure line. Tags per scene: REAL for observations; TEMPLATE for the narrative; SIM for organisations, evidence and the repair; MODELLED for the reduction; CHAIN for the createProject, fund, accept, submitEvidence, recordDecision and releasePayment transactions. The receipt shows "Not a carbon credit · not tradable" and the reduction is labelled "From simulated measurements". The ledger shows real-world verified reductions: none. |
| Clipped content | None. The 34 px disclosure band sits below the app (viewport shortened to 866 px), so it never covers UI. In-page zooms (1.14–1.2×) scale only the page content; the top bar and band stay in frame. |
| Static stretches flagged by freezedetect | Held screens while narration continues (the intro map, the report, the form review, the evidence panel, the workbench, the receipt, the ledger). None of them is a stalled capture, and the cursor or highlights move in each. |
| Accuracy of spoken figures | Checked against the live UI during recording: 51 detections, 28 dates, 5 instruments, priority 81.4/100 (third of 3,907), ARI 0.97 (EVALUATION.md), 10,098 detections. DEMO_SCRIPT.md's "ranks 81 out of 3,907" was wrong; the video says neither, and the script now says "scores 81 out of 100, the third-highest of 3,907". |

Known, accepted imperfections:
- At 0:40–0:42 the zoom is anchored at the plume origin. For about a second the cursor rests on a detection marker, so the app's hover tooltip shows a real neighbouring EMIT detection.
- A few two-line subtitle cues run to 43 characters per line, one over the usual 42.

## What is real, simulated and modelled in the footage

- **Real**: the 10,098 Carbon Mapper CH₄ detections, the INC‑32893D incident (51 detections, 28 dates, 5 instruments), Carbon Mapper's plume raster, the investigation code, every contract transaction (local Anvil) and the browser-side viem chain check.
- **Simulated**: the sponsor, provider and verifier organisations, the repair, the evidence documents and site measurements, the escrowed funds (test ETH) and the elapsed time (Anvil clock fast-forward).
- **Modelled**: the CH₄/CO₂e reduction on the verification and receipt screens, computed from synthetic measurements and labelled as such. No real leak was repaired; no carbon credit was issued; the ledger reports real-world verified reductions as none.
