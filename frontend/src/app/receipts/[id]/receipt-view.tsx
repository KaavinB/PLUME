"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Blocks, Coins, Download, FileSearch, Fingerprint, Gavel, Printer, Radar, Scale, ScrollText, ShieldCheck, Wrench, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { use, useState, type ReactNode } from "react";
import type { Hex } from "viem";

import { ImpactCalc } from "@/app/verification/[code]/workbench";
import { Badge, Button, CheckIcon, ErrorBox, ExtLink, Hash, KV, Label, PageHeader, PageSkeleton, Panel, SimBadge, StatusChip, cx } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { readProof, type ChainProof } from "@/lib/chain";
import { recordedProof, STATIC_SNAPSHOT } from "@/lib/snapshot";
import { fmtCoord, fmtDate, fmtEth, fmtNum, sectorName } from "@/lib/format";
import type { Receipt } from "@/lib/types";

function ProofNode({ i, icon: Icon, title, kind, children, defaultOpen = false }: { i: number; icon: LucideIcon; title: string; kind: "real" | "computed" | "simulated" | "onchain"; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = { real: "text-amber", computed: "text-teal", simulated: "text-sim", onchain: "text-ok" }[kind];
  const label = { real: "Real data", computed: "Computed", simulated: "Simulated", onchain: "On-chain" }[kind];
  return (
    <motion.li initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06, duration: 0.25 }} className="relative pl-12">
      <span className={cx("absolute top-2.5 left-0 flex size-8 items-center justify-center rounded-full border border-line-strong bg-surface", tone)}>
        <Icon className="size-4" />
      </span>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface-2">
        <span>
          <span className="num mr-2 text-xs text-ink-3">{String(i + 1).padStart(2, "0")}</span>
          <span className="text-sm font-medium text-ink">{title}</span>
        </span>
        <span className={cx("text-[10px] tracking-wider uppercase", tone)}>{label}</span>
      </button>
      {open && <div className="mx-3 mb-3 rounded-md border border-line bg-surface-2 p-3 text-xs">{children}</div>}
    </motion.li>
  );
}

