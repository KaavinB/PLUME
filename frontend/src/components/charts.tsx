"use client";

import { useMemo, useState } from "react";

import { fmtDate, fmtNum, INSTRUMENTS } from "@/lib/format";
import type { Factor, Measurement, Observation } from "@/lib/types";

const LABELS: Record<string, string> = {
  magnitude: "Reported magnitude",
  recurrence: "Recurrence (distinct dates)",
  provider_persistence: "Provider persistence",
  corroboration: "Independent instruments",
  recency: "Recency",
  measurement_confidence: "Measurement confidence",
  localization: "Localization",
};

/** Horizontal bars: each factor's contribution out of its maximum weight (single series, teal). */
export function PriorityBars({ factors, compact = false }: { factors: Factor[]; compact?: boolean }) {
  return (
    <div className="space-y-2" role="table" aria-label="Priority score breakdown">
      {factors.map((f) => (
        <div key={f.name} role="row" className="group">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span role="cell" className="text-ink-2">{LABELS[f.name] ?? f.name}</span>
            <span role="cell" className="num text-ink">
              {f.value === null ? <span className="text-ink-3">n/a</span> : fmtNum(f.contribution, 1)}
              <span className="text-ink-3"> / {f.weight}</span>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-surface-3" aria-hidden>
            <div className="h-1.5 rounded-full bg-teal" style={{ width: `${(f.contribution / f.weight) * 100}%` }} />
          </div>
          {!compact && <div className="mt-1 text-[11px] leading-snug text-ink-3">{f.evidence}</div>}
        </div>
      ))}
    </div>
  );
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  return Math.ceil(v / p) * p;
}

