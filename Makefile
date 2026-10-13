# PLUME developer commands. Requires: Docker, uv, Node 20+, and Foundry (or Docker for the Foundry fallback).
SHELL := /bin/bash
export PATH := $(HOME)/.foundry/bin:$(PATH)
BACKEND := cd backend &&
ANVIL_PID := .anvil.pid

.PHONY: help setup up down db anvil deploy-local migrate ingest seed bootstrap api web dev demo-reset \
        test test-backend test-contracts test-e2e lint typecheck gas eval clean

help:
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[33m%-16s\033[0m %s\n",$$1,$$2}'

setup: ## Install backend, frontend and contract dependencies
	@test -f .env || cp .env.example .env
	$(BACKEND) uv sync
	cd frontend && npm ci && (test -f .env.local || cp .env.example .env.local)
	cd contracts && ([ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git) \
	  && ([ -d lib/forge-std ] || forge install foundry-rs/forge-std --no-git)

up: db anvil ## Start PostGIS and a local Anvil chain

db: ## Start PostGIS (docker compose)
	docker compose up -d --wait db

anvil: ## Start Anvil on :8545 (host Foundry if installed, otherwise docker compose)
	@if curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://127.0.0.1:8545 >/dev/null; then \
	  echo "Anvil already running on :8545"; \
	elif command -v anvil >/dev/null; then \
	  nohup anvil --port 8545 --chain-id 31337 --silent > .anvil.log 2>&1 & echo $$! > $(ANVIL_PID); sleep 1; echo "Anvil started (pid $$(cat $(ANVIL_PID)))"; \
	else docker compose up -d anvil; sleep 2; fi

deploy-local: ## Deploy RepairEscrow to the local chain and approve demo provider/verifier
	./scripts/deploy-local.sh

migrate: ## Apply database migrations
	$(BACKEND) uv run alembic upgrade head

ingest: ## Load the version-controlled Carbon Mapper snapshot (10,098 real CH4 plumes)
	$(BACKEND) uv run python -m app.cli ingest-snapshot

seed: ## Create demo personas (and on-chain approvals if needed)
	$(BACKEND) uv run python -m app.cli seed-demo

bootstrap: up migrate ingest deploy-local seed ## One-shot: infra + schema + real data + contract + personas

api: ## Run the API on :8000 (reload)
	$(BACKEND) uv run uvicorn app.main:app --port 8000 --reload --reload-dir app

web: ## Run the web app on :3000
	cd frontend && npm run dev

dev: ## Run API and web app together (Ctrl-C stops both)
	@trap 'kill 0' EXIT; $(MAKE) -s api & $(MAKE) -s web & wait

demo-reset: ## Local only: clear projects/investigations and redeploy a fresh escrow contract
	./scripts/deploy-local.sh
	$(BACKEND) uv run python -m app.cli reset-demo
	$(BACKEND) uv run python -m app.cli seed-demo
	@echo "Demo reset complete. The API picks up the new contract address automatically."

test: test-contracts test-backend ## Contract + backend tests

test-backend: ## pytest (unit + PostGIS + Anvil integration) with coverage
	docker compose up -d --wait db
	$(BACKEND) uv run pytest --cov=app --cov-report=term-missing:skip-covered

test-contracts: ## Foundry unit, fuzz and invariant tests
	cd contracts && forge test

test-e2e: ## Playwright journey (needs `make dev` running)
	cd frontend && npx playwright test

lint: ## ruff + eslint + forge fmt check
	$(BACKEND) uv run ruff check app tests && uv run ruff format --check app tests
	cd frontend && npm run lint
	cd contracts && forge fmt --check

typecheck: ## mypy + tsc
	$(BACKEND) uv run mypy app
	cd frontend && npm run typecheck

gas: ## Gas report for the escrow lifecycle
	cd contracts && forge test --gas-report --match-contract RepairEscrowTest

eval: ## Reproduce EVALUATION.md measurements (needs the stack running)
	uv run --project backend python scripts/benchmark.py

clean:
	-@test -f $(ANVIL_PID) && kill $$(cat $(ANVIL_PID)) && rm $(ANVIL_PID)
	docker compose down
