"""Carbon Mapper Data Platform API adapter.

Endpoints used (verified against https://api.carbonmapper.org/api/v1/openapi.json):
  GET /catalog/plumes/annotated   — plume list with emission estimates (limit/offset pagination)
  GET /catalog/sources.geojson    — Carbon Mapper's own DBSCAN source grouping
  GET /catalog/plume/{plume_id}   — single plume, used to obtain fresh signed image URLs

Data is provided by Carbon Mapper and must be cited as such (https://carbonmapper.org/terms).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from app.providers.base import NormalizedObservation

log = logging.getLogger(__name__)

PROVIDER = "carbonmapper"
ATTRIBUTION = "Data: Carbon Mapper (carbonmapper.org). Used under the Carbon Mapper Terms of Use."

# Pre-signed asset URLs expire after ~24h, so they are never persisted.
_SIGNED_URL_FIELDS = ("plume_png", "plume_rgb_png", "plume_tif", "con_tif", "rgb_png")


class ProviderError(RuntimeError):
    pass


def plume_source_url(display_id: str) -> str:
    return f"https://api.carbonmapper.org/api/v1/catalog/plume/{display_id}"


def strip_signed_urls(item: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in item.items() if k not in _SIGNED_URL_FIELDS}


class CarbonMapperAdapter:
    name = PROVIDER

    def __init__(
        self,
        base_url: str = "https://api.carbonmapper.org/api/v1",
        token: str | None = None,
        timeout_s: float = 60.0,
        cache_dir: Path | None = None,
        max_retries: int = 4,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.cache_dir = cache_dir
        self.max_retries = max_retries
        headers = {"Accept": "application/json", "User-Agent": "plume-climate/0.1 (+hackathon prototype)"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = client or httpx.Client(timeout=timeout_s, headers=headers)

    # ------------------------------------------------------------------ HTTP
    def _get(self, path: str, params: list[tuple[str, Any]], use_cache: bool = True) -> Any:
        key = hashlib.sha256(json.dumps([path, params], default=str).encode()).hexdigest()[:24]
        cache_file = self.cache_dir / f"cm_{key}.json" if self.cache_dir else None
        if use_cache and cache_file and cache_file.exists():
            return json.loads(cache_file.read_text())

        url = f"{self.base_url}{path}"
        delay = 2.0
        for attempt in range(1, self.max_retries + 1):
            try:
                resp = self._client.get(url, params=params)
            except httpx.TimeoutException as exc:
                log.warning("carbonmapper timeout", extra={"url": url, "attempt": attempt})
                if attempt == self.max_retries:
                    raise ProviderError(f"Carbon Mapper request timed out: {url}") from exc
                time.sleep(delay)
                delay *= 2
                continue
            except httpx.HTTPError as exc:
                raise ProviderError(f"Carbon Mapper request failed: {exc}") from exc

            if resp.status_code == 429 or resp.status_code >= 500:
                retry_after = resp.headers.get("Retry-After")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
                log.warning(
                    "carbonmapper retryable status",
                    extra={"status": resp.status_code, "attempt": attempt, "wait_s": wait},
                )
                if attempt == self.max_retries:
                    raise ProviderError(f"Carbon Mapper returned HTTP {resp.status_code} for {url}")
                time.sleep(wait)
                delay *= 2
                continue
            if resp.status_code >= 400:
                raise ProviderError(f"Carbon Mapper returned HTTP {resp.status_code}: {resp.text[:300]}")
            data = resp.json()
            if cache_file:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(json.dumps(data))
            return data
        raise ProviderError("unreachable")

    # ------------------------------------------------------------- Fetching
    def fetch_observations(
        self,
        bbox: tuple[float, float, float, float],
        gas: str = "CH4",
        datetime_range: str | None = None,
        page_size: int = 1000,
        max_records: int | None = None,
        use_cache: bool = True,
    ) -> list[dict[str, Any]]:
        """Fetch plume records page by page. Returns raw items (signed URLs removed)."""
        items: list[dict[str, Any]] = []
        offset = 0
        total: int | None = None
        while True:
            params: list[tuple[str, Any]] = [("plume_gas", gas), ("limit", page_size), ("offset", offset)]
            params += [("bbox", v) for v in bbox]
            params.append(("sort", "desc"))
            if datetime_range:
                params.append(("datetime", datetime_range))
            page = self._get("/catalog/plumes/annotated", params, use_cache=use_cache)
            batch = page.get("items", [])
            total = page.get("bbox_count", page.get("total_count")) if total is None else total
            items.extend(strip_signed_urls(i) for i in batch)
            offset += len(batch)
            log.info("carbonmapper page", extra={"fetched": len(items), "total": total})
            if not batch or len(batch) < page_size:
                break
            if max_records and len(items) >= max_records:
                items = items[:max_records]
                break
        return items

    def fetch_sources(
        self, bbox: tuple[float, float, float, float], gas: str = "CH4", use_cache: bool = True
    ) -> dict[str, Any]:
        params: list[tuple[str, Any]] = [("plume_gas", gas)] + [("bbox", v) for v in bbox]
        return self._get("/catalog/sources.geojson", params, use_cache=use_cache)

    def fetch_plume(self, display_id: str) -> dict[str, Any]:
        """Fetch a single plume (not cached: the response carries short-lived signed asset URLs)."""
        return self._get(f"/catalog/plume/{display_id}", [], use_cache=False)

    # -------------------------------------------------------- Normalization
    def normalize(self, raw: dict[str, Any]) -> NormalizedObservation | None:
        return normalize_carbonmapper(raw)


def _finite(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_carbonmapper(raw: dict[str, Any]) -> NormalizedObservation | None:
    return normalize_carbonmapper_with_reason(raw)[0]


def normalize_carbonmapper_with_reason(
    raw: dict[str, Any],
) -> tuple[NormalizedObservation | None, str | None]:
    """Normalize one Carbon Mapper plume record. Returns (observation, rejection_reason).

    Exclusion rules (record dropped → returns None):
      * gas is not CH4
      * missing/unparseable id, timestamp or point geometry
      * coordinates outside valid WGS84 ranges
      * provider status other than "published"
    Retained-with-flag rules (record kept, flag recorded):
      * provider hides the emission estimate → rate set to None
      * missing or non-positive emission estimate → rate set to None
      * missing/negative uncertainty → uncertainty set to None
      * uncertainty larger than the estimate itself
      * provider quality "bad" / not assessed
    """
    if str(raw.get("gas", "")).upper() != "CH4":
        return None, "not_methane"
    status = raw.get("status")
    if status is not None and status != "published":
        return None, "not_published"
    external_id = raw.get("id")
    display_id = raw.get("plume_id")
    observed_at = _parse_ts(raw.get("scene_timestamp"))
    geom = raw.get("geometry_json") or {}
    coords = geom.get("coordinates") if isinstance(geom, dict) else None
    if not external_id or not display_id:
        return None, "missing_identifier"
    if observed_at is None:
        return None, "invalid_timestamp"
    if geom.get("type") != "Point" or not isinstance(coords, list | tuple) or len(coords) < 2:
        return None, "missing_point_geometry"
    lon, lat = _finite(coords[0]), _finite(coords[1])
    if lon is None or lat is None or not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
        return None, "invalid_coordinates"

    flags: list[str] = []
    rate = _finite(raw.get("emission_auto"))
    unc = _finite(raw.get("emission_uncertainty_auto"))
    if raw.get("hide_emission"):
        flags.append("emission_hidden_by_provider")
        rate, unc = None, None
    if rate is None or rate <= 0:
        if rate is not None:
            flags.append("non_positive_emission_estimate")
        elif "emission_hidden_by_provider" not in flags:
            flags.append("emission_estimate_unavailable")
        rate, unc = None, None
    if unc is not None and unc < 0:
        flags.append("negative_uncertainty_discarded")
        unc = None
    if rate is not None and unc is None:
        flags.append("uncertainty_unavailable")
    if rate is not None and unc is not None and unc > rate:
        flags.append("uncertainty_exceeds_estimate")

    quality = raw.get("plume_quality")
    if quality is None:
        flags.append("quality_not_assessed_by_provider")
    elif quality == "bad":
        flags.append("provider_quality_bad")

    bounds_raw = raw.get("plume_bounds")
    bounds: tuple[float, float, float, float] | None = None
    if isinstance(bounds_raw, list) and len(bounds_raw) == 4:
        b = [_finite(x) for x in bounds_raw]
        if all(x is not None for x in b):
            minx, miny, maxx, maxy = (float(x) for x in b)  # type: ignore[arg-type]
            if minx < maxx and miny < maxy:
                bounds = (minx, miny, maxx, maxy)

    obs = NormalizedObservation(
        provider=PROVIDER,
        external_id=str(external_id),
        display_id=str(display_id),
        gas="CH4",
        observed_at=observed_at,
        longitude=lon,
        latitude=lat,
        emission_rate_kg_h=rate,
        emission_uncertainty_kg_h=unc,
        instrument=raw.get("instrument"),
        platform=raw.get("platform"),
        sector=raw.get("sector"),
        quality=quality,
        footprint_bounds=bounds,
        wind_speed_m_s=_finite(raw.get("wind_speed_avg_auto")),
        source_url=plume_source_url(str(display_id)),
        scene_id=raw.get("scene_id"),
        raw=strip_signed_urls(raw),
        validation_flags=tuple(flags),
    )
    return obs, None
