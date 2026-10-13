"use client";

import { useQuery } from "@tanstack/react-query";
import { Database, FlaskConical, Globe2, Receipt as ReceiptIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Badge, ErrorBox, PageHeader, PageSkeleton, Panel, SimBadge, Stat, StatusChip } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { fmtDate, fmtEth, fmtNum } from "@/lib/format";

interface Ledger {
  real_data: {
    label: string;
    observations_ingested: number;
    observations_with_emission_estimate: number;
    incidents: number;
    incidents_with_detections_on_3plus_dates: number;
    investigations_completed: number;
    ingestion: { rejected: Record<string, number>; duplicates_same_id: number; duplicates_same_detection: number; flags: Record<string, number>; incidents?: { provider_comparison?: { adjusted_rand_index: number } } } | null;
  };
  workflow: {
    label: string;
    projects_by_status: Record<string, number>;
    projects_funded_testnet: number;
    escrow_committed_test_wei: string;
    repair_submissions: number;
    verification_decisions: Record<string, number>;
    verified_completion_events: number;
    receipts_issued: number;
  };
  simulated_reductions: { label: string; receipts_with_quantified_reduction: number; ch4_avoided_kg: number; co2e_avoided_kg: number; methodology: string };
  real_world_verified_reductions: { label: string; value: null; note: string };
  receipts: { id: string; project_id: string; created_at: string; status: string; ch4_avoided_kg: number | null; tx: string }[];
}

function Section({ icon, title, tag, children }: { icon: ReactNode; title: string; tag: ReactNode; children: ReactNode }) {
  return (
    <Panel title={<span className="flex items-center gap-2">{icon}{title}</span>} actions={tag}>
      {children}
    </Panel>
  );
}

export default function LedgerPage() {
  const q = useQuery({ queryKey: ["impact"], queryFn: () => apiGet<Ledger>("/impact"), refetchInterval: 10000 });
  if (q.isPending) return <PageSkeleton />;
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} /></div>;
  const d = q.data;
  const ari = d.real_data.ingestion?.incidents?.provider_comparison?.adjusted_rand_index;
  return (
    <div>
      <PageHeader title="Public impact ledger">
        Real observations, simulated workflow activity and modelled reductions are reported separately and never summed together.
      </PageHeader>
      <div className="space-y-4 p-6">
        <Section icon={<Database className="size-4 text-amber" />} title="Historical observations" tag={<Badge tone="amber">Real data · Carbon Mapper</Badge>}>
          <div className="grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat label="Observations ingested" value={fmtNum(d.real_data.observations_ingested)} tone="amber" sub={`${fmtNum(d.real_data.observations_with_emission_estimate)} with a provider rate`} />
            <Stat label="Candidate incidents" value={fmtNum(d.real_data.incidents)} sub={ari ? `ARI ${ari.toFixed(3)} vs provider grouping` : undefined} />
            <Stat label="Detected on ≥ 3 dates" value={fmtNum(d.real_data.incidents_with_detections_on_3plus_dates)} sub="recurring candidate sources" />
            <Stat label="Investigations completed" value={fmtNum(d.real_data.investigations_completed)} tone="teal" />
            <Stat label="Duplicates removed" value={fmtNum((d.real_data.ingestion?.duplicates_same_id ?? 0) + (d.real_data.ingestion?.duplicates_same_detection ?? 0))} sub={`${Object.values(d.real_data.ingestion?.rejected ?? {}).reduce((a, b) => a + b, 0)} records rejected`} />
          </div>
        </Section>

        <Section icon={<FlaskConical className="size-4 text-sim" />} title="Repair workflow" tag={<SimBadge label="Simulated projects · test network" />}>
          <div className="grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat label="Projects funded (testnet)" value={fmtNum(d.workflow.projects_funded_testnet)} tone="sim" sub={fmtEth(d.workflow.escrow_committed_test_wei) + " escrowed (test)"} />
            <Stat label="Repair submissions" value={fmtNum(d.workflow.repair_submissions)} />
            <Stat label="Verified completion events" value={fmtNum(d.workflow.verified_completion_events)} tone="green" />
            <Stat label="Rejected / other decisions" value={fmtNum(Object.entries(d.workflow.verification_decisions).filter(([k]) => k !== "VERIFIED").reduce((a, [, v]) => a + v, 0))} />
            <Stat label="Receipts issued" value={fmtNum(d.workflow.receipts_issued)} />
          </div>
          {Object.keys(d.workflow.projects_by_status).length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
              {Object.entries(d.workflow.projects_by_status).map(([s, n]) => (
                <span key={s} className="flex items-center gap-1.5 text-xs text-ink-2"><StatusChip status={s} /> {n}</span>
              ))}
            </div>
          )}
        </Section>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section icon={<FlaskConical className="size-4 text-sim" />} title="Modelled reductions" tag={<SimBadge label="Synthetic measurements" />}>
            <div className="grid grid-cols-2 gap-6">
              <Stat label="CH₄ (t), simulated evidence" value={fmtNum(d.simulated_reductions.ch4_avoided_kg / 1000, 1)} tone="sim" sub={`${d.simulated_reductions.receipts_with_quantified_reduction} quantified receipt(s)`} />
              <Stat label="CO₂e (t), simulated evidence" value={fmtNum(d.simulated_reductions.co2e_avoided_kg / 1000, 0)} tone="sim" sub="GWP-100, IPCC AR6" />
            </div>
            <p className="mt-3 text-xs text-ink-3">{d.simulated_reductions.label}. {d.simulated_reductions.methodology}</p>
          </Section>
          <Section icon={<Globe2 className="size-4 text-ok" />} title="Real-world verified reductions" tag={<Badge>None</Badge>}>
            <div className="num text-2xl font-semibold text-ink-3">—</div>
            <p className="mt-2 text-sm text-ink-2">{d.real_world_verified_reductions.note}</p>
            <p className="mt-1 text-xs text-ink-3">This prototype demonstrates the coordination and verification workflow on historical observations. It makes no claim of achieved emission reductions.</p>
          </Section>
        </div>

        <Panel title={<span className="flex items-center gap-2"><ReceiptIcon className="size-4 text-ink-3" />Impact receipts</span>}>
          {d.receipts.length === 0 ? (
            <p className="text-sm text-ink-3">No receipts yet. A receipt is issued when a verified project&apos;s escrow is settled.</p>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="text-xs text-ink-3">
                <tr className="border-b border-line"><th className="py-2 font-medium">Receipt</th><th className="py-2 font-medium">Issued</th><th className="py-2 font-medium">Reduction</th><th className="py-2 text-right font-medium">CH₄ (simulated)</th></tr>
              </thead>
              <tbody>
                {d.receipts.map((r) => (
                  <tr key={r.id} className="border-b border-line/60">
                    <td className="py-2"><Link href={`/receipts/${r.id}`} className="mono text-teal hover:underline">{r.id}</Link></td>
                    <td className="num py-2 text-ink-2">{fmtDate(r.created_at, true)}</td>
                    <td className="py-2 text-ink-2">{r.status.replace("_", " ")}</td>
                    <td className="num py-2 text-right">{r.ch4_avoided_kg ? `${fmtNum(r.ch4_avoided_kg / 1000, 1)} t` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
