import { test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { assertChainHistory, Director, highlight, mainScroll, panel, presetSession, readHandoff, resetZoom, reveal, zoomTo } from './lib/plume';

/** Proof-timeline nodes opened during this scene, in narration order (also replayed off camera by scene 8). */
export const OPENED = ['Investigation', 'Repair submission', 'Evidence commitment', 'Verification decision', 'Smart contract state', 'Payment transaction'];

// 3:35–4:10 · Settlement & proof [CHAIN] — escrow released once to the provider; receipt re-checked from the browser.
test('plume-07-settlement', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-07-settlement');
  const prev = readHandoff('plume-06-verification');
  const code = prev.project!;

  await presetSession(page, request, 'verifier');
  await d.prepare(prev.cursor, ['/projects/RP-000000', '/receipts/RCPT-000000']);
  await page.goto(prev.url);
  await expect(page.getByTestId('decision-result')).toContainText('VERIFIED');
  if (prev.scroll?.main) await page.evaluate((t) => document.querySelector('main')!.scrollTo(0, t), prev.scroll.main);

  await d.begin();

  let receipt = '';
  await d.part('release', async () => {
    await d.click(page.getByRole('link', { name: 'Continue to project' }));
    await expect(page).toHaveURL(new RegExp(`/projects/${code}$`));
    await d.click(page.getByTestId('release'));
    const proof = page.getByRole('link', { name: /View proof · RCPT-/ });
    await expect(proof).toBeVisible({ timeout: 20_000 });
    receipt = (await proof.innerText()).match(/RCPT-[A-Za-z0-9-]+/)![0];
    const escrow = panel(page, 'Escrow contract');
    await expect(escrow).toContainText('PAID');
    await d.cue('exactly once', -300);
    await highlight(escrow, 3400, 'green');
    await d.moveTo(escrow.getByText('On-chain state'), 1.8, 0.5, 700);
    await d.cue('anyone can inspect', -300);
    await highlight(proof, 2600, 'amber');
    await d.moveTo(proof, 0.5, 0.5, 700);
  });

  const proj = await assertChainHistory(request, d.log, code, ['DecisionRecorded', 'PaymentReleased']);
  expect(proj.status).toBe('PAID');
  expect(proj.onchain.state).toBe('PAID');
  expect(proj.receipt_id).toBe(receipt);
  d.log.ok(`${code}: escrow released (PaymentReleased), on-chain state PAID, receipt ${receipt} issued`);

  await d.part('proof', async () => {
    await d.click(page.getByRole('link', { name: /View proof · RCPT-/ }));
    await expect(page).toHaveURL(new RegExp(`/receipts/${receipt}`));
    const checks = page.getByTestId('chain-checks');
    await expect(checks).toContainText('Contract state is Paid', { timeout: 20_000 });
    await expect(checks.locator('[aria-label="Pass"]')).toHaveCount(5);
    await expect(checks.locator('[aria-label="Fail"]')).toHaveCount(0);
    const chainPanel = panel(page, 'Independent chain check');
    await zoomTo(chainPanel, 1.18, 900);
    await highlight(chainPanel, 6500, 'green');
    await d.moveTo(checks.locator('li').first(), 0.25, 0.5, 600);
    await d.cue('five checks', -200);
    await d.moveTo(checks.locator('li').nth(4), 0.3, 0.5, 900);
    await d.cue('The proof timeline', -400);
    await resetZoom(page, 700);
    const proofChain = page.getByTestId('proof-chain');
    const node = (t: string) => proofChain.getByRole('button', { name: new RegExp(t) });
    await highlight(proofChain, 3000, 'amber');
    await d.moveTo(node('Original observation'), 0.4, 0.5, 600);
    for (const [phrase, title] of [
      ['the investigation', 'Investigation'],
      ['simulated repair', 'Repair submission'],
      ['the evidence', 'Evidence commitment'],
      ['signed decision', 'Verification decision'],
      ['contract state', 'Smart contract state'],
      ['the payment', 'Payment transaction'],
    ] as const) {
      await d.cue(phrase, -350);
      await reveal(node(title), 'center', 350);
      await d.click(node(title), 0.35, 0.5);
      await expect(node(title)).toHaveAttribute('aria-expanded', 'true');
    }
    await reveal(node('Payment transaction'), 'center', 500);
  });
  d.log.ok(`${receipt}: browser-side viem check 5/5 pass (state Paid, evidence hash, terms hash, decision digest, settlement tx success)`);

  await d.finish({ url: `/receipts/${receipt}`, persona: 'verifier', project: code, receipt, expanded: OPENED, scroll: { main: await mainScroll(page) } });
});
