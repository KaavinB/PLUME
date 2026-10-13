"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSearch, Map as MapIcon, Play, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";

import { DetectionTimeline, PriorityBars } from "@/components/charts";
import { Badge, Button, Empty, ErrorBox, ExtLink, KV, LinkButton, PageHeader, PageSkeleton, Panel, StatusChip, cx } from "@/components/ui";
import { apiGet, apiPost, apiUrl } from "@/lib/api";
import { fmtCoord, fmtDate, fmtEth, fmtNum, INSTRUMENTS, sectorName } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { IncidentDetail, InvestigationOut } from "@/lib/types";
import { STATIC_SNAPSHOT } from "@/lib/snapshot";

export function IncidentView({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useSession();
  const q = useQuery({ queryKey: ["incident", code.toUpperCase()], queryFn: () => apiGet<IncidentDetail>(`/incidents/${code}`) });
  const [picked, setPicked] = useState<string | null>(null);
  const investigate = useMutation({
    mutationFn: () => apiPost<InvestigationOut>(`/incidents/${code}/investigate`),
    onSuccess: (inv) => {
      void qc.invalidateQueries({ queryKey: ["incident"] });
      router.push(`/investigations/${inv.id}`);
    },
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} title="Incident unavailable" /></div>;
  const inc = q.data;
  const obs = [...inc.observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  const preview = obs.find((o) => o.display_id === picked) ?? obs.find((o) => o.emission_rate_kg_h !== null && o.footprint_bounds) ?? obs[0];
  const ctx = inc.provider_source_context;
  const canInvestigate = user && user.role !== "observer";
  const latestInv = inc.investigations[0];

  return (
    <div>
      <PageHeader
        eyebrow={
          <>
            <Badge tone="amber">Historical data</Badge>
            <Badge>{sectorName(inc.sector)}{inc.sector ? ` · ${inc.sector}` : ""}</Badge>
            <StatusChip status={inc.status} />
          </>
        }
        title={<span className="mono">{inc.code}</span>}
        actions={
          <>
            <LinkButton href={`/?incident=${inc.code}`} icon={<MapIcon className="size-4" />}>View on map</LinkButton>
            {latestInv && <LinkButton href={`/investigations/${latestInv.id}`} icon={<FileSearch className="size-4" />}>Latest report</LinkButton>}
            {user?.role === "sponsor" && latestInv && (
              <LinkButton href={`/projects/new?incident=${inc.code}`} icon={<Plus className="size-4" />}>Create repair project</LinkButton>
            )}
            {!STATIC_SNAPSHOT && <Button
              variant="primary"
              onClick={() => investigate.mutate()}
              loading={investigate.isPending}
              disabled={!canInvestigate}
              title={canInvestigate ? undefined : "Select a non-observer persona to run an investigation"}
              icon={<Play className="size-4" />}
              data-testid="run-investigation"
            >
              {latestInv ? "Re-run investigation" : "Run investigation"}
            </Button>}
          </>
        }
      >
        Candidate emission source at {fmtCoord(inc.latitude, inc.longitude)} — {inc.observation_count} plume detection(s) on {inc.detection_date_count} date(s),{" "}
        {fmtDate(inc.first_observed_at)} → {fmtDate(inc.last_observed_at)}.
        {STATIC_SNAPSHOT ? <span className="text-ink-3"> Read-only snapshot: investigations run in the live app.</span> : !canInvestigate && <span className="text-ink-3"> Choose a persona (top right) to run an investigation.</span>}
      </PageHeader>
      {investigate.error && <div className="px-6 pt-4"><ErrorBox error={investigate.error} title="Investigation failed" /></div>}

      <div className="grid gap-4 p-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Detections over time" subtitle="Provider-reported instantaneous emission estimates">
            <DetectionTimeline observations={inc.observations} selected={preview?.display_id} onSelect={setPicked} />
          </Panel>

          <Panel title={`Observations (${inc.observation_count})`} subtitle="Every row links to the original Carbon Mapper record. Raw payloads are stored with SHA-256 digests.">
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface text-ink-3">
                  <tr className="border-b border-line">
                    <th className="py-2 pr-3 font-medium">Plume id</th>
                    <th className="py-2 pr-3 font-medium">Observed (UTC)</th>
                    <th className="py-2 pr-3 font-medium">Instrument</th>
                    <th className="py-2 pr-3 text-right font-medium">Rate ± 1σ (kg/h)</th>
                    <th className="py-2 pr-3 font-medium">Flags</th>
                    <th className="py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {obs.map((o) => (
                    <tr key={o.id} onClick={() => setPicked(o.display_id)} className={cx("cursor-pointer border-b border-line/60 hover:bg-surface-2", preview?.display_id === o.display_id && "bg-surface-2")}>
                      <td className="mono py-1.5 pr-3 text-ink">{o.display_id}</td>
                      <td className="num py-1.5 pr-3 text-ink-2">{fmtDate(o.observed_at, true)}</td>
                      <td className="py-1.5 pr-3 text-ink-2">{INSTRUMENTS[o.instrument ?? ""] ?? o.instrument}</td>
                      <td className="num py-1.5 pr-3 text-right text-ink">
                        {o.emission_rate_kg_h !== null ? `${fmtNum(o.emission_rate_kg_h)} ± ${fmtNum(o.emission_uncertainty_kg_h)}` : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="py-1.5 pr-3">
                        {o.validation_flags.filter((f) => f !== "quality_not_assessed_by_provider").map((f) => (
                          <Badge key={f} tone="amber" className="mr-1">{f.replaceAll("_", " ")}</Badge>
                        ))}
                      </td>
                      <td className="py-1.5"><ExtLink href={o.source_url}>record</ExtLink></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          {preview && (
            <Panel title="Provider plume raster" subtitle={<span className="mono">{preview.display_id}</span>}>
              {preview.footprint_bounds ? (
                <div className="overflow-hidden rounded-md border border-line bg-[#05070a]">
                  <PlumeRaster key={preview.display_id} id={preview.display_id} />
                </div>
              ) : (
                <p className="text-xs text-ink-3">No raster footprint reported.</p>
              )}
              <p className="mt-2 text-[11px] leading-snug text-ink-3">
                Carbon Mapper&apos;s methane enhancement visualisation for this detection. Colour shows column enhancement, not emission rate. The raster is
                fetched from the provider on demand and cached.
              </p>
            </Panel>
          )}

          <Panel title="Investigation priority" subtitle={inc.priority_breakdown.interpretation} actions={<span className="num text-2xl font-semibold text-teal">{fmtNum(inc.priority_score, 1)}</span>}>
            <PriorityBars factors={inc.priority_breakdown.factors} />
            <p className="mt-3 text-[11px] text-ink-3">Scoring {inc.priority_breakdown.version}; reference time {fmtDate(inc.priority_breakdown.reference_time)} (dataset end), so scores reproduce.</p>
          </Panel>

          <Panel title="Source grouping" subtitle="PLUME's grouping compared with the provider's own">
            <div className="divide-y divide-line">
              <KV k="PLUME method" v={`DBSCAN · ${inc.grouping_params.eps_m} m · per sector`} />
              <KV k="RMS spread" v={`${fmtNum(inc.spatial_spread_m)} m`} />
              <KV k="Provider groupings" v={Object.keys(ctx.sources).length || "none"} />
            </div>
            {Object.values(ctx.sources).map((s) => (
              <div key={s.source_name} className="mt-3 rounded-md border border-line p-2.5 text-xs">
                <div className="mono text-[11px] break-all text-ink-2">{s.source_name}</div>
                <div className="mt-1 text-ink-2">
                  {s.plume_count} plumes · detected on {s.detection_date_count} of {s.observation_date_count} overpass dates ({fmtNum(s.persistence * 100)}%)
                </div>
                <div className="text-ink-3">{s.timestamp_min} → {s.timestamp_max}</div>
              </div>
            ))}
            <p className="mt-3 text-[11px] text-ink-3">Proximity is not proof of a shared source. Neither grouping identifies a facility or operator.</p>
          </Panel>

          <Panel title="Investigations">
            {inc.investigations.length === 0 ? (
              <p className="text-xs text-ink-3">Not yet investigated.</p>
            ) : (
              <ul className="space-y-1.5">
                {inc.investigations.map((i) => (
                  <li key={i.id}>
                    <Link href={`/investigations/${i.id}`} className="flex items-center justify-between rounded-md border border-line px-2.5 py-2 text-xs hover:bg-surface-2">
                      <span className="text-ink">{fmtDate(i.created_at, true)}</span>
                      <span className="flex items-center gap-2">
                        <Badge tone={i.report_kind === "llm" ? "teal" : "neutral"}>{i.report_kind === "llm" ? "LLM narrative" : "Template narrative"}</Badge>
                        <span className="num text-ink-3">{i.latency_ms} ms</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Repair projects">
            {inc.repair_projects.length === 0 ? (
              <Empty title="No repair project yet">
                {latestInv ? "A sponsor can create a simulated repair bounty from the investigation." : "Run an investigation first."}
              </Empty>
            ) : (
              <ul className="space-y-1.5">
                {inc.repair_projects.map((p) => (
                  <li key={p.id}>
                    <Link href={`/projects/${p.code}`} className="flex items-center justify-between rounded-md border border-line px-2.5 py-2 text-xs hover:bg-surface-2">
                      <span className="mono text-ink">{p.code}</span>
                      <span className="flex items-center gap-2">
                        <span className="num text-ink-3">{fmtEth(p.funding_amount_wei)}</span>
                        <StatusChip status={p.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function PlumeRaster({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p className="p-3 text-center text-xs text-ink-3">
        {STATIC_SNAPSHOT ? "Raster not included in this static snapshot (only locally cached images are)." : "Raster unavailable (offline or provider error)."}
      </p>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={apiUrl(`/observations/${id}/plume.png`)} alt={`Carbon Mapper methane enhancement image for ${id}`} className="mx-auto max-h-56 object-contain" onError={() => setFailed(true)} />
  );
}
