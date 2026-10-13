"""Runtime configuration. All values come from environment variables (see .env.example)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(str(REPO_ROOT / ".env"),), env_prefix="PLUME_", extra="ignore"
    )

    environment: str = "local"
    database_url: str = "postgresql+psycopg://plume:plume@localhost:5434/plume"

    # Data providers
    carbonmapper_base_url: str = "https://api.carbonmapper.org/api/v1"
    carbonmapper_token: str | None = None
    data_mode: str = Field(default="snapshot", description="snapshot | live")
    snapshot_dir: Path = REPO_ROOT / "data" / "snapshots"
    cache_dir: Path = REPO_ROOT / "data" / "cache"
    evidence_dir: Path = REPO_ROOT / "data" / "evidence"
    http_timeout_s: float = 60.0

    # Demo / auth
    demo_mode: bool = True
    jwt_secret: str = "local-dev-only-secret-change-me-0123456789"
    jwt_ttl_minutes: int = 12 * 60

    # Blockchain
    chain_rpc_url: str = "http://127.0.0.1:8545"
    chain_id: int = 31337
    chain_name: str = "Anvil (local)"
    chain_explorer_url: str | None = None
    deployment_file: Path = REPO_ROOT / "contracts" / "deployments" / "local.json"
    # Mnemonic for *demo persona* signing keys. The default Anvil/Hardhat test mnemonic is public
    # and only meaningful on a local development chain. Never put a mainnet key here.
    demo_mnemonic: str = "test test test test test test test test test test test junk"

    # LLM
    llm_provider: str = "none"  # none | anthropic
    llm_model: str = "claude-opus-5-5"
    anthropic_api_key: str | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    llm_timeout_s: float = 60.0

    # Impact accounting
    gwp_ch4: float = 29.8
    gwp_reference: str = "IPCC AR6 WG1 Ch.7 Table 7.15, GWP-100, fossil CH4 (29.8 ± 11)"

    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
