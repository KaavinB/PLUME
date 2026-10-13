import { test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { assertChainHistory, Director, highlight, mainScroll, panel, PERSONA_NAME, presetSession, readHandoff, reveal, scrollMainTo } from './lib/plume';

// 2:10–2:45 · Repair [SIM + CHAIN] — provider accepts on-chain, chain clock advanced, synthetic evidence committed.
test('plume-05-repair', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-05-repair');
  const prev = readHandoff('plume-04-funding');
  const code = prev.project!;

  await presetSession(page, request, 'sponsor');
  await d.prepare(prev.cursor);
  await page.goto(prev.url);
  await expect(page.getByText('Waiting for the provider')).toBeVisible();
  await expect(panel(page, 'Escrow contract')).toContainText('FUNDED');
  if (prev.scroll?.main) await page.evaluate((t) => document.querySelector('main')!.scrollTo(0, t), prev.scroll.main);

  await d.begin();

  const modeBar = page.getByTestId('mode-bar');
  const chainBefore = await modeBar.locator('[title^="Chain:"]').innerText();
  await d.part('accept', async () => {
    await d.click(page.getByTestId('switch-provider'));
    await expect(page.getByTestId('persona-switcher')).toContainText(PERSONA_NAME.provider);
    await d.click(page.getByTestId('accept'));
    await expect(page.getByTestId('evidence-form')).toBeVisible({ timeout: 20_000 });
    const ff = page.getByTestId('advance-time');
    await expect(ff).toBeVisible();
    await d.moveTo(ff, 0.5, 0.5, 900);
    await d.cue('so we fast', -200);
    await d.click(ff);
    await expect(ff).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('submit-evidence')).toBeEnabled();
    await expect(modeBar.locator('[title^="Chain:"]')).not.toHaveText(chainBefore, { timeout: 25_000 });
    const pill = modeBar.locator('[title^="Chain:"]');
    await highlight(pill, 2600, 'green');
    await d.moveTo(pill, 0.6, 0.6, 800);
  });
  d.log.ok(`chain clock advanced on Anvil: ${chainBefore.replace(/\s+/g, ' ')} → ${(await modeBar.locator('[title^="Chain:"]').innerText()).replace(/\s+/g, ' ')}`);

  await d.part('evidence', async () => {
    const form = page.getByTestId('evidence-form');
    await d.cue('synthetic package', -300);
    const simBox = form.getByText('Simulated evidence package.').locator('../..');
    await highlight(simBox, 2600, 'sim');
    await d.moveTo(simBox, 0.35, 0.5, 700);
    await d.cue('a work order');
    const docs = form.getByText('Documents', { exact: true }).locator('..');
    await highlight(docs, 3000, 'sim');
    await d.moveTo(docs, 0.4, 0.45, 700);
    await d.cue('site measurements', -300);
    const meas = form.getByText(/Site measurements \(simulated\)/).locator('..');
    await reveal(meas, 'center', 650);
    await highlight(meas, 2600, 'sim');
    await d.cue('Every file is hashed', -200);
    const submit = page.getByTestId('submit-evidence');
    await reveal(submit, 'center', 500);
    await highlight(form.getByText('Files are content-hashed; the manifest hash is committed on-chain.'), 2600, 'white');
    await d.moveTo(submit, 0.5, 0.5, 700);
    await d.cue('committed on', -300);
    await d.click(submit);
    await expect(page.getByText('Waiting for the verifier')).toBeVisible({ timeout: 20_000 });
    await d.cue('Swap a single byte', -400);
    const subs = panel(page, 'Evidence submissions');
    await reveal(subs, 'center', 650);
    await highlight(subs, 3600, 'green');
    await d.moveTo(subs.getByText('Evidence hash'), 1.6, 0.5, 700);
    await d.clipEnd(300);
    await scrollMainTo(page, 0, 700);
  });

  const proj = await assertChainHistory(request, d.log, code, ['ProjectCreated', 'ProjectFunded', 'AssignmentAccepted', 'EvidenceSubmitted']);
  expect(proj.status).toBe('REPAIR_SUBMITTED');
  expect(proj.evidence.length).toBe(1);
  expect(proj.evidence[0].is_simulated).toBe(true);
  expect(proj.onchain.evidence_hash.toLowerCase()).toBe(proj.evidence[0].content_hash.toLowerCase());
  d.log.ok(`${code}: REPAIR_SUBMITTED; simulated evidence round 1, manifest hash on-chain equals stored content hash`);

  await d.finish({ url: `/projects/${code}`, persona: 'provider', project: code, scroll: { main: await mainScroll(page) } });
});
