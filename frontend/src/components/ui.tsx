"use client";

import clsx from "clsx";
import { AlertTriangle, Check, CircleSlash, Copy, ExternalLink, FlaskConical, HelpCircle, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

import { short } from "@/lib/format";

export function cx(...a: Parameters<typeof clsx>) {
  return clsx(...a);
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-amber text-[#1a1206] hover:bg-[#f6b75a]",
        variant === "secondary" && "border border-line-strong bg-surface-2 text-ink hover:bg-surface-3",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-[#5a2522] bg-[rgba(229,83,75,0.08)] text-bad hover:bg-[rgba(229,83,75,0.16)]",
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = "secondary", children, className, icon }: { href: string; variant?: Variant; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors",
        variant === "primary" && "bg-amber text-[#1a1206] hover:bg-[#f6b75a]",
        variant === "secondary" && "border border-line-strong bg-surface-2 text-ink hover:bg-surface-3",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        className,
      )}
    >
      {icon}
      {children}
    </Link>
  );
}

type Tone = "neutral" | "amber" | "teal" | "green" | "red" | "sim";
const toneCls: Record<Tone, string> = {
  neutral: "border-line-strong text-ink-2 bg-surface-2",
  amber: "border-[#5c4318] text-amber bg-[rgba(242,169,59,0.08)]",
  teal: "border-[#1f4a46] text-teal bg-[rgba(79,179,169,0.08)]",
  green: "border-[#244a2a] text-ok bg-[rgba(107,203,119,0.08)]",
  red: "border-[#5a2522] text-bad bg-[rgba(229,83,75,0.08)]",
  sim: "border-[#43386a] text-sim bg-[rgba(180,156,240,0.08)]",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap", toneCls[tone], className)}>
      {children}
    </span>
  );
}

export function SimBadge({ label = "Simulated" }: { label?: string }) {
  return (
    <Badge tone="sim" title="Simulated workflow — not a real-world repair or real funds">
      <FlaskConical className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  OPEN_FOR_FUNDING: "amber",
  FUNDED: "teal",
  ASSIGNED: "teal",
  REPAIR_SUBMITTED: "teal",
  UNDER_VERIFICATION: "amber",
  VERIFIED: "green",
  PAID: "green",
  REJECTED: "red",
  ADDITIONAL_EVIDENCE_REQUIRED: "amber",
  INCONCLUSIVE: "amber",
  DISPUTED: "red",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
  open: "amber",
  investigated: "teal",
  repair_project: "teal",
};

export function StatusChip({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replaceAll("_", " ")}</Badge>;
}

export function CheckIcon({ status }: { status: "pass" | "fail" | "warn" | "n/a" }) {
  const map = {
    pass: { Icon: Check, cls: "text-ok bg-[rgba(107,203,119,0.12)]", label: "Pass" },
    fail: { Icon: X, cls: "text-bad bg-[rgba(229,83,75,0.12)]", label: "Fail" },
    warn: { Icon: AlertTriangle, cls: "text-amber bg-[rgba(242,169,59,0.12)]", label: "Warning" },
    "n/a": { Icon: CircleSlash, cls: "text-ink-3 bg-surface-3", label: "Not applicable" },
  }[status];
  return (
    <span className={cx("inline-flex size-5 shrink-0 items-center justify-center rounded-full", map.cls)} aria-label={map.label} title={map.label}>
      <map.Icon className="size-3" strokeWidth={2.5} aria-hidden />
    </span>
  );
}

export function Panel({ title, actions, children, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold tracking-wide text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium tracking-wider text-ink-3 uppercase">{children}</div>;
}

export function KV({ k, v, mono }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <span className="shrink-0 text-ink-3">{k}</span>
      <span className={cx("min-w-0 truncate text-right text-ink", mono && "mono text-xs")}>{v}</span>
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "amber" | "teal" | "green" | "sim" }) {
  return (
    <div>
      <div className="text-xs text-ink-3">{label}</div>
      <div
        className={cx(
          "num mt-1 text-2xl font-semibold tracking-tight",
          tone === "amber" && "text-amber",
          tone === "teal" && "text-teal",
          tone === "green" && "text-ok",
          tone === "sim" && "text-sim",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-4 p-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-4 w-96" />
      <div className="grid grid-cols-3 gap-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-12 text-center">
      {icon && <div className="mb-3 text-ink-3">{icon}</div>}
      <div className="text-sm font-medium text-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-sm text-ink-3">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error, title = "Something went wrong" }: { error: unknown; title?: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-[#5a2522] bg-[rgba(229,83,75,0.06)] p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
      <div>
        <div className="font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-ink-2">{msg}</div>
      </div>
    </div>
  );
}

export function Hash({ value, n = 6, href }: { value: string | null | undefined; n?: number; href?: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-ink-3">—</span>;
  return (
    <span className="mono inline-flex items-center gap-1 text-xs text-ink">
      <span title={value}>{short(value, n)}</span>
      <button
        type="button"
        className="rounded p-0.5 text-ink-3 hover:text-ink"
        aria-label="Copy to clipboard"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />}
      </button>
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-ink" aria-label="Open in explorer">
          <ExternalLink className="size-3" />
        </a>
      )}
    </span>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      <HelpCircle className="size-3.5 text-ink-3" aria-hidden />
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden w-64 -translate-x-1/2 rounded-md border border-line-strong bg-surface-3 p-2 text-xs font-normal normal-case tracking-normal text-ink-2 shadow-xl group-hover:block group-focus-within:block">
        {children}
      </span>
    </span>
  );
}

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-6 pt-6 pb-5">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-3">{eyebrow}</div>}
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {children && <div className="mt-1.5 max-w-3xl text-sm text-ink-2">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">
      {children}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}
