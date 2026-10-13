import Link from "next/link";

const STEPS = [
  ["Observation", "establishes evidence of a potential problem.", "Real Carbon Mapper plume detections — instrument, timestamp, rate, uncertainty and raw payload preserved."],
  ["Investigation", "supports decisions about what to do.", "Validation, DBSCAN grouping, explainable priority, retrieval of source-linked guidance, and a grounding-checked report."],
  ["Escrow", "establishes a financial commitment.", "A sponsor deposits funds against hashed terms naming an approved provider and an independent verifier."],
  ["Verification", "authorizes settlement.", "The verifier reviews evidence against policy checks and signs an EIP-712 decision bound to the exact evidence hash."],
  ["Blockchain", "preserves an auditable record.", "The contract enforces roles, rounds and replay protection; payment releases only on a VERIFIED signature."],
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="text-xs tracking-wider text-amber uppercase">The planet has bugs. Let&apos;s fix them.</div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Who is fixing it, who is paying, how do we know — and where is the evidence?</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
        Satellites and aircraft already detect large methane emissions, and systems such as UNEP&apos;s Methane Alert and Response System notify
        governments and operators. PLUME does not replace them. It adds an open, programmable repair-funding and verification workflow on top of
        existing observations — the part that turns a detection into an accountable, paid-for repair.
      </p>

      <ol className="mt-8 space-y-3">
        {STEPS.map(([k, v, d], i) => (
          <li key={k} className="flex gap-4 rounded-lg border border-line bg-surface p-4">
            <span className="num flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-xs text-ink-2">{i + 1}</span>
            <div>
              <div className="text-sm"><b className="text-ink">{k}</b> <span className="text-ink-2">{v}</span></div>
              <div className="mt-1 text-[13px] text-ink-3">{d}</div>
            </div>
          </li>
        ))}
      </ol>

      <h2 className="mt-10 text-lg font-semibold">What is real, what is simulated</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-line p-4 text-[13px] text-ink-2"><div className="mb-1 font-medium text-amber">Real</div>10,098 historical CH₄ plume detections in the Permian Basin retrieved from the Carbon Mapper public API (snapshot with provenance and SHA-256).</div>
        <div className="rounded-lg border border-line p-4 text-[13px] text-ink-2"><div className="mb-1 font-medium text-teal">Executed</div>Ingestion, grouping, scoring, report generation, policy checks, impact maths, EIP-712 signing and every escrow transaction run for real on a local or test chain.</div>
        <div className="rounded-lg border border-line p-4 text-[13px] text-ink-2"><div className="mb-1 font-medium text-sim">Simulated</div>Repair work, repair documents, site measurements, organisations and funds. Simulated outputs are labelled everywhere and never mixed with real data.</div>
      </div>

      <h2 className="mt-10 text-lg font-semibold">Trust boundary</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
        A blockchain cannot observe methane. The contract guarantees that only the project&apos;s designated, independent verifier — by signing the
        exact evidence hash for the current review round — can unlock payment, that rejected or inconclusive decisions cannot pay out, that funds are
        never paid twice, and that the administrator has no path to escrowed funds. Whether a repair actually worked remains a judgement by the
        verifier, recorded with its inputs and published for inspection. A later satellite overpass without a detected plume is never treated as
        proof of repair.
      </p>

      <h2 className="mt-10 text-lg font-semibold">Credits</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
        Methane observations: Carbon Mapper (carbonmapper.org), used under its Terms of Use. Basemaps: © CARTO, © OpenStreetMap contributors; imagery
        © Esri. Remediation guidance links to US EPA, IEA, UNEP and eCFR publications. GWP values: IPCC AR6 WG1 Chapter 7.
      </p>
      <Link href="/" className="mt-8 inline-flex h-9 items-center rounded-md bg-amber px-4 text-sm font-medium text-[#1a1206]">Open Mission Control</Link>
    </div>
  );
}
