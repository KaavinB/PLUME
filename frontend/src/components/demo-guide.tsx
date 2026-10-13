"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Compass } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { apiGet } from "@/lib/api";
import { useMeta, useSession } from "@/lib/session";
import { STATIC_SNAPSHOT } from "@/lib/snapshot";
import type { IncidentDetail, ProjectBrief } from "@/lib/types";
import { cx } from "./ui";

const ORDER = ["DRAFT", "OPEN_FOR_FUNDING", "FUNDED", "ASSIGNED", "REPAIR_SUBMITTED", "UNDER_VERIFICATION", "VERIFIED", "PAID"];
const rank = (s?: string) => (s ? Math.max(ORDER.indexOf(s), ["REJECTED", "INCONCLUSIVE", "ADDITIONAL_EVIDENCE_REQUIRED", "DISPUTED"].includes(s) ? 5 : -1) : -1);

export function DemoGuide() {
  const pathname = usePathname();
  const { user } = useSession();
  const { data: meta } = useMeta();
  const primary = meta?.featured_incidents.find((f) => f.role === "primary")?.code ?? "INC-32893D";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const toggle = () => setOpen((o) => !o);

  const incident = useQuery({ queryKey: ["incident", primary], queryFn: () => apiGet<IncidentDetail>(`/incidents/${primary}`), refetchInterval: 8000 });
  const projects = useQuery({
    queryKey: ["projects", "incident", primary],
    queryFn: () => apiGet<{ items: ProjectBrief[] }>(`/repair-projects?incident=${primary}`),
    refetchInterval: 5000,
  });
  const project = projects.data?.items.find((p) => p.status !== "CANCELLED" && p.status !== "DRAFT") ?? projects.data?.items[0];
  const inv = incident.data?.investigations[0];
  const r = rank(project?.status);
  const proj = project ? `/projects/${project.code}` : `/projects/new?incident=${primary}`;

  const steps: { label: string; who?: string; href: string; done: boolean; sim?: boolean }[] = [
    { label: "Open Mission Control", href: "/", done: true },
    { label: `Select real observation ${primary}`, href: `/?incident=${primary}`, done: pathname !== "/" || !!inv },
    { label: "Review metadata & provenance", href: `/incidents/${primary}`, done: !!inv || pathname.startsWith("/incidents/") },
    { label: "Run investigation", who: "sponsor", href: `/incidents/${primary}`, done: !!inv },
    { label: "Read evidence-grounded report", href: inv ? `/investigations/${inv.id}` : `/incidents/${primary}`, done: !!project },
    { label: "Create repair project", who: "sponsor", href: proj, done: !!project, sim: true },
    { label: "Publish & fund escrow", who: "sponsor", href: proj, done: r >= 2, sim: true },
    { label: "Accept & submit simulated evidence", who: "provider", href: proj, done: r >= 4, sim: true },
    { label: "Review evidence", who: "verifier", href: project ? `/verification/${project.code}` : "/verification", done: r >= 6 || project?.status === "UNDER_VERIFICATION", sim: true },
    { label: "Sign decision (approve / reject)", who: "verifier", href: project ? `/verification/${project.code}` : "/verification", done: r >= 6, sim: true },
    { label: "Settle escrow on-chain", who: "any party", href: proj, done: project?.status === "PAID", sim: true },
    { label: "Open Impact Receipt & View Proof", href: proj, done: pathname.startsWith("/receipts"), sim: true },
  ];
  const next = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={toggle} className="flex h-8 items-center gap-2 rounded-md border border-[#5c4318] bg-[rgba(242,169,59,0.08)] px-2.5 text-xs" aria-expanded={open} data-testid="demo-guide-toggle">
        <Compass className="size-3.5 text-amber" aria-hidden />
        <span className="font-medium text-ink">Guided demo</span>
        <span className="num text-ink-3">
          {doneCount}/{steps.length}
        </span>
        {open ? <ChevronUp className="size-3.5 text-ink-3" /> : <ChevronDown className="size-3.5 text-ink-3" />}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[320px] rounded-lg border border-line-strong bg-surface-2 px-3 pt-2 pb-3 shadow-2xl" role="dialog" aria-label="Guided demo steps">
          <ol className="space-y-0.5">
            {steps.map((s, i) => (
              <li key={s.label}>
                <Link
                  href={s.href}
                  className={cx(
                    "flex items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-surface-2",
                    i === next ? "text-ink" : s.done ? "text-ink-3" : "text-ink-2",
                  )}
                >
                  <span
                    className={cx(
                      "mt-px flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px]",
                      s.done ? "border-transparent bg-[rgba(107,203,119,0.15)] text-ok" : i === next ? "border-amber text-amber" : "border-line-strong text-ink-3",
                    )}
                  >
                    {s.done ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="flex-1">
                    {s.label}
                    {s.who && (
                      <span className={cx("ml-1 text-[10px] uppercase tracking-wide", user?.role === s.who ? "text-teal" : "text-ink-3")}>· {s.who}</span>
                    )}
                  </span>
                  {s.sim && <span className="mt-px text-[9px] tracking-wide text-sim uppercase">sim</span>}
                </Link>
              </li>
            ))}
          </ol>
          <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-3">
            Observations are real (Carbon Mapper). Steps marked <span className="text-sim">SIM</span> use a simulated repair, synthetic evidence and
            test-network funds. {STATIC_SNAPSHOT ? "This static snapshot shows the recorded end state; run PLUME locally to step through it." : "Switch persona at top right."}
          </p>
        </div>
      )}
    </div>
  );
}
