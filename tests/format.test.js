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

t('premiumLabel qualifies MA-PD (drug-portion) but leaves PDP as the whole premium', () => {
  // MA-PD in either raw or display form → "drug coverage premium"; PDP → plain "premium"
  for (const t of ['MA-PD', 'MA-PD (regional)', 'MA', 'MA-regional']) {
    assert.strictEqual(F.isMaPd(t), true, t);
    assert.strictEqual(F.premiumLabel(t), 'drug coverage premium', t);
  }
  assert.strictEqual(F.isMaPd('PDP'), false);
  assert.strictEqual(F.premiumLabel('PDP'), 'premium');
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

console.log('\nThe two roads — grouping orders, it NEVER filters:');

const maPlan = (id, notCovered = 0) => ({ planId: id, planType: 'MA-PD', notCovered });
const pdpPlan = (id, notCovered = 0) => ({ planId: id, planType: 'PDP', notCovered });

t('roadOf: an MA-PD (any variant) is the MA road; a PDP is the Original-Medicare road', () => {
  for (const t of ['MA-PD', 'MA-PD (regional)', 'MA', 'MA-regional']) assert.strictEqual(F.roadOf(t), 'ma', t);
  assert.strictEqual(F.roadOf('PDP'), 'original');
});

t('plan-ID shape: forgiving of spaces and case; prefix stays quiet until it can’t be valid', () => {
  assert.strictEqual(F.normalizePlanId(' h1234-001 '), 'H1234-001');
  for (const ok of ['H1234-001', 'h1234-001', ' S5601-002 ', 'R5826-123']) assert.strictEqual(F.isPlanIdShape(ok), true, ok);
  for (const no of ['', 'H1234', 'H1234-01', 'HH234-001', '1234-001', 'H12345-001']) assert.strictEqual(F.isPlanIdShape(no), false, no);
  // still-typing prefixes must NOT be nagged at
  for (const p of ['H', 'H1', 'H1234', 'H1234-', 'H1234-0']) assert.strictEqual(F.isPlanIdPrefix(p), true, p);
  for (const p of ['HH', 'H1234-0011', 'XY']) assert.strictEqual(F.isPlanIdPrefix(p), false, p);
});

t('groupPlans NEVER drops a plan and preserves the incoming order (ranking underneath untouched)', () => {
  const plans = [maPlan('H1'), pdpPlan('S1'), maPlan('H2'), pdpPlan('S2')];
  for (const road of ['ma', 'original']) {
    const g = F.groupPlans(plans, { road });
    assert.strictEqual(g.grouped, true);
    assert.strictEqual(g.yourPlan, null);
    // every plan survives, exactly once
    const seen = [g.yourPlan, ...g.sameRoadOthers, ...g.otherRoad].filter(Boolean);
    assert.strictEqual(seen.length, plans.length, road);
    assert.deepStrictEqual(seen.map((x) => x.planId).sort(), ['H1', 'H2', 'S1', 'S2'], road);
    // order within each group is the order it arrived in
    assert.deepStrictEqual(g.sameRoadOthers.map((x) => x.planId), road === 'ma' ? ['H1', 'H2'] : ['S1', 'S2'], road);
    assert.deepStrictEqual(g.otherRoad.map((x) => x.planId), road === 'ma' ? ['S1', 'S2'] : ['H1', 'H2'], road);
    assert.ok(g.sameRoadOthers.every((x) => F.roadOf(x.planType) === road), road);
  }
});

t('groupPlans keeps complete-before-partial inside each group (the partition beneath is intact)', () => {
  const plans = [maPlan('H1', 0), pdpPlan('S1', 0), maPlan('H2', 2), pdpPlan('S2', 1)];
  const g = F.groupPlans(plans, { road: 'ma' });
  assert.deepStrictEqual(g.sameRoadOthers.map((x) => x.notCovered), [0, 2], 'MA group still complete-then-partial');
  assert.deepStrictEqual(g.otherRoad.map((x) => x.notCovered), [0, 1], 'PDP group still complete-then-partial');
});

t('no known road ("new", "not sure", null) → no grouping; every plan stays in one list', () => {
  const plans = [maPlan('H1'), pdpPlan('S1')];
  for (const road of [null, undefined, 'new', 'unsure', 'nonsense']) {
    const g = F.groupPlans(plans, { road });
    assert.strictEqual(g.grouped, false, String(road));
    assert.strictEqual(g.sameRoadOthers.length, 2, String(road));
    assert.strictEqual(g.otherRoad.length, 0, String(road));
    assert.strictEqual(F.isKnownRoad(road), false, String(road));
  }
  assert.strictEqual(F.isKnownRoad('ma'), true);
  assert.strictEqual(F.isKnownRoad('original'), true);
});

t('a matching plan ID EXTRACTS her plan, defines the road, and still drops nobody', () => {
  const plans = [maPlan('H1234-001', 0), pdpPlan('S5601-002', 0), maPlan('H9999-001', 3)];
  const g = F.groupPlans(plans, { planId: ' h1234-001 ' });   // spaces/case forgiven
  assert.strictEqual(g.yourPlan.planId, 'H1234-001');
  assert.strictEqual(g.planIdMissed, false);
  assert.strictEqual(g.road, 'ma', 'the matched plan defines the road — no answer needed');
  assert.strictEqual(g.grouped, true);
  assert.deepStrictEqual(g.sameRoadOthers.map((x) => x.planId), ['H9999-001'], 'her plan is EXTRACTED from its group');
  assert.deepStrictEqual(g.otherRoad.map((x) => x.planId), ['S5601-002']);
  // nothing lost
  assert.strictEqual(1 + g.sameRoadOthers.length + g.otherRoad.length, plans.length);
});

t('her plan is extracted even when it is the WORST plan (placement is exempt, honesty is not)', () => {
  const plans = [maPlan('H1111-001', 0), maPlan('H2222-002', 5)];  // hers covers nothing
  const g = F.groupPlans(plans, { planId: 'H2222-002' });
  assert.strictEqual(g.yourPlan.planId, 'H2222-002');
  assert.strictEqual(g.yourPlan.notCovered, 5, 'the plan object is untouched — the card renders it honestly');
  assert.deepStrictEqual(g.sameRoadOthers.map((x) => x.planId), ['H1111-001']);
});

t('a well-formed ID we cannot match → planIdMissed, and it does NOT invent a road', () => {
  const plans = [maPlan('H1234-001'), pdpPlan('S5601-002')];
  const g = F.groupPlans(plans, { planId: 'H7777-777' });
  assert.strictEqual(g.yourPlan, null);
  assert.strictEqual(g.planIdMissed, true);
  assert.strictEqual(g.grouped, false, 'no road assumed from a plan we could not find');
  assert.strictEqual(g.sameRoadOthers.length, 2, 'results still render, ungrouped-by-ID');
  // but a road she chose herself still groups
  const g2 = F.groupPlans(plans, { planId: 'H7777-777', road: 'original' });
  assert.strictEqual(g2.planIdMissed, true);
  assert.strictEqual(g2.grouped, true);
  assert.deepStrictEqual(g2.sameRoadOthers.map((x) => x.planId), ['S5601-002']);
});

console.log('\nThe headline count speaks the grouping (one source of truth):');

t('count line: no road → a plain total; grouped → both real numbers, her plan counted in her road', () => {
  const plans = [maPlan('H1'), maPlan('H2'), pdpPlan('S1'), pdpPlan('S2'), pdpPlan('S3')];
  assert.strictEqual(F.resultsCountLine(F.groupPlans(plans, {}), 'St. Louis County'), '5 plans');
  assert.strictEqual(F.resultsCountLine(F.groupPlans(plans, { road: 'ma' }), 'St. Louis County'),
    '2 Medicare Advantage plans in St. Louis County — plus 3 drug-only plans on a different road, below');
  assert.strictEqual(F.resultsCountLine(F.groupPlans(plans, { road: 'original' }), 'St. Louis County'),
    '3 drug-only plans in St. Louis County — plus 2 Medicare Advantage plans on a different road, below');
});

t('count line counts her extracted plan inside her own road (it IS one of them)', () => {
  const plans = [maPlan('H1234-001'), maPlan('H2'), pdpPlan('S1')];
  const g = F.groupPlans(plans, { planId: 'H1234-001' });
  assert.strictEqual(F.resultsCountLine(g, 'Boone County'),
    '2 Medicare Advantage plans in Boone County — plus 1 drug-only plan on a different road, below');
});

t('count line is count-aware (no "1 plans"), and drops the clause when a road stands alone', () => {
  assert.strictEqual(F.resultsCountLine(F.groupPlans([maPlan('H1')], {}), 'X'), '1 plan');
  // only one road present → nothing to say about "a different road"
  assert.strictEqual(F.resultsCountLine(F.groupPlans([maPlan('H1')], { road: 'ma' }), 'Boone County'),
    '1 Medicare Advantage plan in Boone County');
});

t('roadsMix: true only when BOTH roads are present', () => {
  assert.strictEqual(F.roadsMix([maPlan('H1'), pdpPlan('S1')]), true);
  assert.strictEqual(F.roadsMix([maPlan('H1'), maPlan('H2')]), false);
  assert.strictEqual(F.roadsMix([pdpPlan('S1')]), false);
  assert.strictEqual(F.roadsMix([]), false);
});

console.log('\nSeason awareness (the window is a parameter; the verdict is computed on her clock):');

const AEP_META = { enrollment: require('../tools/overrides/statutory-params').ENROLLMENT };

t('inAep: boundaries inclusive on BOTH ends; the window comes from the engine parameter', () => {
  const aep = AEP_META.enrollment.aep;
  assert.strictEqual(F.inAep(aep, new Date(2026, 9, 15)), true, 'Oct 15 is open');
  assert.strictEqual(F.inAep(aep, new Date(2026, 11, 7)), true, 'Dec 7 is open');
  assert.strictEqual(F.inAep(aep, new Date(2026, 9, 14)), false, 'Oct 14 is closed');
  assert.strictEqual(F.inAep(aep, new Date(2026, 11, 8)), false, 'Dec 8 is closed');
  assert.strictEqual(F.inAep(aep, new Date(2026, 6, 8)), false, 'July is closed');
  assert.strictEqual(F.inAep(null, new Date()), null, 'no window → no guess');
});

t('seasonLine: speaks the right sentence either side of the boundary, and never invents a date', () => {
  assert.strictEqual(F.seasonLine(AEP_META, new Date(2026, 10, 1)), 'switching is open until December 7');
  assert.strictEqual(F.seasonLine(AEP_META, new Date(2026, 9, 15)), 'switching is open until December 7');
  assert.strictEqual(F.seasonLine(AEP_META, new Date(2026, 11, 7)), 'switching is open until December 7');
  assert.strictEqual(F.seasonLine(AEP_META, new Date(2026, 11, 8)), 'plan switching opens October 15');
  assert.strictEqual(F.seasonLine(AEP_META, new Date(2026, 6, 8)), 'plan switching opens October 15');
  assert.strictEqual(F.seasonLine({}, new Date()), null, 'meta without a window → say nothing seasonal');
});

console.log('\nFair-price check — disclosure, never a grade:');

// planDisplayTotal reads breakdown/annualEstimate; planCoverage reads drugs+notCovered.
const fpPlan = (id, total, notCovered = 0, type = 'MA-PD') => ({
  planId: id, planType: type, notCovered,
  annualEstimate: total, breakdown: { premiumAnnual: total, copayAnnual: 0, coinsuranceEstRxcuis: [], capBinds: false },
  drugs: notCovered ? { a: { covered: true }, b: { covered: false } } : { a: { covered: true }, b: { covered: true } },
});
const fpGroup = (yours, others) => F.groupPlans([yours].concat(others), { planId: yours.planId });

t('fires when a same-road plan covering everything is at least the floor cheaper', () => {
  const r = F.fairPriceCheck(fpGroup(fpPlan('H1-001', 1000), [fpPlan('H2-002', 800), fpPlan('H3-003', 700)]));
  assert.strictEqual(r.fires, true);
  assert.strictEqual(r.reason, 'cheaper');
  assert.strictEqual(r.n, 2, 'both alternatives clear the floor');
  assert.strictEqual(r.atLeast, 200, 'all N are at least this much less (the SMALLEST qualifying gap)');
  assert.strictEqual(r.road, 'ma');
});

t('BOUNDARY AT THE FLOOR: exactly-floor fires; a dollar under it is silence', () => {
  const at = F.fairPriceCheck(fpGroup(fpPlan('H1-001', 1000), [fpPlan('H2-002', 900)]));   // exactly $100
  assert.strictEqual(at.fires, true, '$100 under == the floor → fires');
  assert.strictEqual(at.atLeast, 100);
  const under = F.fairPriceCheck(fpGroup(fpPlan('H1-001', 1000), [fpPlan('H2-002', 901)])); // $99
  assert.strictEqual(under.fires, false, '$99 under → below the floor');
  assert.strictEqual(under.reason, 'below-floor');
  assert.strictEqual(F.FAIR_PRICE_FLOOR_UNTUNED, 100, 'the shipped placeholder');
});

t('"at least $Y" agrees with the totals on her cards (gaps come from the DISPLAYED totals)', () => {
  // planDisplayTotal is the sum of ROUNDED components — literally the number printed on the card. The
  // gap we claim must be the one she could work out herself from the two cards; a raw-cents figure
  // would silently disagree with the screen.
  assert.strictEqual(F.planDisplayTotal(fpPlan('H2-002', 812.4)), 812, 'the card says $812');
  const r = F.fairPriceCheck(fpGroup(fpPlan('H1-001', 1000), [fpPlan('H2-002', 812.4)]));
  assert.strictEqual(r.atLeast, 188, '$1,000 − $812 = $188 — exactly what the two cards show');
});

t('her plan missing a drug ALWAYS fires, whatever the money says', () => {
  // hers is the CHEAPEST — but it doesn't cover everything she takes
  const r = F.fairPriceCheck(fpGroup(fpPlan('H1-001', 100, 1), [fpPlan('H2-002', 900)]));
  assert.strictEqual(r.fires, true, 'a gap is worth knowing at any price');
  assert.strictEqual(r.reason, 'not-covered');
  assert.strictEqual(r.n, 1, 'plans that cover all of them');
  assert.strictEqual(r.atLeast, null, 'no cheaper alternative → no savings claimed');
  assert.strictEqual(r.yourCoverage.complete, false);
});

t('SILENCE: no same-road alternative covers everything → nothing to disclose', () => {
  const r = F.fairPriceCheck(fpGroup(fpPlan('H1-001', 1000), [fpPlan('H2-002', 100, 1)]));
  assert.strictEqual(r.fires, false);
  assert.strictEqual(r.reason, 'no-alternatives');
});

t('SILENCE: cheapest on her road → no "your plan looks good" grade', () => {
  const r = F.fairPriceCheck(fpGroup(fpPlan('H1-001', 500), [fpPlan('H2-002', 900), fpPlan('H3-003', 1200)]));
  assert.strictEqual(r.fires, false);
  assert.strictEqual(r.reason, 'below-floor', 'we disclose gaps; we never rank loyalty');
});

t('the other road is never compared against (that is not a fair compare)', () => {
  // a PDP is far cheaper, but she's on the MA road — comparing across roads would be dishonest
  const yours = fpPlan('H1-001', 1000);
  const g = F.groupPlans([yours, fpPlan('S9-009', 10, 0, 'PDP')], { planId: 'H1-001' });
  const r = F.fairPriceCheck(g);
  assert.strictEqual(r.fires, false);
  assert.strictEqual(r.reason, 'no-alternatives', 'the cheap PDP is on the other road — not counted');
});

t('no anchored plan → the check cannot run', () => {
  const r = F.fairPriceCheck(F.groupPlans([fpPlan('H1-001', 1000)], { road: 'ma' }));
  assert.strictEqual(r.fires, false);
  assert.strictEqual(r.reason, 'no-plan');
});

t('the floor is injectable, so re-tuning is a data change (not a code change)', () => {
  const g = fpGroup(fpPlan('H1-001', 1000), [fpPlan('H2-002', 950)]);   // $50 gap
  assert.strictEqual(F.fairPriceCheck(g).fires, false, '$50 < $100 default');
  assert.strictEqual(F.fairPriceCheck(g, { floor: 50 }).fires, true, 'same data, tuned floor → fires');
});

console.log('\nPrice basis — a price never ships without its basis:');

t('HEADLINE_BASIS mirrors the engine projection basis (prose and math cannot disagree)', () => {
  const { FILLS_PER_YEAR, DAYS_MONTHS } = require('../tools/overrides');
  const B = F.HEADLINE_BASIS;
  // the engine projects the headline with daysSupply code '1'; its fills/year and month span must be
  // exactly what our label and our ×fills arithmetic claim
  assert.strictEqual(FILLS_PER_YEAR[B.daysSupplyCode], B.fillsPerYear, 'fills/year matches the engine');
  assert.strictEqual(DAYS_MONTHS[B.daysSupplyCode] * 30, B.days, 'day span matches the engine');
  assert.ok(B.perLabel.includes(`${B.days}-day fill`), B.perLabel);
  assert.ok(B.ofEachLabel.includes(`${B.days}-day fill`), B.ofEachLabel);
  assert.strictEqual(F.headlineAnnual(10), 120);   // $10.00 per 30-day fill → $120.00/yr
  assert.strictEqual(F.headlineAnnual(0), 0);
});

console.log(`\nALL FORMAT TESTS PASSED (${passed}).`);
