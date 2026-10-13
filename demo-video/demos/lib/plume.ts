/**
 * Shared choreography for the PLUME demo-video captures (one Argo capture per scene).
 *
 *  - Director: scene windows, narration marks, word-level cues (Whisper timings of the actual Kokoro clips),
 *    hold-until-window-end so narration is never cut, handoff of UI state to the next capture.
 *  - On-screen disclosure strip (REAL / SIM / CHAIN / MODELLED), element highlights and a restrained in-page
 *    camera that zooms only the content area (the app's own mode bar and the strip stay visible).
 *  - Assertions against the UI, the PLUME API and the Anvil JSON-RPC endpoint. Nothing here fabricates state:
 *    every transaction shown is sent by the app itself and its receipt is checked on the chain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { createHumanCursor, type HumanCursor, type NarrationTimeline } from '@argo-video/cli';
import sharp from 'sharp';
import config from '../../argo.config.mjs';

export const API = process.env.PLUME_API ?? 'http://localhost:8000/api/v1';
export const RPC = process.env.PLUME_RPC ?? 'http://127.0.0.1:8545';
export const INCIDENT = 'INC-32893D';
/** Highest-rate detection of the demo incident (AVIRIS-3, 2024-10-01, 5,636 kg/h); clearest provider plume raster. */
export const FEATURED_OBS = 'av320241001t172751-M';
/** Where the map centres a selected observation (VIEW_PADDING in mission-map.tsx), as fractions of the map element. */
export const FOCUS = { fx: (790 - 60) / 1540, fy: (457 - 48) / 818, x: 790, y: 457 };
/** Screen region (CSS px) covered by the featured plume raster after zoomMapAtCursor(). */
export const PLUME_REGION = { x: 560, y: 470, width: 250, height: 200 };
const ARGO = path.resolve('.argo');
const HANDOFF = path.join(ARGO, 'handoff.json');

type Tag = { kind: 'real' | 'sim' | 'chain' | 'model' | 'none'; label: string; text: string };
type PlanPart = { scene: string; say: string; show: string };
type PlanScene = { id: string; chapter: string; startMs: number; endMs: number; tags: Tag[]; parts: PlanPart[] };
type WordTimes = Record<string, { file: string; clipMs: number; words: { w: string; s: number; e: number }[] }>;

const PLAN: PlanScene[] = JSON.parse(readFileSync(path.resolve('demos/lib/plan.json'), 'utf8'));
const WORDS: WordTimes = JSON.parse(readFileSync(path.resolve('demos/lib/word-times.json'), 'utf8'));

export type Persona = 'sponsor' | 'provider' | 'verifier';
export const PERSONA_NAME: Record<Persona, string> = { sponsor: 'Avery Sponsor', provider: 'Riley Provider', verifier: 'Jordan Verifier' };

