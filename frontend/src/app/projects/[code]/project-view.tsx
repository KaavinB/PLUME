"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Clock, FastForward, FileCheck2, FlaskConical, Gavel, Link2, RefreshCw, Receipt as ReceiptIcon, Upload, UserRound } from "lucide-react";
import Link from "next/link";
import { use, useState, type ReactNode } from "react";

import { Badge, Button, CheckIcon, ErrorBox, Hash, KV, Label, LinkButton, PageHeader, PageSkeleton, Panel, SimBadge, StatusChip, cx } from "@/components/ui";
import { apiGet, apiPost, apiPostForm, apiUrl } from "@/lib/api";
import { fmtDate, fmtEth, fmtNum } from "@/lib/format";
import { useMeta, useSession } from "@/lib/session";
import type { EvidencePayload, History, Project } from "@/lib/types";
import { READ_ONLY_MESSAGE, STATIC_SNAPSHOT } from "@/lib/snapshot";

const LIFECYCLE = ["DRAFT", "OPEN_FOR_FUNDING", "FUNDED", "ASSIGNED", "REPAIR_SUBMITTED", "UNDER_VERIFICATION", "VERIFIED", "PAID"];
const SIDE: Record<string, number> = { REJECTED: 5, INCONCLUSIVE: 5, ADDITIONAL_EVIDENCE_REQUIRED: 5, DISPUTED: 6, CANCELLED: -1, EXPIRED: -1 };

function Stepper({ status }: { status: string }) {
  const idx = LIFECYCLE.indexOf(status);
  const at = idx >= 0 ? idx : SIDE[status] ?? -1;
  return (
    <ol className="flex items-center gap-1 overflow-x-auto px-6 py-4" aria-label="Project lifecycle">
      {LIFECYCLE.map((s, i) => {
        const done = idx >= 0 ? i < idx || status === "PAID" : i < at;
        const current = i === idx;
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              className={cx(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] whitespace-nowrap",
                current ? "border-amber text-ink" : done ? "border-[#244a2a] text-ok" : "border-line text-ink-3",
              )}
            >
              {done ? <Check className="size-3" strokeWidth={3} /> : <span className="num">{i + 1}</span>}
              {s.replaceAll("_", " ").toLowerCase()}
            </span>
            {i < LIFECYCLE.length - 1 && <span className={cx("h-px w-3", done ? "bg-[#244a2a]" : "bg-line")} />}
          </li>
        );
      })}
      {idx < 0 && (
        <li className="ml-3"><StatusChip status={status} /></li>
      )}
    </ol>
  );
}

