"""Test configuration.

* Unit tests need nothing external.
* `db` tests use the `plume_test` PostGIS database (created by scripts/db-init.sql); skipped if unreachable.
* `chain` tests start a throwaway Anvil on a free port and deploy RepairEscrow with Foundry; skipped if
  `anvil`/`forge` are not installed.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

TEST_DB = os.environ.get(
    "PLUME_TEST_DATABASE_URL", "postgresql+psycopg://plume:plume@localhost:5434/plume_test"
)
os.environ["PLUME_DATABASE_URL"] = TEST_DB
os.environ.setdefault("PLUME_LLM_PROVIDER", "none")
os.environ.setdefault("PLUME_JWT_SECRET", "test-secret-for-pytest-only-0123456789abcdef")

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "carbonmapper_sample.json"
FOUNDRY_BIN = Path.home() / ".foundry" / "bin"


@pytest.fixture(scope="session")
def sample() -> dict:
    return json.loads(FIXTURE.read_text())


def _db_available() -> bool:
    from sqlalchemy import create_engine, text

    try:
        with create_engine(TEST_DB).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001
        return False


@pytest.fixture(scope="session")
def engine():  # type: ignore[no-untyped-def]
    if not _db_available():
        pytest.skip("test database unavailable (run `make up`)")
    from alembic.config import Config

    from alembic import command

    cfg = Config(str(ROOT / "backend" / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "backend" / "alembic"))
    cfg.set_main_option("sqlalchemy.url", TEST_DB)
    command.upgrade(cfg, "head")
    from app.db import get_engine

    return get_engine(TEST_DB)


TABLES = [
    "impact_receipts",
    "verifications",
    "evidence",
    "chain_events",
    "audit_events",
    "repair_projects",
    "investigations",
    "incident_observations",
    "incidents",
    "observations",
    "ingestion_runs",
    "users",
]


@pytest.fixture()
def db(engine):  # type: ignore[no-untyped-def]
    from sqlalchemy import text
    from sqlalchemy.orm import sessionmaker

    with engine.begin() as c:
        c.execute(text("TRUNCATE " + ", ".join(TABLES) + " RESTART IDENTITY CASCADE"))
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    yield s
    s.close()


@pytest.fixture()
def ingested(db, sample):  # type: ignore[no-untyped-def]
    from app.ingestion.pipeline import ingest

    return ingest(db, sample["plumes"], "carbonmapper", "snapshot", "tests/fixtures", None, sample["sources"])


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="session")
def anvil(tmp_path_factory) -> Iterator[dict]:  # type: ignore[no-untyped-def]
    anvil_bin = shutil.which("anvil") or (FOUNDRY_BIN / "anvil")
    forge_bin = shutil.which("forge") or (FOUNDRY_BIN / "forge")
    if not Path(anvil_bin).exists() or not Path(forge_bin).exists():
        pytest.skip("Foundry (anvil/forge) not installed")
    port = _free_port()
    proc = subprocess.Popen(
        [str(anvil_bin), "--port", str(port), "--silent"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    rpc = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.1)
    out_dir = tmp_path_factory.mktemp("deploy")
    contracts = ROOT / "contracts"
    from eth_account import Account

    Account.enable_unaudited_hdwallet_features()
    mnemonic = "test test test test test test test test test test test junk"
    keys = [Account.from_mnemonic(mnemonic, account_path=f"m/44'/60'/0'/0/{i}") for i in range(6)]
    env = {
        **os.environ,
        "APPROVE_PROVIDERS": keys[2].address,
        "APPROVE_VERIFIERS": keys[3].address,
        "DEPLOYMENT_NAME": f"pytest-{port}",
    }
    subprocess.run(
        [
            str(forge_bin),
            "script",
            "script/Deploy.s.sol:Deploy",
            "--rpc-url",
            rpc,
            "--private-key",
            keys[0].key.hex(),
            "--broadcast",
            "--silent",
        ],
        cwd=contracts,
        env=env,
        check=True,
        capture_output=True,
    )
    dep_src = contracts / "deployments" / f"pytest-{port}.json"
    dep = out_dir / "local.json"
    dep.write_text(dep_src.read_text())
    dep_src.unlink()
    abi = subprocess.run(
        [str(forge_bin), "inspect", "RepairEscrow", "abi", "--json"],
        cwd=contracts,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    (out_dir / "RepairEscrow.abi.json").write_text(abi)
    yield {"rpc": rpc, "deployment": dep}
    proc.terminate()
    proc.wait(timeout=5)


@pytest.fixture()
def settings(anvil, tmp_path):  # type: ignore[no-untyped-def]
    from app.chain.client import reset_chain_client
    from app.config import Settings, get_settings

    s = Settings(
        database_url=TEST_DB,
        chain_rpc_url=anvil["rpc"],
        deployment_file=anvil["deployment"],
        evidence_dir=tmp_path / "evidence",
        jwt_secret="test-secret-for-pytest-only-0123456789abcdef",
        demo_mode=True,
    )
    get_settings.cache_clear()
    reset_chain_client()
    os.environ["PLUME_CHAIN_RPC_URL"] = anvil["rpc"]
    os.environ["PLUME_DEPLOYMENT_FILE"] = str(anvil["deployment"])
    os.environ["PLUME_EVIDENCE_DIR"] = str(tmp_path / "evidence")
    yield s
    get_settings.cache_clear()
    reset_chain_client()
