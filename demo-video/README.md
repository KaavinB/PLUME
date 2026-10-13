# PLUME demo video (Argo + Playwright)

Records the 4:30 narrated PLUME demo from the **real running app**: real UI, real API, real Anvil transactions, local Kokoro TTS. Built on [shreyaskarnik/argo](https://github.com/shreyaskarnik/argo) (`@argo-video/cli`).

## Output (`output/`)

| File | |
|---|---|
| `plume-demo-final.mp4` | 1920×1080, H.264/AAC, 4:30, chapters, soft subtitles |
| `subtitles.srt` | Phrase-level subtitles, timed from Whisper word timestamps of the generated speech |
| `plume-demo-narration.wav` | Final narration track, sample-aligned with the MP4 |
| `playwright-automation/` | Snapshot of the scripts below |
| `VERIFICATION_REPORT.md` | Assertions, transactions, timing, render checks and manual review |

## Run it

Needs: the PLUME repo set up (`make setup` at the root), Docker, Foundry, ffmpeg, Google Chrome.

```bash
cd demo-video
npm install                      # @argo-video/cli, Playwright, kokoro-js, sharp
node scripts/record-all.mjs      # ~20 min: prepare stack → preflight → 8 captures → assemble
```

`record-all.mjs` restarts the local stack (fresh Anvil, `make demo-reset`, API, production web build). It then records each scene with `argo pipeline`. If a capture fails, it resets the stack and rebuilds the state through the previous scene via the API (`scripts/state-builder.mjs`), then re-records only that capture. Afterwards your dev servers are not running: use `make dev` at the root to get them back.

## How it's put together

- `scripts/narration.mjs`: the single source for scene windows, narration and the REAL / SIM / CHAIN / MODELLED / TEMPLATE disclosures. It writes `demos/*.scenes.json` and `demos/lib/plan.json`.
- `scripts/clip-durations.mjs`: fails if any scene's narration doesn't fit its window. `scripts/word-times.mjs` stores Whisper word timings, which the scripts use to cue actions to spoken words.
- `demos/plume-0N-*.demo.ts`: one capture per scene. They use role, text and test-id selectors from the app's DOM, and assert UI, API and on-chain state.
- `demos/lib/plume.ts`: the shared Director (marks, cues, holds until the narration ends), disclosure band, highlights, content-only camera zoom, map pixel check, and Anvil receipt checks.
- `scripts/assemble.mjs`: trims each capture to its window and concatenates them with a single encode. It also adds chapters and subtitles, and writes the report.

When you change narration text, run `node scripts/narration.mjs`, `npx argo tts generate demos/<id>.scenes.json`, `node scripts/clip-durations.mjs` and `node scripts/word-times.mjs`.
