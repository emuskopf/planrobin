'use strict';
// Unit tests for the statutory override layer (tools/overrides). Pure functions over real
// Missouri RXCUIs (from tools/overrides/data/classification.json) + representative cost inputs.
// Hermetic: no DB, no network. Run: node tests/overrides.test.js

const assert = require('assert');
const { applyPerFillOverrides, projectAnnual, classify } = require('../tools/overrides');
const { paramsForYear } = require('../tools/overrides/statutory-params');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// Real MO RXCUIs: insulin Toujeo 1604544, ACIP vaccine Shingrix 1986830, duloxetine 596930.
const INSULIN_RX = '1604544', VACCINE_RX = '1986830', PLAIN_RX = '596930';

console.log('Statutory params (2026):');
t('2026 params verified: oopCap 2100, insulin 35', () => {
  const p = paramsForYear(2026);
  assert.strictEqual(p.oopCapAnnual, 2100);
  assert.strictEqual(p.insulinMonthlyCap, 35);
});
t('unknown plan year throws (no invented params)', () => {
  assert.throws(() => paramsForYear(2099));
});

console.log('\nRule 1 — insulin $35 cap:');
t('classification: Toujeo is insulin, Shingrix is not', () => {
  assert.strictEqual(classify(INSULIN_RX).isInsulin, true);
  assert.strictEqual(classify(VACCINE_RX).isInsulin, false);
});
t('insulin at/below cap: plan $35 -> $35, not capped, deductible waived', () => {
  const m = applyPerFillOverrides({ rxcui: INSULIN_RX, tier: 3, dedAppliesTier: true, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'copay', dollars: 47 } }, insulinByDays: { '1': { copay: 35, coin: 0.25 } } });
  assert.strictEqual(m.perFill['1'].dollars, 35);
  assert.strictEqual(m.perFill['1'].capped, false);
  assert.strictEqual(m.deductibleApplies, false); // waived by statute even though tier ded_applies was true
  assert.ok(m.appliedOverrides.some((o) => o.rule === 'insulin_cap_35'));
});
t('insulin above cap: plan $50 -> capped to $35', () => {
  const m = applyPerFillOverrides({ rxcui: INSULIN_RX, tier: 3, dedAppliesTier: false, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'copay', dollars: 50 } }, insulinByDays: { '1': { copay: 50, coin: null } } });
  assert.strictEqual(m.perFill['1'].dollars, 35);
  assert.strictEqual(m.perFill['1'].capped, true);
});
t('insulin 90-day pro-rates to $105 ceiling', () => {
  const m = applyPerFillOverrides({ rxcui: INSULIN_RX, tier: 3, dedAppliesTier: false, planYear: 2026,
    standardRetailByDays: { '2': { kind: 'copay', dollars: 200 } }, insulinByDays: { '2': { copay: 200, coin: null } } });
  assert.strictEqual(m.perFill['2'].dollars, 105); // 3 × $35
  assert.strictEqual(m.perFill['2'].capped, true);
});
t('insulin fallback to tier copay when no insulin row, still capped', () => {
  const m = applyPerFillOverrides({ rxcui: INSULIN_RX, tier: 3, dedAppliesTier: false, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'copay', dollars: 47 } }, insulinByDays: null });
  assert.strictEqual(m.perFill['1'].dollars, 35);
});
t('keeps BOTH values: fileDerived preserved alongside override', () => {
  const m = applyPerFillOverrides({ rxcui: INSULIN_RX, tier: 3, dedAppliesTier: false, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'copay', dollars: 47 } }, insulinByDays: { '1': { copay: 35 } } });
  assert.strictEqual(m.fileDerived['1'].dollars, 47);   // original
  assert.strictEqual(m.perFill['1'].dollars, 35);        // override-applied
});

