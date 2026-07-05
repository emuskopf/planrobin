'use strict';
// Capture real API responses from a running dev server (PGLITE full MO data) and derive the
// results-state variants the UX floor suite replays. Deterministic + hermetic: the suite never
// touches the DB or the network, it replays these JSON files via Playwright route interception.
//
//   (dev server on :8788)  node tests/ux/build-fixtures.js
//
// Re-run only when the API shape changes. Fixtures are committed.

const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'fixtures');
const BASE = process.env.BASE || 'http://localhost:8788';

async function get(p) { const r = await fetch(BASE + p); if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`); return r.json(); }
async function post(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`POST ${p} -> ${r.status}`); return r.json(); }
const write = (name, obj) => { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 1)); console.log('  wrote', name, `(${Math.round(fs.statSync(path.join(OUT, name)).size / 1024)}kb)`); };
const clone = (o) => JSON.parse(JSON.stringify(o));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('Capturing base API responses…');

  const counties = await get('/api/counties');
  counties.counties = counties.counties.filter((c) => ['26940', '26950', '26910', '26490'].includes(c.code));
  write('counties.json', counties);
  write('meta.json', await get('/api/meta'));
  write('zip-single.json', await get('/api/zip?zip=63011'));
  write('zip-multi.json', await get('/api/zip?zip=65041'));

  const rx = await get('/api/rxnorm/search?q=duloxetine');
  rx.results = rx.results.slice(0, 6);
  write('rxnorm.json', rx);

  // Two-drug basket (a copay drug + another) -> real complete plans with breakdown + channels.
  const full = await post('/api/results', { county: '26940', rxcuis: ['596934', '596926'], quantities: { '596934': 30, '596926': 30 } });
  const RX_A = '596934', RX_B = '596926';
  full.plans = full.plans.slice(0, 8); full.planCount = full.plans.length;

  // ---- complete: ensure at least one plan advertises a savings line (calm "bringing your total to…")
  const complete = clone(full);
  const sp = complete.plans[1];
  const anchor = Math.round(sp.annualEstimate || sp.breakdown.total || 300);
  sp.savings = { channel: 'preferredMail', channelTotal: Math.max(0, anchor - 120) };
  write('results-complete.json', complete);

  // ---- partial: some plans miss drug B (honest "$X · covers N of your M meds" + divider)
  const partial = clone(full);
  for (const i of [5, 6, 7]) {
    const p = partial.plans[i];
    if (p.drugs[RX_B]) p.drugs[RX_B].covered = false;
    p.notCovered = 1;
    p.breakdown.notCoveredRxcuis = [RX_B];
    p.savings = null;
    p.annualComplete = false;
  }
  write('results-partial.json', partial);

  // ---- zero-coverage: every plan covers 0 of the basket (no-dollar badge + no-complete note)
  const zero = clone(full);
  for (const p of zero.plans) {
    for (const k of Object.keys(p.drugs)) p.drugs[k].covered = false;
    p.notCovered = Object.keys(p.drugs).length;
    p.breakdown.notCoveredRxcuis = Object.keys(p.drugs);
    p.savings = null; p.annualComplete = false;
  }
  write('results-zero.json', zero);

  // ---- cap note: a plan that reaches the $2,100 OOP cap mid-year
  const cap = clone(complete);
  const cp = cap.plans[0];
  cp.capHit = { reached: true, month: 3 };
  cp.breakdown.capHit = { reached: true, month: 3 };
  cp.breakdown.capBinds = true;
  cp.breakdown.oopCap = 2100; cp.breakdown.cappedDrugOOP = 2100;
  write('results-cap.json', cap);

  console.log('Done. Base RX:', RX_A, RX_B);
}
main().catch((e) => { console.error('build-fixtures FAILED:', e.message); process.exit(1); });
