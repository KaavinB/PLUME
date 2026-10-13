import { test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { assertMapRendered, Director, highlight, presetSession, waitForMapIdle } from './lib/plume';

// 0:00–0:25 · The problem — guest view of Mission Control over 10,098 real Carbon Mapper detections.
test('plume-01-problem', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-01-problem');

  // ---- off camera: guest landing page, map and data fully loaded
  await presetSession(page, request, null);
  await d.prepare({ x: 0.6, y: 0.66 });
  await page.goto('/');
  await expect(page.getByTestId('intro')).toBeVisible();
  await expect(page.getByTestId('persona-switcher')).toContainText('Guest (read-only)');
  const modeBar = page.getByTestId('mode-bar');
  await expect(modeBar).toContainText('Historical');
  await expect(modeBar).toContainText('Simulated');
  await expect(modeBar).toContainText('Anvil (local)');
  await expect(page.getByText('10,098 historical CH₄ plume detections')).toBeVisible();
  await expect(page.getByRole('button', { name: /Filters & layers/ })).toContainText('10,098 / 10,098');
  d.log.ok('guest landing: intro card, Guest (read-only), mode bar Historical / Simulated / Anvil, 10,098 detections');
  await waitForMapIdle(page);
  await assertMapRendered(page, d.log, { x: 700, y: 230, width: 520, height: 420 }, { plume: false });

  await d.begin();

  await d.part('problem', async () => {
    const map = page.getByTestId('mission-map');
    await d.moveTo(map, 0.5, 0.62, 1600);
    await d.cue('from aircraft and satellites');
    await d.moveTo(map, 0.58, 0.5, 1400);
    await d.cue('published by Carbon Mapper');
    const provenance = page.getByText('10,098 historical CH₄ plume detections');
    await d.moveTo(provenance, 0.4, 0.5);
    await highlight(provenance.locator('..'), 3200, 'amber');
    await d.cue('The hard part is the next question');
    const intro = page.getByTestId('intro');
    await d.moveTo(intro.locator('h1'), 0.75, 0.6);
    await d.cue('who fixes it');
    const legend = intro.locator('div.grid');
    await highlight(legend, 6200, 'white');
    await d.moveTo(legend, 0.18, 0.5, 900);
    await d.cue('who pays');
    await d.moveTo(legend, 0.5, 0.5, 900);
    await d.cue('how does anyone know');
    await d.moveTo(legend, 0.83, 0.5, 900);
    await d.cue('PLUME is the workflow');
    await highlight(intro.locator('h1'), 3500, 'amber');
    await d.moveTo(page.getByRole('button', { name: 'Show the demo incident' }), 0.5, 0.5, 1200);
  });

  await d.finish({ url: '/', persona: null });
});