export interface Handoff {
  url: string;
  persona: Persona | null;
  cursor: { x: number; y: number };
  scroll?: { main?: number; drawer?: number };
  expanded?: string[];
  project?: string;
  investigation?: string;
  receipt?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

// ---------------------------------------------------------------- assertions log (read by the report)

export class Log {
  readonly lines: { t: number; ok: boolean; msg: string }[] = [];
  readonly tx: { label: string; hash: string; status: string; block: number; to: string }[] = [];
  constructor(private readonly id: string) {}
  ok(msg: string) {
    this.lines.push({ t: Date.now(), ok: true, msg });
    console.log(`  ✓ ${msg}`);
  }
  save(extra: Record<string, unknown> = {}) {
    mkdirSync(path.join(ARGO, this.id), { recursive: true });
    writeFileSync(path.join(ARGO, this.id, 'assertions.json'), JSON.stringify({ capture: this.id, at: new Date().toISOString(), checks: this.lines, transactions: this.tx, ...extra }, null, 2));
  }
}

// ---------------------------------------------------------------- API + chain helpers

export async function token(request: APIRequestContext, persona: string): Promise<string> {
  const r = await request.post(`${API}/auth/demo-login`, { data: { persona } });
  expect(r.ok(), `demo-login ${persona}`).toBeTruthy();
  return (await r.json()).token;
}

export async function apiGet<T = any>(request: APIRequestContext, p: string, persona?: string): Promise<T> {
  const headers = persona ? { Authorization: `Bearer ${await token(request, persona)}` } : undefined;
  const r = await request.get(`${API}${p}`, { headers });
  expect(r.ok(), `GET ${p} → ${r.status()}`).toBeTruthy();
  return r.json();
}

async function rpc<T = any>(request: APIRequestContext, method: string, params: unknown[]): Promise<T> {
  const r = await request.post(RPC, { data: { jsonrpc: '2.0', id: 1, method, params } });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

/** Every contract transaction recorded for the project must exist on Anvil, be mined with status 1 and target
 *  the escrow contract. Returns the receipts so the report can list them. */
export async function assertChainHistory(request: APIRequestContext, log: Log, code: string, expectEvents: string[]) {
  const proj = await apiGet(request, `/repair-projects/${code}`);
  const hist = await apiGet(request, `/repair-projects/${code}/history`);
  const events: string[] = hist.chain_events.map((e: any) => e.event);
  for (const ev of expectEvents) expect(events, `chain events for ${code}`).toContain(ev);
  const seen = new Set<string>();
  for (const e of hist.chain_events) {
    if (seen.has(e.tx_hash)) continue;
    seen.add(e.tx_hash);
    const rc = await rpc<any>(request, 'eth_getTransactionReceipt', [e.tx_hash]);
    expect(rc, `receipt ${e.tx_hash}`).toBeTruthy();
    expect(rc.status, `tx ${e.event} status`).toBe('0x1');
    expect(rc.to.toLowerCase(), `tx ${e.event} target`).toBe(proj.contract_address.toLowerCase());
    if (!log.tx.some((t) => t.hash === e.tx_hash)) log.tx.push({ label: e.event, hash: e.tx_hash, status: rc.status, block: parseInt(rc.blockNumber, 16), to: rc.to });
  }
  log.ok(`${code}: ${seen.size} contract transaction(s) mined with status 1 on Anvil (${[...new Set(events)].join(', ')})`);
  return proj;
}

// ---------------------------------------------------------------- handoff between captures

export function readHandoff(id: string): Handoff {
  const all = existsSync(HANDOFF) ? JSON.parse(readFileSync(HANDOFF, 'utf8')) : {};
  if (!all[id]) throw new Error(`No handoff from ${id}. Record the previous capture first (or run the state builder).`);
  return all[id];
}

export function writeHandoff(id: string, h: Handoff) {
  mkdirSync(ARGO, { recursive: true });
  const all = existsSync(HANDOFF) ? JSON.parse(readFileSync(HANDOFF, 'utf8')) : {};
  all[id] = h;
  writeFileSync(HANDOFF, JSON.stringify(all, null, 2));
}

// ---------------------------------------------------------------- page chrome: disclosure strip, highlight + camera CSS

const TAG_STYLE: Record<Tag['kind'], string> = {
  real: 'color:#f2a93b;border-color:rgba(242,169,59,.55);background:rgba(242,169,59,.10)',
  sim: 'color:#b49cf0;border-color:rgba(180,156,240,.55);background:rgba(180,156,240,.10)',
  chain: 'color:#6bcb77;border-color:rgba(107,203,119,.55);background:rgba(107,203,119,.10)',
  model: 'color:#b49cf0;border-color:rgba(180,156,240,.55);border-style:dashed;background:transparent',
  none: 'color:#a3a9b3;border-color:rgba(163,169,179,.45);background:transparent',
};

function stripHtml(scene: PlanScene, index: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const tags = scene.tags
    .map((t) => `<span class="pv-tag"><b style="${TAG_STYLE[t.kind]}">${esc(t.label)}</b>${esc(t.text)}</span>`)
    .join('<span class="pv-sep"></span>');
  // The pulsing dot keeps the compositor painting during static holds (Argo's jpeg-stitch capture only emits
  // frames on paint), and says what the footage is.
  return `<span class="pv-ch"><span class="pv-num">${String(index + 1).padStart(2, '0')}</span>${esc(scene.chapter)}</span>${tags}<span class="pv-live"><i></i>Live capture · local stack</span>`;
}

const CHROME_CSS = `
#pv-strip{position:fixed;left:0;right:0;bottom:0;height:34px;z-index:2147482000;pointer-events:none;
  display:flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap;
  background:#090b0e;border-top:1px solid rgba(255,255,255,.09);
  font:500 12.5px/1 var(--font-geist),ui-sans-serif,system-ui,sans-serif;color:#c9ced6;letter-spacing:.01em}
.h-dvh{height:calc(100dvh - 34px)!important}
#pv-strip .pv-ch{display:flex;align-items:center;gap:7px;color:#eef1f5;font-weight:600;padding-right:4px}
#pv-strip .pv-num{font:600 11px/1 var(--font-plex-mono),ui-monospace,monospace;color:#11161c;background:#e8ebef;border-radius:5px;padding:4px 5px}
#pv-strip .pv-tag{display:flex;align-items:center;gap:6px}
#pv-strip .pv-tag b{font:600 10.5px/1 var(--font-plex-mono),ui-monospace,monospace;letter-spacing:.08em;border:1px solid;border-radius:4px;padding:3px 5px}
#pv-strip .pv-sep{width:1px;height:14px;background:rgba(255,255,255,.14)}
#pv-strip .pv-live{position:absolute;right:16px;display:flex;align-items:center;gap:6px;color:#7d8590;font-size:11px}
#pv-strip .pv-live i{width:6px;height:6px;border-radius:50%;background:#6bcb77;animation:pv-pulse 1.4s ease-in-out infinite}
@keyframes pv-breathe{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes pv-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
.pv-hl{outline:2px solid transparent!important;outline-offset:3px;border-radius:8px;transition:outline-color .35s ease,box-shadow .35s ease!important}
.pv-hl.pv-on{outline-color:var(--pv-c)!important;box-shadow:0 0 0 6px color-mix(in srgb,var(--pv-c) 18%,transparent),0 0 28px color-mix(in srgb,var(--pv-c) 30%,transparent)!important}
#pv-end{position:fixed;inset:0;z-index:2147482500;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .9s ease;
  background:radial-gradient(1200px 600px at 50% 45%,rgba(24,28,36,.97),rgba(8,10,13,.99));pointer-events:none}
#pv-end.pv-on{opacity:1}
`;

/** Installs the disclosure strip on every document of this capture (survives full navigations). */
export async function installChrome(page: Page, scene: PlanScene, index: number) {
  await page.addInitScript(
    ({ css, html }) => {
      const mount = () => {
        if (document.getElementById('pv-strip')) return;
        const st = document.createElement('style');
        st.id = 'pv-style';
        st.textContent = css;
        document.documentElement.appendChild(st);
        const el = document.createElement('div');
        el.id = 'pv-strip';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = html;
        document.documentElement.appendChild(el);
      };
      if (document.readyState === 'complete') mount();
      else window.addEventListener('load', mount, { once: true });
    },
    { css: CHROME_CSS, html: stripHtml(scene, index) },
  );
}

const TONE = { amber: '#f2a93b', teal: '#4fb3a9', green: '#6bcb77', sim: '#b49cf0', white: '#e8ebef' } as const;
export type Tone = keyof typeof TONE;

/** Soft outline + glow on the element itself (moves and scales with it). Non-blocking. */
export async function highlight(loc: Locator, ms = 2600, tone: Tone = 'amber') {
  await loc.first().evaluate(
    (el, { ms, c }) => {
      const h = el as HTMLElement;
      h.style.setProperty('--pv-c', c);
      h.classList.add('pv-hl');
      requestAnimationFrame(() => requestAnimationFrame(() => h.classList.add('pv-on')));
      window.setTimeout(() => {
        h.classList.remove('pv-on');
        window.setTimeout(() => h.classList.remove('pv-hl'), 400);
      }, ms);
    },
    { ms, c: TONE[tone] },
  );
}

/** Restrained camera: scale the page content (not the top bar, rail or disclosure strip) toward an element. */
export async function zoomTo(loc: Locator, scale = 1.18, ms = 1100) {
  await loc.first().evaluate(
    (el, { scale, ms }) => {
      const main = document.querySelector('main') as HTMLElement;
      const content = main.firstElementChild as HTMLElement;
      const prev = content.style.transform;
      content.style.transition = 'none';
      content.style.transform = 'none';
      const mr = main.getBoundingClientRect();
      const cr = content.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      content.style.transform = prev;
      void content.offsetWidth;
      const px = er.left + er.width / 2 - cr.left;
      const py = er.top + er.height / 2 - cr.top;
      let tx = mr.left + mr.width / 2 - cr.left - scale * px;
      let ty = mr.top + mr.height / 2 - cr.top - scale * py;
      tx = Math.min(mr.left - cr.left, Math.max(mr.right - cr.left - scale * cr.width, tx));
      ty = Math.min(mr.top - cr.top, Math.max(mr.bottom - cr.top - scale * Math.max(cr.height, mr.height), ty));
      content.style.transformOrigin = '0 0';
      content.style.willChange = 'transform';
      content.style.transition = `transform ${ms}ms cubic-bezier(.45,0,.2,1)`;
      content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    },
    { scale, ms },
  );
  await sleep(ms);
}

export async function resetZoom(page: Page, ms = 900) {
  await page.evaluate((ms) => {
    const content = document.querySelector('main')?.firstElementChild as HTMLElement | null;
    if (!content || !content.style.transform || content.style.transform === 'none') return;
    content.style.transition = `transform ${ms}ms cubic-bezier(.45,0,.2,1)`;
    content.style.transform = 'translate(0px, 0px) scale(1)';
  }, ms);
  await sleep(ms);
  await page.evaluate(() => {
    const content = document.querySelector('main')?.firstElementChild as HTMLElement | null;
    if (content) {
      content.style.transition = '';
      content.style.transform = '';
      content.style.willChange = '';
    }
  });
}

/** Smoothly scroll the nearest scroll container so the element sits at `block` of the viewport. */
export async function reveal(loc: Locator, block: ScrollLogicalPosition = 'center', settleMs = 750) {
  await loc.first().evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' }), block);
  await sleep(settleMs);
}

export async function scrollMainTo(page: Page, top: number, settleMs = 750) {
  await page.evaluate((top) => document.querySelector('main')?.scrollTo({ top, behavior: 'smooth' }), top);
  await sleep(settleMs);
}

export async function mainScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0);
}

