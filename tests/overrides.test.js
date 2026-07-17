'use strict';
// Unit tests for the statutory override layer (tools/overrides). Pure functions over real
// Missouri RXCUIs (from tools/overrides/data/classification.json) + representative cost inputs.
// Hermetic: no DB, no network. Run: node tests/overrides.test.js

const assert = require('assert');
const { applyPerFillOverrides, projectAnnual, projectChannels, computeChannelSavings, roundSavings, classify } = require('../tools/overrides');
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
t('AEP window is a verified parameter (Oct 15 – Dec 7); the comparison lives in PRFormat', () => {
  const { ENROLLMENT } = require('../tools/overrides/statutory-params');
  assert.deepStrictEqual(
    [ENROLLMENT.aep.startMonth, ENROLLMENT.aep.startDay, ENROLLMENT.aep.endMonth, ENROLLMENT.aep.endDay],
    [10, 15, 12, 7], 'Medicare Open Enrollment is October 15 – December 7 (Medicare.gov)');
  assert.strictEqual(ENROLLMENT.aep.effective, 'January 1');
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

console.log('\nPharmacy-channel savings (V1):');
t('applyPerFillOverrides emits per-channel per-fill; rules apply identically per channel', () => {
  // Vaccine -> $0 in every channel that has file data; a channel with no file data -> no entry.
  const m = applyPerFillOverrides({ rxcui: VACCINE_RX, tier: 1, dedAppliesTier: true, planYear: 2026,
    standardRetailByDays: { '1': { kind: 'coinsurance', rate: 0.25 } }, insulinByDays: null,
    channelsByDays: {
      standardRetail: { '1': { kind: 'coinsurance', rate: 0.25 } },
      preferredRetail: { '1': { kind: 'not_offered' } },
      standardMail: { '1': { kind: 'copay', dollars: 20 } },
      preferredMail: null,
    } });
  assert.strictEqual(m.perFillByChannel.standardRetail['1'].dollars, 0);      // $0 by vaccine rule
  assert.strictEqual(m.perFillByChannel.standardMail['1'].dollars, 0);        // $0 in mail too
  assert.strictEqual(m.perFillByChannel.preferredMail, null);                 // no data -> null
  assert.deepStrictEqual(m.perFillByChannel.standardRetail, m.perFill);       // standard == anchor
});

t('projectChannels: a channel with no data projects to null, never interpolated', () => {
  const proj = projectChannels({ premium: 0, deductible: 0, planYear: 2026, daysSupply: 1,
    drugsByChannel: {
      standardRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 10 } }, deductibleApplies: false }],
      preferredRetail: null,
      standardMail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 4 } }, deductibleApplies: false }],
      preferredMail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 4 } }, deductibleApplies: false }],
    } });
  assert.strictEqual(proj.standardRetail.annualDrugOOP, 120);
  assert.strictEqual(proj.preferredRetail, null);
  assert.strictEqual(proj.standardMail.annualDrugOOP, 48);
});

t('savings: real preferred/standard differential -> saving on the cheaper channel', () => {
  // $10/mo standard vs $4/mo preferred retail => (120-48)=$72/yr saving, above threshold.
  const chProj = projectChannels({ premium: 20, deductible: 0, planYear: 2026, daysSupply: 1,
    drugsByChannel: {
      standardRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 10 } }, deductibleApplies: false }],
      preferredRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 4 } }, deductibleApplies: false }],
      standardMail: null, preferredMail: null,
    } });
  const s = computeChannelSavings(chProj);
  assert.ok(s, 'a saving should be reported');
  assert.strictEqual(s.channel, 'preferredRetail');
  assert.strictEqual(s.amount, 72);
  assert.strictEqual(s.channelLabel, 'preferred pharmacy');
  // The savings-pair copy needs both totals: anchor (standard) and the recomputed channel total.
  assert.strictEqual(s.anchorTotal, 360);   // premium 240 + std drug OOP 120
  assert.strictEqual(s.channelTotal, 288);  // premium 240 + preferred drug OOP 48
});

