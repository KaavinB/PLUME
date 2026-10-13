"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { Badge, Button, ErrorBox, PageHeader, Skeleton, StatusChip, cx } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { fmtDate, fmtNum, sectorName } from "@/lib/format";
import type { IncidentSummary } from "@/lib/types";

const SORTS = [
  ["priority", "Priority"],
  ["recent", "Most recent"],
  ["rate", "Median rate"],
  ["detections", "Detection dates"],
] as const;
const PAGE = 50;

export default function IncidentsPage() {
  const [sort, setSort] = useState<(typeof SORTS)[number][0]>("priority");
  const [sector, setSector] = useState<string>("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const params = new URLSearchParams({ sort, limit: String(PAGE), offset: String(page * PAGE) });
  if (sector) params.set("sector", sector);
  if (q) params.set("q", q);
  const res = useQuery({
    queryKey: ["incidents", params.toString()],
    queryFn: () => apiGet<{ total: number; items: IncidentSummary[] }>(`/incidents?${params}`),
    placeholderData: keepPreviousData,
  });
  const total = res.data?.total ?? 0;

  return (
    <div>
      <PageHeader eyebrow={<Badge tone="amber">Historical data</Badge>} title="Incidents">
        Candidate emission sources formed by grouping nearby plume detections (DBSCAN, 200 m, per provider sector). An incident is a hypothesis about a
        shared source, ranked by an explainable investigation priority.
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(0);
          }}
          placeholder="Filter by code (e.g. INC-32893D)"
          aria-label="Filter incidents by code"
          className="h-8 w-64 rounded-md border border-line-strong bg-surface-2 px-2.5 text-sm placeholder:text-ink-3"
        />
        <select
          value={sector}
          onChange={(e) => {
            setSector(e.target.value);
            setPage(0);
          }}
          aria-label="Sector"
          className="h-8 rounded-md border border-line-strong bg-surface-2 px-2 text-sm"
        >
          <option value="">All sectors</option>
          {["1B2", "6A", "4B", "1B1a"].map((s) => (
            <option key={s} value={s}>{sectorName(s)}</option>
          ))}
        </select>
        <div className="ml-2 flex rounded-md border border-line-strong p-0.5">
          {SORTS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => setSort(k)} className={cx("h-7 rounded px-2.5 text-xs", sort === k ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink")}>
              {label}
            </button>
          ))}
        </div>
        <span className="num ml-auto text-xs text-ink-3">{fmtNum(total)} incidents</span>
      </div>
      <div className="p-6">
        {res.error && <ErrorBox error={res.error} />}
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-medium">Incident</th>
                <th className="px-3 py-2.5 text-right font-medium">Priority</th>
                <th className="px-3 py-2.5 font-medium">Sector (provider)</th>
                <th className="px-3 py-2.5 text-right font-medium">Detections</th>
                <th className="px-3 py-2.5 text-right font-medium">Dates</th>
                <th className="px-3 py-2.5 text-right font-medium">Median kg/h</th>
                <th className="px-3 py-2.5 font-medium">Last detected</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {res.isPending &&
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={8} className="px-4 py-2"><Skeleton className="h-5" /></td>
                  </tr>
                ))}
              {res.data?.items.map((i) => (
                <tr key={i.id} className="border-b border-line/60 hover:bg-surface">
                  <td className="px-4 py-2"><Link href={`/incidents/${i.code}`} className="mono text-ink hover:text-amber">{i.code}</Link></td>
                  <td className="num px-3 py-2 text-right font-semibold text-teal">{fmtNum(i.priority_score, 1)}</td>
                  <td className="px-3 py-2 text-ink-2">{sectorName(i.sector)}</td>
                  <td className="num px-3 py-2 text-right">{i.observation_count}</td>
                  <td className="num px-3 py-2 text-right">{i.detection_date_count}</td>
                  <td className="num px-3 py-2 text-right">{fmtNum(i.median_rate_kg_h)}</td>
                  <td className="num px-3 py-2 text-ink-2">{fmtDate(i.last_observed_at)}</td>
                  <td className="px-3 py-2"><StatusChip status={i.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-ink-3">
          <span className="num">
            {total ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total)} of ${fmtNum(total)}` : ""}
          </span>
          <Button size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Previous</Button>
          <Button size="sm" onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * PAGE >= total}>Next</Button>
        </div>
      </div>
    </div>
  );
}
