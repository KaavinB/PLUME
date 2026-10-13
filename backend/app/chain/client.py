"""Thin, typed wrapper around the RepairEscrow contract (web3.py).

The backend signs with *demo persona* keys derived from a public test mnemonic. This is only
acceptable on a local chain or a public testnet with valueless funds; production deployments
should have participants sign in their own wallets (the contract does not depend on the backend).
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from enum import IntEnum
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_account.signers.local import LocalAccount
from hexbytes import HexBytes
from web3 import Web3
from web3.contract import Contract

from app.config import Settings

log = logging.getLogger(__name__)
Account.enable_unaudited_hdwallet_features()


class ChainState(IntEnum):
    NONE = 0
    OPEN = 1
    FUNDED = 2
    ASSIGNED = 3
    SUBMITTED = 4
    VERIFIED = 5
    REJECTED = 6
    INCONCLUSIVE = 7
    EVIDENCE_REQUESTED = 8
    DISPUTED = 9
    PAID = 10
    CANCELLED = 11
    REFUNDED = 12


class Outcome(IntEnum):
    NONE = 0
    VERIFIED = 1
    REJECTED = 2
    INCONCLUSIVE = 3
    ADDITIONAL_EVIDENCE_REQUIRED = 4


# Backend status implied by each on-chain state (the chain is authoritative for these).
CHAIN_TO_STATUS: dict[ChainState, set[str]] = {
    ChainState.OPEN: {"OPEN_FOR_FUNDING"},
    ChainState.FUNDED: {"FUNDED"},
    ChainState.ASSIGNED: {"ASSIGNED"},
    ChainState.SUBMITTED: {
        "REPAIR_SUBMITTED",
        "UNDER_VERIFICATION",
    },  # UNDER_VERIFICATION is off-chain detail
    ChainState.VERIFIED: {"VERIFIED"},
    ChainState.REJECTED: {"REJECTED"},
    ChainState.INCONCLUSIVE: {"INCONCLUSIVE"},
    ChainState.EVIDENCE_REQUESTED: {"ADDITIONAL_EVIDENCE_REQUIRED"},
    ChainState.DISPUTED: {"DISPUTED"},
    ChainState.PAID: {"PAID"},
    ChainState.CANCELLED: {"CANCELLED"},
    ChainState.REFUNDED: {"EXPIRED"},
}


def canonical_status(state: ChainState) -> str:
    return sorted(CHAIN_TO_STATUS[state])[0] if state != ChainState.SUBMITTED else "REPAIR_SUBMITTED"


class ChainError(RuntimeError):
    pass


@dataclass(frozen=True)
class TxResult:
    tx_hash: str
    block_number: int
    gas_used: int
    status: int
    events: list[dict[str, Any]]
    block_timestamp: int


@dataclass(frozen=True)
class OnchainProject:
    sponsor: str
    amount: int
    provider: str
    expires_at: int
    round: int
    state: ChainState
    verifier: str
    verified_at: int
    dispute_window: int
    terms_hash: str
    evidence_hash: str
    last_decision_digest: str


def _hex(b: bytes | HexBytes) -> str:
    return "0x" + bytes(b).hex()


class ChainClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        dep_path: Path = settings.deployment_file
        if not dep_path.exists():
            raise ChainError(f"deployment file not found: {dep_path}. Run `make deploy-local`.")
        self.deployment = json.loads(dep_path.read_text())
        abi = json.loads((dep_path.parent / "RepairEscrow.abi.json").read_text())
        self.w3 = Web3(Web3.HTTPProvider(settings.chain_rpc_url, request_kwargs={"timeout": 30}))
        self.address = Web3.to_checksum_address(self.deployment["address"])
        self.contract: Contract = self.w3.eth.contract(address=self.address, abi=abi)
        self.chain_id = int(self.deployment["chainId"])
        self._locks: dict[str, threading.Lock] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------- accounts
    def account(self, hd_index: int) -> LocalAccount:
        return _derive(self.settings.demo_mnemonic, hd_index)

    def is_connected(self) -> bool:
        try:
            return bool(self.w3.is_connected()) and self.w3.eth.chain_id == self.chain_id
        except Exception:  # noqa: BLE001 — health probe must not raise
            return False

    def balance(self, address: str) -> int:
        return int(self.w3.eth.get_balance(Web3.to_checksum_address(address)))

    # ------------------------------------------------------------- reads
    def get_project(self, onchain_id: int) -> OnchainProject:
        p = self.contract.functions.getProject(onchain_id).call()
        return OnchainProject(
            sponsor=p[0],
            amount=int(p[1]),
            provider=p[2],
            expires_at=int(p[3]),
            round=int(p[4]),
            state=ChainState(int(p[5])),
            verifier=p[6],
            verified_at=int(p[7]),
            dispute_window=int(p[8]),
            terms_hash=_hex(p[9]),
            evidence_hash=_hex(p[10]),
            last_decision_digest=_hex(p[11]),
        )

    def is_approved_provider(self, address: str) -> bool:
        return bool(self.contract.functions.approvedProvider(Web3.to_checksum_address(address)).call())

    def is_approved_verifier(self, address: str) -> bool:
        return bool(self.contract.functions.approvedVerifier(Web3.to_checksum_address(address)).call())

    def latest_timestamp(self) -> int:
        return int(self.w3.eth.get_block("latest")["timestamp"])

    # ------------------------------------------------------------- writes
    def transact(self, hd_index: int, fn: str, *args: Any, value: int = 0) -> TxResult:
        acct = self.account(hd_index)
        with self._lock:
            lock = self._locks.setdefault(acct.address, threading.Lock())
        with lock:
            func = getattr(self.contract.functions, fn)(*args)
            try:
                gas = func.estimate_gas({"from": acct.address, "value": value})
            except Exception as exc:  # contract revert during estimation → surface the reason
                raise ChainError(_revert_reason(self.contract, exc)) from exc
            tx = func.build_transaction(
                {
                    "from": acct.address,
                    "value": value,
                    "nonce": self.w3.eth.get_transaction_count(acct.address, "pending"),
                    "gas": int(gas * 1.25),
                    "chainId": self.chain_id,
                }
            )
            signed = acct.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
        if receipt["status"] != 1:
            raise ChainError(f"transaction {_hex(tx_hash)} reverted")
        block = self.w3.eth.get_block(receipt["blockNumber"])
        events = self.decode_logs(receipt["logs"])
        log.info("tx mined", extra={"fn": fn, "tx": _hex(tx_hash), "gas": receipt["gasUsed"]})
        return TxResult(
            _hex(tx_hash),
            int(receipt["blockNumber"]),
            int(receipt["gasUsed"]),
            1,
            events,
            int(block["timestamp"]),
        )

    def decode_logs(self, logs: list[Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for lg in logs:
            if Web3.to_checksum_address(lg["address"]) != self.address:
                continue
            for ev in cast(Iterable[Any], self.contract.events):
                try:
                    decoded = ev().process_log(lg)
                except Exception:  # noqa: BLE001,S112 — try each event ABI until one matches
                    continue
                out.append(
                    {
                        "event": decoded["event"],
                        "args": {
                            k: (_hex(v) if isinstance(v, bytes | HexBytes) else v)
                            for k, v in decoded["args"].items()
                        },
                        "tx_hash": _hex(lg["transactionHash"]),
                        "log_index": int(lg["logIndex"]),
                        "block_number": int(lg["blockNumber"]),
                    }
                )
                break
        return out

    def logs_since(self, from_block: int) -> list[dict[str, Any]]:
        logs = self.w3.eth.get_logs({"address": self.address, "fromBlock": from_block, "toBlock": "latest"})
        return self.decode_logs(list(logs))

    # ------------------------------------------------------------- EIP-712
    def typed_decision(
        self,
        onchain_id: int,
        round_: int,
        evidence_hash: str,
        outcome: Outcome,
        report_hash: str,
        deadline: int,
    ) -> dict[str, Any]:
        return {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "RepairDecision": [
                    {"name": "projectId", "type": "uint256"},
                    {"name": "round", "type": "uint32"},
                    {"name": "evidenceHash", "type": "bytes32"},
                    {"name": "outcome", "type": "uint8"},
                    {"name": "reportHash", "type": "bytes32"},
                    {"name": "deadline", "type": "uint64"},
                ],
            },
            "primaryType": "RepairDecision",
            "domain": {
                "name": "PLUME Proof of Repair",
                "version": "1",
                "chainId": self.chain_id,
                "verifyingContract": self.address,
            },
            "message": {
                "projectId": onchain_id,
                "round": round_,
                "evidenceHash": evidence_hash,
                "outcome": int(outcome),
                "reportHash": report_hash,
                "deadline": deadline,
            },
        }

    def sign_decision(self, hd_index: int, typed: dict[str, Any]) -> tuple[str, str]:
        """Sign typed data; cross-check the digest against the contract's own computation."""
        signable = encode_typed_data(full_message=typed)
        signed = self.account(hd_index).sign_message(signable)
        m = typed["message"]
        onchain_digest = self.contract.functions.decisionDigest(
            m["projectId"],
            m["round"],
            HexBytes(m["evidenceHash"]),
            m["outcome"],
            HexBytes(m["reportHash"]),
            m["deadline"],
        ).call()
        if _hex(onchain_digest) != _hex(signed.message_hash):
            raise ChainError("EIP-712 digest mismatch between client and contract")
        return _hex(signed.message_hash), _hex(signed.signature)