t('savings: plan with NO differential -> null (show nothing, not "$0 savings")', () => {
  const chProj = projectChannels({ premium: 0, deductible: 0, planYear: 2026, daysSupply: 1,
    drugsByChannel: {
      standardRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 5 } }, deductibleApplies: false }],
      preferredRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 5 } }, deductibleApplies: false }],
      standardMail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 5 } }, deductibleApplies: false }],
      preferredMail: null,
    } });
  assert.strictEqual(computeChannelSavings(chProj), null);
});

t('savings: sub-threshold difference stays silent (no "$3 opportunity")', () => {
  // $12/yr difference ($1/mo) is below the $25/yr floor.
  const chProj = projectChannels({ premium: 0, deductible: 0, planYear: 2026, daysSupply: 1,
    drugsByChannel: {
      standardRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 5 } }, deductibleApplies: false }],
      preferredRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 4 } }, deductibleApplies: false }],
      standardMail: null, preferredMail: null,
    } });
  assert.strictEqual(computeChannelSavings(chProj), null); // 12 < 25 -> quiet
});

t('savings: incomplete anchor (coinsurance) -> null (can\'t compare honestly)', () => {
  const chProj = projectChannels({ premium: 0, deductible: 0, planYear: 2026, daysSupply: 1,
    drugsByChannel: {
      standardRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'coinsurance', rate: 0.25 } }, deductibleApplies: false }],
      preferredRetail: [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 4 } }, deductibleApplies: false }],
      standardMail: null, preferredMail: null,
    } });
  assert.strictEqual(computeChannelSavings(chProj), null);
});

t('cap month differs by channel; both cap out -> no channel saving claimed', () => {
  // Big basket: standard $600/mo hits $2,100 in month 4; preferred $525/mo hits it in month 4 too.
  const std = [1,2,3,4,5].map((i) => ({ rxcui: 'x'+i, perFill: { '1': { kind: 'copay', dollars: 120 } }, deductibleApplies: false }));
  const pref = [1,2,3,4,5].map((i) => ({ rxcui: 'x'+i, perFill: { '1': { kind: 'copay', dollars: 105 } }, deductibleApplies: false }));
  const chProj = projectChannels({ premium: 0, deductible: 0, planYear: 2026, daysSupply: 1,
    drugsByChannel: { standardRetail: std, preferredRetail: pref, standardMail: null, preferredMail: null } });
  assert.strictEqual(chProj.standardRetail.capHit.month, 4);   // 600/mo
  assert.strictEqual(chProj.preferredRetail.capHit.month, 4);  // 525/mo -> 2100 by month 4 as well
  assert.strictEqual(chProj.standardRetail.annualDrugOOP, 2100);
  assert.strictEqual(chProj.preferredRetail.annualDrugOOP, 2100);
  // Both hit the same $2,100 cap -> your annual total is identical -> we must NOT claim a saving.
  assert.strictEqual(computeChannelSavings(chProj), null);
});

t('cap month differs by channel; only standard caps -> real saving below the cap', () => {
  // Standard $200/mo hits cap in month 11 ($2,100). Preferred $80/mo never caps ($960/yr).
  const std = [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 200 } }, deductibleApplies: false }];
  const pref = [{ rxcui: 'a', perFill: { '1': { kind: 'copay', dollars: 80 } }, deductibleApplies: false }];
  const chProj = projectChannels({ premium: 0, deductible: 0, planYear: 2026, daysSupply: 1,
    drugsByChannel: { standardRetail: std, preferredRetail: pref, standardMail: null, preferredMail: null } });
  assert.strictEqual(chProj.standardRetail.capHit.reached, true);
  assert.strictEqual(chProj.standardRetail.annualDrugOOP, 2100);
  assert.strictEqual(chProj.preferredRetail.capHit.reached, false);
  assert.strictEqual(chProj.preferredRetail.annualDrugOOP, 960);
  const s = computeChannelSavings(chProj);
  assert.strictEqual(s.amount, 1140); // 2100 - 960, cap correctly bounded the standard channel
});

t('roundSavings: calm, non-false-precision figures', () => {
  assert.strictEqual(roundSavings(72), 70);     // <100 -> nearest 5 ... 72 -> 70
  assert.strictEqual(roundSavings(27), 25);
  assert.strictEqual(roundSavings(322), 320);   // >=100 -> nearest 10
  assert.strictEqual(roundSavings(1140), 1140);
});

console.log(`\nALL OVERRIDE UNIT TESTS PASSED (${passed}).`);
