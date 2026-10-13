"""Curated remediation knowledge base and retrieval (TF-IDF ranking within sector-applicable entries)."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

KB_PATH = Path(__file__).resolve().parents[2] / "knowledge" / "remediation.yaml"


@dataclass(frozen=True)
class KbEntry:
    id: str
    title: str
    sectors: tuple[str, ...]
    tags: tuple[str, ...]
    guidance: str
    suggested_evidence: tuple[str, ...]
    sources: tuple[dict[str, str], ...]

    @property
    def text(self) -> str:
        return f"{self.title}. {self.guidance} {' '.join(self.tags)}"

    def applies_to(self, sector: str | None) -> bool:
        return "*" in self.sectors or (sector is not None and sector in self.sectors)


@dataclass(frozen=True)
class KnowledgeBase:
    version: str
    entries: tuple[KbEntry, ...]

    def get(self, entry_id: str) -> KbEntry | None:
        return next((e for e in self.entries if e.id == entry_id), None)


@lru_cache
def load_kb(path: Path = KB_PATH) -> KnowledgeBase:
    data: dict[str, Any] = yaml.safe_load(path.read_text())
    entries = tuple(
        KbEntry(
            id=e["id"],
            title=e["title"],
            sectors=tuple(e["sectors"]),
            tags=tuple(e.get("tags", [])),
            guidance=" ".join(e["guidance"].split()),
            suggested_evidence=tuple(e.get("suggested_evidence", [])),
            sources=tuple(e["sources"]),
        )
        for e in data["entries"]
    )
    for e in entries:
        if not e.sources:
            raise ValueError(f"knowledge entry {e.id} has no source")
    return KnowledgeBase(version=str(data["version"]), entries=entries)


def build_query(
    sector: str | None, detection_dates: int, provider_persistence: float | None, median_rate: float | None
) -> str:
    terms: list[str] = []
    if detection_dates >= 3:
        terms += ["persistent", "recurring", "leak", "monitoring"]
    elif detection_dates == 2:
        terms += ["recurring", "intermittent"]
    else:
        terms += ["single", "uncertain", "intermittent"]
    if provider_persistence is not None and provider_persistence < 0.5:
        terms += ["intermittent", "tank", "flare"]
    if median_rate is not None and median_rate >= 1000:
        terms += ["large", "notification", "super-emitter"]
    if sector is None or sector in ("NA", "NULL", "other"):
        terms += ["attribution", "sector", "unassigned"]
    terms += ["verification", "inspection"]
    return " ".join(terms)


def retrieve(kb: KnowledgeBase, sector: str | None, query: str, k: int = 5) -> list[tuple[KbEntry, float]]:
    """Return up to k entries applicable to the sector, ranked by TF-IDF cosine similarity.

    Sector-specific entries come first; cross-cutting ("*") entries fill the remaining slots.
    """
    candidates = [e for e in kb.entries if e.applies_to(sector)]
    if not candidates:
        return []
    vec = TfidfVectorizer(stop_words="english")
    matrix = vec.fit_transform([e.text for e in candidates] + [query])
    sims = cosine_similarity(matrix[-1], matrix[:-1]).ravel()
    ranked = sorted(
        zip(candidates, sims, strict=True),
        key=lambda t: ("*" in t[0].sectors, -float(t[1]), t[0].id),
    )
    specific = [(e, float(s)) for e, s in ranked if "*" not in e.sectors][: max(k - 2, 1)]
    generic = [(e, float(s)) for e, s in ranked if "*" in e.sectors]
    return (specific + generic)[:k]
