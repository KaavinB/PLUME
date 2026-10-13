# Proof of Repair contracts

`src/RepairEscrow.sol`: escrow for authorised methane repair projects. Funds release only on an EIP‑712 `RepairDecision` signed by the project's designated, independent, admin-approved verifier over the current evidence hash and review round.

```bash
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git && forge install foundry-rs/forge-std --no-git
forge test                      # 39 unit/fuzz tests + invariant suite
forge test --gas-report         # gas per function
../scripts/deploy-local.sh      # deploy to local Anvil and approve demo provider/verifier
```

| Function | Who | Effect |
|---|---|---|
| `createProject(provider, verifier, amount, termsHash, expiresAt, disputeWindow)` | sponsor | Open; parties must be distinct and approved |
| `fund(id)` payable | sponsor | Funded; exact amount, once |
| `acceptAssignment(id)` | provider | Assigned |
| `submitEvidence(id, evidenceHash)` | provider | Submitted; new round |
| `recordDecision(id, round, evidenceHash, outcome, reportHash, deadline, sig)` | anyone relays; verifier signs | Verified / Rejected / Inconclusive / EvidenceRequested |
| `dispute(id, reasonHash)` | sponsor or provider | Disputed; round bumps so the old signature can't resolve it |
| `releasePayment(id)` | anyone | Paid; once, to the provider only, after the dispute window |
| `cancel(id)` / `refundExpired(id)` | sponsor | Cancelled (refund if funded) / Refunded after expiry |

See [SECURITY.md](../SECURITY.md) for the threat model and the test that covers each threat.
