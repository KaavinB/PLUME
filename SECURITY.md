# Security model

## Contract roles (`RepairEscrow.sol`)

| Role | Powers | Explicitly cannot |
|---|---|---|
| Owner / administrator (`Ownable2Step`) | approve or revoke providers and verifiers | withdraw, redirect or freeze escrow; record decisions; change project terms |
| Sponsor | `createProject` (must be distinct from provider and verifier), `fund` (exact amount, once), `cancel` before acceptance (refund), `dispute`, `refundExpired` after expiry | pay out to anyone; act after the provider accepts (except dispute or expiry refund) |
| Provider (approved) | `acceptAssignment`, `submitEvidence` (new round), `dispute` | verify its own work; receive funds without a VERIFIED decision |
| Verifier (approved, project-specific) | sign EIP‑712 `RepairDecision` | move funds; sign for another project, round, evidence hash or contract |
| Anyone | relay a signed decision; call `releasePayment` after VERIFIED and the dispute window | change where funds go |

## Authorization in the backend

- Persona sessions are HS256 JWTs (`sub`, `role`, `exp`, `iss`) issued only when `PLUME_DEMO_MODE=true`.
- Every state change checks three things:
  1. the role is allowed by the lifecycle table (`repair/state_machine.py`);
  2. the user is *this project's* sponsor, provider or verifier;
  3. the transition is valid from the current state, under a row lock.
- Observers are read-only. Admin-only reset is limited to demo mode on chain 31337.
- The contract re-checks everything, so a compromised backend still cannot pay an unapproved party or skip verification.

## Threat model

| Threat | Mitigation | Test |
|---|---|---|
| Unauthorised verification | `ecrecover` must equal the project's verifier; verifier must still be approved | `test_Decision_UnauthorizedSignerRejected`, fuzz `testFuzz_OnlyVerifierKeyCanVerify`, `test_Decision_RevokedVerifierCannotDecide`, API 403 tests |
| Signature replay (other project, round or contract; same decision twice) | EIP‑712 domain (chain id, contract) plus `projectId`, `round`, `evidenceHash`, `reportHash`, `deadline`; round bumps on resubmission and dispute; `usedDecision[digest]` | `test_Decision_ReplayAfterResubmissionRejected`, `…ForOtherProjectRejected`, `…ForOtherContractRejected`, `test_DecisionCannotBeRecordedTwice` |
| Tampered outcome or evidence | the outcome and the evidence hash are part of the signed digest | `test_Decision_TamperedOutcomeRejected`, `…WrongEvidenceHashRejected` |
| Malleable or garbage signatures | OpenZeppelin `ECDSA.tryRecover` (rejects high-s and bad lengths) | `test_Decision_MalformedSignatureRejected` |
| Expired signatures and decisions after expiry | `deadline` and `expiresAt` checks | `test_Decision_ExpiredSignatureRejected`, `test_Expiry_RefundsSponsorAndBlocksDecision` |
| Payment on REJECTED or INCONCLUSIVE | `releasePayment` requires `Verified` | `test_Rejected_CannotPay`, `test_Inconclusive_CannotPay`, API and Playwright tests |
| Double funding or double payout | state checks; checks-effects-interactions (state set before the transfer) | `test_Fund_DoubleFundingRejected`, `test_DuplicatePayoutPrevented`, invariants |
| Reentrancy | `nonReentrant` on every value-moving function; CEI; push transfer limited to 50k gas | `test_Reentrancy_ProviderCannotDoubleCollect` |
| Griefing by a reverting provider | failed push → `pendingWithdrawals` credit plus `withdraw()` | `test_RevertingProvider_FundsCreditedForWithdrawal` |
| Admin rug | no admin function touches balances | `test_AdminCannotTakeFunds` |
| Funds stuck forever | `refundExpired` from every unverified live state; VERIFIED is always releasable | `invariant_BalanceMatchesLiveEscrow`, `test_Expiry_VerifiedProjectNotRefundable` |
| Evidence swapped after commitment | keccak‑256 of the canonical manifest is on-chain; every file SHA‑256 is recomputed before decisions | `test_bundle_commitment_detects_tampering`, policy check `evidence_hash_consistent` |
| Self-dealing (verifier = provider or sponsor) | contract `InvalidParameters`; DB CHECK constraint; policy check on wallet and organisation | `test_Create_RequiresIndependentRoles`, policy tests |
| Unauthorised physical work | projects require a sponsor site-authorisation attestation plus a provider authorisation reference; only admin-approved providers | policy `provider_authorized` |
| Duplicate or concurrent API submissions | `SELECT … FOR UPDATE`, version column, lifecycle checks | API double-fund and double-release tests |

## External verifier trust

The design does not remove trust in the verifier. It **narrows and records** it:
- one key per project, approved by the admin and revocable;
- each decision bound to one evidence bundle and round;
- the full report (policy checks, measurements, notes) is hashed into the signed message, so it is attributable afterwards.

Collusion between provider and verifier is not prevented on-chain. It is constrained by approval, independence checks, public receipts and the dispute path. Multi-verifier quorum is future work.

## Evidence integrity and privacy

Only hashes, ids and state transitions go on-chain. Files stay in off-chain storage (`data/evidence/`, outside git). Accepted media types: PDF, PNG, JPEG, CSV, TXT, Markdown, JSON; maximum 10 MB per file. Personal data is not collected; demo personas are fictional.

## Keys and secrets

- No private keys are committed. Demo persona keys are derived at runtime from `PLUME_DEMO_MNEMONIC`, which defaults to the **publicly known Anvil test mnemonic**, valid only on local or test chains.
- `.env` is gitignored. `PLUME_JWT_SECRET` must be replaced for any shared deployment.
- Time travel and reset endpoints refuse to run outside demo mode or off chain 31337.

## Known limitations

1. **Custodial demo signing:** the backend holds persona test keys, which is acceptable only for local or testnet demos. Production requires participant wallets (not implemented).
2. **Single verifier;** a dispute is resolved by a fresh decision from the same verifier.
3. **No rate limiting** on the API, and no audit by a third party. The contract has not been formally audited.
4. **Expiry favours the sponsor:** a provider whose evidence is never reviewed before expiry loses the escrow claim, so verifier service levels matter.
5. **Revoking a verifier** blocks decisions until expiry, then funds return to the sponsor. This is a liveness lever for the admin, not a theft vector.
6. **JWT in localStorage** (demo convenience); production should use httpOnly cookies or wallet sessions.
