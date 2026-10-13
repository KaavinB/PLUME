"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, FileText, PenLine, Satellite, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";

import { MeasurementChart } from "@/components/charts";
import { Badge, Button, CheckIcon, ErrorBox, ExtLink, Hash, KV, LinkButton, PageHeader, PageSkeleton, Panel, SimBadge, StatusChip, cx } from "@/components/ui";
import { apiGet, apiPost, apiUrl } from "@/lib/api";
import { fmtDate, fmtNum, INSTRUMENTS } from "@/lib/format";
import { useMeta, useSession } from "@/lib/session";
import type { Impact, Project, VerificationContext, VerificationOut } from "@/lib/types";
import { STATIC_SNAPSHOT } from "@/lib/snapshot";

const OUTCOMES = [
  { k: "VERIFIED", label: "Verified", desc: "Policy satisfied. Unlocks escrow release to the provider.", tone: "green" },
  { k: "ADDITIONAL_EVIDENCE_REQUIRED", label: "Request more evidence", desc: "Provider may resubmit; funds stay in escrow.", tone: "amber" },
  { k: "INCONCLUSIVE", label: "Inconclusive", desc: "Evidence cannot support a decision either way.", tone: "amber" },
  { k: "REJECTED", label: "Rejected", desc: "Evidence does not show the repair. No payment.", tone: "red" },
] as const;

export function ImpactCalc({ impact }: { impact: Impact }) {
  if (impact.status !== "quantified")
    return (
      <div className="text-xs leading-relaxed text-ink-2">
        <Badge>Not quantified</Badge>
        <p className="mt-2">{impact.reason}</p>
      </div>
    );
  const t = (v: number | null) => (v === null ? "—" : fmtNum(v / 1000, 1));
  return (
    <div className="space-y-2 text-xs">
      <div className="mono rounded-md border border-line bg-surface-2 p-2.5 leading-relaxed text-ink-2">
        <div>Δrate = {fmtNum(impact.baseline_rate_kg_h, 1)} − {fmtNum(impact.post_rate_kg_h, 1)} = <span className="text-ink">{fmtNum(impact.reduction_rate_kg_h, 1)} ± {fmtNum(impact.reduction_uncertainty_kg_h, 1)} kg/h</span></div>
        <div>CH₄ = Δrate × {fmtNum(impact.supported_duration_h)} h = <span className="text-ink">{t(impact.ch4_avoided_kg)} t</span> <span className="text-ink-3">[{t(impact.ch4_avoided_kg_low)}–{t(impact.ch4_avoided_kg_high)}]</span></div>
        <div>CO₂e = CH₄ × {impact.gwp_value} = <span className="text-ink">{t(impact.co2e_avoided_kg)} t</span> <span className="text-ink-3">[{t(impact.co2e_avoided_kg_low)}–{t(impact.co2e_avoided_kg_high)}]</span></div>
      </div>
      <p className="text-[11px] text-ink-3">{impact.gwp_reference}. Duration basis: {impact.duration_basis}.</p>
      <ul className="space-y-0.5 text-[11px] text-ink-3">
        {impact.assumptions.map((a) => <li key={a}>· {a}</li>)}
      </ul>
    </div>
  );
}

