import { test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { apiGet, Director, highlight, panel, presetSession, readHandoff, showEndCard } from './lib/plume';

// 4:10–4:30 · Close — Impact Ledger keeps real, simulated and modelled apart; closing line.
test('plume-08-closing', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-08-closing');
  const prev = readHandoff('plume-07-settlement');

  // ---- off camera: restore the receipt page exactly as scene 7 left it
  await presetSession(page, request, 'verifier');
  await d.prepare(prev.cursor, ['/ledger']);
  await page.goto(prev.url);
  const checks = page.getByTestId('chain-checks');
  await expect(checks.locator('[aria-label="Pass"]')).toHaveCount(5, { timeout: 20_000 });
  for (const title of prev.expanded ?? []) {
    const b = page.getByTestId('proof-chain').getByRole('button', { name: new RegExp(title) });
    if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
  }
  await page.waitForTimeout(600);
  if (prev.scroll?.main) await page.evaluate((t) => document.querySelector('main')!.scrollTo(0, t), prev.scroll.main);
  await page.waitForTimeout(400);

  await d.begin();

  await d.part('ledger', async () => {
    await d.click(page.getByRole('link', { name: 'Impact Ledger' }));
    await expect(page).toHaveURL(/\/ledger$/);
    await expect(page.getByRole('heading', { name: 'Public impact ledger' })).toBeVisible();
    const real = panel(page, 'Historical observations');
    const wf = panel(page, 'Repair workflow');
    const mod = panel(page, 'Modelled reductions');
    const rw = panel(page, 'Real-world verified reductions');
    await expect(real).toContainText('10,098');
    await expect(rw).toContainText('None');
    await d.cue('Real observations', -200);
    await highlight(real, 2200, 'amber');
    await d.moveTo(real, 0.2, 0.5, 600);
    await d.cue('simulated activity', -200);
    await highlight(wf, 2000, 'sim');
    await d.moveTo(wf, 0.25, 0.5, 600);
    await d.cue('reductions are kept', -400);
    await highlight(mod, 2400, 'sim');
    await d.moveTo(mod, 0.3, 0.5, 600);
    await d.cue('world verified', -300);
    await highlight(rw, 5200, 'white');
    await d.moveTo(rw.getByText('None', { exact: true }), 0.5, 0.5, 700);
  });

  const ledger = await apiGet(request, '/impact');
  expect(ledger.real_world_verified_reductions.value).toBeNull();
  expect(ledger.workflow.receipts_issued).toBeGreaterThanOrEqual(1);
  d.log.ok(`ledger: ${ledger.real_data.observations_ingested} real observations; ${ledger.workflow.receipts_issued} receipt(s); modelled ${(ledger.simulated_reductions.ch4_avoided_kg / 1000).toFixed(1)} t CH₄ from synthetic evidence; real-world verified reductions: none`);

  await d.part('close', async () => {
    await d.cursor.hide();
    await showEndCard(page);
  });

  await d.finish({ url: '/ledger', persona: 'verifier' });
});