/** A <Panel> (section) by its exact heading text. */
export function panel(page: Page, title: string): Locator {
  return page.getByRole('heading', { name: title, exact: true }).locator('xpath=ancestor::section[1]');
}

/** Closing card: the supplied closing line plus the standing disclosure. Fades in over the live app. */
export async function showEndCard(page: Page) {
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'pv-end';
    el.innerHTML = `
      <div style="text-align:center;max-width:980px;padding:0 40px;font-family:var(--font-geist),ui-sans-serif,system-ui,sans-serif">
        <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:34px">
          <svg viewBox="0 0 32 32" width="44" height="44" aria-hidden="true" style="color:#e8ebef">
            <circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>
            <path d="M16 3v4M16 25v4M3 16h4M25 16h4" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M11 22c0-4 5-4 5-8s-3-4-1-8" fill="none" stroke="#f2a93b" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M17 22c0-3 4-3 4-6s-2-3-1-6" fill="none" stroke="#f2a93b" stroke-opacity="0.55" stroke-width="1.6" stroke-linecap="round" style="animation:pv-breathe 2.4s ease-in-out infinite"/>
          </svg>
          <span style="font-size:26px;font-weight:600;letter-spacing:.22em;color:#eef1f5">PLUME</span>
        </div>
        <div style="font-size:46px;line-height:1.18;font-weight:600;letter-spacing:-.01em;color:#eef1f5">We don't just track emissions.</div>
        <div style="font-size:46px;line-height:1.18;font-weight:600;letter-spacing:-.01em;color:#f2a93b;margin-top:6px">We help turn evidence into action.</div>
        <div style="margin-top:42px;font-size:13.5px;line-height:1.7;color:#8b929c">
          Real: historical Carbon Mapper CH₄ detections · Simulated: repair, evidence, organisations and funds<br/>
          Transactions executed on a local Anvil test chain · Impact Receipts are not carbon credits · Real-world verified reductions: none
        </div>
      </div>`;
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('pv-on')));
  });
}

