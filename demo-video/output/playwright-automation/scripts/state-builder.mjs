// Rebuilds the app state that a given capture leaves behind, off camera, through the real PLUME API (every
// transaction is still sent by the backend to Anvil). Used only when a capture fails: the stack is reset, the
// state is rebuilt through the previous capture, and only the failed capture is recorded again.
//   node scripts/state-builder.mjs <capture-id>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const API = process.env.PLUME_API ?? 'http://localhost:8000/api/v1';
const INCIDENT = 'INC-32893D';
const FEATURED_OBS = 'av320241001t172751-M';
const ORDER = ['plume-01-problem', 'plume-02-detection', 'plume-03-investigation', 'plume-04-funding', 'plume-05-repair', 'plume-06-verification', 'plume-07-settlement'];
const OPENED = ['Investigation', 'Repair submission', 'Evidence commitment', 'Verification decision', 'Smart contract state', 'Payment transaction'];

const tokens = {};
async function tok(p) {
  if (!tokens[p]) {
    const r = await fetch(`${API}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: p }) });
    tokens[p] = (await r.json()).token;
  }
  return tokens[p];
}
async function call(method, path, as, body, form) {
  const headers = as ? { Authorization: `Bearer ${await tok(as)}` } : {};
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(`${API}${path}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const target = process.argv[2];
const upto = ORDER.indexOf(target);
if (upto < 0) throw new Error(`usage: state-builder.mjs <${ORDER.join('|')}>`);
const handoff = {};
const cursor = { x: 0.55, y: 0.55 };
let inv, code, receipt;

for (let i = 0; i <= upto; i++) {
  const id = ORDER[i];
  if (id === 'plume-01-problem') handoff[id] = { url: '/', persona: null, cursor };
  if (id === 'plume-02-detection') handoff[id] = { url: `/?obs=${FEATURED_OBS}`, persona: null, cursor };
  if (id === 'plume-03-investigation') {
    inv = await call('POST', `/incidents/${INCIDENT}/investigate`, 'sponsor');
    handoff[id] = { url: `/investigations/${inv.id}`, persona: 'sponsor', investigation: inv.id, cursor };
  }
  if (id === 'plume-04-funding') {
    // Exactly the defaults the "Create a repair bounty" form submits.
    const p = await call('POST', '/repair-projects', 'sponsor', {
      incident_id: INCIDENT,
      title: `Leak detection & repair at ${INCIDENT}`,
      repair_scope: 'Conduct a ground leak survey at the plume origin, repair or replace emitting components with operator authorization, and re-survey to confirm repair.',
      site_authorization: 'Sponsor attests that the facility operator has authorized the assigned provider to inspect and repair equipment at this location (simulated attestation).',
      milestones: [
        { name: 'Pre-repair survey', description: 'Locate emitting components at the plume origin.' },
        { name: 'Repair', description: 'Repair or replace emitting components.' },
        { name: 'Post-repair verification', description: 'Independent re-survey and site measurements.' },
      ],
      methodology: 'QUANTIFIED_REDUCTION', min_monitoring_days: 21, funding_amount_eth: '2.5', provider_id: 'provider', verifier_id: 'verifier',
      expires_in_days: 120, dispute_window_hours: 0,
    });
    code = p.code;
    await call('POST', `/repair-projects/${code}/publish`, 'sponsor');
    await call('POST', `/repair-projects/${code}/fund`, 'sponsor');
    handoff[id] = { url: `/projects/${code}`, persona: 'sponsor', project: code, cursor };
  }
  if (id === 'plume-05-repair') {
    await call('POST', `/repair-projects/${code}/accept`, 'provider');
    let t = await call('GET', `/repair-projects/${code}/simulated-evidence`, 'provider');
    if (!t.ready) {
      await call('POST', '/demo/advance-time', 'provider', { days: t.days_to_advance });
      t = await call('GET', `/repair-projects/${code}/simulated-evidence`, 'provider');
    }
    const fd = new FormData();
    fd.set('payload', JSON.stringify(t.payload));
    for (const f of t.files) fd.append('files', new Blob([f.content], { type: f.media_type }), f.name);
    await call('POST', `/repair-projects/${code}/submit-evidence`, 'provider', undefined, fd);
    handoff[id] = { url: `/projects/${code}`, persona: 'provider', project: code, cursor };
  }
  if (id === 'plume-06-verification') {
    await call('POST', `/repair-projects/${code}/start-review`, 'verifier');
    await call('POST', `/repair-projects/${code}/verify`, 'verifier', { outcome: 'VERIFIED', notes: 'Documentation complete; reduction exceeds uncertainty (synthetic evidence).' });
    handoff[id] = { url: `/verification/${code}`, persona: 'verifier', project: code, cursor };
  }
  if (id === 'plume-07-settlement') {
    receipt = (await call('POST', `/repair-projects/${code}/release`, 'verifier')).receipt_id;
    handoff[id] = { url: `/receipts/${receipt}`, persona: 'verifier', project: code, receipt, expanded: OPENED, cursor };
  }
}

mkdirSync('.argo', { recursive: true });
const path = '.argo/handoff.json';
const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
for (const [k, v] of Object.entries(handoff)) all[k] = { ...v, cursor: all[k]?.cursor ?? v.cursor, rebuilt: true };
writeFileSync(path, JSON.stringify(all, null, 2));
console.log(`state rebuilt through ${target}${code ? ` (project ${code})` : ''}`);