/** Dot-and-whisker timeline of provider emission estimates (single series: amber). */
export function DetectionTimeline({ observations, selected, onSelect }: { observations: Observation[]; selected?: string | null; onSelect?: (id: string) => void }) {
  const [hover, setHover] = useState<Observation | null>(null);
  const W = 720;
  const H = 210;
  const m = { l: 52, r: 16, t: 14, b: 28 };
  const data = useMemo(() => [...observations].sort((a, b) => a.observed_at.localeCompare(b.observed_at)), [observations]);
  const quant = data.filter((o) => o.emission_rate_kg_h !== null);
  const t0 = new Date(data[0]?.observed_at ?? 0).getTime();
  const t1 = new Date(data[data.length - 1]?.observed_at ?? 0).getTime();
  const pad = Math.max((t1 - t0) * 0.04, 86400000 * 15);
  const xmin = t0 - pad;
  const xmax = t1 + pad;
  const ymax = niceMax(Math.max(...quant.map((o) => (o.emission_rate_kg_h ?? 0) + (o.emission_uncertainty_kg_h ?? 0)), 100));
  const x = (t: number) => m.l + ((t - xmin) / (xmax - xmin)) * (W - m.l - m.r);
  const y = (v: number) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const years: number[] = [];
  for (let yr = new Date(xmin).getUTCFullYear(); yr <= new Date(xmax).getUTCFullYear(); yr++) {
    const t = Date.UTC(yr, 0, 1);
    if (t >= xmin && t <= xmax) years.push(yr);
  }
  const ticks = [0, ymax / 2, ymax];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Emission estimates for ${data.length} detections over time`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
            <text x={m.l - 8} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--text-3)" className="num">
              {v >= 1000 ? `${fmtNum(v / 1000, v % 1000 ? 1 : 0)}K` : fmtNum(v)}
            </text>
          </g>
        ))}
        <text x={12} y={m.t + 4} fontSize={10} fill="var(--text-3)" transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle" dx={-H / 2 + 20}>
          kg/h
        </text>
        {years.map((yr) => (
          <text key={yr} x={x(Date.UTC(yr, 0, 1))} y={H - 8} fontSize={10} fill="var(--text-3)" textAnchor="middle" className="num">
            {yr}
          </text>
        ))}
        {data
          .filter((o) => o.emission_rate_kg_h === null)
          .map((o) => (
            <line key={o.id} x1={x(+new Date(o.observed_at))} x2={x(+new Date(o.observed_at))} y1={H - m.b} y2={H - m.b - 8} stroke="var(--text-3)" strokeWidth={1.5}>
              <title>{`${o.display_id}: detection without provider emission estimate`}</title>
            </line>
          ))}
        {quant.map((o) => {
          const cx = x(+new Date(o.observed_at));
          const r = o.emission_rate_kg_h ?? 0;
          const u = o.emission_uncertainty_kg_h ?? 0;
          const sel = o.display_id === selected;
          return (
            <g key={o.id} onMouseEnter={() => setHover(o)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(o.display_id)} className="cursor-pointer">
              <line x1={cx} x2={cx} y1={y(Math.max(r - u, 0))} y2={y(r + u)} stroke="var(--amber)" strokeOpacity={0.45} strokeWidth={1.5} />
              <circle cx={cx} cy={y(r)} r={sel ? 6 : 4.5} fill="var(--amber)" stroke={sel ? "var(--text)" : "var(--surface)"} strokeWidth={2} />
              <circle cx={cx} cy={y(r)} r={10} fill="transparent" />
            </g>
          );
        })}
        <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="var(--border-strong)" strokeWidth={1} />
      </svg>
      {hover && (
        <div className="pointer-events-none absolute top-1 right-2 rounded-md border border-line-strong bg-surface-3 px-2.5 py-1.5 text-xs shadow-lg">
          <div className="mono text-[11px] text-ink-2">{hover.display_id}</div>
          <div className="num text-ink">
            {fmtNum(hover.emission_rate_kg_h)} ± {fmtNum(hover.emission_uncertainty_kg_h)} kg/h
          </div>
          <div className="text-ink-3">
            {fmtDate(hover.observed_at)} · {INSTRUMENTS[hover.instrument ?? ""] ?? hover.instrument}
          </div>
        </div>
      )}
      <p className="mt-1 text-[11px] text-ink-3">
        Dots: provider instantaneous estimate at overpass time; whiskers ±1σ. Ticks on the baseline: detections without an estimate.
      </p>
    </div>
  );
}

/** Pre/post site measurements on a time axis with the repair completion marker (single series). */
export function MeasurementChart({ pre, post, completedAt }: { pre: Measurement; post: Measurement[]; completedAt: string }) {
  const W = 640;
  const H = 200;
  const m = { l: 52, r: 16, t: 14, b: 30 };
  const pts = [pre, ...post];
  const ts = pts.map((p) => +new Date(p.measured_at));
  const tc = +new Date(completedAt);
  const xmin = Math.min(...ts, tc) - 86400000;
  const xmax = Math.max(...ts, tc) + 86400000;
  const ymax = niceMax(Math.max(...pts.map((p) => p.rate_kg_h + p.uncertainty_kg_h)));
  const x = (t: number) => m.l + ((t - xmin) / (xmax - xmin)) * (W - m.l - m.r);
  const y = (v: number) => H - m.b - (v / ymax) * (H - m.t - m.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Pre- and post-repair site measurements (simulated)">
      {[0, ymax / 2, ymax].map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="var(--border)" />
          <text x={m.l - 8} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--text-3)" className="num">
            {fmtNum(v)}
          </text>
        </g>
      ))}
      <line x1={x(tc)} x2={x(tc)} y1={m.t} y2={H - m.b} stroke="var(--teal)" strokeWidth={1} />
      <text x={x(tc) + 4} y={m.t + 8} fontSize={10} fill="var(--text-2)">
        repair completed
      </text>
      {pts.map((p, i) => {
        const cx = x(+new Date(p.measured_at));
        return (
          <g key={p.measured_at}>
            <line x1={cx} x2={cx} y1={y(Math.max(p.rate_kg_h - p.uncertainty_kg_h, 0))} y2={y(p.rate_kg_h + p.uncertainty_kg_h)} stroke="var(--sim)" strokeOpacity={0.5} strokeWidth={1.5} />
            <circle cx={cx} cy={y(p.rate_kg_h)} r={5} fill="var(--sim)" stroke="var(--surface)" strokeWidth={2}>
              <title>{`${i === 0 ? "Pre-repair" : "Post-repair"} ${fmtDate(p.measured_at)}: ${fmtNum(p.rate_kg_h, 1)} ± ${fmtNum(p.uncertainty_kg_h, 1)} kg/h`}</title>
            </circle>
            <text x={cx} y={y(p.rate_kg_h) - 10} fontSize={10} fill="var(--text-2)" textAnchor="middle" className="num">
              {i === 0 || i === pts.length - 1 ? fmtNum(p.rate_kg_h, p.rate_kg_h < 100 ? 1 : 0) : ""}
            </text>
            <text x={cx} y={H - 10} fontSize={10} fill="var(--text-3)" textAnchor="middle" className="num">
              {fmtDate(p.measured_at).slice(5)}
            </text>
          </g>
        );
      })}
      <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke="var(--border-strong)" />
      <text x={14} y={H / 2} fontSize={10} fill="var(--text-3)" transform={`rotate(-90 14 ${H / 2})`} textAnchor="middle">
        kg/h
      </text>
    </svg>
  );
}

export function RateLegend() {
  const stops = [
    ["#6b4a1a", "< 100"],
    ["#94651f", "100"],
    ["#c48327", "300"],
    ["#eba039", "1K"],
    ["#ffc56a", "3K"],
    ["#ffe3a8", "10K+"],
  ];
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full">
        {stops.map(([c]) => (
          <div key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="num mt-1 flex justify-between text-[10px] text-ink-3">
        {stops.map(([c, l]) => (
          <span key={c}>{l}</span>
        ))}
      </div>
    </div>
  );
}