// ---------------------------------------------------------------- map render check (pixels, not DOM)

/** Screenshots a region and counts warm "plume raster" pixels and basemap variance, so a blank or black map fails. */
export async function assertMapRendered(page: Page, log: Log, region: { x: number; y: number; width: number; height: number }, opts: { plume: boolean }) {
  const deadline = Date.now() + 20_000;
  let last = { warm: 0, plume: 0, std: 0 };
  while (Date.now() < deadline) {
    const png = await page.screenshot({ clip: region, scale: 'css' });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    // Amber rate markers (sequential amber ramp) and the provider plume raster (jet colormap: saturated blue/cyan
    // body) are both distinct from the grey dark-matter basemap.
    let warm = 0;
    let plume = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 150 && b < 110 && r - b > 80 && g > 50) warm++;
      if (b > 140 && b - r > 70) plume++;
    }
    const stats = await sharp(png).stats();
    const std = stats.channels.slice(0, 3).reduce((a, c) => a + c.stdev, 0) / 3;
    last = { warm, plume, std };
    if (std > 6 && warm > 40 && (!opts.plume || plume > 400)) {
      log.ok(`map rendered (${region.width}×${region.height} px region): σ=${std.toFixed(1)}, ${warm} amber marker px${opts.plume ? `, ${plume} plume-raster px` : ''}`);
      return last;
    }
    await sleep(500);
  }
  throw new Error(`map did not render as expected (σ=${last.std.toFixed(1)}, amber=${last.warm}, plume=${last.plume})`);
}

