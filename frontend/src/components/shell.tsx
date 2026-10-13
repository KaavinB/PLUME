"use client";

import { BookOpenCheck, ChevronDown, Code, Database, Eye, FileSearch, Film, Gavel, Landmark, Link2, ListChecks, Radar, ScrollText, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useMeta, useSession } from "@/lib/session";
import { REPO_URL, SNAPSHOT_DATE, STATIC_SNAPSHOT, VIDEO_URL } from "@/lib/snapshot";
import { DemoGuide } from "./demo-guide";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Mission Control", icon: Radar, match: (p: string) => p === "/" },
  { href: "/incidents", label: "Incidents", icon: ListChecks, match: (p: string) => p.startsWith("/incidents") },
  { href: "/investigations", label: "Investigations", icon: FileSearch, match: (p: string) => p.startsWith("/investigations") },
  { href: "/projects", label: "Repair Bounties", icon: Wrench, match: (p: string) => p.startsWith("/projects") },
  { href: "/verification", label: "Verification", icon: Gavel, match: (p: string) => p.startsWith("/verification") },
  { href: "/ledger", label: "Impact Ledger", icon: Landmark, match: (p: string) => p.startsWith("/ledger") || p.startsWith("/receipts") },
  { href: "/about", label: "How PLUME works", icon: BookOpenCheck, match: (p: string) => p.startsWith("/about") },
];

