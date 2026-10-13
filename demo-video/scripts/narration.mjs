// Single source of truth for the PLUME demo video: scene windows, on-screen disclosures and narration.
// `node scripts/narration.mjs` writes one Argo scenes manifest per capture (demos/<id>.scenes.json) and
// demos/lib/plan.json, which the Playwright scripts and the assembler read.
//
// `say` is what Kokoro speaks. `show` (optional) is the subtitle text when the spoken form is spelled out for
// pronunciation. Claims follow DEMO_SCRIPT.md and EVALUATION.md; numbers are asserted against the live UI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Disclosure tags shown in the on-screen strip. Kinds map to the app's own colour tokens.
const REAL = { kind: 'real', label: 'REAL' };
const SIM = { kind: 'sim', label: 'SIM' };
const CHAIN = { kind: 'chain', label: 'CHAIN' };
const MODEL = { kind: 'model', label: 'MODELLED' };

export const SCENES = [
  {
    id: 'plume-01-problem',
    chapter: 'Problem',
    startMs: 0,
    endMs: 25_000,
    tags: [[REAL, 'Historical Carbon Mapper detections, 2019–2026']],
    parts: [
      {
        scene: 'problem',
        say: "Every dot on this map is a real methane plume: more than ten thousand detections over the Permian Basin, from aircraft and satellites, published by Carbon Mapper. Detecting leaks isn't the hard part anymore. The hard part is the next question: who fixes it, who pays, and how does anyone know it was fixed? PLUME is the workflow that comes after detection.",
      },
    ],
  },
  {
    id: 'plume-02-detection',
    chapter: 'Detection',
    startMs: 25_000,
    endMs: 55_000,
    tags: [[REAL, 'Historical detections · provider plume image']],
    parts: [
      { scene: 'labels', say: "Every screen labels what's real and what's simulated." },
      {
        scene: 'detection',
        say: "This is one candidate source: fifty-one detections on twenty-eight different days, from five instruments. That's Carbon Mapper's own plume image, drawn where they put it. We keep what's known, a plume at this point and rate, apart from what's inferred, that these detections share a source, and from what space can't tell us: the operator, or the faulty component.",
      },
    ],
  },
  {
    id: 'plume-03-investigation',
    chapter: 'Investigation',
    startMs: 55_000,
    endMs: 95_000,
    tags: [[REAL, 'Real records · analysis executed live'], [{ kind: 'none', label: 'TEMPLATE' }, 'Deterministic narrative, no LLM']],
    parts: [
      {
        scene: 'investigate',
        say: "As the sponsor, I run an investigation. It's mostly computation, not a chatbot: validation, DBSCAN grouping that matches Carbon Mapper's own at an adjusted Rand index of 0.97, an explainable priority score, and guidance from EPA, IEA and U-N-E-P sources.",
        show: "As the sponsor, I run an investigation. It's mostly computation, not a chatbot: validation, DBSCAN grouping that matches Carbon Mapper's own at an adjusted Rand index of 0.97, an explainable priority score, and guidance from EPA, IEA and UNEP sources.",
      },
      {
        scene: 'report',
        say: "Facts stay apart from possible explanations, each citing evidence. An LLM, if configured, only writes the narrative, and is rejected if it invents a number, an evidence id or a company. Today, it's the deterministic template, and it says so.",
      },
    ],
  },
  {
    id: 'plume-04-funding',
    chapter: 'Funding',
    startMs: 95_000,
    endMs: 130_000,
    tags: [[SIM, 'Simulated sponsor, provider & verifier'], [CHAIN, 'createProject + fund · local Anvil']],
    parts: [
      {
        scene: 'terms',
        say: "The sponsor, think of a municipal climate fund or an operator's own budget, defines the authorised scope, milestones, the evidence the verifier will require, an approved repair provider, and an independent verifier.",
      },
      {
        scene: 'escrow',
        say: "The terms are hashed, and the hash and the funds go into an escrow contract: two real transactions on our local Anvil chain. The contract itself refuses unapproved providers, and any verifier who's also a party.",
      },
    ],
  },
  {
    id: 'plume-05-repair',
    chapter: 'Repair',
    startMs: 130_000,
    endMs: 165_000,
    tags: [[SIM, 'Synthetic evidence · simulated repair'], [CHAIN, 'acceptAssignment + submitEvidence']],
    parts: [
      {
        scene: 'accept',
        say: "The provider accepts the assignment on-chain. The twenty-eight-day monitoring window needs elapsed time, so we fast-forward the local chain's clock.",
      },
      {
        scene: 'evidence',
        say: "The evidence is a clearly labelled synthetic package: a work order, surveys, and pre- and post-repair site measurements. Every file is hashed, and the hash of the whole manifest is committed on-chain. Swap a single byte afterwards, and verification fails.",
      },
    ],
  },
  {
    id: 'plume-06-verification',
    chapter: 'Verification',
    startMs: 165_000,
    endMs: 215_000,
    tags: [[SIM, 'Synthetic measurements'], [MODEL, 'Modelled reduction'], [CHAIN, 'EIP-712 decision recorded']],
    parts: [
      {
        scene: 'review',
        say: "The independent verifier sees the satellite records, the repair record, documents and measurements. Server-side checks confirm complete documentation, an authorised provider, independent parties, consistent timestamps, files matching the on-chain hash, and a reduction beyond measurement uncertainty.",
      },
      {
        scene: 'impact',
        say: "The reduction counts documented monitoring hours only, times the IPCC AR6 warming potential, and it's labelled synthetic. A later satellite pass that sees no plume is never proof.",
      },
      {
        scene: 'sign',
        say: "The verifier signs an EIP-712 message bound to this project, evidence hash and round. Rejected or inconclusive decisions never pay out, and old signatures can't be replayed.",
      },
    ],
  },
  {
    id: 'plume-07-settlement',
    chapter: 'Settlement & Proof',
    startMs: 215_000,
    endMs: 250_000,
    tags: [[CHAIN, 'releasePayment · test ETH only'], [SIM, 'Simulated repair · not a carbon credit']],
    parts: [
      {
        scene: 'release',
        say: 'Only now does the contract release the funds: exactly once, and only to the named provider. And anyone can inspect exactly how that decision was made.',
      },
      {
        scene: 'proof',
        say: "This independent chain check reads the contract straight from the browser, not from our server: five checks, all passing. The proof timeline runs from the original observation, through the investigation, the simulated repair, the evidence and the signed decision, to the contract state and the payment.",
      },
    ],
  },
  {
    id: 'plume-08-closing',
    chapter: 'Closing',
    startMs: 250_000,
    endMs: 270_000,
    tags: [[REAL, 'Observations'], [SIM, 'Workflow'], [MODEL, 'Reductions'], [{ kind: 'none', label: 'REAL-WORLD' }, 'Verified reductions: none']],
    parts: [
      {
        scene: 'ledger',
        say: "Real observations, simulated activity and modelled reductions are kept separate. Real-world verified reductions: none. We haven't fixed a real leak yet, and we won't pretend otherwise.",
      },
      { scene: 'close', say: "We don't just track emissions. We help turn evidence into action." },
    ],
  },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const demos = join(ROOT, 'demos');
  mkdirSync(join(demos, 'lib'), { recursive: true });
  for (const s of SCENES) {
    const manifest = s.parts.map((p) => ({ scene: p.scene, text: p.say }));
    writeFileSync(join(demos, `${s.id}.scenes.json`), JSON.stringify(manifest, null, 2) + '\n');
  }
  const plan = SCENES.map((s) => ({
    id: s.id,
    chapter: s.chapter,
    startMs: s.startMs,
    endMs: s.endMs,
    tags: s.tags.map(([t, text]) => ({ ...t, text })),
    parts: s.parts.map((p) => ({ scene: p.scene, say: p.say, show: p.show ?? p.say })),
  }));
  writeFileSync(join(demos, 'lib', 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  console.log(`wrote ${SCENES.length} manifests + demos/lib/plan.json`);
}