export async function waitForMapIdle(page: Page, ms = 1200) {
  // MapLibre exposes no global; wait for the canvas to stop changing between two screenshots.
  const canvas = page.locator('[data-testid="mission-map"] canvas').first();
  await expect(canvas).toBeVisible();
  let prev = '';
  for (let i = 0; i < 40; i++) {
    const buf = await canvas.screenshot({ scale: 'css' });
    const h = createHash('sha1').update(buf).digest('hex');
    if (h === prev) return;
    prev = h;
    await sleep(ms / 2);
  }
}

/** Wheel-zooms the map ~2 levels around the current mouse position (real MapLibre interaction). */
export async function zoomMapAtCursor(page: Page) {
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -120);
    await sleep(150);
  }
  await sleep(1400);
}

// ---------------------------------------------------------------- personas

export async function presetSession(page: Page, request: APIRequestContext, persona: Persona | null) {
  const t = persona ? await token(request, persona) : null;
  await page.addInitScript((t) => {
    try {
      if (t) window.localStorage.setItem('plume.token', t);
      else window.localStorage.removeItem('plume.token');
    } catch {
      /* storage unavailable */
    }
  }, t);
}

// ---------------------------------------------------------------- director

export class Director {
  readonly scene: PlanScene;
  readonly index: number;
  readonly log: Log;
  cursor!: HumanCursor;
  private t0 = 0;
  private lastClipEnd = 0;
  private current: { scene: string; at: number } | null = null;
  private pos = { x: 0.55, y: 0.55 };
  readonly marks: Record<string, number> = {};

  constructor(
    readonly page: Page,
    readonly narration: NarrationTimeline,
    readonly request: APIRequestContext,
    id: string,
  ) {
    this.index = PLAN.findIndex((p) => p.id === id);
    if (this.index < 0) throw new Error(`unknown capture ${id}`);
    this.scene = PLAN[this.index];
    this.log = new Log(id);
    for (const p of this.scene.parts) this.clip(p.scene); // fail fast if TTS/word timings are stale
  }

  get windowMs() {
    return this.scene.endMs - this.scene.startMs;
  }

  /** Clip timing for a part. Refuses stale timings (text or voice changed since word-times.json was built). */
  clip(scene: string) {
    const part = this.scene.parts.find((p) => p.scene === scene);
    const wt = WORDS[`${this.scene.id}/${scene}`];
    if (!part || !wt) throw new Error(`no narration timing for ${this.scene.id}/${scene}`);
    const h = createHash('sha256').update(JSON.stringify({ scene, text: part.say, voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed })).digest('hex');
    if (!wt.file.endsWith(`${h}.wav`)) throw new Error(`word timings for ${this.scene.id}/${scene} are stale — run scripts/word-times.mjs`);
    return wt;
  }

  /** Off camera. `warm` routes are opened once so their JS chunks are cached (each capture is a fresh browser
   *  context); a route first opened on camera would otherwise show its loading skeleton. No state is changed. */
  async prepare(start?: { x: number; y: number }, warm: string[] = []) {
    if (start) this.pos = start;
    for (const url of warm) {
      await this.page.goto(url);
      await this.page.waitForLoadState('networkidle').catch(() => undefined);
    }
    await installChrome(this.page, this.scene, this.index);
  }

