# Scientific methodology

PLUME helps people decide where to investigate and makes repair commitments accountable. This document states what each number means, how it was derived and what it cannot support.

## 1. Source data

**Carbon Mapper CH₄ plume catalogue**, retrieved 2026‑10‑12 from `https://api.carbonmapper.org/api/v1/catalog/plumes/annotated`:
- Query: `plume_gas=CH4`, `bbox=-104.5,31.0,-101.0,33.5` (Permian Basin, TX/NM).
- Size: 10,098 plume records, 2019‑09‑22 → 2026‑09‑12.
- Instruments: GAO (5,606), AVIRIS‑NG (1,642), Tanager‑1 (1,365), AVIRIS‑3 (1,232), EMIT (253).
- Provider sectors (IPCC codes): 1B2 oil & gas (10,048), 6A solid waste (3), 4B manure (3), 1B1a coal (1), unassigned (43).

**Carbon Mapper source grouping** (`/catalog/sources.geojson`, same bbox): 3,827 DBSCAN sources with plume ids, detection-date and observed-overpass counts, and a `persistence` ratio.

The fields PLUME uses, and what they mean:

| Field | Meaning |
|---|---|
| `emission_auto`, `emission_uncertainty_auto` (kg/h) | provider's instantaneous emission-rate estimate and its uncertainty at overpass time |
| `geometry_json` (Point) | plume origin |
| `plume_bounds` | bounding box of the plume raster (used only to place the provider's image) |
| `scene_timestamp` | observation time |
| `hide_emission` | provider withheld the rate |
| `plume_quality` | quality flag (null for every record in this extract) |

## 2. Normalisation and units

- Only `gas == CH4` and `status == published` records are kept. Records with missing or invalid ids, timestamps or point geometry, or with out-of-range coordinates, are rejected with a recorded reason.
- Rates stay in **kg CH₄/h** exactly as reported. If the provider hides a rate, or the rate is non-positive or non-finite, PLUME stores it as *unavailable* and never estimates a replacement.
- **PLUME never derives an emission rate from concentration enhancement (ppm·m) imagery.**
- Uncertainty is kept as reported. Negative values are discarded with a flag. Uncertainty larger than the estimate itself is flagged.
- De-duplication: by (provider, external id), and by (instrument, timestamp, origin rounded to 1e‑4°) to catch re-issued records.
- Every raw payload is stored without its expiring signed URLs, along with its SHA‑256.

## 3. Geospatial grouping

- DBSCAN with the haversine metric on plume origins, ε = 200 m, `min_samples = 1`, run separately for each provider sector, so a landfill plume never merges with a nearby well pad.
- Each group is an **incident**: a *candidate* shared source. Its centroid is the spherical mean of the members, and its spread is the RMS distance from that centroid.
- **Comparison with the provider:** every PLUME group is compared with Carbon Mapper's grouping using the adjusted Rand index. At ε = 200 m the ARI is 0.974, and 3,752 groups are identical to a provider source; the ε sweep is in EVALUATION.md. PLUME keeps the provider's grouping visible next to its own rather than replacing it.
- **Limits:** proximity is not proof of a shared source. Co-located facilities may be merged, and one large facility may be split. Plume-origin accuracy depends on instrument resolution (roughly 5 m for airborne to 60 m for EMIT pixels) and on the retrieval itself.

## 4. Persistence

- A single detection date never implies persistence; the report says so explicitly.
- *Recurrence* counts distinct UTC dates with a detection. Several plumes in one scene count once.
- *Provider persistence* is Carbon Mapper's ratio of detection dates to observed overpass dates. It is the only measure that accounts for overpasses with no detection, and PLUME labels it as provider-reported.

## 5. Investigation priority (`priority-v1`)

Score = Σ wᵢ·vᵢ, where each vᵢ ∈ [0, 1] and the weights sum to 100. A missing factor contributes 0 and is shown as *n/a*, so less evidence means lower priority.

| Factor | w | vᵢ |
|---|---|---|
| Magnitude | 30 | log-scaled median quantified rate between 50 and 5,000 kg/h |
| Recurrence | 20 | 1 date → 0, 2 → 0.5, 3 → 0.7, 4 → 0.85, ≥5 → 1 |
| Provider persistence | 10 | Carbon Mapper persistence ratio |
| Independent instruments | 10 | (distinct instruments − 1) / 2, capped at 1 |
| Recency | 10 | 0.5^(age / 365 d), with age measured from the **dataset end date** so scores reproduce |
| Measurement confidence | 10 | 1 − median relative uncertainty |
| Localisation | 10 | 1 − RMS spread / 150 m (0.5 for a single detection) |

It ranks where field investigation is likely to be useful. It is **not** an estimate of total emissions, climate impact or health risk, and PLUME makes no population-exposure claims.

## 6. Verification

The verifier sees the original observations, the investigation, the repair record, the documents (each with a SHA‑256), the measurements, the policy checks and the impact preview. Possible outcomes: **VERIFIED**, **REJECTED**, **INCONCLUSIVE** and **ADDITIONAL_EVIDENCE_REQUIRED**.

Two methodologies are available:
- **Verified repair completion:** documentation (work order, pre-repair survey, post-repair survey) plus site authorisation. **No quantified reduction is recorded.**
- **Verified quantified reduction:** the above, plus comparable pre/post site measurements by the same method, timed correctly relative to the repair, showing a reduction that exceeds uncertainty, over at least the agreed monitoring period.

The verification policy checks are:
- documentation complete;
- provider is the assigned, approved provider and has supplied a site-authorisation reference;
- verifier is approved and independent;
- timestamps are valid against chain time and the funding time;
- stored evidence matches the on-chain commitment;
- measurements are comparable;
- the reduction exceeds 1σ;
- the monitoring period is long enough.

**Non-detection is never evidence of repair.** Satellite coverage, overpass timing, sunlight, clouds, surface conditions and detection thresholds all mean that an absent plume proves nothing. The workbench shows any post-funding detections as context only.

## 7. Impact calculation (`impact-v1`)

```
Δrate [kg/h]   = pre-repair measured rate − mean(post-repair measured rates)       (same method)
σ_Δ            = √(σ_pre² + (√Σσ_post²/n)²)
duration [h]   = last post-repair measurement − repair completion                  (documented period only)
CH₄ avoided    = Δrate × duration            range: (Δrate ± 1σ_Δ) × duration
CO₂e avoided   = CH₄ avoided × GWP-100
GWP-100        = 29.8 (fossil CH₄; oil & gas, coal, energy) or 27.0 (non-fossil; landfill, wastewater, livestock)
                 IPCC AR6 WG1 Ch.7 Table 7.15 (±11, reported but not propagated)
```

PLUME **refuses** to quantify a reduction, and records the reason, when:
- the pre- or post-repair measurements are missing;
- the methods differ;
- a post-repair measurement predates the repair, or the pre-repair measurement postdates it;
- the repair completion time is missing;
- the reduction is not distinguishable from zero at 1σ.

It never:
- multiplies a satellite instantaneous rate by an assumed duration;
- extrapolates beyond the monitored period;
- sums several plume detections of one source as if they were independent continuous emissions.

## 8. Modelled vs verified

| Category | Example in this prototype | Shown as |
|---|---|---|
| Real observation | 10,098 Carbon Mapper detections | "Historical data" (amber) |
| Computed analysis | grouping, priority, report | "Computed" (teal) |
| Simulated workflow | escrow, evidence, decisions on Anvil | "Simulated" (violet) |
| Modelled reduction from **synthetic** measurements | e.g. 727.3 t CH₄ over 28 documented days in the demo scenario | "From simulated measurements — not a real-world emission reduction" |
| Real-world verified reduction | **none** | "None. PLUME has not coordinated any real repair." |

These categories are never summed together. Impact Receipts are **not carbon credits**, are not tradable, and make no claim about double counting across external registries.

## 9. The simulation scenario

The synthetic pre-repair rate is set to about 0.8× the incident's median satellite estimate. This puts it on the right order of magnitude, but it is **not derived from** the satellite estimate. Post-repair values are about 3–4% of the pre-repair rate. The scenario timeline:
- pre-repair measurement at funding + 12 h;
- repair from funding + 1 day to funding + 2 days;
- post-repair measurements at +7, +14 and +28 days after completion.

Because the local chain's clock can be advanced, every timestamp stays consistent with on-chain funding and expiry. Every synthetic file carries a "SIMULATED" banner.