export function ReceiptView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useQuery({ queryKey: ["receipt", id], queryFn: () => apiGet<Receipt>(`/receipts/${id}`) });
  const pl = q.data?.payload;
  const proof = useQuery({
    queryKey: ["chain-proof", id],
    enabled: !!pl,
    queryFn: async (): Promise<ChainProof & { recordedAt?: string }> => {
      if (!STATIC_SNAPSHOT) return readProof(pl!.chain.chain_id, pl!.chain.network, pl!.chain.contract as Hex, pl!.chain.onchain_project_id, pl!.chain.settlement_tx as Hex);
      // Static site: no chain to reach. Show the reads recorded from the local Anvil node at export time.
      const r = await recordedProof(id);
      return {
        state: r.state,
        round: r.round,
        amount: BigInt(r.amount),
        evidenceHash: r.evidenceHash as Hex,
        termsHash: r.termsHash as Hex,
        lastDecisionDigest: r.lastDecisionDigest as Hex,
        provider: r.provider,
        verifier: "",
        settlement: r.settlement ? { status: r.settlement.status, blockNumber: BigInt(r.settlement.blockNumber), from: "", to: null, gasUsed: BigInt(r.settlement.gasUsed) } : null,
        recordedAt: r.recorded_at,
      };
    },
    retry: 0,
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.error || !pl) return <div className="p-6"><ErrorBox error={q.error ?? "missing"} title="Receipt unavailable" /></div>;
  const r = q.data;
  const im = pl.impact;
  const explorer = r.explorer;
  const tx = (h: string) => (explorer ? `${explorer}/tx/${h}` : null);
  const pr = proof.data;
  const events = r.history.chain_events;
  const ev = (name: string) => events.filter((e) => e.event === name);

  const download = () => {
    const blob = new Blob([JSON.stringify({ id: r.id, payload: pl, payload_sha256: r.payload_sha256 }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${r.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const checks = pr
    ? [
        { ok: pr.state === "Paid", label: `Contract state is ${pr.state}` },
        { ok: pr.evidenceHash.toLowerCase() === pl.evidence.hash.toLowerCase(), label: "Evidence hash on-chain matches receipt" },
        { ok: pr.termsHash.toLowerCase() === pl.repair_project.terms_hash.toLowerCase(), label: "Terms hash on-chain matches receipt" },
        { ok: pr.lastDecisionDigest.toLowerCase() === pl.verification.eip712_digest.toLowerCase(), label: "Last decision digest matches the VERIFIED signature" },
        { ok: pr.settlement?.status === "success", label: `Settlement transaction ${pr.settlement ? pr.settlement.status : "not found"}` },
      ]
    : [];

  return (
    <div>
      <PageHeader
        eyebrow={
          <>
            <SimBadge label="Simulated repair · test network" />
            <span>Not a carbon credit · not tradable</span>
          </>
        }
        title={<span>Impact Receipt <span className="mono text-ink-2">{r.id}</span></span>}
        actions={
          <span className="no-print flex gap-2">
            <Button onClick={download} icon={<Download className="size-4" />}>JSON</Button>
            <Button onClick={() => window.print()} icon={<Printer className="size-4" />}>Print</Button>
          </span>
        }
      >
        {pl.label}. Every claim below links to the record it came from;{" "}
        {STATIC_SNAPSHOT ? "in this static snapshot the contract reads were recorded from the local chain at export time." : "the contract state is re-read directly from the chain in your browser."}
      </PageHeader>

      <div className="grid gap-4 p-6 xl:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          <Panel title="Receipt" subtitle={`Payload SHA-256 ${r.payload_sha256.slice(0, 16)}…`}>
            <div className="grid gap-x-8 md:grid-cols-2">
              <div className="divide-y divide-line">
                <KV k="Receipt ID" v={<span className="mono text-xs">{r.id}</span>} />
                <KV k="Incident" v={<Link href={`/incidents/${pl.incident.code}`} className="mono text-xs text-teal">{pl.incident.code}</Link>} />
                <KV k="Location" v={fmtCoord(pl.incident.latitude, pl.incident.longitude)} />
                <KV k="Sector (provider)" v={sectorName(pl.incident.sector)} />
                <KV k="Observation sources" v={`${pl.incident.observation_sources.length} · Carbon Mapper`} />
                <KV k="Repair project" v={<Link href={`/projects/${pl.repair_project.code}`} className="mono text-xs text-teal">{pl.repair_project.code}</Link>} />
                <KV k="Verification result" v={<StatusChip status={pl.verification.result} />} />
                <KV k="Methodology" v={pl.verification.methodology.replaceAll("_", " ").toLowerCase()} />
              </div>
              <div className="divide-y divide-line">
                <KV k="Evidence hash" v={<Hash value={pl.evidence.hash} />} />
                <KV k="Calculation" v={im.calculation_version} />
                <KV k="Network" v={`${pl.chain.network} (${pl.chain.chain_id})`} />
                <KV k="Contract" v={<Hash value={pl.chain.contract} />} />
                <KV k="On-chain project" v={`#${pl.chain.onchain_project_id}`} />
                <KV k="Settlement tx" v={<Hash value={pl.chain.settlement_tx} href={tx(pl.chain.settlement_tx)} />} />
                <KV k="Verified at" v={fmtDate(pl.verification.decided_at, true)} />
                <KV k="Settled (chain time)" v={fmtDate(pl.chain.settled_at_chain_time, true)} />
              </div>
            </div>
            <div className="mt-4 rounded-md border border-line p-3">
              <div className="flex items-center justify-between">
                <Label>Reduction estimate</Label>
                {im.is_simulated && <SimBadge label="From simulated measurements" />}
              </div>
              {im.status === "quantified" ? (
                <div className="mt-2 flex flex-wrap items-end gap-6">
                  <div>
                    <div className="num text-2xl font-semibold text-sim">{fmtNum((im.ch4_avoided_kg ?? 0) / 1000, 1)} t CH₄</div>
                    <div className="num text-xs text-ink-3">range {fmtNum((im.ch4_avoided_kg_low ?? 0) / 1000, 1)}–{fmtNum((im.ch4_avoided_kg_high ?? 0) / 1000, 1)} t (±1σ)</div>
                  </div>
                  <div>
                    <div className="num text-2xl font-semibold text-sim">{fmtNum((im.co2e_avoided_kg ?? 0) / 1000, 0)} t CO₂e</div>
                    <div className="text-xs text-ink-3">GWP-100 = {im.gwp_value} ({im.gwp_basis.replace("_", "-")} CH₄)</div>
                  </div>
                  <div className="text-xs text-ink-3">over {fmtNum((im.supported_duration_h ?? 0) / 24, 0)} documented days only</div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-ink-2">Not quantified — {im.reason}</p>
              )}
              <p className="mt-2 text-[11px] text-ink-3">
                {im.is_simulated
                  ? "This figure is computed from synthetic measurements in a labelled simulation. It is not a real-world emission reduction."
                  : "Computed from verifier-accepted measurements."}
              </p>
            </div>
          </Panel>

          <Panel
            title={STATIC_SNAPSHOT ? "Independent chain check (recorded)" : "Independent chain check"}
            subtitle={STATIC_SNAPSHOT ? `Recorded from the local Anvil RPC${pr?.recordedAt ? ` at ${fmtDate(pr.recordedAt, true)}` : ""}; a static site cannot reach that chain` : "Read with viem from the RPC endpoint — not from the PLUME API"}
            actions={<Blocks className="size-4 text-ok" />}
          >
            {proof.isPending && <p className="text-xs text-ink-3">Reading contract…</p>}
            {proof.error && <ErrorBox error={proof.error} title="Could not reach the chain RPC from the browser" />}
            {pr && (
              <ul className="space-y-2" data-testid="chain-checks">
                {checks.map((c) => (
                  <li key={c.label} className="flex items-center gap-2.5 text-[13px]"><CheckIcon status={c.ok ? "pass" : "fail"} /><span className="text-ink">{c.label}</span></li>
                ))}
                <li className="pt-1 text-[11px] text-ink-3">
                  Escrow amount {fmtEth(pr.amount.toString())} · provider {pr.provider.slice(0, 10)}… · settlement block {pr.settlement?.blockNumber.toString()} · gas{" "}
                  {pr.settlement?.gasUsed.toString()}
                </li>
              </ul>
            )}
          </Panel>

          <Panel title="Methodology & assumptions">
            <ImpactCalc impact={im} />
          </Panel>
        </div>

        <Panel title={<span className="flex items-center gap-2"><Fingerprint className="size-4 text-amber" /> View proof</span>} subtitle="From satellite detection to settlement — open any step">
          <ol className="relative space-y-1 before:absolute before:top-4 before:bottom-4 before:left-4 before:w-px before:bg-line" data-testid="proof-chain">
            <ProofNode i={0} icon={Radar} title="Original observation" kind="real" defaultOpen>
              <p className="text-ink-2">{pl.incident.observation_sources.length} methane plume detections grouped into {pl.incident.code}.</p>
              <ul className="mt-2 max-h-36 space-y-0.5 overflow-y-auto">
                {pl.incident.observation_sources.slice(0, 60).map((o) => (
                  <li key={o.id} className="flex justify-between gap-2">
                    <span className="mono text-ink-2">{o.id}</span>
                    <span className="num text-ink">{o.emission_rate_kg_h !== null ? `${fmtNum(o.emission_rate_kg_h)} kg/h` : "—"}</span>
                  </li>
                ))}
              </ul>
            </ProofNode>
            <ProofNode i={1} icon={ScrollText} title="Original source reference" kind="real">
              <p className="text-ink-2">Carbon Mapper Data Platform API. Each record retains its provider id, timestamp, units, uncertainty and raw payload digest.</p>
              <div className="mt-1.5"><ExtLink href={pl.incident.observation_sources[0]?.url ?? "https://carbonmapper.org"}>Example record: {pl.incident.observation_sources[0]?.id}</ExtLink></div>
            </ProofNode>
            <ProofNode i={2} icon={FileSearch} title="Investigation" kind="computed">
              {r.investigation ? (
                <>
                  <p className="text-ink-2">{r.investigation.summary}</p>
                  <div className="mt-1.5 flex items-center gap-2"><Badge>{r.investigation.kind === "llm" ? r.investigation.model : "template narrative"}</Badge><Link href={`/investigations/${r.investigation.id}`} className="text-teal">Open report</Link></div>
                </>
              ) : "—"}
            </ProofNode>
            <ProofNode i={3} icon={Wrench} title="Repair submission" kind="simulated">
              <p className="text-ink-2">{pl.repair_project.title}. {pl.repair_project.scope}</p>
              <div className="mt-1.5"><KV k="Terms hash" v={<Hash value={pl.repair_project.terms_hash} />} /></div>
            </ProofNode>
            <ProofNode i={4} icon={Fingerprint} title="Evidence commitment" kind="onchain">
              <KV k="Round" v={pl.evidence.round} />
              <KV k="Manifest keccak-256" v={<Hash value={pl.evidence.hash} />} />
              <KV k="Submission tx" v={<Hash value={pl.evidence.submission_tx} href={tx(pl.evidence.submission_tx)} />} />
              <p className="mt-1 text-ink-3">{ev("EvidenceSubmitted").length} evidence round(s) committed for this project.</p>
            </ProofNode>
            <ProofNode i={5} icon={Gavel} title="Verification decision" kind="onchain">
              <ul className="mb-2 space-y-1">
                {pl.verification.policy_checks.map((c) => (
                  <li key={c.id} className="flex items-center gap-2"><CheckIcon status={c.status} /><span className="text-ink-2">{c.label}</span></li>
                ))}
              </ul>
              <KV k="EIP-712 digest" v={<Hash value={pl.verification.eip712_digest} />} />
              <KV k="Decision tx" v={<Hash value={pl.verification.decision_tx} href={tx(pl.verification.decision_tx)} />} />
              <p className="mt-1 text-ink-3">Earlier decisions for this project: {ev("DecisionRecorded").length - 1}</p>
            </ProofNode>
            <ProofNode i={6} icon={ShieldCheck} title="Smart contract state" kind="onchain">
              {pr ? <p className="text-ink-2">{STATIC_SNAPSHOT ? "Recorded read" : "Live read"}: <span className="mono text-ok">{pr.state}</span>, round {pr.round}, amount {fmtEth(pr.amount.toString())}.</p> : <p className="text-ink-3">Reading…</p>}
              <ul className="mt-1.5 space-y-0.5">
                {events.map((e) => (
                  <li key={`${e.tx_hash}-${e.log_index}`} className="flex justify-between gap-2"><span className="mono text-teal">{e.event}</span><span className="num text-ink-3">block {e.block}</span></li>
                ))}
              </ul>
            </ProofNode>
            <ProofNode i={7} icon={Coins} title="Payment transaction" kind="onchain">
              <KV k="Settlement tx" v={<Hash value={pl.chain.settlement_tx} href={tx(pl.chain.settlement_tx)} />} />
              <KV k="Block" v={pl.chain.settlement_block} />
              <p className="mt-1 text-ink-3">Test-network funds only — not real-world repair funding.</p>
            </ProofNode>
            <ProofNode i={8} icon={Scale} title="Impact methodology" kind="computed">
              <ImpactCalc impact={im} />
            </ProofNode>
          </ol>
        </Panel>
      </div>
    </div>
  );
}
