"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, FlaskConical, Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Badge, Button, ErrorBox, Label, PageHeader, Panel, SimBadge, Skeleton, cx } from "@/components/ui";
import { apiGet, apiPost } from "@/lib/api";
import { fmtNum, sectorName } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { IncidentDetail, Project, User } from "@/lib/types";
import { READ_ONLY_MESSAGE, STATIC_SNAPSHOT } from "@/lib/snapshot";

const METHODS = {
  QUANTIFIED_REDUCTION: {
    label: "Verified quantified reduction",
    body: "Repair completion plus comparable pre/post site measurements showing a reduction beyond measurement uncertainty, over a minimum monitoring period.",
  },
  REPAIR_COMPLETION: {
    label: "Verified repair completion",
    body: "Documented repair plus an independent post-repair survey. No quantified emission reduction will be claimed.",
  },
} as const;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <span className="block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

const inputCls = "w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-teal focus:outline-none";

export function NewProject() {
  const router = useRouter();
  const sp = useSearchParams();
  const code = sp.get("incident") ?? "";
  const { user } = useSession();
  const incident = useQuery({ queryKey: ["incident", code], queryFn: () => apiGet<IncidentDetail>(`/incidents/${code}`), enabled: !!code });
  const providers = useQuery({ queryKey: ["participants", "provider"], queryFn: () => apiGet<User[]>("/participants?role=provider") });
  const verifiers = useQuery({ queryKey: ["participants", "verifier"], queryFn: () => apiGet<User[]>("/participants?role=verifier") });

  const sectorIsLandfill = incident.data?.sector === "6A";
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [auth, setAuth] = useState("Sponsor attests that the facility operator has authorized the assigned provider to inspect and repair equipment at this location (simulated attestation).");
  const [milestones, setMilestones] = useState([
    { name: "Pre-repair survey", description: "Locate emitting components at the plume origin." },
    { name: "Repair", description: "Repair or replace emitting components." },
    { name: "Post-repair verification", description: "Independent re-survey and site measurements." },
  ]);
  const [method, setMethod] = useState<keyof typeof METHODS>("QUANTIFIED_REDUCTION");
  const [minDays, setMinDays] = useState(21);
  const [amount, setAmount] = useState("2.5");
  const [provider, setProvider] = useState("provider");
  const [verifier, setVerifier] = useState("verifier");
  const [expires, setExpires] = useState(120);
  const [dispute, setDispute] = useState(0);
  const [stage, setStage] = useState<"form" | "review">("form");

  const effTitle = title || (incident.data ? `${sectorIsLandfill ? "Landfill gas collection repair" : "Leak detection & repair"} at ${incident.data.code}` : "");
  const effScope =
    scope ||
    (sectorIsLandfill
      ? "Assess and repair the landfill gas collection system and cover integrity in the area of the plume origin; conduct surface emissions monitoring before and after repair."
      : "Conduct a ground leak survey at the plume origin, repair or replace emitting components with operator authorization, and re-survey to confirm repair.");

  const create = useMutation({
    mutationFn: () =>
      apiPost<Project>("/repair-projects", {
        incident_id: code,
        title: effTitle,
        repair_scope: effScope,
        site_authorization: auth,
        milestones,
        methodology: method,
        min_monitoring_days: minDays,
        funding_amount_eth: amount,
        provider_id: provider,
        verifier_id: verifier,
        expires_in_days: expires,
        dispute_window_hours: dispute,
      }),
    onSuccess: (p) => router.push(`/projects/${p.code}?created=1`),
  });

  if (!code) return <div className="p-6"><ErrorBox error="Choose an investigated incident first (open an incident and click “Create repair project”)." title="No incident selected" /></div>;
  if (user && user.role !== "sponsor")
    return <div className="p-6"><ErrorBox error={`You are acting as ${user.role}. Only a project sponsor can create repair bounties — switch persona at top right.`} title="Sponsor role required" /></div>;
  if (STATIC_SNAPSHOT) return <div className="p-6"><ErrorBox error={READ_ONLY_MESSAGE} title="Creating a repair project needs the live app" /></div>;
  if (!user) return <div className="p-6"><ErrorBox error="Select the Sponsor persona (top right) to create a repair project." title="Sign in as a sponsor" /></div>;

  const inc = incident.data;
  const amountOk = /^\d+(\.\d{1,18})?$/.test(amount) && Number(amount) > 0;

  return (
    <div>
      <PageHeader eyebrow={<><SimBadge label="Simulated repair project" /><span>Test-network funds only</span></>} title="Create a repair bounty">
        Define authorized repair work for an investigated incident, the evidence the verifier will require, and the escrowed funding that is released
        only on a signed VERIFIED decision.
      </PageHeader>
      <div className="grid gap-4 p-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {stage === "form" ? (
            <>
              <Panel title="1 · Repair scope & authorization">
                <div className="space-y-4">
                  <Field label="Title"><input className={inputCls} value={effTitle} onChange={(e) => setTitle(e.target.value)} /></Field>
                  <Field label="Repair scope" hint="Describe the authorized work. Remote sensing cannot identify the component; the scope should start with a ground survey.">
                    <textarea className={cx(inputCls, "min-h-24")} value={effScope} onChange={(e) => setScope(e.target.value)} />
                  </Field>
                  <Field label="Site authorization" hint="PLUME coordinates authorized work only. The sponsor attests that the operator authorized access.">
                    <textarea className={cx(inputCls, "min-h-16")} value={auth} onChange={(e) => setAuth(e.target.value)} />
                  </Field>
                </div>
              </Panel>
              <Panel title="2 · Milestones" actions={<Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setMilestones((m) => [...m, { name: "", description: "" }])}>Add</Button>}>
                <div className="space-y-2">
                  {milestones.map((m, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="num mt-2 w-5 text-xs text-ink-3">{i + 1}</span>
                      <input className={cx(inputCls, "w-48")} value={m.name} placeholder="Name" onChange={(e) => setMilestones((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                      <input className={inputCls} value={m.description} placeholder="Description" onChange={(e) => setMilestones((all) => all.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                      <Button size="sm" variant="ghost" aria-label="Remove milestone" onClick={() => setMilestones((all) => all.filter((_, j) => j !== i))} disabled={milestones.length === 1}><Trash2 className="size-3.5" /></Button>
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel title="3 · Verification methodology & evidence requirements">
                <div className="grid gap-3 md:grid-cols-2">
                  {(Object.keys(METHODS) as (keyof typeof METHODS)[]).map((k) => (
                    <button key={k} type="button" onClick={() => setMethod(k)} aria-pressed={method === k} className={cx("rounded-md border p-3 text-left", method === k ? "border-teal bg-[rgba(79,179,169,0.06)]" : "border-line hover:border-line-strong")}>
                      <div className="text-sm font-medium text-ink">{METHODS[k].label}</div>
                      <div className="mt-1 text-xs leading-relaxed text-ink-2">{METHODS[k].body}</div>
                    </button>
                  ))}
                </div>
                {method === "QUANTIFIED_REDUCTION" && (
                  <div className="mt-4 w-56"><Field label="Minimum post-repair monitoring (days)"><input type="number" min={0} max={365} className={inputCls} value={minDays} onChange={(e) => setMinDays(Number(e.target.value))} /></Field></div>
                )}
                <p className="mt-3 text-[11px] text-ink-3">
                  Required documents: work order, pre-repair survey, post-repair survey{method === "QUANTIFIED_REDUCTION" ? ", measurement report" : ""}. A later satellite
                  non-detection is never accepted as proof.
                </p>
              </Panel>
              <Panel title="4 · Parties, funding & deadlines">
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Repair provider" hint="Must be approved in the escrow registry to be funded.">
                    <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>
                      {providers.data?.map((u) => <option key={u.id} value={u.id}>{u.display_name} — {u.organization}</option>)}
                    </select>
                  </Field>
                  <Field label="Independent verifier" hint="Must differ from sponsor and provider (enforced on-chain).">
                    <select className={inputCls} value={verifier} onChange={(e) => setVerifier(e.target.value)}>
                      {verifiers.data?.map((u) => <option key={u.id} value={u.id}>{u.display_name} — {u.organization}</option>)}
                    </select>
                  </Field>
                  <Field label="Escrow amount (test ETH)" hint="Local Anvil / testnet currency only. No real-world value.">
                    <input className={cx(inputCls, !amountOk && "border-bad")} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Expires (days)"><input type="number" min={1} max={730} className={inputCls} value={expires} onChange={(e) => setExpires(Number(e.target.value))} /></Field>
                    <Field label="Dispute window (h)"><input type="number" min={0} max={720} className={inputCls} value={dispute} onChange={(e) => setDispute(Number(e.target.value))} /></Field>
                  </div>
                </div>
              </Panel>
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => setStage("review")} disabled={!amountOk || !inc} icon={<ArrowRight className="size-4" />} data-testid="review-terms">Review terms</Button>
              </div>
            </>
          ) : (
            <Panel title="5 · Review terms" subtitle="These terms are hashed (keccak-256) and the hash is stored in the escrow contract.">
              <dl className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
                <dt className="text-ink-3">Incident</dt><dd className="mono">{code}</dd>
                <dt className="text-ink-3">Title</dt><dd>{effTitle}</dd>
                <dt className="text-ink-3">Scope</dt><dd className="text-ink-2">{effScope}</dd>
                <dt className="text-ink-3">Authorization</dt><dd className="text-ink-2">{auth}</dd>
                <dt className="text-ink-3">Milestones</dt><dd>{milestones.map((m) => m.name).join(" → ")}</dd>
                <dt className="text-ink-3">Methodology</dt><dd>{METHODS[method].label}{method === "QUANTIFIED_REDUCTION" ? ` · ≥ ${minDays} days monitoring` : ""}</dd>
                <dt className="text-ink-3">Provider / verifier</dt><dd>{provider} / {verifier}</dd>
                <dt className="text-ink-3">Escrow</dt><dd className="num">{amount} test ETH · expires in {expires} days · dispute window {dispute} h</dd>
              </dl>
              <div className="mt-4 rounded-md border border-[#43386a] bg-[rgba(180,156,240,0.06)] p-3 text-xs text-ink-2">
                <FlaskConical className="mr-1.5 inline size-3.5 text-sim" />
                This creates a <b className="text-ink">simulated</b> project on a test network. It does not fund real repair work.
              </div>
              {create.error && <div className="mt-3"><ErrorBox error={create.error} title="Could not create project" /></div>}
              <div className="mt-4 flex justify-between">
                <Button variant="ghost" onClick={() => setStage("form")}>Back</Button>
                <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} data-testid="create-draft">Create draft project</Button>
              </div>
            </Panel>
          )}
        </div>

        <div className="space-y-4">
          <Panel title="Incident">
            {incident.isPending ? <Skeleton className="h-28" /> : incident.error ? <ErrorBox error={incident.error} /> : inc && (
              <div className="space-y-2 text-[13px]">
                <div className="mono text-ink">{inc.code}</div>
                <div className="flex flex-wrap gap-1"><Badge tone="amber">Historical data</Badge><Badge>{sectorName(inc.sector)}</Badge></div>
                <p className="text-ink-2">{inc.observation_count} detections on {inc.detection_date_count} dates · median {fmtNum(inc.median_rate_kg_h)} kg/h · priority {fmtNum(inc.priority_score, 1)}</p>
                {inc.investigations.length === 0 && <ErrorBox error="This incident has not been investigated. The API will refuse to create a project until it is." title="Investigation required" />}
              </div>
            )}
          </Panel>
          <Panel title="What happens next">
            <ol className="space-y-2 text-xs leading-relaxed text-ink-2">
              <li><b className="text-ink">Draft</b> — terms stored and hashed.</li>
              <li><b className="text-ink">Publish</b> — <span className="mono">createProject</span> registers sponsor, provider, verifier, amount and terms hash on-chain. The contract rejects unapproved or non-independent parties.</li>
              <li><b className="text-ink">Fund</b> — exact amount deposited into escrow.</li>
              <li><b className="text-ink">Assign → evidence → verify</b> — only the verifier&apos;s EIP-712 signature over the exact evidence hash can unlock payment.</li>
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}
