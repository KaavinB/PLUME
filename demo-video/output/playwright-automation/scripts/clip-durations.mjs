// Reports each narration clip's length against its scene window, so narration never has to be cut off.
// Reads the Argo TTS cache (.argo/<capture>/clips/<sha256>.wav). Exit code 1 if any window is over budget.
import { existsSync, readFileSync } from 'node:fs';
import { clipMs, clipPath } from './clip-durations-lib.mjs';

const plan = JSON.parse(readFileSync('demos/lib/plan.json', 'utf8'));
// Minimum gap the scripts leave between consecutive clips.
const GAP_MS = 350;

let over = false;
const rows = [];
for (const s of plan) {
  const window = s.endMs - s.startMs;
  let total = 0;
  const parts = [];
  for (const p of s.parts) {
    const f = clipPath(s.id, p.scene, p.say);
    if (!existsSync(f)) throw new Error(`missing clip for ${s.id}/${p.scene} — run argo tts generate`);
    const ms = clipMs(f);
    total += ms + GAP_MS;
    const words = p.say.split(/\s+/).length;
    parts.push(`${p.scene} ${(ms / 1000).toFixed(1)}s (${words}w, ${(words / (ms / 1000)).toFixed(2)} w/s)`);
  }
  const slack = window - total;
  if (slack < 1500) over = true;
  rows.push(`${s.id.padEnd(24)} window ${(window / 1000).toFixed(0).padStart(3)}s  speech ${(total / 1000).toFixed(1).padStart(5)}s  slack ${(slack / 1000).toFixed(1).padStart(5)}s ${slack < 1500 ? '✗ OVER' : '✓'}  | ${parts.join(' · ')}`);
}
console.log(rows.join('\n'));
if (over) {
  console.error('\nAt least one window leaves < 1.5 s of slack. Shorten its narration.');
  process.exit(1);
}
