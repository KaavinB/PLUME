import { test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { apiGet, assertChainHistory, Director, highlight, INCIDENT, mainScroll, panel, PERSONA_NAME, presetSession, readHandoff, reveal, scrollMainTo } from './lib/plume';

// 1:35–2:10 · Funding [SIM + CHAIN] — sponsor drafts hashed terms, publishes and funds the escrow on Anvil.
test('plume-04-funding', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-04-funding');
  const prev = readHandoff('plume-03-investigation');
  const existing = await apiGet(request, `/repair-projects?incident=${INCIDENT}`);
  expect(existing.items.length, 'no repair project yet').toBe(0);

  await presetSession(page, request, 'sponsor');
  await d.prepare(prev.cursor, ['/projects/new', '/projects/RP-000000']);
  await page.goto(prev.url);
  await expect(page.getByTestId('report-summary')).toContainText(INCIDENT);
  await expect(page.getByTestId('persona-switcher')).toContainText(PERSONA_NAME.sponsor);

  await d.begin();

  await d.part('terms', async () => {
    await d.click(page.getByRole('link', { name: 'Create repair project' }));
    await expect(page).toHaveURL(new RegExp(`/projects/new\\?incident=${INCIDENT}`));
    await expect(page.getByRole('heading', { name: 'Create a repair bounty' })).toBeVisible();
    await expect(page.getByTestId('review-terms')).toBeEnabled();
    const inc = panel(page, 'Incident');
    await expect(inc).toContainText('51 detections on 28 dates');
    await d.moveTo(inc, 0.5, 0.5, 900);
    await d.cue('municipal climate fund');
    await highlight(panel(page, 'What happens next'), 2600, 'white');
    await d.cue('defines the');
    const p1 = panel(page, '1 · Repair scope & authorization');
    await highlight(p1, 2400, 'sim');
    await d.moveTo(p1, 0.4, 0.4, 700);
    await d.cue('milestones');
    const p2 = panel(page, '2 · Milestones');
    await reveal(p2, 'center', 650);
    await highlight(p2, 2000, 'sim');
    await d.cue('the evidence the verifier');
    const p3 = panel(page, '3 · Verification methodology & evidence requirements');
    await reveal(p3, 'center', 650);
    await highlight(p3, 2400, 'sim');
    await d.moveTo(p3, 0.35, 0.4, 600);
    await d.cue('an approved repair provider');
    const p4 = panel(page, '4 · Parties, funding & deadlines');
    await reveal(p4, 'center', 600);
    const prov = p4.locator('label').filter({ hasText: 'Repair provider' });
    await highlight(prov, 2000, 'sim');
    await d.moveTo(prov, 0.5, 0.6, 600);
    await d.cue('an independent verifier');
    const ver = p4.locator('label').filter({ hasText: 'Independent verifier' });
    await highlight(ver, 2200, 'sim');
    await d.moveTo(ver, 0.5, 0.6, 600);
    await d.clipEnd(0);
    await d.click(page.getByTestId('review-terms'));
    await expect(panel(page, '5 · Review terms')).toBeVisible();
  });

  let code = '';
  await d.part('escrow', async () => {
    const review = panel(page, '5 · Review terms');
    await highlight(review.locator('header'), 2600, 'white');
    await d.moveTo(review.locator('header'), 0.3, 0.6, 700);
    await d.cue('go into an escrow', -400);
    await d.click(page.getByTestId('create-draft'));
    await expect(page).toHaveURL(/\/projects\/RP-/);
    code = page.url().split('/projects/')[1].split('?')[0];
    await d.click(page.getByTestId('publish-fund'));
    await expect(page.getByText('Waiting for the provider')).toBeVisible({ timeout: 20_000 });
    const escrow = panel(page, 'Escrow contract');
    await expect(escrow).toContainText('FUNDED');
    await d.cue('Two real transactions', -200);
    const audit = panel(page, 'Audit trail');
    await reveal(audit, 'center', 700);
    await highlight(audit, 3600, 'green');
    await d.moveTo(audit, 0.45, 0.55, 800);
    await d.cue('refuses unapproved');
    await scrollMainTo(page, 0, 700);
    const parties = panel(page, 'Parties');
    await highlight(parties, 3400, 'sim');
    await d.moveTo(parties, 0.5, 0.45, 700);
    await d.clipEnd(0);
    await highlight(escrow, 3000, 'green');
    await d.moveTo(escrow.getByText('On-chain state'), 0.5, 0.5, 700);
  });

  const proj = await assertChainHistory(request, d.log, code, ['ProjectCreated', 'ProjectFunded']);
  expect(proj.status).toBe('FUNDED');
  expect(proj.onchain.state).toBe('FUNDED');
  expect(proj.onchain.terms_hash.toLowerCase()).toBe(proj.terms_hash.toLowerCase());
  d.log.ok(`${code}: status FUNDED, on-chain state FUNDED, on-chain terms hash equals stored terms hash, escrow ${proj.onchain.amount_wei} wei`);

  await d.finish({ url: `/projects/${code}`, persona: 'sponsor', project: code, scroll: { main: await mainScroll(page) } });
});