export function BrandMark({ className }: { className?: string }) {
  // A reticle (observation) with a rising plume line (the "bug") passing through it.
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
      <path d="M16 3v4M16 25v4M3 16h4M25 16h4" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 22c0-4 5-4 5-8s-3-4-1-8" fill="none" stroke="var(--amber)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M17 22c0-3 4-3 4-6s-2-3-1-6" fill="none" stroke="var(--amber)" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Rail() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="no-print flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-3">
      <Link href="/" aria-label="PLUME home" className="mb-3 text-ink">
        <BrandMark className="size-8" />
      </Link>
      {NAV.map(({ href, label, icon: Icon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cx(
              "group relative flex size-10 items-center justify-center rounded-md transition-colors",
              active ? "bg-surface-3 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
              href === "/about" && "mt-auto",
            )}
          >
            {active && <span className="absolute left-[-10px] h-5 w-[3px] rounded-r bg-amber" aria-hidden />}
            <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden />
            <span className="pointer-events-none absolute left-full z-50 ml-3 hidden rounded-md border border-line-strong bg-surface-3 px-2 py-1 text-xs whitespace-nowrap text-ink shadow-lg group-hover:block group-focus-visible:block">
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function ModePill({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: "amber" | "sim" | "teal" | "red" }) {
  const dot = { amber: "bg-amber", sim: "bg-sim", teal: "bg-teal", red: "bg-bad" }[tone];
  return (
    <div className="hidden items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs lg:flex" title={`${label}: ${value}`}>
      <span className={cx("size-1.5 rounded-full", dot)} aria-hidden />
      <span className="text-ink-3">{icon}</span>
      <span className="text-ink-2">{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

const PERSONA_ORDER = ["sponsor", "provider", "verifier", "observer", "admin", "contractor-unapproved"];
const PERSONA_HINT: Record<string, string> = {
  sponsor: "Creates & funds repair bounties",
  provider: "Accepts work, submits evidence",
  verifier: "Reviews evidence, signs decisions",
  observer: "Read-only public view",
  admin: "Approves participants; cannot move funds",
  "contractor-unapproved": "Not approved — tests authorization",
};

function PersonaSwitcher() {
  const { user, loginAs, logout, ready } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-testid="persona-switcher"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface-2 pr-2 pl-2.5 text-xs hover:bg-surface-3"
      >
        <span className="text-ink-3">Acting as</span>
        <span className="font-medium text-ink">{!ready ? "…" : user ? user.display_name : "Guest (read-only)"}</span>
        {user && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] tracking-wider text-ink-2 uppercase">{user.role}</span>}
        <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-80 rounded-lg border border-line-strong bg-surface-2 p-1.5 shadow-2xl">
          <div className="px-2.5 pt-1.5 pb-2 text-[11px] text-ink-3">
            Demo personas · fictional organisations · local test keys only
          </div>
          {PERSONA_ORDER.map((id) => (
            <button
              key={id}
              role="menuitem"
              type="button"
              data-testid={`persona-${id}`}
              disabled={busy !== null}
              onClick={async () => {
                setBusy(id);
                try {
                  await loginAs(id);
                  setOpen(false);
                } finally {
                  setBusy(null);
                }
              }}
              className={cx(
                "flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-2 text-left hover:bg-surface-3",
                user?.id === id && "bg-surface-3",
              )}
            >
              <span>
                <span className="block text-[13px] text-ink capitalize">{id.replace("-", " ")}</span>
                <span className="block text-xs text-ink-3">{PERSONA_HINT[id]}</span>
              </span>
              {busy === id && <span className="text-xs text-ink-3">…</span>}
            </button>
          ))}
          {user && (
            <button type="button" role="menuitem" onClick={() => { logout(); setOpen(false); }} className="mt-1 w-full rounded-md border-t border-line px-2.5 pt-2 pb-1.5 text-left text-xs text-ink-3 hover:text-ink">
              Sign out (guest view)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TopBar() {
  const { data: meta } = useMeta();
  const chainTime = meta?.chain.chain_time ? new Date(meta.chain.chain_time * 1000).toISOString().slice(0, 10) : null;
  return (
    <header className="no-print flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
      <div className="flex items-center gap-3">
        <span className="text-[15px] font-semibold tracking-[0.18em] text-ink">PLUME</span>
        <span className="hidden text-xs text-ink-3 xl:inline">The planet has bugs. Let&apos;s fix them.</span>
      </div>
      <div className="flex items-center gap-2" data-testid="mode-bar">
        <ModePill icon={<Database className="size-3.5" />} label="Data" value={meta ? `Historical · ${meta.data.mode}` : "…"} tone="amber" />
        <ModePill icon={<Wrench className="size-3.5" />} label="Repair" value="Simulated" tone="sim" />
        <ModePill
          icon={<Link2 className="size-3.5" />}
          label="Chain"
          value={meta ? (STATIC_SNAPSHOT ? `${meta.chain.name} · recorded` : meta.chain.connected ? `${meta.chain.name}${chainTime ? ` · ${chainTime}` : ""}` : "offline") : "…"}
          tone={meta?.chain.connected ? "teal" : "red"}
        />
        <ModePill icon={<ScrollText className="size-3.5" />} label="Reports" value={meta ? (meta.llm.model ?? "template") : "…"} tone="teal" />
        <DemoGuide />
        {STATIC_SNAPSHOT ? <SnapshotPill /> : <PersonaSwitcher />}
      </div>
    </header>
  );
}

function SnapshotPill() {
  return (
    <span className="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 text-xs" title="No backend behind this site: every page is read-only">
      <Eye className="size-3.5 text-ink-3" aria-hidden />
      <span className="text-ink-3">Viewing as</span>
      <span className="font-medium text-ink">Guest · read-only snapshot</span>
    </span>
  );
}

/** Shown on the GitHub Pages build only: what this site is, and where the live app and video are. */
function SnapshotBanner() {
  return (
    <div className="no-print flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-[#43386a] bg-[rgba(180,156,240,0.08)] px-4 py-1.5 text-center text-xs text-ink-2" role="note">
      <span>
        <b className="text-ink">Static snapshot</b> of PLUME{SNAPSHOT_DATE ? `, exported ${SNAPSHOT_DATE}` : ""} from a local run: real Carbon Mapper data, a simulated repair project, and
        transactions recorded from a local Anvil chain. No backend runs here, so actions are disabled.
      </span>
      <a href={VIDEO_URL} className="inline-flex items-center gap-1 text-teal hover:underline"><Film className="size-3.5" aria-hidden /> 4.5-min demo video</a>
      <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline"><Code className="size-3.5" aria-hidden /> Run it live (GitHub)</a>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="print-full flex h-dvh overflow-hidden">
      <Rail />
      <div className="print-full flex min-w-0 flex-1 flex-col">
        {STATIC_SNAPSHOT && <SnapshotBanner />}
        <TopBar />
        <main className="print-full relative min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
