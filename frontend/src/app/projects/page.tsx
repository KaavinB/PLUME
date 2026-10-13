"use client";

import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import Link from "next/link";

import { Empty, ErrorBox, PageHeader, SimBadge, Skeleton, StatusChip } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { fmtDate, fmtEth } from "@/lib/format";
import type { ProjectBrief } from "@/lib/types";

export default function ProjectsPage() {
  const q = useQuery({ queryKey: ["projects"], queryFn: () => apiGet<{ items: ProjectBrief[] }>("/repair-projects"), refetchInterval: 8000 });
  return (
    <div>
      <PageHeader eyebrow={<SimBadge label="Simulated projects · test-network funds" />} title="Repair bounties">
        Funded, authorized repair work for investigated incidents. Escrow releases only on an independent verifier&apos;s signed decision.
      </PageHeader>
      <div className="p-6">
        {q.error && <ErrorBox error={q.error} />}
        {q.isPending && <Skeleton className="h-40" />}
        {q.data?.items.length === 0 && (
          <Empty icon={<Wrench className="size-6" />} title="No repair projects yet">
            As the Sponsor persona, open an investigated incident and choose “Create repair project”.
          </Empty>
        )}
        {!!q.data?.items.length && (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-surface text-xs text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-4 py-2.5 font-medium">Project</th>
                  <th className="px-3 py-2.5 font-medium">Incident</th>
                  <th className="px-3 py-2.5 font-medium">Methodology</th>
                  <th className="px-3 py-2.5 text-right font-medium">Escrow</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((p) => (
                  <tr key={p.id} className="border-b border-line/60 hover:bg-surface">
                    <td className="px-4 py-2.5"><Link href={`/projects/${p.code}`} className="hover:text-amber"><span className="mono mr-2 text-ink">{p.code}</span><span className="text-ink-2">{p.title}</span></Link></td>
                    <td className="mono px-3 py-2.5 text-ink-2">{p.incident_code}</td>
                    <td className="px-3 py-2.5 text-xs text-ink-2">{p.methodology?.replaceAll("_", " ").toLowerCase()}</td>
                    <td className="num px-3 py-2.5 text-right">{fmtEth(p.funding_amount_wei)}</td>
                    <td className="px-3 py-2.5"><StatusChip status={p.status} /></td>
                    <td className="num px-3 py-2.5 text-xs text-ink-3">{fmtDate(p.updated_at, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
