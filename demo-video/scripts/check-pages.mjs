// Smoke test for the GitHub Pages static snapshot: every main page renders from snapshot data, the map draws,
// the receipt shows the recorded chain check, write actions are absent, and nothing calls a local backend/chain.
//   node scripts/check-pages.mjs [base-url]   (default http://localhost:4321/PLUME)
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const BASE = (process.argv[2] ?? 'http://localhost:4321/PLUME').replace(/\/$/, '');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
const local = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/plume\.png|Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text().slice(0, 160)}`));
page.on('request', (r) => /localhost:8000|127\.0\.0\.1:8545|localhost:8545/.test(r.url()) && local.push(r.url()));
const ok = (m) => console.log(`✓ ${m}`);
const must = async (cond, m) => {
  if (!(await cond)) throw new Error(`✗ ${m}`);
  ok(m);
};
const text = (sel) => page.locator(sel).first().innerText({ timeout: 20_000 });

await page.goto(`${BASE}/`);
await page.getByText('10,098 historical CH₄ plume detections').waitFor({ timeout: 30_000 });
await must((await text('[role="note"]')).includes('Static snapshot'), 'landing: snapshot banner');
await must((await text('[data-testid="mode-bar"]')).includes('recorded'), 'landing: chain pill says recorded');
await must((await page.getByTestId('persona-switcher').count()) === 0, 'landing: no persona switcher');
await page.waitForTimeout(4000);
const shot = await page.screenshot({ clip: { x: 700, y: 480, width: 520, height: 300 } });
const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
let amber = 0;
for (let i = 0; i < data.length; i += info.channels) if (data[i] > 150 && data[i + 2] < 110 && data[i] - data[i + 2] > 80) amber++;
await must(amber > 40, `landing: map markers drawn (${amber} amber px)`);

await page.getByRole('button', { name: 'Show the demo incident' }).click();
await must((await text('[data-testid="incident-drawer"]')).includes('51 on 28 date(s)'), 'map drawer: INC-32893D from snapshot');
const png = page.waitForResponse((r) => r.url().includes('/plume.png'));
await page.getByTestId('incident-drawer').getByRole('button', { name: /av320241001t172751-M/ }).click();
await must((await png).status() === 200, 'map: featured plume raster served from snapshot');

await page.getByTestId('investigate-cta').click();
await page.waitForURL(/incidents\/INC-32893D/);
await must((await text('main')).includes('Read-only snapshot'), 'incident page: read-only note, no Run investigation');
await must((await page.getByTestId('run-investigation').count()) === 0, 'incident page: run button absent');

await page.getByRole('link', { name: 'Latest report' }).click();
await page.getByTestId('report-summary').waitFor();
await must((await text('main')).includes('Grounding check passed'), 'investigation report renders');

await page.goto(`${BASE}/projects/`);
await page.getByRole('link', { name: /RP-/ }).first().click();
await page.waitForURL(/projects\/RP-/);
await page.getByText('Escrow released').waitFor({ timeout: 20_000 });
await must((await page.getByRole('button', { name: 'Reconcile with chain' }).count()) === 0, 'project page: PAID, no reconcile button');
const code = page.url().match(/RP-[A-Z0-9]+/)[0];

await page.goto(`${BASE}/verification/${code}/`);
await page.getByTestId('policy-checks').waitFor();
await must((await page.locator('[data-check][data-status="fail"]').count()) === 0, 'workbench: policy checks render, none failing');
await must((await page.getByRole('button', { name: 'Act as verifier' }).count()) === 0, 'workbench: no persona button');

await page.goto(`${BASE}/projects/${code}/`);
await page.getByRole('link', { name: /View proof · RCPT-/ }).click();
await page.waitForURL(/receipts\/RCPT-/);
const checks = page.getByTestId('chain-checks');
await checks.waitFor({ timeout: 20_000 });
await must((await checks.locator('[aria-label="Pass"]').count()) === 5 && (await checks.locator('[aria-label="Fail"]').count()) === 0, 'receipt: recorded chain check 5/5');
await must((await text('main')).includes('Independent chain check (recorded)'), 'receipt: chain check labelled recorded');
await must((await text('main')).includes('Not a carbon credit'), 'receipt: not-a-carbon-credit label');

await page.goto(`${BASE}/ledger/`);
await page.getByRole('heading', { name: 'Real-world verified reductions' }).waitFor();
ok('ledger renders');

await page.goto(`${BASE}/incidents/`);
await page.getByText('INC-4EED6F').waitFor();
await page.getByLabel('Filter incidents by code').fill('INC-32893D');
await page.getByRole('link', { name: 'INC-32893D' }).first().waitFor();
ok('incidents list: in-browser filter over the exported list');

await page.goto(`${BASE}/about/`);
await page.waitForTimeout(800);
ok('about renders');
const v = await page.request.get(`${BASE}/demo/plume-demo-final.mp4`);
await must(v.status() === 200, 'demo video served');

await must(local.length === 0, `no requests to a local API or chain (${local.length})`);
if (problems.length) {
  console.log(problems.join('\n'));
  throw new Error(`${problems.length} page/console error(s)`);
}
ok('no page or console errors');
await browser.close();