@lru_cache(maxsize=32)
def _derive(mnemonic: str, index: int) -> LocalAccount:
    return Account.from_mnemonic(mnemonic, account_path=f"m/44'/60'/0'/0/{index}")


def _revert_reason(contract: Contract, exc: Exception) -> str:
    data: Any = getattr(exc, "data", None)
    if isinstance(data, str) and data.startswith("0x") and len(data) >= 10:
        selector = data[:10]
        for item in cast(list[dict[str, Any]], contract.abi):
            if item.get("type") == "error":
                sig = f"{item['name']}({','.join(i['type'] for i in item.get('inputs', []))})"
                if Web3.keccak(text=sig).hex()[:8] == selector[2:]:
                    return f"contract reverted: {item['name']}"
    return f"contract call failed: {exc}"


_client: ChainClient | None = None
_client_mtime: float | None = None
_client_lock = threading.Lock()


def get_chain(settings: Settings) -> ChainClient:
    """Shared client; rebuilt automatically when the deployment file changes (e.g. after a redeploy)."""
    global _client, _client_mtime
    with _client_lock:
        try:
            mtime = settings.deployment_file.stat().st_mtime
        except OSError:
            mtime = None
        if _client is None or mtime != _client_mtime or _client.settings is not settings:
            _client = ChainClient(settings)
            _client_mtime = mtime
        return _client


def reset_chain_client() -> None:
    global _client
    with _client_lock:
        _client = None
