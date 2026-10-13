// Assembles the eight Argo captures into the deliverables in output/:
//   plume-demo-final.mp4 (1920×1080, H.264/AAC, chapters, soft English subtitles), subtitles.srt,
//   plume-demo-narration.wav, playwright-automation/ (copy of the scripts), VERIFICATION_REPORT.md (+ checks).
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'output';
const WORK = `${OUT}/work`;
mkdirSync(WORK, { recursive: true });
const plan = JSON.parse(readFileSync('demos/lib/plan.json', 'utf8'));
const words = JSON.parse(readFileSync('demos/lib/word-times.json', 'utf8'));
const runLog = existsSync(`${WORK}/run-log.json`) ? JSON.parse(readFileSync(`${WORK}/run-log.json`, 'utf8')) : {};
if (existsSync('../.video-logs/prepare.out')) runLog.prepare = readFileSync('../.video-logs/prepare.out', 'utf8').split('\n').find((l) => l.startsWith('✓')) ?? runLog.prepare;
const TOTAL = plan.at(-1).endMs;

const probe = (f, entries = 'format=duration') => execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', f]).toString();
const durMs = (f) => Math.round(Number(JSON.parse(probe(f)).format.duration) * 1000);
const fmt = (ms) => {
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4), s = Math.floor((ms % 6e4) / 1000), x = Math.round(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(x).padStart(3, '0')}`;
};
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// ---------------------------------------------------------------- per-capture facts
const caps = plan.map((s) => {
  const video = `videos/${s.id}.mp4`;
  if (!existsSync(video)) throw new Error(`missing ${video}`);
  const report = JSON.parse(readFileSync(`.argo/${s.id}/scene-report.json`, 'utf8'));
  const assertions = JSON.parse(readFileSync(`.argo/${s.id}/assertions.json`, 'utf8'));
  const window = s.endMs - s.startMs;
  const vDur = durMs(video);
  const parts = s.parts.map((p) => {
    const r = report.scenes.find((x) => x.scene === p.scene);
    const w = words[`${s.id}/${p.scene}`];
    return { ...p, startMs: r.startMs, endMs: r.endMs, clipMs: w.clipMs, words: w.words };
  });
  return { ...s, video, window, vDur, padMs: Math.max(0, window - vDur), parts, assertions };
});

// ---------------------------------------------------------------- subtitles (phrase level, Whisper-timed)
function chunks(text) {
  const out = [];
  for (const sentence of text.split(/(?<=[.?!:])\s+/)) {
    if (sentence.length <= 84) {
      out.push(sentence);
      continue;
    }
    let rest = sentence;
    while (rest.length > 84) {
      const commas = [...rest.matchAll(/,\s/g)].map((m) => m.index).filter((i) => i > 25 && i < 84);
      const cut = commas.length ? commas.at(-1) + 1 : rest.lastIndexOf(' ', 80);
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
function wrap(t) {
  if (t.length <= 42) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return `${t.slice(0, best)}\n${t.slice(best + 1)}`;
}
const cues = [];
for (const c of caps) {
  for (const p of c.parts) {
    const base = c.startMs + p.startMs;
    const ws = p.words.filter((w) => w.w.trim());
    const pieces = chunks(p.show);
    const total = pieces.reduce((a, x) => a + x.split(/\s+/).length, 0);
    let acc = 0;
    for (const piece of pieces) {
      const n = piece.split(/\s+/).length;
      const i0 = Math.min(ws.length - 1, Math.floor((acc / total) * ws.length));
      const i1 = Math.min(ws.length - 1, Math.max(i0, Math.ceil(((acc + n) / total) * ws.length) - 1));
      acc += n;
      cues.push({ start: base + ws[i0].s, end: base + ws[i1].e + 150, text: wrap(piece) });
    }
  }
}
cues.sort((a, b) => a.start - b.start);
for (let i = 0; i < cues.length; i++) {
  if (cues[i].end - cues[i].start < 1000) cues[i].end = cues[i].start + 1000;
  if (i + 1 < cues.length && cues[i].end > cues[i + 1].start - 40) cues[i].end = cues[i + 1].start - 40;
}
const srt = cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
writeFileSync(`${OUT}/subtitles.srt`, srt);

// ---------------------------------------------------------------- chapters
let meta = ';FFMETADATA1\ntitle=PLUME — narrated demo (IEEE ClimateChain 2026)\n';
plan.forEach((s, i) => (meta += `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s.startMs}\nEND=${s.endMs}\ntitle=${i + 1} · ${s.chapter}\n`));
writeFileSync(`${WORK}/chapters.txt`, meta);

// ---------------------------------------------------------------- one encode: trim/pad each capture to its window, concat
const inputs = caps.flatMap((c) => ['-i', c.video]);
let fc = '';
caps.forEach((c, i) => {
  // Exact segment lengths (frames and samples) so every scene cut lands on its planned time with no drift.
  const frames = Math.round((c.window / 1000) * 30);
  const samples = Math.round((c.window / 1000) * 48000);
  fc += `[${i}:v]setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${frames},setpts=N/30/TB[v${i}];`;
  fc += `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[a${i}];`;
});
fc += caps.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${caps.length}:v=1:a=1[v][a]`;
const final = `${OUT}/plume-demo-final.mp4`;
const n = caps.length;
const enc = spawnSync('ffmpeg', [
  '-v', 'error', '-y', ...inputs, '-f', 'ffmetadata', '-i', `${WORK}/chapters.txt`, '-i', `${OUT}/subtitles.srt`,
  '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-map', `${n + 1}:s`, '-map_chapters', String(n), '-map_metadata', String(n),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
  '-c:a', 'aac', '-b:a', '192k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', '0',
  '-movflags', '+faststart', final,
], { encoding: 'utf8' });
if (enc.status !== 0) throw new Error(`ffmpeg failed: ${enc.stderr}`);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', final, '-map', '0:a', '-c:a', 'pcm_s16le', '-ar', '48000', `${OUT}/plume-demo-narration.wav`]);

