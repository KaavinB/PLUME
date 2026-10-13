"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Crosshair, ExternalLink, Info, Layers, Search, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { PriorityBars, RateLegend } from "@/components/charts";
import { MissionMap, type Basemap } from "@/components/mission-map";
import { Badge, Button, cx, ErrorBox, Hint, KV, Label, Skeleton } from "@/components/ui";
import { apiGet, apiUrl } from "@/lib/api";
import { fmtCoord, fmtDate, fmtNum, INSTRUMENTS, sectorName } from "@/lib/format";
import { useMeta, useSession } from "@/lib/session";
import { useStoredValue } from "@/lib/storage";
import type { IncidentDetail, IncidentSummary, ObsGeoJSON, Observation } from "@/lib/types";
import { STATIC_SNAPSHOT } from "@/lib/snapshot";

const ALL_INSTRUMENTS = ["GAO", "ang", "av3", "emi", "tan"];
const ALL_SECTORS = ["1B2", "6A", "4B", "1B1a", "none"];
const RATE_OPTIONS = [0, 100, 250, 500, 1000, 2500];

export function MissionControl() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: meta } = useMeta();
  const { user } = useSession();

  const [basemap, setBasemap] = useState<Basemap>("dark");
  const [showObs, setShowObs] = useState(true);
  const [showPlume, setShowPlume] = useState(true);
  const [cluster, setCluster] = useState(true);
  const [from, setFrom] = useState("2019-01-01");
  const [to, setTo] = useState("2026-12-31");
  const [minRate, setMinRate] = useState(0);
  const [includeNoRate, setIncludeNoRate] = useState(true);
  const [instruments, setInstruments] = useState<string[]>(ALL_INSTRUMENTS);
  const [sectors, setSectors] = useState<string[]>(ALL_SECTORS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<{ lon: number; lat: number; zoom?: number; key: number } | null>(null);
  const [view, setView] = useState<[number, number, number, number] | null>(null);
  // Server snapshot "dismissed" avoids flashing the intro before hydration.
  const [introState, setIntroState] = useStoredValue("plume.intro", "dismissed");
  const introDismissed = introState === "dismissed";

  const obsQ = useQuery({ queryKey: ["observations"], queryFn: () => apiGet<ObsGeoJSON>("/observations"), staleTime: 300_000 });
  const topQ = useQuery({
    queryKey: ["incidents", "top"],
    queryFn: () => apiGet<{ total: number; items: IncidentSummary[] }>("/incidents?sort=priority&limit=8"),
  });

  const selectedObsId = params.get("obs");
  const incidentParam = params.get("incident");

  // Resolve ?incident=CODE → its most recent observation
  const selectedIncidentCode = useMemo(() => {
    if (incidentParam) return incidentParam.toUpperCase();
    if (!selectedObsId || !obsQ.data) return null;
    return obsQ.data.features.find((f) => f.properties.id === selectedObsId)?.properties.incident ?? null;
  }, [incidentParam, selectedObsId, obsQ.data]);

  const incidentQ = useQuery({
    queryKey: ["incident", selectedIncidentCode],
    queryFn: () => apiGet<IncidentDetail>(`/incidents/${selectedIncidentCode}`),
    enabled: !!selectedIncidentCode,
  });

  const selectedObs: Observation | null = useMemo(() => {
    const obs = incidentQ.data?.observations ?? [];
    if (!obs.length) return null;
    const recent = [...obs].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    return (
      obs.find((o) => o.display_id === selectedObsId) ??
      recent.find((o) => o.emission_rate_kg_h !== null && o.footprint_bounds) ??
      recent[0]
    );
  }, [incidentQ.data, selectedObsId]);


  const filtered: ObsGeoJSON | undefined = useMemo(() => {
    if (!obsQ.data) return undefined;
    const fromTs = Date.parse(from) / 1000;
    const toTs = Date.parse(to) / 1000 + 86400;
    return {
      type: "FeatureCollection",
      features: obsQ.data.features.filter((f) => {
        const p = f.properties;
        if (p.ts < fromTs || p.ts > toTs) return false;
        if (p.rate === null ? !includeNoRate || minRate > 0 : p.rate < minRate) return false;
        if (!instruments.includes(p.inst ?? "")) return false;
        if (!sectors.includes(p.sector)) return false;
        return true;
      }),
    };
  }, [obsQ.data, from, to, minRate, includeNoRate, instruments, sectors]);

  const inView = useMemo(() => {
    if (!filtered || !view) return null;
    const [w, s, e, n] = view;
    const feats = filtered.features.filter((f) => {
      const [x, y] = f.geometry.coordinates;
      return x >= w && x <= e && y >= s && y <= n;
    });
    return { obs: feats.length, incidents: new Set(feats.map((f) => f.properties.incident)).size };
  }, [filtered, view]);

  const select = useCallback(
    (obsId: string) => {
      const sp = new URLSearchParams();
      sp.set("obs", obsId);
      router.replace(`/?${sp.toString()}`, { scroll: false });
    },
    [router],
  );

  const clear = () => router.replace("/", { scroll: false });

  const runSearch = async () => {
    const q = search.trim();
    setSearchMsg(null);
    if (!q) return;
    if (/^inc-/i.test(q)) {
      router.replace(`/?incident=${q.toUpperCase()}`);
      return;
    }
    const hit = obsQ.data?.features.find((f) => f.properties.id.toLowerCase() === q.toLowerCase());
    if (hit) {
      router.replace(`/?obs=${hit.properties.id}`);
      return;
    }
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        setFlyTo({ lon, lat, zoom: 11, key: Date.now() });
        return;
      }
    }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { Accept: "application/json" },
      });
      const j = (await r.json()) as { lat: string; lon: string; display_name: string }[];
      if (j[0]) {
        setFlyTo({ lon: Number(j[0].lon), lat: Number(j[0].lat), zoom: 10, key: Date.now() });
        setSearchMsg(`→ ${j[0].display_name.split(",").slice(0, 3).join(",")} (OpenStreetMap Nominatim)`);
      } else setSearchMsg("No match. Try an incident code (INC-…), a plume id, “lat, lon”, or a place name.");
    } catch {
      setSearchMsg("Place search unavailable offline. Use an incident code, plume id or “lat, lon”.");
    }
  };

  const plume =
    selectedObs && selectedObs.footprint_bounds
      ? { url: apiUrl(`/observations/${selectedObs.display_id}/plume.png`), bounds: selectedObs.footprint_bounds }
      : null;

  const toggle = (arr: string[], v: string, set: (a: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <MissionMap
        data={filtered}
        basemap={basemap}
        showObservations={showObs}
        showPlume={showPlume}
        cluster={cluster}
        selectedIncident={selectedIncidentCode}
        selectedObservation={selectedObs?.display_id ?? null}
        plume={plume}
        flyTo={flyTo}
        focus={selectedObs ? { id: selectedObs.display_id, lon: selectedObs.longitude, lat: selectedObs.latitude } : null}
        onSelect={select}
        onViewChange={setView}
      />

      {/* ---------------- Left column: search, filters, priority list */}
      <div className="pointer-events-none absolute top-3 bottom-3 left-3 flex w-[318px] flex-col gap-2.5">
        <div className="pointer-events-auto rounded-lg border border-line bg-surface/95 p-2 shadow-xl backdrop-blur">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
            className="flex items-center gap-2"
          >
            <Search className="ml-1 size-4 text-ink-3" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Incident, plume id, lat,lon or place"
              aria-label="Search the map"
              data-testid="map-search"
              className="h-8 min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
            />
            <Button size="sm" type="submit" variant="ghost">
              Go
            </Button>
          </form>
          {searchMsg && <div className="px-1 pt-1 text-[11px] text-ink-3">{searchMsg}</div>}
        </div>

        <div className="pointer-events-auto rounded-lg border border-line bg-surface/95 shadow-xl backdrop-blur">
          <button type="button" onClick={() => setFiltersOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2.5" aria-expanded={filtersOpen}>
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <SlidersHorizontal className="size-4 text-ink-3" aria-hidden /> Filters & layers
            </span>
            <span className="num text-xs text-ink-3">
              {filtered ? `${fmtNum(filtered.features.length)} / ${fmtNum(obsQ.data?.features.length)}` : "…"}
            </span>
          </button>
          {filtersOpen && (
            <div className="space-y-3 border-t border-line px-3 pt-3 pb-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <Label>From</Label>
                  <input type="date" value={from} min="2019-01-01" onChange={(e) => setFrom(e.target.value)} className="h-7 w-full rounded border border-line-strong bg-surface-2 px-1.5 text-ink [color-scheme:dark]" />
                </label>
                <label className="space-y-1">
                  <Label>To</Label>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-7 w-full rounded border border-line-strong bg-surface-2 px-1.5 text-ink [color-scheme:dark]" />
                </label>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Label>Minimum reported rate</Label>
                  <Hint>Provider-reported instantaneous emission estimate (kg CH₄/h) at overpass time.</Hint>
                </div>
                <div className="flex flex-wrap gap-1">
                  {RATE_OPTIONS.map((r) => (
                    <button key={r} type="button" onClick={() => setMinRate(r)} className={cx("num h-6 rounded border px-2", minRate === r ? "border-amber text-amber" : "border-line-strong text-ink-2 hover:text-ink")}>
                      {r === 0 ? "Any" : `≥${fmtNum(r)}`}
                    </button>
                  ))}
                </div>
                <label className="mt-1 flex items-center gap-2 text-ink-2">
                  <input type="checkbox" checked={includeNoRate} onChange={(e) => setIncludeNoRate(e.target.checked)} className="accent-[var(--amber)]" />
                  Include detections without an estimate
                </label>
              </div>
              <div className="space-y-1">
                <Label>Instrument</Label>
                <div className="flex flex-wrap gap-1">
                  {ALL_INSTRUMENTS.map((i) => (
                    <button key={i} type="button" onClick={() => toggle(instruments, i, setInstruments)} aria-pressed={instruments.includes(i)} className={cx("h-6 rounded border px-2", instruments.includes(i) ? "border-teal/60 text-ink" : "border-line text-ink-3 line-through")}>
                      {INSTRUMENTS[i].split(" · ")[0]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <Label>Provider sector</Label>
                <div className="flex flex-wrap gap-1">
                  {ALL_SECTORS.map((s) => (
                    <button key={s} type="button" onClick={() => toggle(sectors, s, setSectors)} aria-pressed={sectors.includes(s)} className={cx("h-6 rounded border px-2", sectors.includes(s) ? "border-teal/60 text-ink" : "border-line text-ink-3 line-through")}>
                      {sectorName(s)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5 border-t border-line pt-3">
                <div className="flex items-center gap-1.5">
                  <Layers className="size-3.5 text-ink-3" aria-hidden />
                  <Label>Layers</Label>
                </div>
                <div className="grid grid-cols-2 gap-1 text-ink-2">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showObs} onChange={(e) => setShowObs(e.target.checked)} className="accent-[var(--amber)]" />Observations</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={cluster} onChange={(e) => setCluster(e.target.checked)} className="accent-[var(--amber)]" />Cluster</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={showPlume} onChange={(e) => setShowPlume(e.target.checked)} className="accent-[var(--amber)]" />Plume raster</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={basemap === "satellite"} onChange={(e) => setBasemap(e.target.checked ? "satellite" : "dark")} className="accent-[var(--amber)]" />Satellite</label>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="pointer-events-auto flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-surface/95 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between px-3 pt-2.5 pb-2">
            <span className="text-[13px] font-medium">Highest investigation priority</span>
            <Link href="/incidents" className="text-xs text-ink-3 hover:text-ink">All {topQ.data ? fmtNum(topQ.data.total) : ""}</Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {topQ.isPending && <div className="space-y-1.5 p-1.5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>}
            {topQ.error && <div className="p-2"><ErrorBox error={topQ.error} title="Could not load incidents" /></div>}
            {topQ.data?.items.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => router.replace(`/?incident=${i.code}`)}
                className={cx("flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-surface-2", selectedIncidentCode === i.code && "bg-surface-2")}
              >
                <span className="num w-9 shrink-0 rounded bg-surface-3 py-1 text-center text-xs font-semibold text-teal">{fmtNum(i.priority_score)}</span>
                <span className="min-w-0 flex-1">
                  <span className="mono block text-xs text-ink">{i.code}</span>
                  <span className="block truncate text-[11px] text-ink-3">
                    {i.detection_date_count} dates · median {fmtNum(i.median_rate_kg_h)} kg/h · {sectorName(i.sector)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-line px-3 py-2 text-[11px] text-ink-3">
            {inView ? `${fmtNum(inView.obs)} observations · ${fmtNum(inView.incidents)} incidents in view` : "—"}
          </div>
        </div>
      </div>

      {/* ---------------- Legend & provenance (bottom center) */}
      <div className="pointer-events-auto absolute bottom-3 left-[342px] w-[300px] rounded-lg border border-line bg-surface/95 p-3 shadow-xl backdrop-blur">
        <div className="mb-1.5 flex items-center justify-between">
          <Label>Reported emission rate (kg/h)</Label>
          <Hint>
            Marker size is fixed and does not represent plume extent. Grey markers: provider withheld or did not estimate a rate. The plume raster
            appears for the selected observation, georeferenced to the provider&apos;s image bounds.
          </Hint>
        </div>
        <RateLegend />
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-3">
          <span className="inline-block size-2 rounded-full bg-[#5f6670]" aria-hidden /> no estimate
          <span className="ml-2 inline-block size-2.5 rounded-full border-2 border-ink" aria-hidden /> selected
          <span className="ml-2 inline-block size-2.5 rounded-full border-[1.5px] border-teal" aria-hidden /> same incident
        </div>
        <div className="mt-2 border-t border-line pt-2 text-[11px] leading-snug text-ink-3">
          {meta ? (
            <>
              {fmtNum(meta.data.observation_count)} historical CH₄ plume detections, {fmtDate(meta.data.observed_from)} → {fmtDate(meta.data.observed_to)} ·{" "}
              {meta.data.attribution}
            </>
          ) : (
            "Loading provenance…"
          )}
        </div>
      </div>

      {obsQ.error && (
        <div className="absolute top-3 left-1/2 w-[420px] -translate-x-1/2">
          <ErrorBox error={obsQ.error} title="Could not load observations — is the API running?" />
        </div>
      )}

      {/* ---------------- Intro card */}
      {!introDismissed && !selectedIncidentCode && (
        <div className="pointer-events-auto absolute top-3 left-1/2 w-[520px] -translate-x-1/2 rounded-lg border border-line-strong bg-surface/95 p-5 shadow-2xl backdrop-blur" data-testid="intro">
          <button
            type="button"
            className="absolute top-3 right-3 text-ink-3 hover:text-ink"
            aria-label="Dismiss introduction"
            onClick={() => setIntroState("dismissed")}
          >
            <X className="size-4" />
          </button>
          <div className="text-xs tracking-wider text-amber uppercase">The planet has bugs. Let&apos;s fix them.</div>
          <h1 className="mt-1.5 text-lg font-semibold tracking-tight">Every dot is a real methane plume. Detection is not the same as repair.</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            Satellites and aircraft already find large methane leaks. PLUME is the workflow that comes next: investigate the incident, fund an
            authorized repair in escrow, verify the evidence independently, and release payment only on a signed decision — with a public,
            inspectable receipt.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
            <div className="rounded border border-line p-2"><span className="text-amber">Real</span> · historical Carbon Mapper observations</div>
            <div className="rounded border border-line p-2"><span className="text-sim">Simulated</span> · repair work, evidence and funding</div>
            <div className="rounded border border-line p-2"><span className="text-teal">Executed</span> · investigation code and escrow contract</div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => router.replace(`/?incident=${meta?.featured_incidents[0]?.code ?? "INC-32893D"}`)} icon={<Crosshair className="size-4" />}>
              Show the demo incident
            </Button>
            <Link href="/about" className="inline-flex h-9 items-center px-3 text-sm text-ink-2 hover:text-ink">How it works</Link>
          </div>
        </div>
      )}

      {/* ---------------- Incident drawer */}
      {selectedIncidentCode && (
        <aside className="pointer-events-auto absolute top-3 right-3 bottom-3 flex w-[400px] flex-col overflow-hidden rounded-lg border border-line bg-surface/97 shadow-2xl backdrop-blur" data-testid="incident-drawer" aria-label="Selected observation">
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge tone="amber">Historical observation</Badge>
                {incidentQ.data && <Badge>{incidentQ.data.observation_count > 1 ? `1 of ${incidentQ.data.observation_count} in incident` : "Single detection"}</Badge>}
              </div>
              <div className="mono mt-2 truncate text-sm text-ink" data-testid="selected-observation-id">{selectedObs?.display_id ?? "…"}</div>
              <div className="mt-0.5 text-xs text-ink-3">{selectedObs ? fmtCoord(selectedObs.latitude, selectedObs.longitude) : ""}</div>
            </div>
            <button type="button" onClick={clear} aria-label="Close" className="text-ink-3 hover:text-ink"><X className="size-4" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {incidentQ.isPending && <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-32" /><Skeleton className="h-40" /></div>}
            {incidentQ.error && <ErrorBox error={incidentQ.error} />}
            {selectedObs && incidentQ.data && (
              <ObservationDetail obs={selectedObs} incident={incidentQ.data} onPick={(id) => router.replace(`/?obs=${id}`)} />
            )}
          </div>
          {incidentQ.data && (
            <div className="space-y-2 border-t border-line p-3">
              <div className="flex gap-2">
                <Link href={`/incidents/${incidentQ.data.code}`} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-amber text-sm font-medium text-[#1a1206] hover:bg-[#f6b75a]" data-testid="investigate-cta">
                  Investigate incident <ArrowRight className="size-4" />
                </Link>
              </div>
              {!user && <p className="text-center text-[11px] text-ink-3">{STATIC_SNAPSHOT ? "Read-only snapshot: investigations and repair projects run in the live app." : "Choose a persona (top right) to run investigations or create projects."}</p>}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

function ObservationDetail({ obs, incident, onPick }: { obs: Observation; incident: IncidentDetail; onPick: (id: string) => void }) {
  const flags = obs.validation_flags.filter((f) => f !== "quality_not_assessed_by_provider");
  const primary = incident.provider_source_context.primary;
  const src = primary ? incident.provider_source_context.sources[primary] : null;
  return (
    <div className="space-y-4">
      <div>
        <Label>Reported by provider</Label>
        <div className="mt-1 divide-y divide-line">
          <KV k="Observed" v={fmtDate(obs.observed_at, true)} />
          <KV k="Instrument" v={`${INSTRUMENTS[obs.instrument ?? ""] ?? obs.instrument}${obs.platform ? ` (${obs.platform})` : ""}`} />
          <KV
            k="Emission rate"
            v={
              obs.emission_rate_kg_h === null ? (
                <span className="text-ink-3">Unavailable{obs.validation_flags.includes("emission_hidden_by_provider") ? " · withheld by provider" : ""}</span>
              ) : (
                <span className="num font-medium text-amber">{fmtNum(obs.emission_rate_kg_h)} <span className="text-ink-2">± {fmtNum(obs.emission_uncertainty_kg_h)} kg/h</span></span>
              )
            }
          />
          <KV k="Provider sector" v={`${obs.sector_label}${obs.sector ? ` (${obs.sector})` : ""}`} />
          <KV k="Quality flag" v={obs.quality ?? <span className="text-ink-3">Not assessed by provider</span>} />
          <KV k="Wind (provider model)" v={obs.wind_speed_m_s !== null ? `${fmtNum(obs.wind_speed_m_s, 1)} m/s` : "—"} />
          <KV k="Source" v={<a href={obs.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">Carbon Mapper record <ExternalLink className="size-3" /></a>} />
        </div>
        {flags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {flags.map((f) => <Badge key={f} tone="amber">{f.replaceAll("_", " ")}</Badge>)}
          </div>
        )}
      </div>

      <div className="rounded-md border border-line bg-surface-2 p-3 text-xs leading-relaxed">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium text-ink"><Info className="size-3.5 text-teal" /> Known vs inferred</div>
        <p className="text-ink-2"><span className="text-ink">Known:</span> a CH₄ plume was detected at this origin on {fmtDate(obs.observed_at)}{obs.emission_rate_kg_h !== null ? ` with an instantaneous estimate of ${fmtNum(obs.emission_rate_kg_h)} kg/h` : ""}.</p>
        <p className="mt-1 text-ink-2">
          <span className="text-ink">Inferred:</span>{" "}
          {incident.detection_date_count > 1
            ? `PLUME groups ${incident.observation_count} detections within ${incident.grouping_params.eps_m} m on ${incident.detection_date_count} dates as one candidate source (a proximity hypothesis).`
            : "nothing about persistence — this location has a single detection date."}
        </p>
        <p className="mt-1 text-ink-3">Not known: the operator, facility or emitting component. Remote sensing cannot identify them.</p>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Incident {incident.code}</Label>
          <span className="num text-xs text-ink-3">priority <span className="font-semibold text-teal">{fmtNum(incident.priority_score, 1)}</span>/100</span>
        </div>
        <div className="mt-1 divide-y divide-line">
          <KV k="Detections" v={`${incident.observation_count} on ${incident.detection_date_count} date(s)`} />
          <KV k="Window" v={`${fmtDate(incident.first_observed_at)} → ${fmtDate(incident.last_observed_at)}`} />
          <KV k="Median / max estimate" v={`${fmtNum(incident.median_rate_kg_h)} / ${fmtNum(incident.max_rate_kg_h)} kg/h`} />
          {src && <KV k="Provider persistence" v={`${src.detection_date_count}/${src.observation_date_count} overpass dates (${fmtNum(src.persistence * 100)}%)`} />}
        </div>
        <div className="mt-3"><PriorityBars factors={incident.priority_breakdown.factors} compact /></div>
      </div>

      {incident.observations.length > 1 && (
        <div>
          <Label>Detections in this incident</Label>
          <div className="mt-1 max-h-48 overflow-y-auto rounded border border-line">
            {[...incident.observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at)).map((o) => (
              <button key={o.id} type="button" onClick={() => onPick(o.display_id)} className={cx("flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-2", o.display_id === obs.display_id && "bg-surface-3")}>
                <span className="mono truncate text-ink-2">{o.display_id}</span>
                <span className="num shrink-0 text-ink">{o.emission_rate_kg_h !== null ? `${fmtNum(o.emission_rate_kg_h)} kg/h` : "—"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