console.log('\nRule 2 — ACIP vaccine $0:');
t('Shingrix -> $0, deductible waived, override named', () => {
  const m = applyPerFillOverrides({ rxcui: VACCINE_RX, tier: 1, dedAppliesTier: true, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'coinsurance', rate: 0.25 } }, insulinByDays: null });
  assert.strictEqual(m.perFill['1'].dollars, 0);
  assert.strictEqual(m.deductibleApplies, false);
  assert.ok(m.appliedOverrides.some((o) => o.rule === 'acip_vaccine_free'));
  assert.strictEqual(m.fileDerived['1'].rate, 0.25); // both values kept
});

console.log('\nRule 3 — tier deductible applicability (data-driven, no invented exemptions):');
t('plain drug, tier deductible does NOT apply -> false, no override', () => {
  const m = applyPerFillOverrides({ rxcui: PLAIN_RX, tier: 2, dedAppliesTier: false, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'copay', dollars: 5 } }, insulinByDays: null });
  assert.strictEqual(m.deductibleApplies, false);
  assert.strictEqual(m.appliedOverrides.length, 0);
  assert.strictEqual(m.perFill['1'].dollars, 5); // unchanged from file
});
t('plain drug, tier deductible applies -> true (from data)', () => {
  const m = applyPerFillOverrides({ rxcui: PLAIN_RX, tier: 4, dedAppliesTier: true, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'copay', dollars: 40 } }, insulinByDays: null });
  assert.strictEqual(m.deductibleApplies, true);
});

console.log('\nRules 4-5 — days-supply × channel and $2,100 OOP cap:');
t('high-cost copay basket crosses $2,100 cap mid-year; accrual stops; cap month returned', () => {
  const basket = [1, 2, 3, 4, 5].map((i) => ({ rxcui: 'x' + i, perFill: { '1': { kind: 'copay', dollars: 120 } }, deductibleApplies: false }));
  const proj = projectAnnual({ premium: 40, deductible: 615, planYear: 2026, drugs: basket, daysSupply: 1 });
  assert.strictEqual(proj.oopCap, 2100);
  assert.strictEqual(proj.annualDrugOOP, 2100);              // accrual stopped exactly at the cap
  assert.strictEqual(proj.capHit.reached, true);
  assert.strictEqual(proj.capHit.month, 4);                  // $600/mo -> $2100 in month 4
  assert.strictEqual(proj.annualPremium, 480);              // premium NOT in the cap; continues all year
  assert.strictEqual(proj.annualTotal, 2580);              // 480 + 2100
  assert.strictEqual(proj.monthly[11].oop, 0);              // Dec: catastrophic, $0
});
t('low-cost basket does not hit the cap; totals sum correctly', () => {
  const proj = projectAnnual({ premium: 0, deductible: 0, planYear: 2026,
    drugs: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 5 } }, deductibleApplies: false }], daysSupply: 1 });
  assert.strictEqual(proj.capHit.reached, false);
  assert.strictEqual(proj.annualDrugOOP, 60); // $5 × 12
});
t('days-supply matters: 90-day fills = 4/year', () => {
  const proj = projectAnnual({ premium: 0, deductible: 0, planYear: 2026,
    drugs: [{ rxcui: 'a', perFill: { '2': { kind: 'copay', dollars: 15 } }, deductibleApplies: false }], daysSupply: 2 });
  assert.strictEqual(proj.fillsPerYear, 4);
  assert.strictEqual(proj.annualDrugOOP, 60); // $15 × 4
});
t('coinsurance drug flags incomplete (cannot dollarize without price)', () => {
  const proj = projectAnnual({ premium: 0, deductible: 0, planYear: 2026,
    drugs: [{ rxcui: 'a', perFill: { '1': { kind: 'coinsurance', rate: 0.25 } }, deductibleApplies: false }], daysSupply: 1 });
  assert.strictEqual(proj.incomplete, true);
});
t('deductible flagged (not fabricated) when a deductible-applicable drug is present', () => {
  const proj = projectAnnual({ premium: 0, deductible: 615, planYear: 2026,
    drugs: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 40 } }, deductibleApplies: true }], daysSupply: 1 });
  assert.strictEqual(proj.deductible.appliesToAnyDrug, true);
  assert.strictEqual(proj.deductible.amount, 615);
});

console.log(`\nALL OVERRIDE UNIT TESTS PASSED (${passed}).`);