export function Workbench({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { user, loginAs } = useSession();
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", code], queryFn: () => apiGet<Project>(`/repair-projects/${code}`) });
  const hasEvidence = (project.data?.evidence.length ?? 0) > 0;
  const ctx = useQuery({
    queryKey: ["verification-context", code, project.data?.evidence_round, project.data?.status],
    queryFn: () => apiGet<VerificationContext>(`/repair-projects/${code}/verification-context`),
    enabled: hasEvidence,
  });
  const [outcome, setOutcome] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const isVerifier = !!user && user.id === project.data?.participants.verifier?.id;
  const reviewing = ["REPAIR_SUBMITTED", "UNDER_VERIFICATION", "DISPUTED"].includes(project.data?.status ?? "");

  const started = useRef(false);
  useEffect(() => {
    if (isVerifier && project.data?.status === "REPAIR_SUBMITTED" && !started.current) {
      started.current = true;
      apiPost(`/repair-projects/${code}/start-review`)
        .then(() => qc.invalidateQueries({ queryKey: ["project", code] }))
        .catch(() => undefined);
    }
  }, [isVerifier, project.data?.status, code, qc]);

  const decide = useMutation({
    mutationFn: () => apiPost<{ verification: VerificationOut; project: Project }>(`/repair-projects/${code}/verify`, { outcome, notes }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["project", code] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["history", code] });
    },
  });

  if (project.isPending) return <PageSkeleton />;
  if (project.error) return <div className="p-6"><ErrorBox error={project.error} /></div>;
  const p = project.data;
  if (!hasEvidence)
    return (
      <div className="p-6">
        <ErrorBox error="No evidence has been submitted for this project yet." title="Nothing to verify" />
        <LinkButton href={`/projects/${p.code}`} className="mt-3">Back to project</LinkButton>
      </div>
    );
  if (ctx.isPending) return <PageSkeleton />;
  if (ctx.error) return <div className="p-6"><ErrorBox error={ctx.error} title="Could not evaluate the verification policy" /></div>;
  const c = ctx.data;
  const ev = c.evidence;
  const pl = ev.manifest.payload;
  const blocked = c.blocking.length > 0;
  const past = [...p.verifications].reverse();
  const explorer = meta?.chain.explorer;
  // Show the decision just signed, or — once the round is closed — the latest recorded decision.
  const decided = decide.data?.verification ?? (reviewing ? undefined : past[0]);

  return (
    <div>
      <PageHeader
        eyebrow={
          <>
            <Link href={`/projects/${p.code}`} className="inline-flex items-center gap-1 hover:text-ink"><ArrowLeft className="size-3" /> <span className="mono">{p.code}</span></Link>
            <StatusChip status={p.status} />
            {ev.is_simulated && <SimBadge label="Simulated evidence" />}
            <span>Round {ev.round}</span>
          </>
        }
        title="Verification workbench"
        actions={!isVerifier && !STATIC_SNAPSHOT ? <Button onClick={() => void loginAs("verifier")} icon={<UserRound className="size-4" />}>Act as verifier</Button> : null}
      >
        {c.methodology.label}: {c.methodology.description}
      </PageHeader>

      <div className="grid gap-4 p-6 xl:grid-cols-[1fr_1.35fr_1fr]">
        {/* -------- Context */}
        <div className="space-y-4">
          <Panel title="Original observations" subtitle={`${c.incident?.code} · historical Carbon Mapper data`}>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {[...c.observations].sort((a, b) => b.observed_at.localeCompare(a.observed_at)).map((o) => (
                <div key={o.display_id} className="flex items-center justify-between gap-2 text-[11px]">
                  <a href={o.url} target="_blank" rel="noreferrer" className="mono truncate text-ink-2 hover:text-teal">{o.display_id}</a>
                  <span className="num shrink-0 text-ink">{o.rate !== null ? `${fmtNum(o.rate)} kg/h` : "—"}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 border-t border-line pt-2 text-[11px] text-ink-3">
              {c.observations.length} detections · instruments: {Array.from(new Set(c.observations.map((o) => INSTRUMENTS[o.instrument ?? ""]?.split(" · ")[0] ?? o.instrument))).join(", ")}
            </div>
          </Panel>
          {c.investigation_summary && (
            <Panel title="Investigation summary">
              <p className="text-xs leading-relaxed text-ink-2">{c.investigation_summary}</p>
            </Panel>
          )}
          <Panel title={<span className="flex items-center gap-2"><Satellite className="size-4 text-amber" /> Subsequent observations</span>}>
            <p className="text-xs text-ink-2">
              {c.post_funding_observations.length === 0 ? "No provider detections after funding in the ingested data." : `${c.post_funding_observations.length} detection(s) after funding.`}
            </p>
            <p className="mt-2 text-[11px] leading-snug text-ink-3">{c.satellite_note}</p>
          </Panel>
          {past.length > 0 && (
            <Panel title="Decision history">
              <ul className="space-y-2">
                {past.map((v) => (
                  <li key={v.id} className="text-xs">
                    <div className="flex items-center gap-2"><span className="text-ink-3">Round {v.round}</span><StatusChip status={v.outcome} /></div>
                    {v.notes && <p className="mt-0.5 text-ink-2">“{v.notes}”</p>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        {/* -------- Evidence */}
        <div className="space-y-4">
          <Panel title="Repair record" subtitle={pl.repair_record.performed_by}>
            <p className="text-[13px] leading-relaxed text-ink-2">{pl.repair_record.work_summary}</p>
            <div className="mt-2 grid gap-x-6 md:grid-cols-2">
              <KV k="Started" v={fmtDate(pl.repair_record.started_at, true)} />
              <KV k="Completed" v={fmtDate(pl.repair_record.completed_at, true)} />
              <KV k="Site authorization" v={<span className="mono text-xs">{pl.site_authorization_ref}</span>} />
              <KV k="Components" v={pl.repair_record.components_repaired.length} />
            </div>
          </Panel>
          <Panel title="Submitted documents" subtitle="Open any file; its SHA-256 is part of the committed manifest">
            <ul className="divide-y divide-line">
              {ev.manifest.files.map((f) => {
                const doc = pl.documents.find((d) => d.file_name === f.name);
                return (
                  <li key={f.sha256} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                    <span className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 text-ink-3" />
                      <a href={apiUrl(`/repair-projects/${p.code}/evidence/${ev.round}/files/${encodeURIComponent(f.name)}`)} target="_blank" rel="noreferrer" className="truncate text-ink hover:text-teal">{doc?.title ?? f.name}</a>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge>{doc?.doc_type.replaceAll("_", " ") ?? "file"}</Badge>
                      <Hash value={f.sha256} n={4} />
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-xs">
              <span className="text-ink-3">Manifest commitment (on-chain)</span>
              <Hash value={ev.content_hash} />
            </div>
          </Panel>
          {pl.measurements && (
            <Panel title="Site measurements" subtitle={`${pl.measurements.method} · ±1σ`} actions={<SimBadge label="Synthetic" />}>
              <MeasurementChart pre={pl.measurements.pre_repair} post={pl.measurements.post_repair} completedAt={pl.repair_record.completed_at} />
            </Panel>
          )}
          <Panel title="Impact calculation preview" subtitle="Recorded only if the decision is VERIFIED under a quantified methodology" actions={ev.is_simulated ? <SimBadge /> : null}>
            <ImpactCalc impact={c.impact_preview} />
          </Panel>
        </div>

        {/* -------- Decision */}
        <div className="space-y-4">
          <Panel title="Policy checks" subtitle={blocked ? `${c.blocking.length} required check(s) failing` : "All required checks pass"}>
            <ul className="space-y-2.5" data-testid="policy-checks">
              {c.checks.map((ch) => (
                <li key={ch.id} className="flex gap-2.5 text-xs" data-check={ch.id} data-status={ch.status}>
                  <CheckIcon status={ch.status} />
                  <span>
                    <span className="text-ink">{ch.label}</span>
                    {!ch.required && <span className="ml-1 text-ink-3">(advisory)</span>}
                    <span className="block text-ink-3">{ch.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={<span className="flex items-center gap-2"><PenLine className="size-4 text-teal" /> Decision</span>} subtitle="Signed as EIP-712 typed data by the verifier key and recorded by the escrow contract">
            {decided ? (
              <div className="space-y-2 text-xs" data-testid="decision-result">
                <div className="flex items-center gap-2"><StatusChip status={decided.outcome} /><span className="text-ink-2">recorded on-chain</span></div>
                <KV k="EIP-712 digest" v={<Hash value={decided.eip712_digest} />} />
                <KV k="Signature" v={<Hash value={decided.signature} />} />
                <KV k="Transaction" v={<Hash value={decided.tx_hash} href={decided.tx_hash && explorer ? `${explorer}/tx/${decided.tx_hash}` : null} />} />
                <LinkButton href={`/projects/${p.code}`} variant="primary" className="mt-2 w-full">Continue to project</LinkButton>
              </div>
            ) : !reviewing ? (
              <p className="text-xs text-ink-2">This round is closed ({p.status.toLowerCase().replaceAll("_", " ")}).</p>
            ) : !isVerifier ? (
              <div className="space-y-2 text-xs text-ink-2">
                <p className="flex items-center gap-1.5"><Ban className="size-3.5 text-bad" /> Only this project&apos;s designated verifier can sign a decision. The contract rejects any other signature.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5" role="radiogroup" aria-label="Verification outcome">
                  {OUTCOMES.map((o) => {
                    const disabled = o.k === "VERIFIED" && blocked;
                    return (
                      <button
                        key={o.k}
                        type="button"
                        role="radio"
                        aria-checked={outcome === o.k}
                        disabled={disabled}
                        onClick={() => setOutcome(o.k)}
                        data-testid={`outcome-${o.k}`}
                        className={cx(
                          "w-full rounded-md border p-2.5 text-left disabled:cursor-not-allowed disabled:opacity-40",
                          outcome === o.k ? (o.tone === "green" ? "border-ok bg-[rgba(107,203,119,0.06)]" : o.tone === "red" ? "border-bad bg-[rgba(229,83,75,0.06)]" : "border-amber bg-[rgba(242,169,59,0.06)]") : "border-line hover:border-line-strong",
                        )}
                      >
                        <div className="text-[13px] font-medium text-ink">{o.label}</div>
                        <div className="text-[11px] text-ink-3">{disabled ? "Blocked: required policy checks fail" : o.desc}</div>
                      </button>
                    );
                  })}
                </div>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes recorded in the verification report (hashed on-chain)" className="min-h-20 w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm placeholder:text-ink-3" data-testid="decision-notes" />
                {outcome && (
                  <div className="mono rounded-md border border-line bg-surface-2 p-2.5 text-[10px] leading-relaxed text-ink-3">
                    <div className="mb-1 text-ink-2">You will sign · RepairDecision</div>
                    <div>domain: PLUME Proof of Repair v1 · chain {p.chain_id}</div>
                    <div>verifyingContract: {p.contract_address}</div>
                    <div>projectId: {p.onchain_project_id} · round: {p.onchain?.round}</div>
                    <div className="break-all">evidenceHash: {p.onchain?.evidence_hash}</div>
                    <div>outcome: {outcome}</div>
                    <div>reportHash: keccak256(report incl. checks & notes)</div>
                  </div>
                )}
                {decide.error && <ErrorBox error={decide.error} title="Decision rejected" />}
                <Button variant="primary" className="w-full" disabled={!outcome} loading={decide.isPending} onClick={() => decide.mutate()} icon={<ShieldCheck className="size-4" />} data-testid="sign-decision">
                  Sign & record decision
                </Button>
              </div>
            )}
          </Panel>
          <p className="px-1 text-[11px] leading-snug text-ink-3">
            Trust boundary: the contract cannot observe methane. It enforces that only this verifier&apos;s signature over this exact evidence hash and
            round can unlock funds. Whether the repair worked is the verifier&apos;s judgement, recorded here with its inputs. <ExtLink href="/about">How PLUME works</ExtLink>
          </p>
        </div>
      </div>
    </div>
  );
}
