import { test } from '@argo-video/cli';
import { expect } from '@playwright/test';
import { apiGet, Director, FEATURED_OBS, FOCUS, highlight, INCIDENT, presetSession, readHandoff, resetZoom, waitForMapIdle, zoomMapAtCursor, zoomTo } from './lib/plume';

// 0:55–1:35 · Investigation [REAL] — sponsor runs the deterministic investigation; facts vs inferences; grounding.
test('plume-03-investigation', async ({ page, narration, request }) => {
  test.setTimeout(150_000);
  const d = new Director(page, narration, request, 'plume-03-investigation');
  const prev = readHandoff('plume-02-detection');
  const before = await apiGet(request, `/incidents/${INCIDENT}`);
  expect(before.investigations.length, 'incident not yet investigated').toBe(0);

  await presetSession(page, request, null);
  await d.prepare(prev.cursor, [`/incidents/${INCIDENT}`, '/investigations/00000000-0000-0000-0000-000000000000']);
  await page.goto(prev.url);
  const drawer = page.getByTestId('incident-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('51 on 28 date(s)');
  await expect(page.getByTestId('selected-observation-id')).toHaveText(FEATURED_OBS);
  await waitForMapIdle(page);
  await page.mouse.move(FOCUS.x, FOCUS.y);
  await zoomMapAtCursor(page);
  await page.mouse.move(FOCUS.x - 140, FOCUS.y + 120);
  await waitForMapIdle(page);
  if (prev.scroll?.drawer) await drawer.locator('div.overflow-y-auto').first().evaluate((el, t) => (el.scrollTop = t), prev.scroll.drawer);

  await d.begin();

  await d.part('investigate', async () => {
    await d.persona('sponsor');
    await d.click(page.getByTestId('investigate-cta'));
    await expect(page).toHaveURL(new RegExp(`/incidents/${INCIDENT}$`));
    const run = page.getByTestId('run-investigation');
    await expect(run).toBeEnabled();
    await d.click(run);
    await expect(page).toHaveURL(/\/investigations\//);
    await expect(page.getByTestId('report-summary')).toContainText(INCIDENT);
    await expect(page.getByText('Grounding check passed')).toBeVisible();
    await expect(page.getByText('Deterministic template narrative')).toBeVisible();
    const step = (n: string) => page.getByText(n, { exact: true }).locator('../..');
    await d.cue('validation');
    await d.moveTo(step('1. Validate'), 0.4, 0.5, 700);
    await highlight(step('1. Validate'), 2000, 'green');
    await d.cue('scan grouping');
    await d.moveTo(step('2. Group'), 0.4, 0.5, 700);
    await highlight(step('2. Group'), 4200, 'green');
    await d.cue('explainable priority');
    await d.moveTo(step('3. Prioritize'), 0.4, 0.5, 700);
    await highlight(step('3. Prioritize'), 2200, 'green');
    await d.cue('guidance');
    await d.moveTo(step('4. Retrieve'), 0.4, 0.5, 700);
    await highlight(step('4. Retrieve'), 2600, 'green');
  });

  const inc = await apiGet(request, `/incidents/${INCIDENT}`);
  expect(inc.investigations.length).toBe(1);
  const inv = await apiGet(request, `/investigations/${inc.investigations[0].id}`);
  expect(inv.report.grounding.passed).toBe(true);
  expect(inv.report.generation.kind).not.toBe('llm');
  d.log.ok(`investigation ${inv.id} stored: template narrative, grounding passed, ${inv.report.confirmed_observations.length} confirmed facts / ${inv.report.possible_explanations.length} explanations, ${inv.report.evidence_references.length} evidence refs`);

  await d.part('report', async () => {
    const confirmed = page.getByRole('heading', { name: 'Confirmed observations' }).locator('xpath=ancestor::section[1]');
    const possible = page.getByRole('heading', { name: 'Possible explanations' }).locator('xpath=ancestor::section[1]');
    await zoomTo(confirmed.locator('..'), 1.14, 1000);
    await highlight(confirmed, 3800, 'green');
    await d.moveTo(confirmed, 0.5, 0.35, 700);
    await d.cue('possible explanations');
    await highlight(possible, 3600, 'amber');
    await d.moveTo(possible, 0.45, 0.35, 700);
    await d.cue('citing evidence');
    const chip = confirmed.locator('button.mono').first();
    await d.moveTo(chip, 0.5, 0.5, 600);
    await highlight(chip, 1800, 'teal');
    await d.cue('An LLM');
    await resetZoom(page, 900);
    const badges = page.getByText('Deterministic template narrative').locator('..');
    await d.moveTo(page.getByText('Deterministic template narrative'), 0.5, 0.5, 900);
    await d.cue('Today');
    await highlight(page.getByText('Deterministic template narrative'), 3500, 'white');
    await highlight(page.getByText('Grounding check passed'), 3500, 'green');
    await d.moveTo(page.getByText('Grounding check passed'), 0.5, 0.5, 900);
    void badges;
  });

  await d.finish({ url: `/investigations/${inv.id}`, persona: 'sponsor', investigation: inv.id });
});
