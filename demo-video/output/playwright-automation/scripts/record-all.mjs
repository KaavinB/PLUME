// Records the PLUME demo video end to end.
//  1. prepares the stack (fresh Anvil, make demo-reset, API restart, production web build, health checks)
//  2. preflight: guest landing page + map render check (screenshot kept for the report)
//  3. records the eight captures in order with `argo pipeline` (TTS → record → align → export)
//     On failure: reset the stack, rebuild state through the previous capture via the API, re-record only that one.
//  4. assembles the deliverables (scripts/assemble.mjs)
//   node scripts/record-all.mjs [--from <capture-id>] [--skip-prepare]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const plan = JSON.parse(readFileSync('demos/lib/plan.json', 'utf8'));
const args = process.argv.slice(2);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : plan[0].id;
const MAX_RETRIES = 2;
const LOGS = '../.video-logs';
mkdirSync(LOGS, { recursive: true });
mkdirSync('output/work', { recursive: true });
const runLogPath = 'output/work/run-log.json';
const runLog = existsSync(runLogPath) && from !== plan[0].id ? JSON.parse(readFileSync(runLogPath, 'utf8')) : { started: new Date().toISOString(), captures: {} };
const save = () => writeFileSync(runLogPath, JSON.stringify(runLog, null, 2));

function sh(cmd, argv, env = {}) {
  const r = spawnSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

if (!args.includes('--skip-prepare')) {
  console.log('▶ preparing stack');
  const r = sh('./scripts/prepare-stack.sh', []);
  writeFileSync(`${LOGS}/prepare.out`, r.out);
  if (r.code !== 0) throw new Error(`stack preparation failed:\n${r.out}`);
  runLog.prepare = r.out.split('\n').find((l) => l.startsWith('✓')) ?? r.out.trim().split('\n').at(-1);
  console.log(`  ${runLog.prepare}`);
}

console.log('▶ narration timing');
execFileSync('node', ['scripts/narration.mjs'], { stdio: 'inherit' });
for (const s of plan) sh('npx', ['argo', 'tts', 'generate', `demos/${s.id}.scenes.json`]);
const dur = sh('node', ['scripts/clip-durations.mjs']);
console.log(dur.out);
if (dur.code !== 0) throw new Error('narration does not fit its windows');

if (from === plan[0].id) {
  console.log('▶ preflight: guest landing page');
  const r = sh('node', ['scripts/preflight.mjs']);
  console.log(r.out.trim());
  if (r.code !== 0) throw new Error('preflight failed');
  runLog.preflight = r.out.trim();
}
save();

const startIdx = plan.findIndex((s) => s.id === from);
for (let i = startIdx; i < plan.length; i++) {
  const id = plan[i].id;
  const attempts = [];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`  ↻ resetting stack and rebuilding state through ${plan[i - 1]?.id ?? '(start)'}`);
      const reset = sh('./scripts/prepare-stack.sh', ['reset-only']);
      if (reset.code !== 0) throw new Error(`reset failed:\n${reset.out}`);
      if (i > 0) {
        const b = sh('node', ['scripts/state-builder.mjs', plan[i - 1].id]);
        if (b.code !== 0) throw new Error(`state rebuild failed:\n${b.out}`);
        console.log(`  ${b.out.trim()}`);
      }
    }
    console.log(`▶ ${id} (attempt ${attempt + 1})`);
    const t0 = Date.now();
    const r = sh('npx', ['argo', 'pipeline', id], { ARGO_USE_GPU: '0' });
    writeFileSync(`${LOGS}/${id}.attempt${attempt + 1}.log`, r.out);
    const failure = r.code === 0 ? null : (r.out.match(/Error: .*/g) ?? ['unknown error']).slice(0, 3).join(' | ');
    attempts.push({ attempt: attempt + 1, ok: r.code === 0, seconds: Math.round((Date.now() - t0) / 1000), failure, rebuiltState: attempt > 0 && i > 0 });
    if (r.code === 0) {
      console.log(`  ✓ ${id}`);
      break;
    }
    console.log(`  ✗ ${failure}`);
  }
  runLog.captures[id] = attempts;
  save();
  if (!attempts.at(-1).ok) throw new Error(`${id} failed after ${MAX_RETRIES + 1} attempts — see ${LOGS}/${id}.attempt*.log`);
}

runLog.finished = new Date().toISOString();
save();
console.log('▶ assembling deliverables');
execFileSync('node', ['scripts/assemble.mjs'], { stdio: 'inherit' });
