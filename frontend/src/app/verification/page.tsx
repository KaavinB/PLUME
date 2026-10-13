"use client";

import { useQuery } from "@tanstack/react-query";
import { Gavel } from "lucide-react";
import Link from "next/link";

import { Empty, ErrorBox, PageHeader, SimBadge, Skeleton, StatusChip } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { ProjectBrief } from "@/lib/types";

const QUEUE = ["REPAIR_SUBMITTED", "UNDER_VERIFICATION", "DISPUTED"];

export default function VerificationQueue() {
  const { user } = useSession();
  const q = useQuery({ queryKey: ["projects"], queryFn: () => apiGet<{ items: ProjectBrief[] }>("/repair-projects"), refetchInterval: 8000 });
  const items = q.data?.items ?? [];
  const pending = items.filter((p) => QUEUE.includes(p.status));
  const decided = items.filter((p) => ["VERIFIED", "PAID", "REJECTED", "INCONCLUSIVE", "ADDITIONAL_EVIDENCE_REQUIRED"].includes(p.status));
  const Row = ({ p }: { p: ProjectBrief }) => (
    <Link href={`/verification/${p.code}`} className="flex items-center justify-between rounded-lg border border-line bg-surface px-4 py-3 hover:border-line-strong">
      <span>
        <span className="mono mr-2 text-sm text-ink">{p.code}</span>
        <span className="text-sm text-ink-2">{p.title}</span>
        <span className="block text-xs text-ink-3">{p.incident_code} · verifier {p.verifier_id}{user?.id === p.verifier_id ? " (you)" : ""} · updated {fmtDate(p.updated_at, true)}</span>
      </span>
      <StatusChip status={p.status} />
    </Link>
  );
  return (
    <div>
      <PageHeader eyebrow={<SimBadge label="Simulated evidence" />} title="Verification">
        Independent review of repair evidence against each project&apos;s methodology. Non-detection by satellite is never accepted as proof of repair.
      </PageHeader>
      <div className="space-y-6 p-6">
        {q.error && <ErrorBox error={q.error} />}
        {q.isPending && <Skeleton className="h-32" />}
        <section>
          <h2 className="mb-2 text-sm font-medium">Awaiting decision ({pending.length})</h2>
          {pending.length === 0 && !q.isPending ? (
            <Empty icon={<Gavel className="size-6" />} title="No evidence awaiting review">Providers submit evidence from a funded, assigned project.</Empty>
          ) : (
            <div className="space-y-2">{pending.map((p) => <Row key={p.id} p={p} />)}</div>
          )}
        </section>
        {decided.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-ink-2">Decided ({decided.length})</h2>
            <div className="space-y-2">{decided.map((p) => <Row key={p.id} p={p} />)}</div>
          </section>
        )}
      </div>
    </div>
  );
}
