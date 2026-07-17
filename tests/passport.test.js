'use strict';
// PASSPORT MODEL — the single source of truth for the print DOM and the PDF. This proves the model
// is DETERMINISTIC (identical regardless of consumer/time) and that its string contract is complete.
// The DOM==PDF string parity itself is proven in the browser (tests/ux/passport.spec.js), where both
// renderers run against this same model.
//
//   node tests/passport.test.js
const assert = require('assert');
const P = require('../site/passport.js');
const data = require('./ux/fixtures/results-complete.json');

const drugs = [
  ['596934', { label: 'duloxetine 60 MG Delayed Release Oral Capsule', qty: 30 }],
  ['596926', { label: 'duloxetine 20 MG Delayed Release Oral Capsule', qty: 30 }],
];
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('Passport model — one source of truth (print DOM + PDF render from THIS):');

t('model is identical regardless of consumer (deterministic items + strings)', () => {
  const m1 = P.passportModel(data, drugs, { shareUrl: 'https://planrobin.com/#abc' });
  const m2 = P.passportModel(data, drugs, { shareUrl: 'https://planrobin.com/#abc' });
  assert.deepStrictEqual(m1.items, m2.items);
  assert.deepStrictEqual(P.passportStrings(m1), P.passportStrings(m2));
});

t('string contract is complete: brand, county, meds, plan money, caveats, reopen', () => {
  const m = P.passportModel(data, drugs, { shareUrl: 'https://planrobin.com/#abc' });
  const s = P.passportStrings(m);
  assert.ok(s.includes('PlanRobin — Medicare drug plan comparison'), 'brand');
  assert.ok(s.some((x) => /^County: .+, .+/.test(x)), 'county');
  assert.ok(s.some((x) => /duloxetine/.test(x)), 'a medication name');
  // fixture plans are MA-PD → the sub line qualifies the premium as the drug-coverage portion
  assert.ok(s.some((x) => /· drug coverage premium \$\d/.test(x)), 'MA-PD plan sub line shows the drug-coverage premium qualifier');
  assert.ok(s.some((x) => /\/yr|Doesn’t cover/.test(x)), 'a plan total');
  assert.ok(s.includes('Before you decide'), 'caveats heading');
  assert.ok(s.some((x) => /1-800-MEDICARE/.test(x)), 'medicare phone caveat');
  assert.ok(s.includes('https://planrobin.com/#abc'), 'reopen url');
});

t('MA-PD premium caveat renders when an MA-PD is printed, and NOT for a PDP-only list', () => {
  // the fixture is all MA-PD → the caveat must appear in the shared model (so DOM + PDF both carry it)
  const withMa = P.passportStrings(P.passportModel(data, drugs, { shareUrl: 'x' }));
  assert.ok(withMa.some((x) => /separate medical premium not shown here/.test(x)), 'MA-PD caveat present when an MA-PD is in the printed list');

  // a PDP-only sheet carries no note it doesn't need (conditional honesty — no noise)
  const pdpOnly = {
    county: { name: 'St. Louis', state: 'Missouri' }, planCount: 1, meta: { quarter: '2026-Q1' },
    plans: [{ planId: 'S5601-001', segmentId: '000', planName: 'SilverScript Choice', planType: 'PDP',
      premium: 22.4, deductible: 0, notCovered: 0, annualComplete: true, breakdown: {},
      drugs: { '9': { covered: true, tier: 2, flags: {}, headline: { kind: 'copay', dollars: 10 }, appliedOverrides: [] } } }],
  };
  const noMa = P.passportStrings(P.passportModel(pdpOnly, [['9', { label: 'somedrug', qty: 30 }]], { shareUrl: 'x' }));
  assert.ok(!noMa.some((x) => /separate medical premium/.test(x)), 'no MA-PD caveat for a PDP-only list');
});

