"use client";

import { useQuery } from "@tanstack/react-query";
import { BookMarked, Bot, Check, CircleHelp, FileText, ListChecks, Plus, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { use, useState, type ReactNode } from "react";

import { PriorityBars } from "@/components/charts";
import { Badge, CheckIcon, ErrorBox, ExtLink, KV, Label, LinkButton, PageHeader, PageSkeleton, Panel, cx } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { fmtDate, fmtNum } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { EvidenceRef, InvestigationOut } from "@/lib/types";

const CONF_TONE = { low: "neutral", medium: "amber", high: "green" } as const;

const PIPELINE = [
  { k: "validate", label: "Validate", icon: ListChecks, desc: "Coordinates, timestamps, gas, units, uncertainty, duplicates" },
  { k: "group", label: "Group", icon: BookMarked, desc: "DBSCAN haversine grouping vs. provider grouping" },
  { k: "prioritize", label: "Prioritize", icon: ShieldCheck, desc: "7 weighted, explainable factors" },
  { k: "retrieve", label: "Retrieve", icon: FileText, desc: "TF-IDF over curated, source-linked guidance" },
  { k: "report", label: "Report", icon: Bot, desc: "Narrative + grounding check" },
];

export function InvestigationView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user } = useSession();
  const q = useQuery({ queryKey: ["investigation", id], queryFn: () => apiGet<InvestigationOut>(`/investigations/${id}`) });
  const [focusRef, setFocusRef] = useState<string | null>(null);

  if (q.isPending) return <PageSkeleton />;
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} title="Investigation unavailable" /></div>;
  const r = q.data.report;
  const refs = new Map(r.evidence_references.map((e) => [e.id, e]));
  const isLlm = r.generation.kind === "llm";

  const Chips = ({ ids, max = 4 }: { ids: string[]; max?: number }) => (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {ids.slice(0, max).map((rid) => (
        <button key={rid} type="button" onClick={() => setFocusRef(rid)} className={cx("mono rounded border px-1.5 py-0.5 text-[10px] hover:text-ink", focusRef === rid ? "border-teal text-teal" : "border-line-strong text-ink-3")} title={refs.get(rid)?.label}>
          {rid.length > 34 ? `${rid.slice(0, 32)}…` : rid}
        </button>
      ))}
      {ids.length > max && <span className="text-[10px] text-ink-3">+{ids.length - max} more</span>}
    </span>
  );

  return (
    <div>
      <PageHeader
        eyebrow={
          <>
            <Link href={`/incidents/${r.incident_code}`} className="mono hover:text-ink">{r.incident_code}</Link>
            <span>·</span>
            <span>Investigation {fmtDate(r.generation.generated_at, true)}</span>
            <Badge tone={isLlm ? "teal" : "neutral"}>{isLlm ? `LLM narrative · ${r.generation.model_identifier}` : "Deterministic template narrative"}</Badge>
            <Badge tone={r.grounding.passed ? "green" : "red"}>{r.grounding.passed ? "Grounding check passed" : "Grounding check failed"}</Badge>
          </>
        }
        title="Incident investigation report"
        actions={
          user?.role === "sponsor" ? (
            <LinkButton variant="primary" href={`/projects/new?incident=${r.incident_code}`} icon={<Plus className="size-4" />}>Create repair project</LinkButton>
          ) : null
        }
      >
        {r.generation.note}
      </PageHeader>

      {/* Pipeline */}
      <div className="grid grid-cols-5 gap-px border-b border-line bg-line">
        {PIPELINE.map((p, i) => (
          <div key={p.k} className="bg-bg px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-ink">
              <span className="flex size-5 items-center justify-center rounded-full bg-[rgba(107,203,119,0.15)] text-ok"><Check className="size-3" strokeWidth={3} /></span>
              <span className="font-medium">{i + 1}. {p.label}</span>
            </div>
            <div className="mt-1 text-[11px] text-ink-3">{p.desc}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 p-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Executive summary" actions={<span className="num text-xs text-ink-3">{q.data.latency_ms ?? r.generation.latency_ms} ms</span>}>
            <p className="text-[15px] leading-relaxed text-ink" data-testid="report-summary">{r.summary}</p>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title={<span className="flex items-center gap-2"><Check className="size-4 text-ok" /> Confirmed observations</span>} subtitle="Computed from stored records — each traceable to evidence">
              <ul className="space-y-3">
                {r.confirmed_observations.map((f) => (
                  <li key={f.statement} className="text-[13px] leading-relaxed text-ink-2">
                    {f.statement}
                    <Chips ids={f.evidence_refs} />
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title={<span className="flex items-center gap-2"><CircleHelp className="size-4 text-amber" /> Possible explanations</span>} subtitle="Inferences — to be confirmed on site">
              <ul className="space-y-3">
                {r.possible_explanations.map((e) => (
                  <li key={e.statement} className="text-[13px] leading-relaxed text-ink-2">
                    <Badge tone={CONF_TONE[e.confidence]} className="mr-1.5">{e.confidence} confidence</Badge>
                    {e.statement}
                    <Chips ids={e.basis_refs} max={3} />
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <Panel title="Suggested remediation approaches" subtitle="Retrieved from PLUME's curated knowledge base. Satellite data cannot identify the specific faulty component.">
            <div className="grid gap-3 md:grid-cols-2">
              {r.suggested_actions.map((a) => {
                const ref = refs.get(a.knowledge_refs[0]);
                return (
                  <div key={a.action} className="rounded-md border border-line p-3">
                    <div className="text-[13px] font-medium text-ink">{a.action}</div>
                    <p className="mt-1 text-xs leading-relaxed text-ink-2">{a.rationale}</p>
                    {a.suggested_evidence.length > 0 && (
                      <div className="mt-2 text-[11px] text-ink-3">Evidence to request: {a.suggested_evidence.join(" · ")}</div>
                    )}
                    {ref?.url && <div className="mt-2 text-[11px]"><ExtLink href={ref.url}>{ref.label}</ExtLink></div>}
                  </div>
                );
              })}
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Next investigation steps">
              <ol className="list-decimal space-y-2 pl-4 text-[13px] leading-relaxed text-ink-2 marker:text-ink-3">
                {r.next_investigation_steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
            </Panel>
            <Panel title="Unresolved questions">
              <ul className="space-y-2 text-[13px] leading-relaxed text-ink-2">
                {r.unresolved_questions.map((s) => <li key={s} className="flex gap-2"><CircleHelp className="mt-0.5 size-3.5 shrink-0 text-ink-3" />{s}</li>)}
              </ul>
            </Panel>
          </div>

          <Panel title={<span className="flex items-center gap-2"><TriangleAlert className="size-4 text-amber" /> Data limitations</span>}>
            <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-2">
              {r.limitations.map((l) => <li key={l} className="flex gap-2"><span className="text-ink-3">—</span>{l}</li>)}
            </ul>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Measured inputs">
            <div className="divide-y divide-line">
              <KV k="Median estimate" v={`${fmtNum(r.observed_emission_rate.median)} kg/h`} />
              <KV k="Range" v={`${fmtNum(r.observed_emission_rate.minimum)}–${fmtNum(r.observed_emission_rate.maximum)} kg/h`} />
              <KV k="Quantified detections" v={`${r.observed_emission_rate.quantified_detections} / ${r.observed_emission_rate.total_detections}`} />
              <KV k="Median rel. uncertainty" v={r.measurement_uncertainty.median_relative_uncertainty !== null ? `±${fmtNum(r.measurement_uncertainty.median_relative_uncertainty * 100)}%` : "—"} />
              <KV k="Potential sector" v={`${r.potential_sector.label} · ${r.sector_confidence} confidence`} />
            </div>
            <p className="mt-2 text-[11px] leading-snug text-ink-3">{r.observed_emission_rate.basis}</p>
            <p className="mt-1 text-[11px] leading-snug text-ink-3">{r.sector_confidence_basis}</p>
          </Panel>

          <Panel title="Data validation">
            <ul className="space-y-2">
              {r.data_validation.map((c) => (
                <li key={c.name} className="flex gap-2.5 text-xs">
                  <CheckIcon status={c.status} />
                  <span>
                    <span className="text-ink">{c.name.replaceAll("_", " ")}</span>
                    <span className="block text-ink-3">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Priority breakdown" actions={<span className="num text-xl font-semibold text-teal">{fmtNum(r.prioritization_score, 1)}</span>}>
            <PriorityBars factors={r.prioritization_breakdown.factors} compact />
          </Panel>

          <Panel title="Possible source matches" subtitle="Null results are allowed; no facility is ever inferred">
            {r.possible_source_matches.length === 0 ? (
              <p className="text-xs text-ink-3">No provider source grouping matched.</p>
            ) : (
              r.possible_source_matches.map((m) => (
                <div key={m.identifier} className="mb-2 text-xs text-ink-2">
                  <div className="mono text-[11px] break-all text-ink">{m.identifier}</div>
                  {m.description}
                </div>
              ))
            )}
          </Panel>

          <Panel title="Grounding check" subtitle="Narrative fields checked against the evidence pack">
            <div className="divide-y divide-line">
              <KV k="Fields checked" v={r.grounding.checked_fields.length} />
              <KV k="Unknown evidence ids" v={r.grounding.unknown_refs.length} />
              <KV k="Unsupported numbers" v={r.grounding.unsupported_numbers.length} />
              <KV k="Named organisations" v={r.grounding.named_entity_flags.length} />
            </div>
          </Panel>

          <Panel title={`Evidence references (${r.evidence_references.length})`}>
            <EvidenceList refs={r.evidence_references} focus={focusRef} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function EvidenceList({ refs, focus }: { refs: EvidenceRef[]; focus: string | null }) {
  const groups: Record<string, EvidenceRef[]> = {};
  for (const r of refs) (groups[r.kind] ??= []).push(r);
  const title: Record<string, ReactNode> = { observation: "Observations", provider_source: "Provider groupings", knowledge: "Guidance", calculation: "Calculations", dataset: "Datasets" };
  return (
    <div className="max-h-96 space-y-3 overflow-y-auto">
      {Object.entries(groups).map(([k, items]) => (
        <div key={k}>
          <Label>{title[k] ?? k}</Label>
          <ul className="mt-1 space-y-1">
            {items.map((e) => (
              <li key={e.id} className={cx("rounded px-1.5 py-1 text-[11px] leading-snug", focus === e.id ? "bg-[rgba(79,179,169,0.12)]" : "")}>
                <div className="mono text-ink-2">{e.id}</div>
                <div className="text-ink-3">{e.url ? <ExtLink href={e.url}>{e.label}</ExtLink> : e.label}</div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