export function ProjectView({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const { user, loginAs } = useSession();
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["project", code], queryFn: () => apiGet<Project>(`/repair-projects/${code}`), refetchInterval: 6000 });
  const hist = useQuery({ queryKey: ["history", code], queryFn: () => apiGet<History>(`/repair-projects/${code}/history`), refetchInterval: 6000 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["project", code] });
    void qc.invalidateQueries({ queryKey: ["history", code] });
    void qc.invalidateQueries({ queryKey: ["meta"] });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  const act = useMutation({
    mutationFn: async (actions: string[]) => {
      let last: Project | null = null;
      for (const a of actions) last = await apiPost<Project>(`/repair-projects/${code}/${a}`);
      return last;
    },
    onSettled: refresh,
  });
  const reconcile = useMutation({ mutationFn: () => apiPost<{ changed: boolean; onchain_state: string }>(`/repair-projects/${code}/reconcile`), onSettled: refresh });

  if (q.isPending) return <PageSkeleton />;
  if (q.error) return <div className="p-6"><ErrorBox error={q.error} title="Project unavailable" /></div>;
  const p = q.data;
  const explorer = meta?.chain.explorer;
  const txHref = (h: string | null | undefined) => (h && explorer ? `${explorer}/tx/${h}` : null);
  const role = user?.role;
  const mine = (r: "sponsor" | "provider" | "verifier") => user?.id === p.participants[r]?.id;
  const termsMatch = p.onchain?.terms_hash ? p.onchain.terms_hash.toLowerCase() === p.terms_hash.toLowerCase() : null;

  const waitFor = (persona: "sponsor" | "provider" | "verifier", what: string) => (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">Waiting for the <b className="text-ink">{persona}</b> to {what}.</p>
      {STATIC_SNAPSHOT ? (
        <p className="text-xs text-ink-3">{READ_ONLY_MESSAGE}</p>
      ) : (
        <Button onClick={() => void loginAs(persona)} icon={<UserRound className="size-4" />} data-testid={`switch-${persona}`}>Act as {persona}</Button>
      )}
    </div>
  );

  let next: ReactNode = null;
  switch (p.status) {
    case "DRAFT":
      next = mine("sponsor") ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">Register the terms hash and parties in the escrow contract, then deposit the agreed amount. Two transactions.</p>
          <div className="flex gap-2">
            <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(["publish", "fund"])} icon={<Link2 className="size-4" />} data-testid="publish-fund">
              Publish & fund escrow ({fmtEth(p.funding_amount_wei)})
            </Button>
            <Button loading={act.isPending} onClick={() => act.mutate(["publish"])}>Publish only</Button>
            <Button variant="ghost" onClick={() => act.mutate(["cancel"])}>Cancel draft</Button>
          </div>
        </div>
      ) : waitFor("sponsor", "publish and fund the escrow");
      break;
    case "OPEN_FOR_FUNDING":
      next = mine("sponsor") ? (
        <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(["fund"])} data-testid="fund">Fund escrow ({fmtEth(p.funding_amount_wei)})</Button>
      ) : waitFor("sponsor", "fund the escrow");
      break;
    case "FUNDED":
      next = mine("provider") ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">Accepting confirms you hold the operator&apos;s authorization described in the terms. Recorded on-chain.</p>
          <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(["accept"])} data-testid="accept">Accept assignment</Button>
        </div>
      ) : mine("sponsor") ? (
        <div className="space-y-3">
          {waitFor("provider", "accept the assignment")}
          <Button variant="danger" size="sm" onClick={() => act.mutate(["cancel"])}>Cancel & refund escrow</Button>
        </div>
      ) : waitFor("provider", "accept the assignment");
      break;
    case "ASSIGNED":
    case "REJECTED":
    case "INCONCLUSIVE":
    case "ADDITIONAL_EVIDENCE_REQUIRED":
      next = mine("provider") ? <EvidenceForm project={p} onDone={refresh} /> : waitFor("provider", p.status === "ASSIGNED" ? "submit repair evidence" : "resubmit evidence");
      if (p.status !== "ASSIGNED" && (mine("sponsor") || mine("provider")))
        next = (
          <div className="space-y-4">
            {next}
            <DisputeBox code={code} onDone={refresh} />
          </div>
        );
      break;
    case "REPAIR_SUBMITTED":
    case "UNDER_VERIFICATION":
    case "DISPUTED":
      next = mine("verifier") ? (
        <LinkButton variant="primary" href={`/verification/${p.code}`} icon={<Gavel className="size-4" />}>Open verification workbench</LinkButton>
      ) : (
        <div className="space-y-3">
          {waitFor("verifier", "review the evidence and sign a decision")}
          <LinkButton href={`/verification/${p.code}`} variant="ghost">View workbench (read-only)</LinkButton>
        </div>
      );
      break;
    case "VERIFIED":
      next = role && ["sponsor", "provider", "verifier", "admin"].includes(role) && (mine("sponsor") || mine("provider") || mine("verifier") || role === "admin") ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">A VERIFIED decision is recorded on-chain{p.dispute_window_s ? " and the dispute window must elapse before release" : ""}. Any participant may trigger settlement; funds can only go to the provider.</p>
          <div className="flex gap-2">
            <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(["release"])} data-testid="release">Release escrow to provider</Button>
            {(mine("sponsor") || mine("provider")) && p.dispute_window_s > 0 && <DisputeBox code={code} onDone={refresh} />}
          </div>
        </div>
      ) : waitFor("provider", "trigger settlement");
      break;
    case "PAID":
      next = (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">Escrow released. The full chain from satellite observation to settlement transaction is inspectable.</p>
          {p.receipt_id && (
            <LinkButton variant="primary" href={`/receipts/${p.receipt_id}`} icon={<ReceiptIcon className="size-4" />}>View proof · {p.receipt_id}</LinkButton>
          )}
        </div>
      );
      break;
    default:
      next = <p className="text-sm text-ink-2">This project is closed ({p.status.toLowerCase()}).</p>;
  }

  return (
    <div>
      <PageHeader
        eyebrow={
          <>
            <span className="mono">{p.code}</span>
            <StatusChip status={p.status} />
            <SimBadge />
            {p.incident && <Link href={`/incidents/${p.incident.code}`} className="mono hover:text-ink">{p.incident.code}</Link>}
          </>
        }
        title={p.title}
        actions={
          <>
            {!STATIC_SNAPSHOT && (
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={reconcile.isPending} onClick={() => reconcile.mutate()} title="Index contract events and align state with the chain">
                Reconcile with chain
              </Button>
            )}
            {p.receipt_id && <LinkButton href={`/receipts/${p.receipt_id}`} icon={<ReceiptIcon className="size-4" />}>View proof</LinkButton>}
          </>
        }
      >
        {p.repair_scope}
      </PageHeader>
      <Stepper status={p.status} />
      {reconcile.data && (
        <div className="px-6"><div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink-2">Reconciled: on-chain state {reconcile.data.onchain_state}; {reconcile.data.changed ? "database updated from chain" : "no drift"}.</div></div>
      )}

      <div className="grid gap-4 p-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Next action" subtitle={user ? `Acting as ${user.display_name} (${user.role})` : "Choose a persona at top right to act"}>
            {act.error && <div className="mb-3"><ErrorBox error={act.error} title="Action rejected" /></div>}
            <div data-testid="next-action">{next}</div>
          </Panel>

          {p.evidence.length > 0 && (
            <Panel title="Evidence submissions" subtitle="Each round is committed on-chain as the keccak-256 hash of a canonical manifest">
              <div className="space-y-3">
                {[...p.evidence].reverse().map((e) => {
                  const v = p.verifications.find((x) => x.round === e.round);
                  return (
                    <div key={e.id} className="rounded-md border border-line p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm"><span className="font-medium">Round {e.round}</span>{e.is_simulated && <SimBadge />}<span className="text-xs text-ink-3">{fmtDate(e.submitted_at, true)}</span></div>
                        {v ? <StatusChip status={v.outcome} /> : <Badge>awaiting decision</Badge>}
                      </div>
                      <div className="mt-2 grid gap-x-6 md:grid-cols-2">
                        <KV k="Evidence hash" v={<Hash value={e.content_hash} />} />
                        <KV k="Submission tx" v={<Hash value={e.tx_hash} href={txHref(e.tx_hash)} />} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {e.manifest.files.map((f) => (
                          <a key={f.sha256} href={apiUrl(`/repair-projects/${p.code}/evidence/${e.round}/files/${encodeURIComponent(f.name)}`)} target="_blank" rel="noreferrer" className="rounded border border-line-strong px-2 py-1 text-[11px] text-ink-2 hover:text-ink" title={`sha256 ${f.sha256}`}>
                            {f.name}
                          </a>
                        ))}
                      </div>
                      {v?.notes && <p className="mt-2 text-xs text-ink-2">Verifier: “{v.notes}”</p>}
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          <Panel title="Audit trail" subtitle="Backend actions with actors, and indexed contract events">
            <Timeline history={hist.data} txHref={txHref} />
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Escrow contract" subtitle={meta ? `${meta.chain.name} · chain ${meta.chain.chain_id}` : undefined}>
            {p.onchain_project_id === null ? (
              <p className="text-xs text-ink-3">Not yet published on-chain.</p>
            ) : p.onchain?.error ? (
              <ErrorBox error={p.onchain.error} title="Chain unreachable" />
            ) : (
              <div className="divide-y divide-line">
                <KV k="Contract" v={<Hash value={p.contract_address} />} />
                <KV k="On-chain project #" v={p.onchain_project_id} />
                <KV k="On-chain state" v={<span className="mono text-xs text-teal">{p.onchain?.state}</span>} />
                <KV k="Escrowed amount" v={fmtEth(p.onchain?.amount_wei)} />
                <KV k="Evidence round" v={p.onchain?.round} />
                <KV k="Terms hash" v={<span className="flex items-center gap-1.5"><Hash value={p.terms_hash} />{termsMatch !== null && <CheckIcon status={termsMatch ? "pass" : "fail"} />}</span>} />
                <KV k="Evidence hash" v={<Hash value={p.onchain?.evidence_hash?.match(/^0x0+$/) ? null : p.onchain?.evidence_hash} />} />
                <KV k="Decision digest" v={<Hash value={p.onchain?.last_decision_digest?.match(/^0x0+$/) ? null : p.onchain?.last_decision_digest} />} />
                <KV k="Expires (chain time)" v={p.onchain?.expires_at ? fmtDate(p.onchain.expires_at) : "—"} />
              </div>
            )}
            <p className="mt-2 text-[11px] text-ink-3">{STATIC_SNAPSHOT ? "Recorded when this snapshot was exported (read from the local Anvil contract by the PLUME API)." : "Read live from the contract. The chain is authoritative for funding and settlement state."}</p>
          </Panel>
          <Panel title="Parties">
            {(["sponsor", "provider", "verifier"] as const).map((r) => {
              const u = p.participants[r];
              return (
                <div key={r} className="border-b border-line py-2 last:border-0">
                  <div className="flex items-center justify-between"><Label>{r}</Label>{user?.id === u?.id && <Badge tone="teal">you</Badge>}</div>
                  <div className="mt-0.5 text-[13px] text-ink">{u?.display_name}</div>
                  <div className="text-xs text-ink-3">{u?.organization}</div>
                  <div className="mt-0.5"><Hash value={u?.wallet_address} /></div>
                </div>
              );
            })}
          </Panel>
          <Panel title="Verification terms">
            <div className="text-[13px] font-medium text-ink">{p.evidence_policy.label}</div>
            <p className="mt-1 text-xs text-ink-2">{p.evidence_policy.description}</p>
            <div className="mt-2 divide-y divide-line">
              <KV k="Required documents" v={p.evidence_policy.required_documents.length} />
              {p.evidence_policy.requires_measurements && <KV k="Min. monitoring" v={`${p.evidence_policy.min_monitoring_days} days`} />}
              <KV k="Dispute window" v={p.dispute_window_s ? `${p.dispute_window_s / 3600} h` : "none"} />
              <KV k="Milestones" v={p.milestones.map((m) => m.name).join(" → ")} />
            </div>
            <p className="mt-2 text-[11px] text-ink-3">Site authorization: {p.site_authorization}</p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function DisputeBox({ code, onDone }: { code: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const m = useMutation({ mutationFn: () => apiPost(`/repair-projects/${code}/dispute`, { reason }), onSettled: onDone });
  return (
    <div className="rounded-md border border-line p-3">
      <Label>Dispute the decision</Label>
      <div className="mt-2 flex gap-2">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (hashed on-chain)" className="h-9 flex-1 rounded-md border border-line-strong bg-surface-2 px-3 text-sm" />
        <Button variant="danger" disabled={reason.length < 5} loading={m.isPending} onClick={() => m.mutate()}>Dispute</Button>
      </div>
      {m.error && <div className="mt-2"><ErrorBox error={m.error} /></div>}
    </div>
  );
}

interface Template {
  payload: EvidencePayload;
  files: { name: string; media_type: string; content: string }[];
  ready: boolean;
  chain_now: string;
  requires_chain_time: string;
  days_to_advance: number;
  disclaimer: string;
}

function EvidenceForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const qc = useQueryClient();
  const tpl = useQuery({ queryKey: ["evidence-template", project.code], queryFn: () => apiGet<Template>(`/repair-projects/${project.code}/simulated-evidence`) });
  // Overrides only; every document is included unless the provider unticks it.
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const included = (docType: string) => !excluded[docType];
  const [extra, setExtra] = useState<File[]>([]);
  const advance = useMutation({
    mutationFn: (days: number) => apiPost("/demo/advance-time", { days }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["evidence-template", project.code] });
      void qc.invalidateQueries({ queryKey: ["meta"] });
    },
  });
  const submit = useMutation({
    mutationFn: async () => {
      const t = tpl.data!;
      const docs = t.payload.documents.filter((d) => included(d.doc_type));
      const extraDocs = extra.map((f) => ({ doc_type: "other", title: f.name, description: "Uploaded by provider", file_name: f.name }));
      const payload: EvidencePayload = { ...t.payload, documents: [...docs, ...extraDocs] };
      const fd = new FormData();
      fd.set("payload", JSON.stringify(payload));
      for (const f of t.files) if (docs.some((d) => d.file_name === f.name)) fd.append("files", new Blob([f.content], { type: f.media_type }), f.name);
      for (const f of extra) fd.append("files", f, f.name);
      return apiPostForm(`/repair-projects/${project.code}/submit-evidence`, fd);
    },
    onSettled: onDone,
  });

  if (tpl.isPending) return <p className="text-sm text-ink-3">Preparing simulated evidence package…</p>;
  if (tpl.error) return <ErrorBox error={tpl.error} />;
  const t = tpl.data;
  const pl = t.payload;
  return (
    <div className="space-y-4" data-testid="evidence-form">
      <div className="flex gap-3 rounded-md border border-[#43386a] bg-[rgba(180,156,240,0.06)] p-3 text-xs leading-relaxed text-ink-2">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-sim" />
        <div>
          <b className="text-ink">Simulated evidence package.</b> Synthetic repair documents and synthetic site measurements, timed relative to the on-chain
          funding time. Every file carries a SIMULATED banner. Untick a required document to see the verification policy block approval.
        </div>
      </div>

      {!t.ready && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 p-3">
          <div className="text-xs text-ink-2">
            <Clock className="mr-1.5 inline size-3.5 text-amber" />
            The simulated repair and 28-day monitoring period end at <span className="mono">{fmtDate(t.requires_chain_time, true)}</span> (chain time). Chain clock now:{" "}
            <span className="mono">{fmtDate(t.chain_now, true)}</span>.
          </div>
          <Button size="sm" variant="primary" loading={advance.isPending} onClick={() => advance.mutate(t.days_to_advance)} icon={<FastForward className="size-3.5" />} data-testid="advance-time">
            Fast-forward {fmtNum(t.days_to_advance, 1)} days
          </Button>
        </div>
      )}
      {!t.ready && <p className="-mt-2 text-[11px] text-ink-3">Local Anvil only: advances block time so contract expiry, funding time and evidence timestamps stay consistent.</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Label>Repair record</Label>
          <div className="mt-1 divide-y divide-line text-[13px]">
            <KV k="Performed by" v={pl.repair_record.performed_by.split(" (")[0]} />
            <KV k="Started" v={fmtDate(pl.repair_record.started_at, true)} />
            <KV k="Completed" v={fmtDate(pl.repair_record.completed_at, true)} />
            <KV k="Authorization ref" v={<span className="mono text-xs">{pl.site_authorization_ref}</span>} />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-2">{pl.repair_record.work_summary}</p>
        </div>
        <div>
          <Label>Documents</Label>
          <ul className="mt-1 space-y-1">
            {pl.documents.map((d) => (
              <li key={d.doc_type}>
                <label className="flex items-center gap-2 rounded px-1 py-1 text-[13px] hover:bg-surface-2">
                  <input type="checkbox" checked={included(d.doc_type)} onChange={(e) => setExcluded((c) => ({ ...c, [d.doc_type]: !e.target.checked }))} className="accent-[var(--amber)]" data-testid={`doc-${d.doc_type}`} />
                  <FileCheck2 className="size-3.5 text-ink-3" />
                  <span className="text-ink">{d.title}</span>
                </label>
              </li>
            ))}
          </ul>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-ink-3 hover:text-ink">
            <Upload className="size-3.5" /> Attach additional files (PDF, PNG, JPEG, CSV, TXT, MD)
            <input type="file" multiple className="hidden" accept=".pdf,.png,.jpg,.jpeg,.csv,.txt,.md,.json" onChange={(e) => setExtra(Array.from(e.target.files ?? []))} />
          </label>
          {extra.length > 0 && <div className="mt-1 text-[11px] text-ink-2">{extra.map((f) => f.name).join(", ")}</div>}
        </div>
      </div>

      {pl.measurements && (
        <div>
          <Label>Site measurements (simulated) · {pl.measurements.method}</Label>
          <table className="mt-1 w-full text-xs">
            <tbody>
              {[{ phase: "pre-repair", m: pl.measurements.pre_repair }, ...pl.measurements.post_repair.map((m) => ({ phase: "post-repair", m }))].map(({ phase, m }) => (
                <tr key={m.measured_at} className="border-b border-line/60">
                  <td className="py-1 text-ink-3">{phase}</td>
                  <td className="num py-1 text-ink-2">{fmtDate(m.measured_at, true)}</td>
                  <td className="num py-1 text-right text-ink">{fmtNum(m.rate_kg_h, 1)} ± {fmtNum(m.uncertainty_kg_h, 1)} kg/h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {submit.error && <ErrorBox error={submit.error} title="Submission rejected" />}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-ink-3">Files are content-hashed; the manifest hash is committed on-chain.</span>
        <Button variant="primary" disabled={!t.ready} loading={submit.isPending} onClick={() => submit.mutate()} icon={<ArrowRight className="size-4" />} data-testid="submit-evidence">
          Submit evidence on-chain
        </Button>
      </div>
    </div>
  );
}

function Timeline({ history, txHref }: { history: History | undefined; txHref: (h: string | null) => string | null }) {
  if (!history) return <p className="text-xs text-ink-3">Loading…</p>;
  if (history.audit.length === 0) return <p className="text-xs text-ink-3">No events yet.</p>;
  const byTx = new Map(history.chain_events.map((e) => [e.tx_hash, e]));
  return (
    <ol className="relative space-y-3 border-l border-line pl-5">
      {history.audit.map((a) => {
        const ev = a.tx_hash ? byTx.get(a.tx_hash) : undefined;
        return (
          <li key={a.id} className="relative">
            <span className={cx("absolute top-1 -left-[25px] size-2.5 rounded-full border-2 border-bg", a.tx_hash ? "bg-teal" : "bg-ink-3")} />
            <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
              <span className="font-medium text-ink">{a.action.replaceAll("_", " ")}</span>
              {a.new_state && a.new_state !== a.previous_state && <span className="text-xs text-ink-3">{a.previous_state ?? "∅"} → <span className="text-ink-2">{a.new_state}</span></span>}
              <span className="text-xs text-ink-3">· {a.actor ?? "system"} · {fmtDate(a.at, true)}</span>
            </div>
            {a.tx_hash && (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                {ev && <span className="mono text-teal">{ev.event}</span>}
                {ev && <span>block {ev.block}</span>}
                <Hash value={a.tx_hash} href={txHref(a.tx_hash)} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