t('two-roads caveat prints only when BOTH roads are in the list (paper has no divider)', () => {
  // the fixture is all MA-PD → one road → no two-roads caveat
  const oneRoad = P.passportStrings(P.passportModel(data, drugs, { shareUrl: 'x' }));
  assert.ok(!oneRoad.some((x) => /not interchangeable/.test(x)), 'no two-roads caveat on a one-road sheet');

  // a mixed sheet must carry the consequence itself
  const mixed = JSON.parse(JSON.stringify(data));
  mixed.plans[1].planType = 'PDP';           // make the list span both roads
  const s = P.passportStrings(P.passportModel(mixed, drugs, { shareUrl: 'x' }));
  const caveat = s.find((x) => /not interchangeable/.test(x));
  assert.ok(caveat, 'mixed-road sheet carries the two-roads caveat');
  assert.ok(/end that plan and return you to Original Medicare/.test(caveat), caveat);
  assert.ok(/SHIP/.test(caveat), 'and hands off to a human');
});

t('per-drug price rows carry their basis (per what supply), from the shared constant', () => {
  const B = require('../site/format.js').HEADLINE_BASIS;
  const m = P.passportModel(data, drugs, { shareUrl: 'x' });
  const rows = m.items.filter((i) => i.type === 'plan').flatMap((i) => i.drugs);
  const priced = rows.map((r) => r[2]).filter((c) => /^\$/.test(c));
  assert.ok(priced.length > 0, 'fixture has copay rows');
  for (const c of priced) assert.ok(c.includes(B.perLabel), `price states its basis: ${c}`);
});

t('numbers/strings all come from PRFormat (no bare $0.00 totals, whole-dollar yearly totals)', () => {
  const m = P.passportModel(data, drugs, { shareUrl: 'x' });
  const totals = m.items.filter((i) => i.type === 'plan').map((i) => i.total);
  assert.ok(totals.length > 0);
  for (const tot of totals) assert.ok(/^\$[\d,]+\/yr|Doesn’t cover|^\$[\d,]+\/yr so far|for \d+ of \d+/.test(tot), `total looks right: ${tot}`);
});

t('coinsurance cost is WinAnsi-safe (≈ → ~) so the standard-font PDF can never crash on it', () => {
  const coinsData = {
    county: { name: 'St. Louis', state: 'Missouri' }, planCount: 1, meta: { quarter: '2026-Q1' },
    plans: [{ planId: 'H1-001', segmentId: '000', planName: 'Test Plan', planType: 'MA-PD', premium: 0, deductible: 0, notCovered: 0, annualComplete: true, breakdown: { coinsuranceEstRxcuis: ['9'] },
      drugs: { '9': { covered: true, tier: 4, flags: {}, headline: { kind: 'coinsurance', display: '25%' }, estimated: { annual: 500 }, appliedOverrides: [] } } }],
  };
  const m = P.passportModel(coinsData, [['9', { label: 'somedrug', qty: 30 }]], { shareUrl: 'x' });
  const s = P.passportStrings(m);
  // the estimate carries its basis too ("of each 30-day fill"), and stays WinAnsi-safe
  assert.ok(s.some((x) => x.includes('25% of each 30-day fill ~ $500/yr')), 'coinsurance shows its basis + ~ (approx), from the estimate: ' + s.join(' | '));
  assert.ok(!s.some((x) => /≈/.test(x)), 'no un-encodable ≈ survives into the model');
});

t('reopen section offers three paths (camera, re-add, tap the link) + the share URL', () => {
  const m = P.passportModel(data, drugs, { shareUrl: 'https://planrobin.com/#abc' });
  const paths = m.items.filter((i) => i.type === 'path');
  assert.strictEqual(paths.length, 3);
  assert.ok(paths[0].text.startsWith('Use your phone’s camera'), paths[0].text);
  assert.ok(/re-add your medications from the list on page 1/.test(paths[1].text), paths[1].text);
  assert.ok(/tap the link/i.test(paths[2].text), paths[2].text);
  const url = m.items.find((i) => i.type === 'url');
  assert.strictEqual(url.link, 'https://planrobin.com/#abc'); // the clickable hyperlink target
  const s = P.passportStrings(m);
  assert.ok(s.includes(paths[0].text) && s.includes(url.text), 'path sentences + url are in the parity contract');
});

t('filename is planrobin-comparison-YYYY-MM-DD.pdf', () => {
  const m = P.passportModel(data, drugs, { shareUrl: 'x' });
  assert.ok(/^planrobin-comparison-\d{4}-\d{2}-\d{2}\.pdf$/.test(m.filename), m.filename);
});

console.log(`\nALL PASSPORT MODEL TESTS PASSED (${passed}).`);
