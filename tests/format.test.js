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
  // Zero coverage (incl. every single-drug miss): covered 0, all drugs missing — drives the
  // "no dollar anchor, show the badge" UI branch.
  const none1 = F.planCoverage({ drugs: { '1': { covered: false } } });
  assert.strictEqual(none1.covered, 0); assert.strictEqual(none1.total, 1); assert.strictEqual(none1.complete, false);
  const none2 = F.planCoverage({ drugs: { '1': { covered: false }, '2': { covered: false } } });
  assert.strictEqual(none2.covered, 0); assert.strictEqual(none2.total, 2);
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

console.log('\nCMS plan ID for display (segment suffix only to disambiguate):');
t('planDisplayId shows contract-plan; adds segment ONLY when the id is ambiguous in the results', () => {
  // Two plans share contract-plan H2228-042 but differ by segment -> both need the suffix.
  const a = { planId: 'H2228-042', segmentId: '001' };
  const b = { planId: 'H2228-042', segmentId: '002' };
  const c = { planId: 'S5678-042', segmentId: '000' }; // unique contract-plan
  const ambig = F.ambiguousPlanIds([a, b, c]);
  assert.deepStrictEqual([...ambig], ['H2228-042']);
  assert.strictEqual(F.planDisplayId(a, ambig), 'H2228-042-001');
  assert.strictEqual(F.planDisplayId(b, ambig), 'H2228-042-002');
  assert.strictEqual(F.planDisplayId(c, ambig), 'S5678-042'); // unique -> no noise suffix
});
t('planDisplayId is the bare contract-plan when nothing collides', () => {
  const plans = [{ planId: 'H4461-046', segmentId: '000' }, { planId: 'S1234-001', segmentId: '000' }];
  const ambig = F.ambiguousPlanIds(plans);
  assert.strictEqual(F.planDisplayId(plans[0], ambig), 'H4461-046'); // matches the DB key format
  assert.strictEqual(ambig.size, 0);
});

console.log('\nPhase/channel summary (pattern-collapsed plain lines replace the crushed grid):');
const copay = (d) => ({ kind: 'copay', dollars: d, rate: null });
const coins = (r) => ({ kind: 'coinsurance', dollars: null, rate: r });
const none = () => ({ kind: 'not_offered', dollars: null, rate: null });
// Build a phases object from { lvl: { '1': {chan:cell}, '2': {chan:cell} } }.
const ph = (spec) => { const o = {}; for (const lvl of Object.keys(spec)) { o[lvl] = { byDaysSupply: {} }; for (const ds of Object.keys(spec[lvl])) o[lvl].byDaysSupply[ds] = spec[lvl][ds]; } return o; };

t('worked example (the screenshot plan): equal phases, $0 preferred, 3× footnote → 3 lines', () => {
  const std30 = copay(10), std90 = copay(30), cat = copay(0);
  const phases = ph({
    '0': { '1': { standardRetail: copay(10), preferredRetail: copay(0), preferredMail: copay(0) } },
    '1': { '1': { standardRetail: std30, preferredRetail: copay(0), preferredMail: copay(0) },
           '2': { standardRetail: std90, preferredRetail: copay(0), preferredMail: copay(0) } },
    '3': { '1': { standardRetail: cat, preferredRetail: copay(0), preferredMail: copay(0) } },
  });
  const s = F.phaseSummary(phases);
  assert.deepStrictEqual(s.lines, [
    'At a standard pharmacy: $10.00 until you reach catastrophic coverage, then $0.00.',
    'At this plan’s preferred pharmacies (or by mail): $0.00 all year.',
  ]);
  assert.strictEqual(s.footnote, 'A 90-day supply at a pharmacy costs about three 30-day fills.');
});

t('unequal phases: deductible tier states pre-deductible → initial → catastrophic', () => {
  const phases = ph({
    '0': { '1': { standardRetail: copay(47) } },
    '1': { '1': { standardRetail: copay(10) }, '2': { standardRetail: copay(30) } },
    '3': { '1': { standardRetail: copay(0) } },
  });
  const s = F.phaseSummary(phases);
  assert.strictEqual(s.lines[0], 'At a standard pharmacy: $47.00 before you meet the deductible, then $10.00 until you reach catastrophic coverage, then $0.00.');
});

