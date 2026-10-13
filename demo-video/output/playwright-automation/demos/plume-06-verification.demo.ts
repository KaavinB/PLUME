import { demoType, test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { apiGet, assertChainHistory, Director, highlight, mainScroll, panel, PERSONA_NAME, presetSession, readHandoff, resetZoom, reveal, scrollMainTo, zoomTo } from './lib/plume';

// 2:45–3:35 · Verification [SIM + CHAIN] — independent verifier reviews policy checks and signs an EIP-712 decision.
test('plume-06-verification', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-06-verification');
  const prev = readHandoff('plume-05-repair');
  const code = prev.project!;

  await presetSession(page, request, 'provider');
  await d.prepare(prev.cursor, ['/verification/RP-000000']);
  await page.goto(prev.url);
  await expect(page.getByText('Waiting for the verifier')).toBeVisible();
  await expect(page.getByTestId('persona-switcher')).toContainText(PERSONA_NAME.provider);

  await d.begin();

  await d.part('review', async () => {
    await d.click(page.getByTestId('switch-verifier'));
    await expect(page.getByTestId('persona-switcher')).toContainText(PERSONA_NAME.verifier);
    await d.click(page.getByRole('link', { name: 'Open verification workbench' }));
    await expect(page).toHaveURL(new RegExp(`/verification/${code}`));
    const checks = page.getByTestId('policy-checks');
    await expect(checks).toBeVisible({ timeout: 20_000 });
    await d.cue('the satellite records', -200);
    const obs = panel(page, 'Original observations');
    await highlight(obs, 2200, 'amber');
    await d.moveTo(obs, 0.5, 0.3, 700);
    await d.cue('the repair record');
    const rec = panel(page, 'Repair record');
    await highlight(rec, 1800, 'sim');
    await d.moveTo(rec, 0.5, 0.4, 600);
    await d.cue('documents');
    const docs = panel(page, 'Submitted documents');
    await highlight(docs, 1800, 'sim');
    await d.moveTo(docs, 0.5, 0.4, 600);
    await d.cue('and measurements', -100);
    const meas = panel(page, 'Site measurements');
    await reveal(meas, 'center', 600);
    await highlight(meas, 1800, 'sim');
    await d.cue('Server', -200);
    await scrollMainTo(page, 0, 600);
    const checksPanel = panel(page, 'Policy checks');
    await highlight(checksPanel, 11_000, 'green');
    await zoomTo(checksPanel, 1.16, 900);
    const item = (id: string) => checks.locator(`[data-check="${id}"]`);
    for (const [phrase, id] of [
      ['complete documentation', 'documentation_complete'],
      ['provider', 'provider_authorized'],
      ['independent parties', 'verifier_independent'],
      ['consistent timestamps', 'timestamps_valid'],
      ['files matching', 'evidence_hash_consistent'],
      ['reduction beyond', 'reduction_supported'],
    ] as const) {
      await d.cue(phrase, -150);
      await expect(item(id)).toHaveAttribute('data-status', 'pass');
      await d.moveTo(item(id), 0.12, 0.3, 450);
    }
  });

  const ctx = await apiGet(request, `/repair-projects/${code}/verification-context`, 'verifier');
  expect(ctx.blocking, 'no blocking policy checks').toEqual([]);
  await expect(page.locator('[data-check][data-status="fail"]')).toHaveCount(0);
  d.log.ok(`${code}: ${ctx.checks.length} policy checks evaluated server-side, 0 failing, impact preview "${ctx.impact_preview.status}"`);

  await d.part('impact', async () => {
    await resetZoom(page, 700);
    const imp = panel(page, 'Impact calculation preview');
    await reveal(imp, 'center', 650);
    await zoomTo(imp, 1.2, 900);
    await highlight(imp, 6200, 'sim');
    await d.moveTo(imp.locator('.mono').first(), 0.55, 0.5, 700);
    await d.cue('synthetic', -200);
    await d.moveTo(imp.locator('header'), 0.92, 0.5, 600);
    await d.cue('A later satellite', -300);
    await resetZoom(page, 700);
    const sat = panel(page, 'Subsequent observations');
    await reveal(sat, 'center', 600);
    await highlight(sat, 3600, 'amber');
    await d.moveTo(sat, 0.5, 0.65, 700);
  });

  await d.part('sign', async () => {
    const verified = page.getByTestId('outcome-VERIFIED');
    await reveal(verified, 'center', 600);
    await d.click(verified);
    const notes = page.getByTestId('decision-notes');
    await d.click(notes, 0.3, 0.4);
    await demoType(page, notes, 'Documentation complete; reduction exceeds uncertainty (synthetic evidence).', 18);
    await d.cue('bound to this project', -400);
    const preview = page.getByText('You will sign · RepairDecision').locator('..');
    await reveal(preview, 'center', 500);
    await highlight(preview, 3800, 'teal');
    await d.moveTo(preview, 0.5, 0.6, 700);
    await d.cue('Rejected or inconclusive', -500);
    await d.click(page.getByTestId('sign-decision'));
    const result = page.getByTestId('decision-result');
    await expect(result).toContainText('VERIFIED', { timeout: 20_000 });
    await reveal(result, 'center', 500);
    await highlight(result, 4200, 'green');
    await d.moveTo(result, 0.6, 0.45, 700);
  });

  const proj = await assertChainHistory(request, d.log, code, ['EvidenceSubmitted', 'DecisionRecorded']);
  expect(proj.status).toBe('VERIFIED');
  expect(proj.onchain.state).toBe('VERIFIED');
  const v = proj.verifications[proj.verifications.length - 1];
  expect(v.outcome).toBe('VERIFIED');
  expect(proj.onchain.last_decision_digest.toLowerCase()).toBe(v.eip712_digest.toLowerCase());
  d.log.ok(`${code}: VERIFIED recorded on-chain; contract's last decision digest equals the verifier's EIP-712 digest ${v.eip712_digest.slice(0, 12)}…`);

  await d.finish({ url: `/verification/${code}`, persona: 'verifier', project: code, scroll: { main: await mainScroll(page) } });
});
