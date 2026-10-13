// Transcribes every narration clip back with Whisper (local, via Argo's transcriber) and stores per-word start/end
// times. The Playwright scripts use them to cue actions to spoken words; the assembler uses them for subtitles;
// the verification report uses the transcript to confirm Kokoro actually said the scripted words.
import { readFileSync, writeFileSync } from 'node:fs';
import { transcribeWav } from '../node_modules/@argo-video/cli/dist/tts/transcribe.js';
import { clipMs, clipPath } from './clip-durations-lib.mjs';

const plan = JSON.parse(readFileSync('demos/lib/plan.json', 'utf8'));
const out = {};
for (const s of plan) {
  for (const p of s.parts) {
    const file = clipPath(s.id, p.scene, p.say);
    const words = await transcribeWav(file);
    out[`${s.id}/${p.scene}`] = { file, clipMs: clipMs(file), words: words.map((w) => ({ w: w.text, s: Math.round(w.start * 1000), e: Math.round(w.end * 1000) })) };
    process.stdout.write('.');
  }
}
writeFileSync('demos/lib/word-times.json', JSON.stringify(out, null, 1) + '\n');
console.log(`\nwrote demos/lib/word-times.json (${Object.keys(out).length} clips)`);
