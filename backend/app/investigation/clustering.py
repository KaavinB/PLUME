"""Spatial grouping of plume observations into candidate emission sources ("incidents").

Method: DBSCAN with the haversine metric on plume origin coordinates, run separately per
reported sector so that, e.g., a landfill plume is never merged with a nearby well pad plume.
`min_samples=1` means every observation belongs to exactly one group; a singleton group is a
single-observation incident and is never described as persistent.

Proximity is a necessary but not sufficient condition for a shared source. The output is a
*candidate* grouping and is compared against Carbon Mapper's own DBSCAN source grouping.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from sklearn.cluster import DBSCAN
from sklearn.metrics import adjusted_rand_score

EARTH_RADIUS_M = 6_371_008.8
GROUPING_METHOD = "dbscan-haversine-per-sector"


@dataclass(frozen=True)
class PointRecord:
    key: str  # observation identifier
    longitude: float
    latitude: float
    sector: str | None
    provider_group: str | None = None  # provider's own source grouping, if any


@dataclass(frozen=True)
class ClusterParams:
    eps_m: float = 200.0
    min_samples: int = 1

    def as_dict(self) -> dict[str, float | int | str]:
        return {"eps_m": self.eps_m, "min_samples": self.min_samples, "metric": "haversine"}


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def cluster_points(points: Sequence[PointRecord], params: ClusterParams) -> list[list[PointRecord]]:
    """Return groups of points. Deterministic: groups ordered by their smallest member key."""
    by_sector: dict[str, list[PointRecord]] = defaultdict(list)
    for p in points:
        by_sector[p.sector or "_unassigned"].append(p)

    groups: list[list[PointRecord]] = []
    for sector_key in sorted(by_sector):
        members = sorted(by_sector[sector_key], key=lambda p: p.key)
        coords = np.radians(np.array([[p.latitude, p.longitude] for p in members], dtype=float))
        if len(members) == 1:
            groups.append(members)
            continue
        labels = DBSCAN(
            eps=params.eps_m / EARTH_RADIUS_M,
            min_samples=params.min_samples,
            metric="haversine",
            algorithm="ball_tree",
        ).fit_predict(coords)
        clusters: dict[int, list[PointRecord]] = defaultdict(list)
        noise: list[list[PointRecord]] = []
        for label, p in zip(labels, members, strict=True):
            if label < 0:  # only possible when min_samples > 1: keep noise points as singletons
                noise.append([p])
            else:
                clusters[int(label)].append(p)
        groups.extend(clusters.values())
        groups.extend(noise)
    groups.sort(key=lambda g: min(p.key for p in g))
    return groups


def centroid(group: Sequence[PointRecord]) -> tuple[float, float]:
    """Mean of unit vectors — safe for small groups anywhere on the globe."""
    x = y = z = 0.0
    for p in group:
        la, lo = math.radians(p.latitude), math.radians(p.longitude)
        x += math.cos(la) * math.cos(lo)
        y += math.cos(la) * math.sin(lo)
        z += math.sin(la)
    n = len(group)
    x, y, z = x / n, y / n, z / n
    lon = math.degrees(math.atan2(y, x))
    lat = math.degrees(math.atan2(z, math.hypot(x, y)))
    return lon, lat


def spread_m(group: Sequence[PointRecord]) -> float:
    """Root-mean-square distance of members from the group centroid (metres)."""
    if len(group) < 2:
        return 0.0
    clon, clat = centroid(group)
    d2 = [haversine_m(p.longitude, p.latitude, clon, clat) ** 2 for p in group]
    return math.sqrt(sum(d2) / len(d2))


@dataclass(frozen=True)
class GroupingComparison:
    compared_points: int
    adjusted_rand_index: float | None
    our_groups: int
    provider_groups: int
    exact_group_matches: int


def compare_with_provider(groups: Sequence[Sequence[PointRecord]]) -> GroupingComparison:
    """Agreement between our grouping and the provider's grouping on points the provider grouped."""
    ours: list[int] = []
    theirs: list[str] = []
    our_sets: dict[int, set[str]] = defaultdict(set)
    their_sets: dict[str, set[str]] = defaultdict(set)
    for gi, g in enumerate(groups):
        for p in g:
            if p.provider_group:
                ours.append(gi)
                theirs.append(p.provider_group)
                our_sets[gi].add(p.key)
                their_sets[p.provider_group].add(p.key)
    if not ours:
        return GroupingComparison(0, None, 0, 0, 0)
    ari = float(adjusted_rand_score(theirs, ours)) if len(ours) > 1 else None
    their_frozen = {frozenset(v) for v in their_sets.values()}
    exact = sum(1 for s in our_sets.values() if frozenset(s) in their_frozen)
    return GroupingComparison(len(ours), ari, len(our_sets), len(their_sets), exact)