t('mail discount (nonzero): phase story and the 90-day discount are SEPARATE sentences', () => {
  const phases = ph({
    '1': { '1': { standardRetail: copay(10), preferredMail: copay(3) },
           '2': { standardRetail: copay(30), preferredMail: copay(6) } },
  });
  const s = F.phaseSummary(phases);
  // two distinct sentences, never welded with an em-dash into the phase story
  assert.ok(s.lines.includes('By this plan’s mail-order pharmacy: $3.00 all year.'), s.lines.join(' | '));
  assert.ok(s.lines.includes('A 90-day supply by mail is $6.00, less than three 30-day fills.'), s.lines.join(' | '));
  assert.ok(!s.lines.some((l) => /—/.test(l)), 'no welded em-dash sentence: ' + s.lines.join(' | '));
  assert.strictEqual(s.footnote, null); // not all channels are the plain 3× → no shared footnote
});

t('REPORTED $0 mail case (30-day $5 / 90-day $0): unambiguous two-sentence form, no comparison, anchored', () => {
  const phases = ph({
    '0': { '1': { preferredMail: copay(5) } },
    '1': { '1': { preferredMail: copay(5) }, '2': { preferredMail: copay(0) } },
    '3': { '1': { preferredMail: copay(5) } },
  });
  const s = F.phaseSummary(phases);
  assert.deepStrictEqual(s.lines, [
    'By this plan’s mail-order pharmacy: $5.00 all year.',
    'A 90-day supply by mail is $0 all year.',
  ], s.lines.join(' | '));
  // the $0 case drops the "less than three 30-day fills" comparison entirely, and never welds
  assert.ok(!s.lines.some((l) => /less than three|—/.test(l)), s.lines.join(' | '));
});

console.log('\nExplainer prose renders from the engine parameter (prose and math can’t disagree):');
const { paramsForYear } = require('../tools/overrides/statutory-params');
const fs = require('fs');

t('capPhrase renders "$2,100 in 2026" straight from the statutory parameter', () => {
  const y = 2026, cap = paramsForYear(y).oopCapAnnual;
  assert.strictEqual(cap, 2100); // guards the verified param itself
  assert.strictEqual(F.capPhrase({ oopCapAnnual: cap, planYear: y }), '$2,100 in 2026');
  assert.strictEqual(F.capPhrase({}), null);       // no data → number-free fallback, never a guess
  assert.strictEqual(F.capPhrase(null), null);
});

t('no user-facing page hardcodes a cap amount/year — the number comes only from the parameter', () => {
  const faq = fs.readFileSync(__dirname + '/../site/faq.html', 'utf8');
  const app = fs.readFileSync(__dirname + '/../site/app.js', 'utf8');
  // the stale strings must be gone, and no literal cap dollar figure may be baked into the prose
  for (const [name, src] of [['faq.html', faq], ['app.js', app]]) {
    assert.ok(!/\$2,000|in 2025\)/.test(src), `${name} still hardcodes the old cap/year`);
    assert.ok(!/\$2,100/.test(src), `${name} hardcodes a cap figure instead of reading the parameter`);
  }
  // faq renders the cap from /api/meta via the shared formatter (single source of truth)
  assert.ok(/oop-cap-phrase/.test(faq) && /\/api\/meta/.test(faq) && /capPhrase/.test(faq), 'faq must fill the cap from /api/meta');
});

t('coinsurance: % with the estimated-basis note; no fabricated dollars', () => {
  const phases = ph({ '1': { '1': { standardRetail: coins(0.25) } }, '3': { '1': { standardRetail: copay(0) } } });
  const s = F.phaseSummary(phases);
  assert.strictEqual(s.lines[0], 'At a standard pharmacy: 25% until you reach catastrophic coverage, then $0.00.');
  assert.ok(s.lines.some((l) => /coinsurance rates/.test(l)), s.lines.join(' | '));
});

t('n/a channel is omitted honestly (no blank line), and deductible-exempt note integrates', () => {
  const phases = ph({
    '0': { '1': { standardRetail: copay(5), preferredRetail: none(), preferredMail: none() } },
    '1': { '1': { standardRetail: copay(5), preferredRetail: none(), preferredMail: none() } },
    '3': { '1': { standardRetail: copay(5), preferredRetail: none(), preferredMail: none() } },
  });
  const s = F.phaseSummary(phases, { deductibleExempt: true });
  assert.deepStrictEqual(s.lines, ['At a standard pharmacy: $5.00 all year.']); // no preferred line, no blank
  assert.ok(s.lines.every((l) => l && !/undefined|null|—\s*$/.test(l)));
  assert.ok(/skips the plan’s deductible/.test(s.footnote), s.footnote);
});

console.log(`\nALL FORMAT TESTS PASSED (${passed}).`);
