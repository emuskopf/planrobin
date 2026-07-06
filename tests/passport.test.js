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
  assert.ok(s.some((x) => /· premium \$\d/.test(x)), 'a plan sub line with the CMS id + premium');
  assert.ok(s.some((x) => /\/yr|Doesn’t cover/.test(x)), 'a plan total');
  assert.ok(s.includes('Before you decide'), 'caveats heading');
  assert.ok(s.some((x) => /1-800-MEDICARE/.test(x)), 'medicare phone caveat');
  assert.ok(s.includes('https://planrobin.com/#abc'), 'reopen url');
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
  assert.ok(s.some((x) => x.includes('25% ~ $500/yr')), 'coinsurance shows ~ (approx), from the estimate: ' + s.join(' | '));
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
