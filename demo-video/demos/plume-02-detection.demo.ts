import { test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { assertMapRendered, Director, FEATURED_OBS, FOCUS, highlight, INCIDENT, PLUME_REGION, presetSession, readHandoff, reveal, waitForMapIdle, zoomMapAtCursor } from './lib/plume';

// 0:25–0:55 · Detection [REAL] — the demo incident, Carbon Mapper's own plume raster, known vs inferred.
test('plume-02-detection', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-02-detection');
  const prev = readHandoff('plume-01-problem');

  await presetSession(page, request, null);
  await d.prepare(prev.cursor);
  await page.goto(prev.url);
  await expect(page.getByTestId('intro')).toBeVisible();
  await expect(page.getByTestId('persona-switcher')).toContainText('Guest (read-only)');
  await waitForMapIdle(page);

  await d.begin();

  const modeBar = page.getByTestId('mode-bar');
  await d.part('labels', async () => {
    await d.moveTo(modeBar.locator('[title^="Data:"]'), 0.5, 0.6, 900);
    await highlight(modeBar.locator('[title^="Data:"]'), 3000, 'amber');
    await d.cue('real');
    await d.moveTo(modeBar.locator('[title^="Repair:"]'), 0.5, 0.6, 600);
    await highlight(modeBar.locator('[title^="Repair:"]'), 2600, 'sim');
    await d.cue('simulated');
    await highlight(modeBar.locator('[title^="Chain:"]'), 2600, 'green');
    await d.moveTo(modeBar.locator('[title^="Chain:"]'), 0.5, 0.6, 600);
  });

  await d.part('detection', async () => {
    const plumePng = page.waitForResponse((r) => r.url().includes('/plume.png') && r.status() === 200, { timeout: 20_000 });
    await d.click(page.getByRole('button', { name: 'Show the demo incident' }));
    const drawer = page.getByTestId('incident-drawer');
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`incident=${INCIDENT}`));
    await expect(page.getByTestId('selected-observation-id')).not.toHaveText('…');
    await expect(drawer).toContainText('1 of 51 in incident');
    await expect(drawer).toContainText('51 on 28 date(s)');
    await expect(drawer).toContainText('81.4');
    await plumePng;
    d.log.ok(`${INCIDENT}: drawer shows 51 detections on 28 dates, priority 81.4/100; provider plume raster fetched (HTTP 200)`);
    // Show the incident's highest-rate detection (AVIRIS-3, 2024-10-01): its provider raster is the clearest plume.
    await d.cue('five instruments');
    const row = drawer.getByRole('button', { name: new RegExp(FEATURED_OBS) });
    await reveal(row, 'center', 500);
    const rowPng = page.waitForResponse((r) => r.url().includes(`${FEATURED_OBS}/plume.png`) && r.status() === 200, { timeout: 20_000 });
    await d.click(row, 0.3, 0.5);
    await expect(page).toHaveURL(new RegExp(`obs=${FEATURED_OBS}`));
    await expect(page.getByTestId('selected-observation-id')).toHaveText(FEATURED_OBS);
    await expect(drawer).toContainText('5,636');
    await rowPng;
    await reveal(drawer.getByText('Reported by provider'), 'start', 400);
    await d.cue('plume image', -900);
    const map = page.getByTestId('mission-map');
    await d.moveTo(map, FOCUS.fx, FOCUS.fy, 900);
    await zoomMapAtCursor(page);
    await d.moveTo(map, 0.385, 0.66, 900);
    await assertMapRendered(page, d.log, PLUME_REGION, { plume: true });
    await d.cue("We keep what's known");
    const kvi = drawer.getByText('Known vs inferred').locator('..');
    await reveal(kvi, 'center', 600);
    await d.moveTo(kvi, 0.7, 0.3, 700);
    await highlight(kvi, 9500, 'teal');
    await d.cue('inferred');
    await d.moveTo(kvi, 0.6, 0.55, 700);
    await d.cue('the operator');
    await d.moveTo(kvi, 0.5, 0.85, 700);
    await d.cue('the faulty component');
    const src = drawer.getByRole('link', { name: /Carbon Mapper record/ });
    await reveal(src, 'center', 500);
    await d.moveTo(src, 0.5, 0.5, 700);
    await highlight(src.locator('..'), 1800, 'teal');
    await page.waitForTimeout(900);
    const bars = drawer.getByText(`Incident ${INCIDENT}`).locator('../..');
    await reveal(bars, 'start', 600);
    await d.moveTo(bars, 0.75, 0.45, 600);
    await highlight(bars, 2200, 'teal');
  });

  const drawerScroll = await page.getByTestId('incident-drawer').locator('div.overflow-y-auto').first().evaluate((el) => el.scrollTop);
  await d.finish({ url: `/?obs=${FEATURED_OBS}`, persona: null, scroll: { drawer: drawerScroll } });
});