  /** Starts the screencast (everything before this is off camera). */
  async begin() {
    await this.page.evaluate(() => document.getElementById('pv-strip') !== null).then((ok) => expect(ok, 'disclosure strip mounted').toBeTruthy());
    await this.narration.startRecording(this.page);
    this.t0 = Date.now();
    this.cursor = await createHumanCursor(this.page, { seed: this.scene.id, size: 26, start: this.pos });
  }

  /** Marks a narration part (its Kokoro clip starts here) and runs its choreography. */
  async part(scene: string, fn: () => Promise<void>) {
    const wait = this.lastClipEnd + 300 - Date.now();
    if (wait > 0) await sleep(wait); // never start a clip before the previous one has finished
    this.narration.mark(scene);
    const at = Date.now();
    this.marks[scene] = at - this.t0;
    this.lastClipEnd = at + this.clip(scene).clipMs;
    this.current = { scene, at };
    await fn();
  }

  /** Waits until the narrator reaches `phrase` in the current part (plus offset). Returns immediately if late. */
  async cue(phrase: string, offsetMs = 0) {
    if (!this.current) throw new Error('cue() outside part()');
    const words = this.clip(this.current.scene).words;
    const target = phrase.split(/\s+/).map(norm).filter(Boolean);
    let at: number | null = null;
    for (let i = 0; i < words.length && at === null; i++) {
      let j = 0;
      let k = i;
      while (k < words.length && j < target.length) {
        const w = norm(words[k].w);
        if (!w) {
          k++;
          continue;
        }
        if (w !== target[j] && !(target[j].startsWith(w) || w.startsWith(target[j]))) break;
        j++;
        k++;
      }
      if (j === target.length) at = words[i].s;
    }
    if (at === null) throw new Error(`cue "${phrase}" not found in ${this.scene.id}/${this.current.scene}`);
    await sleep(this.current.at + at + offsetMs - Date.now());
  }

  /** Waits until the current part's clip has finished (plus a small tail). */
  async clipEnd(tailMs = 200) {
    await sleep(this.lastClipEnd + tailMs - Date.now());
  }

  async moveTo(loc: Locator, fx = 0.5, fy = 0.5, durationMs?: number) {
    await this.track(loc, fx, fy);
    await this.cursor.moveTo(loc.first(), { target: { x: fx, y: fy }, ...(durationMs ? { durationMs } : {}) });
  }

  async click(loc: Locator, fx = 0.5, fy = 0.5) {
    await expect(loc.first()).toBeVisible();
    await this.track(loc, fx, fy);
    await this.cursor.click(loc.first(), { target: { x: fx, y: fy } });
  }

  private async track(loc: Locator, fx: number, fy: number) {
    const b = await loc.first().boundingBox();
    const vp = this.page.viewportSize()!;
    if (b) this.pos = { x: (b.x + b.width * fx) / vp.width, y: (b.y + b.height * fy) / vp.height };
  }

  async persona(p: Persona) {
    await this.click(this.page.getByTestId('persona-switcher'));
    await this.click(this.page.getByTestId(`persona-${p}`), 0.3, 0.5);
    await expect(this.page.getByTestId('persona-switcher')).toContainText(PERSONA_NAME[p]);
    this.log.ok(`acting as ${PERSONA_NAME[p]} (${p})`);
  }

  /** Holds until the scene window ends — never before the last clip has finished. Saves handoff + assertions. */
  async finish(handoff: Omit<Handoff, 'cursor'>) {
    const windowEnd = this.t0 + this.windowMs;
    const speechEnd = this.lastClipEnd + 400;
    const overrun = Math.max(0, speechEnd - windowEnd);
    if (overrun > 0) console.warn(`  ! ${this.scene.id}: narration needs ${overrun} ms beyond the window; holding for it`);
    await sleep(Math.max(windowEnd, speechEnd) + 350 - Date.now());
    writeHandoff(this.scene.id, { ...handoff, cursor: this.pos });
    this.log.save({ marksMs: this.marks, windowMs: this.windowMs, recordedMs: Date.now() - this.t0, overrunMs: overrun });
  }
}
