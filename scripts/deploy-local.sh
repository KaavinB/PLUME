#!/usr/bin/env bash
# Deploys RepairEscrow to a local Anvil chain using the PUBLIC Anvil test mnemonic (index 0 = admin).
# Demo personas: 1 = sponsor, 2 = repair provider, 3 = verifier (approved on deploy), 5 = unapproved contractor.
# Uses host Foundry when installed; otherwise runs Foundry from the docker compose `foundry` service.
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MNEMONIC="${PLUME_DEMO_MNEMONIC:-test test test test test test test test test test test junk}"

if command -v forge >/dev/null && command -v cast >/dev/null; then
  RPC="${PLUME_CHAIN_RPC_URL:-http://127.0.0.1:8545}"
  run() { (cd "$ROOT/contracts" && "$@"); }
else
  echo "Foundry not found on host — using docker compose foundry service" >&2
  RPC="http://anvil:8545"
  run() { docker compose -f "$ROOT/docker-compose.yml" run --rm foundry "$(printf '%q ' "$@")"; }
fi

addr() { run cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index "$1" | tr -d '\r'; }
ADMIN_KEY="$(run cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index 0 | tr -d '\r')"

[ -d "$ROOT/contracts/lib/openzeppelin-contracts" ] || run forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
[ -d "$ROOT/contracts/lib/forge-std" ] || run forge install foundry-rs/forge-std --no-git

PROVIDER="$(addr 2)"
VERIFIER="$(addr 3)"
if command -v forge >/dev/null; then
  (cd "$ROOT/contracts" && APPROVE_PROVIDERS="$PROVIDER" APPROVE_VERIFIERS="$VERIFIER" DEPLOYMENT_NAME=local \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key "$ADMIN_KEY" --broadcast --silent)
  (cd "$ROOT/contracts" && forge inspect RepairEscrow abi --json > deployments/RepairEscrow.abi.json)
else
  docker compose -f "$ROOT/docker-compose.yml" run --rm -e APPROVE_PROVIDERS="$PROVIDER" -e APPROVE_VERIFIERS="$VERIFIER" \
    -e DEPLOYMENT_NAME=local foundry \
    "forge script script/Deploy.s.sol:Deploy --rpc-url $RPC --private-key $ADMIN_KEY --broadcast --silent && forge inspect RepairEscrow abi --json > deployments/RepairEscrow.abi.json"
fi
echo "Deployed:"; cat "$ROOT/contracts/deployments/local.json"; echo
