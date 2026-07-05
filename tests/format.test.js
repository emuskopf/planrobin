'use strict';
// Display-formatting tests (site/format.js) — whole-dollar totals that visibly add up, and the
// savings-sentence wording incl. the $0 special case. Pure, no DB. Run: node tests/format.test.js

const assert = require('assert');
const F = require('../site/format.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

console.log('Whole-dollar display totals:');
t('dollars() rounds to whole dollars with separators', () => {
  assert.strictEqual(F.dollars(355.2), '$355');
  assert.strictEqual(F.dollars(0), '$0');
  assert.strictEqual(F.dollars(1376.04), '$1,376');
});

t('planDisplayTotal (no cap) = SUM of rounded components (so lines visibly add up)', () => {
  // premium 100.60 + copay 100.60: sum-of-rounded = 101 + 101 = 202 (NOT round(201.20)=201).
  const p = { annualEstimate: 201.2, breakdown: { premiumAnnual: 100.6, copayAnnual: 100.6, coinsuranceEstRxcuis: [], capBinds: false } };
  assert.strictEqual(F.planDisplayTotal(p), 202);
  assert.notStrictEqual(F.planDisplayTotal(p), F.round(p.annualEstimate)); // proves sum-of-rounded, not round-of-sum
});

t('planDisplayTotal folds in per-drug coinsurance estimates', () => {
  const p = { annualEstimate: 1504.44, breakdown: { premiumAnnual: 128.4, copayAnnual: 0, coinsuranceEstRxcuis: ['x'], capBinds: false }, drugs: { x: { estimated: { annual: 1376.04 } } } };
  assert.strictEqual(F.planDisplayTotal(p), 128 + 1376); // 1504
});

t('planDisplayTotal (cap binds) = the capped total, not the pre-cap components', () => {
  const p = { annualEstimate: 2100, breakdown: { premiumAnnual: 0, copayAnnual: 0, coinsuranceEstRxcuis: ['x'], capBinds: true }, drugs: { x: { estimated: { annual: 131525.64 } } } };
  assert.strictEqual(F.planDisplayTotal(p), 2100);
});

console.log('\nSavings sentence (whole dollars; pair visibly agrees):');
t('normal case: "…bringing your total to about $Y/yr"; anchor − amount = Y', () => {
  const p = { annualEstimate: 248.4, breakdown: { premiumAnnual: 128.4, copayAnnual: 120, coinsuranceEstRxcuis: [], capBinds: false }, savings: { channel: 'preferredRetail', channelTotal: 128.4 } };
  const c = F.savingsCopy(p, "this plan's preferred pharmacies");
  assert.strictEqual(c.full, "Save about $120/year at this plan's preferred pharmacies — bringing your total to about $128/yr.");
  assert.strictEqual(c.anchorD - c.savingsD, c.channelTotalD); // 248 − 120 = 128, visibly adds up
});

t('zero-total case: "…bringing your total to $0 for the year." (no "about", no cents)', () => {
  const p = { annualEstimate: 120, breakdown: { premiumAnnual: 0, copayAnnual: 120, coinsuranceEstRxcuis: [], capBinds: false }, savings: { channel: 'preferredRetail', channelTotal: 0 } };
  const c = F.savingsCopy(p, "this plan's preferred pharmacies");
  assert.strictEqual(c.full, "Save about $120/year at this plan's preferred pharmacies — bringing your total to $0 for the year.");
  assert.ok(!/about \$0/.test(c.full) && !/\.00/.test(c.full), 'no "about", no cents on the zero case');
});

t('mail channel wording uses the mail location string', () => {
  const p = { annualEstimate: 300, breakdown: { premiumAnnual: 0, copayAnnual: 300, coinsuranceEstRxcuis: [], capBinds: false }, savings: { channel: 'standardMail', channelTotal: 180 } };
  const c = F.savingsCopy(p, "this plan's mail-order pharmacy");
  assert.strictEqual(c.full, "Save about $120/year at this plan's mail-order pharmacy — bringing your total to about $180/yr.");
});

console.log('\nCoverage completeness (shared definition):');
t('planCoverage: complete vs partial, with missing drugs named', () => {
  const complete = { drugs: { '1': { covered: true }, '2': { covered: true } } };
  assert.deepStrictEqual(F.planCoverage(complete), { total: 2, covered: 2, missing: [], complete: true });
  const partial = { drugs: { '1': { covered: true }, '2': { covered: false } } };
  const c = F.planCoverage(partial);
  assert.strictEqual(c.complete, false);
  assert.strictEqual(c.covered, 1);
  assert.deepStrictEqual(c.missing, ['2']);
});

t('planRank: a $0 partial plan NEVER outranks a complete plan', () => {
  const completePricey = { notCovered: 0, annualComplete: true, annualEstimate: 100 };
  const partialFree = { notCovered: 1, annualComplete: true, annualEstimate: 0 };
  assert.strictEqual([partialFree, completePricey].sort(F.planRank)[0], completePricey);
  // within the complete group, cheaper first; within partial group, cheaper first
  const c0 = { notCovered: 0, annualComplete: true, annualEstimate: 0 };
  const c5 = { notCovered: 0, annualComplete: true, annualEstimate: 5 };
  const p0 = { notCovered: 2, annualComplete: true, annualEstimate: 0 };
  const sorted = [c5, p0, c0, completePricey].sort(F.planRank);
  assert.deepStrictEqual(sorted.map((x) => x.annualEstimate + '/' + x.notCovered), ['0/0', '5/0', '100/0', '0/2']);
});

t('planRank: within the partial group, covering MORE drugs beats a cheaper-but-emptier plan', () => {
  const covers1 = { notCovered: 1, annualComplete: true, annualEstimate: 83 };  // covers 1 of 2, $83
  const covers0 = { notCovered: 2, annualComplete: true, annualEstimate: 0 };   // covers 0 of 2, $0
  assert.strictEqual([covers0, covers1].sort(F.planRank)[0], covers1); // the $0 empty plan must not lead
});

console.log(`\nALL FORMAT TESTS PASSED (${passed}).`);
