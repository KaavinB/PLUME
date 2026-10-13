"use client";

import { useQuery } from "@tanstack/react-query";
import { FileSearch } from "lucide-react";
import Link from "next/link";

import { Badge, Empty, ErrorBox, PageHeader, Skeleton } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { fmtDate, fmtNum, sectorName } from "@/lib/format";

interface Row {
  id: string;
  created_at: string;
  report_kind: string;
  model_identifier: string;
  latency_ms: number;
  incident_code: string;
  priority_score: number;
  sector: string | null;
  summary: string;
  grounding_passed: boolean;
}

export default function InvestigationsPage() {
  const q = useQuery({ queryKey: ["investigations"], queryFn: () => apiGet<{ items: Row[] }>("/investigations") });
  return (
    <div>
      <PageHeader title="Investigations">
        Computation-backed reports: validation, grouping, prioritization and source-linked remediation guidance. Narratives are written by a configured
        LLM (grounding-checked) or by a deterministic template — always labelled.
      </PageHeader>
      <div className="space-y-3 p-6">
        {q.error && <ErrorBox error={q.error} />}
        {q.isPending && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        {q.data?.items.length === 0 && (
          <Empty icon={<FileSearch className="size-6" />} title="No investigations yet">
            Open an incident from <Link href="/" className="text-teal">Mission Control</Link> and run an investigation.
          </Empty>
        )}
        {q.data?.items.map((r) => (
          <Link key={r.id} href={`/investigations/${r.id}`} className="block rounded-lg border border-line bg-surface p-4 hover:border-line-strong">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <span className="mono text-ink">{r.incident_code}</span>
              <span>· {sectorName(r.sector)}</span>
              <span>· priority <span className="num text-teal">{fmtNum(r.priority_score, 1)}</span></span>
              <span>· {fmtDate(r.created_at, true)}</span>
              <Badge tone={r.report_kind === "llm" ? "teal" : "neutral"}>{r.report_kind === "llm" ? "LLM" : "Template"}</Badge>
              {r.grounding_passed && <Badge tone="green">Grounded</Badge>}
            </div>
            <p className="mt-2 line-clamp-2 text-sm text-ink-2">{r.summary}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