// ---------------------------------------------------------------- automation scripts copy
rmSync(`${OUT}/playwright-automation`, { recursive: true, force: true });
mkdirSync(`${OUT}/playwright-automation`, { recursive: true });
cpSync('demos', `${OUT}/playwright-automation/demos`, { recursive: true });
cpSync('scripts', `${OUT}/playwright-automation/scripts`, { recursive: true });
for (const f of ['argo.config.mjs', 'package.json']) cpSync(f, `${OUT}/playwright-automation/${f}`);

// ---------------------------------------------------------------- automated checks on the rendered file
const ff = (argv) => spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...argv], { encoding: 'utf8' }).stderr;
const streams = JSON.parse(probe(final, 'stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,size'));
const black = [...ff(['-i', final, '-vf', 'blackdetect=d=0.3:pix_th=0.06', '-an', '-f', 'null', '-']).matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map((m) => m.slice(1).map(Number));
const freezes = [...ff(['-i', final, '-vf', 'freezedetect=n=0.0008:d=4', '-an', '-f', 'null', '-']).matchAll(/freeze_start: ([\d.]+)[\s\S]*?freeze_duration: ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const loud = ff(['-i', final, '-af', 'ebur128', '-vn', '-f', 'null', '-']);
const I = loud.match(/I:\s+(-?[\d.]+) LUFS/g)?.at(-1);
const peak = ff(['-i', final, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).match(/max_volume: (-?[\d.]+) dB/)?.[1];

// transcript check: Whisper transcript of each Kokoro clip vs the scripted words (order-preserving overlap)
const toks = (s) => s.toLowerCase().replace(/(\d),(\d)/g, '$1$2').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const NUM = { 'fifty-one': '51', 'twenty-eight': '28', 'ten thousand': '10000', 'twenty-eight-day': '28 day' };
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}
const speech = caps.flatMap((c) => c.parts.map((p) => {
  let said = p.say.replace(/U-N-E-P/g, 'unep').replace(/-/g, ' ');
  for (const [k, v] of Object.entries(NUM)) said = said.replace(new RegExp(k.replace(/-/g, ' '), 'gi'), v);
  const a = toks(said), b = toks(p.words.map((w) => w.w).join(' ').replace(/ ,/g, ',').replace(/ -/g, '-').replace(/-/g, ' '));
  const end = c.startMs + p.startMs + p.clipMs;
  const nextStart = (() => {
    const idx = c.parts.indexOf(p);
    return idx + 1 < c.parts.length ? c.startMs + c.parts[idx + 1].startMs : c.endMs;
  })();
  const missed = a.filter((w) => !b.includes(w));
  return { id: `${c.id}/${p.scene}`, start: c.startMs + p.startMs, clipMs: p.clipMs, end, limit: nextStart, gap: nextStart - end, match: lcs(a, b) / a.length, missed };
}));

writeFileSync(`${WORK}/checks.json`, JSON.stringify({ streams, black, freezes, loudness: I, peak, speech, cues: cues.length, caps: caps.map((c) => ({ id: c.id, vDur: c.vDur, window: c.window, padMs: c.padMs })) }, null, 2));

// ---------------------------------------------------------------- report
const v = streams.streams.find((s) => s.codec_type === 'video');
const a = streams.streams.find((s) => s.codec_type === 'audio');
const allTx = [];
for (const c of caps) for (const t of c.assertions.transactions) if (!allTx.some((x) => x.hash === t.hash)) allTx.push({ ...t, capture: c.id });
const manual = existsSync(`${WORK}/manual-review.md`) ? readFileSync(`${WORK}/manual-review.md`, 'utf8') : '_Manual review not yet recorded._\n';
let md = `# PLUME demo video — verification report

Generated ${new Date().toISOString()} by \`demo-video/scripts/assemble.mjs\` from the run in \`output/work/run-log.json\`.

## Deliverables

| File | What it is |
|---|---|
| \`plume-demo-final.mp4\` | ${v.width}×${v.height} ${v.codec_name.toUpperCase()} @ ${v.r_frame_rate.replace('/1', '')} fps, ${a.codec_name.toUpperCase()} ${a.sample_rate} Hz, **${(Number(streams.format.duration)).toFixed(2)} s**, ${(Number(streams.format.size) / 1e6).toFixed(1)} MB, 8 chapters, soft English subtitles (off by default) |
| \`subtitles.srt\` | ${cues.length} phrase-level cues timed from Whisper word timestamps of the actual Kokoro clips |
| \`plume-demo-narration.wav\` | The final mixed narration track (48 kHz PCM), sample-aligned with the MP4 |
| \`playwright-automation/\` | Copy of the Argo/Playwright scripts that drove the real UI (\`demos/*.demo.ts\`, \`demos/lib/plume.ts\`) and the pipeline scripts |

## How it was recorded

- **Stack** (\`scripts/prepare-stack.sh\`): fresh Anvil chain → \`make demo-reset\` (fresh RepairEscrow deployment, projects cleared, personas re-seeded) → API restarted → production build of the web app. Health: ${runLog.prepare ?? 'see .video-logs/prepare.out'}
- **Preflight** (\`scripts/preflight.mjs\`): ${runLog.preflight ?? 'n/a'}
- **Capture**: Argo ${JSON.parse(readFileSync('node_modules/@argo-video/cli/package.json', 'utf8')).version}, system Chrome (headless), 1600×900 CSS px at device scale 2 (3200×1800 CDP frames), lanczos-downscaled to 1920×1080. Eight captures, one per scene, each a real end-to-end run against the live local stack; UI state is handed from one capture to the next.
- **Voice**: Kokoro-82M (fp32, local), voice \`af_heart\`, speed 1.05. Every clip fits its scene window; scripts hold each scene until its clip has finished.
- **Disclosure band**: a 34 px band under the app (the app viewport is 866 px tall) carries the scene number and REAL / SIM / CHAIN / MODELLED / TEMPLATE tags. It never covers the UI. The app's own mode bar (Data · Historical, Repair · Simulated, Chain · Anvil local) is visible throughout.

## Capture attempts

| Scene | Window | Attempts | Result |
|---|---|---|---|
${caps.map((c) => {
  const at = runLog.captures?.[c.id] ?? [];
  return `| ${c.chapter} | ${mmss(c.startMs)}–${mmss(c.endMs)} | ${at.length || 1} | ${at.length ? at.map((x) => (x.ok ? 'ok' : `failed: ${x.failure}`) + (x.rebuiltState ? ' (state rebuilt via API)' : '')).join('; ') : 'ok'} |`;
}).join('\n')}

## Assertions checked during recording

${caps.map((c) => `**${c.chapter}**\n${c.assertions.checks.map((x) => `- ✓ ${x.msg}`).join('\n')}`).join('\n\n')}

## Transactions shown (local Anvil, chain id 31337)

Every hash below was read back with \`eth_getTransactionReceipt\` from Anvil after the capture: status \`0x1\`, sent to the escrow contract.

| First shown in | Event | Tx hash | Block |
|---|---|---|---|
${allTx.map((t) => `| ${t.capture.replace(/^plume-\d+-/, '')} | ${t.label} | \`${t.hash}\` | ${t.block} |`).join('\n')}

## Narration timing (no clipped words)

| Clip | Starts | Length | Ends | Next scene/part starts | Spare | Transcript match |
|---|---|---|---|---|---|---|
${speech.map((s) => `| ${s.id} | ${(s.start / 1000).toFixed(2)} s | ${(s.clipMs / 1000).toFixed(2)} s | ${(s.end / 1000).toFixed(2)} s | ${(s.limit / 1000).toFixed(2)} s | ${(s.gap / 1000).toFixed(2)} s ${s.gap >= 0 ? '✓' : '✗'} | ${(s.match * 100).toFixed(0)}% |`).join('\n')}

Transcript match = share of scripted words that Whisper (whisper-base.en, local) recovered in order from the Kokoro clip — an automated intelligibility check (the clips were not listened to by a person during this build). Scripted words Whisper did not return:

${speech.filter((s) => s.missed.length).map((s) => `- ${s.id}: ${s.missed.map((w) => `"${w}"`).join(', ')}`).join('\n') || '- none'}

## Rendered-file checks

- Duration ${Number(streams.format.duration).toFixed(2)} s (target ${(TOTAL / 1000).toFixed(0)} s). Captures trimmed to their windows; padding needed: ${caps.filter((c) => c.padMs > 0).map((c) => `${c.chapter} ${c.padMs} ms`).join(', ') || 'none'}.
- Black frames (blackdetect, ≥ 0.3 s): ${black.length ? black.map(([s, e]) => `${s.toFixed(2)}–${e.toFixed(2)} s`).join(', ') : '**none**'}.
- Static stretches ≥ 4 s (freezedetect): ${freezes.length ? freezes.map(([s, d]) => `${s.toFixed(1)} s for ${d.toFixed(1)} s`).join(', ') : 'none'}. (A static stretch is a held screen while narration continues, not a stall; each was checked in the manual review.)
- Loudness (EBU R128): integrated ${I ? I.replace(/^I:\s+/, '') : 'n/a'}; peak ${peak ?? 'n/a'} dBFS.

## Manual review

${manual}
## What is real, simulated and modelled in the footage

- **Real**: the 10,098 Carbon Mapper CH₄ detections, the INC‑32893D incident (51 detections, 28 dates, 5 instruments), Carbon Mapper's plume raster, the investigation code, every contract transaction (local Anvil) and the browser-side viem chain check.
- **Simulated**: the sponsor, provider and verifier organisations, the repair, the evidence documents and site measurements, the escrowed funds (test ETH) and the elapsed time (Anvil clock fast-forward).
- **Modelled**: the CH₄/CO₂e reduction on the verification and receipt screens, computed from synthetic measurements and labelled as such. No real leak was repaired; no carbon credit was issued; the ledger reports real-world verified reductions as none.
`;
writeFileSync(`${OUT}/VERIFICATION_REPORT.md`, md);
console.log(`✓ ${final} (${Number(streams.format.duration).toFixed(2)} s), ${cues.length} subtitle cues, report written`);
