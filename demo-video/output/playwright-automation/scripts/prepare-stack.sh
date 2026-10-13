#!/usr/bin/env bash
# Brings the local PLUME stack into a clean, recordable state for the demo video:
#   1. fresh Anvil chain (clean block clock), 2. `make demo-reset` (redeploys RepairEscrow, clears projects,
#   re-seeds personas), 3. API restarted without --reload, 4. web app served from a production build
#   (no Next.js dev indicator in the footage), 5. health checks for API, DB, chain, contract and web.
# Local only. Never touches anything but the local demo database and the local Anvil chain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOGS="$ROOT/.video-logs"
mkdir -p "$LOGS"
export PATH="$HOME/.foundry/bin:$PATH"
API=http://localhost:8000
WEB=http://localhost:3000
RPC=http://127.0.0.1:8545
MODE="${1:-full}" # full | reset-only

rpc() { curl -s -m 5 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":$2,\"id\":1}" "$RPC"; }
wait_http() { # url, label, tries
  for _ in $(seq 1 "${3:-60}"); do curl -s -m 3 -o /dev/null -w '%{http_code}' "$1" | grep -q '^2' && return 0; sleep 1; done
  echo "✗ $2 did not become healthy at $1" >&2; return 1
}
kill_port() { local pids; pids="$(lsof -ti tcp:"$1" -sTCP:LISTEN || true)"; [ -n "$pids" ] && kill $pids 2>/dev/null || true; for _ in $(seq 1 20); do lsof -ti tcp:"$1" -sTCP:LISTEN >/dev/null || return 0; sleep 0.5; done; }

cd "$ROOT"
docker compose up -d --wait db >/dev/null

if [ "$MODE" = "full" ]; then
  echo "→ restarting Anvil (fresh chain)"
  pkill -f "anvil --port 8545" 2>/dev/null || true
  kill_port 8545
  nohup anvil --port 8545 --chain-id 31337 --silent > "$LOGS/anvil.log" 2>&1 < /dev/null & echo $! > "$ROOT/.anvil.pid"
  for _ in $(seq 1 30); do rpc eth_chainId '[]' | grep -q 0x7a69 && break; sleep 0.5; done
fi

echo "→ make demo-reset"
make -s demo-reset > "$LOGS/demo-reset.log" 2>&1 || { tail -30 "$LOGS/demo-reset.log"; exit 1; }

if [ "$MODE" = "full" ]; then
  echo "→ restarting API (no reload)"
  pkill -f "uvicorn app.main:app" 2>/dev/null || true
  kill_port 8000
  (cd backend && exec nohup uv run uvicorn app.main:app --port 8000) > "$LOGS/api.log" 2>&1 < /dev/null &
  wait_http "$API/api/v1/health" "API"

  echo "→ production build of the web app"
  pkill -f "next dev" 2>/dev/null || true; pkill -f "next start" 2>/dev/null || true
  kill_port 3000
  (cd frontend && npm run -s build > "$LOGS/web-build.log" 2>&1) || { tail -30 "$LOGS/web-build.log"; exit 1; }
  (cd frontend && exec nohup npx next start -p 3000) > "$LOGS/web.log" 2>&1 < /dev/null &
  wait_http "$WEB" "web app"
fi

echo "→ health checks"
H="$(curl -s -m 5 "$API/api/v1/health")"
echo "$H" | grep -q '"database":true' || { echo "✗ API database unhealthy: $H" >&2; exit 1; }
echo "$H" | grep -q '"blockchain":true' || { echo "✗ API cannot reach the chain: $H" >&2; exit 1; }
CONTRACT="$(python3 -c "import json;print(json.load(open('contracts/deployments/local.json'))['address'])")"
CODE="$(rpc eth_getCode "[\"$CONTRACT\",\"latest\"]" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["result"]))')"
[ "$CODE" -gt 10 ] || { echo "✗ no contract code at $CONTRACT" >&2; exit 1; }
META_CONTRACT="$(curl -s "$API/api/v1/meta" | python3 -c 'import json,sys;print(json.load(sys.stdin)["chain"]["contract"])')"
[ "$(echo "$META_CONTRACT" | tr A-F a-f)" = "$(echo "$CONTRACT" | tr A-F a-f)" ] || { echo "✗ API uses $META_CONTRACT, deployment is $CONTRACT" >&2; exit 1; }
INC="$(curl -s "$API/api/v1/incidents/INC-32893D" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(len(d["investigations"]),len(d["repair_projects"]),d["observation_count"])')"
[ "$INC" = "0 0 51" ] || { echo "✗ demo incident not clean (investigations, projects, observations = $INC)" >&2; exit 1; }
WEB_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$WEB/")"
[ "$WEB_CODE" = "200" ] || { echo "✗ web app returned $WEB_CODE" >&2; exit 1; }
echo "✓ API ok (db + chain) · contract $CONTRACT has code · demo incident clean · web 200"
