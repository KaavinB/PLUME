// Preflight before recording: the guest landing page renders with real data, honest mode labels and a drawn map.
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const WEB = process.env.PLUME_WEB ?? 'http://localhost:3000';
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const obs = page.waitForResponse((r) => r.url().endsWith('/api/v1/observations') && r.status() === 200, { timeout: 30_000 });
await page.goto(WEB);
await obs;
const text = async (sel) => (await page.locator(sel).first().innerText({ timeout: 20_000 })).replace(/\s+/g, ' ');
const intro = await text('[data-testid="intro"]');
const who = await text('[data-testid="persona-switcher"]');
const modes = await text('[data-testid="mode-bar"]');
if (!intro.includes('Every dot is a real methane plume')) fail('intro card missing');
if (!who.includes('Guest (read-only)')) fail(`not a guest session: ${who}`);
for (const m of ['Historical', 'Simulated', 'Anvil (local)']) if (!modes.includes(m)) fail(`mode bar lacks "${m}": ${modes}`);
await page.getByText('10,098 historical CH₄ plume detections').waitFor({ timeout: 20_000 });
await page.waitForTimeout(4000);
const shot = 'output/work/preflight-landing.png';
await page.screenshot({ path: shot });
const region = await page.screenshot({ clip: { x: 700, y: 480, width: 520, height: 300 } });
const { data, info } = await sharp(region).raw().toBuffer({ resolveWithObject: true });
let amber = 0;
for (let i = 0; i < data.length; i += info.channels) if (data[i] > 150 && data[i + 2] < 110 && data[i] - data[i + 2] > 80) amber++;
const std = (await sharp(region).stats()).channels.slice(0, 3).reduce((a, c) => a + c.stdev, 0) / 3;
if (std < 6 || amber < 40) fail(`map not rendered (σ=${std.toFixed(1)}, amber=${amber})`);
if (errors.length) fail(`page errors: ${errors.join('; ')}`);
console.log(`✓ guest landing OK: intro card, "${who.trim()}", mode bar [${modes.replace(/Guided demo.*$/, '').trim()}], 10,098 detections, map σ=${std.toFixed(1)} with ${amber} amber marker px · ${shot}`);
await browser.close();
