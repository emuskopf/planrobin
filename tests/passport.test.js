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
  // the reopen link shows a SHORT label; the raw fragment URL is never printed (it truncates on paper)
  assert.ok(s.includes('Open this search'), 'reopen tap-link label');
  assert.ok(!s.some((x) => /#abc|#v1\./.test(x)), 'the raw fragment URL never appears in the printed strings');
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
  for (const tot of totals) assert.ok(/^\$[\d,]+\/yr|Doesn’t cover|^\$[\d,]+\/yr so far|covers \d+ of your \d+ medications/.test(tot), `total looks right: ${tot}`);
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

t('reopen tiered paths: QR / typed code / re-add + the code block + privacy; raw URL never prints', () => {
  const m = P.passportModel(data, drugs, { shareUrl: 'https://planrobin.com/#abc', county: '26940' });
  const paths = m.items.filter((i) => i.type === 'path');
  assert.strictEqual(paths.length, 3, 'three tiered paths');
  assert.ok(paths[0].text.startsWith('Use your phone’s camera'), 'path 1 = QR');
  assert.ok(/Or type in a code\. Go to planrobin\.com, find “Have a code from a printout\?”/.test(paths[1].text), 'path 2 = typed code (blessed intro)');
  assert.ok(/re-add your medications from the list on page 1/.test(paths[2].text), 'path 3 = re-add');
  // the code block itself, and the privacy line, ride along
  const code = m.items.find((i) => i.type === 'codelines');
  assert.ok(code && code.lines.length >= 2, 'the printed code lines (county + drug lines)');
  assert.ok(/^V2\.26940\.0-C\d$/.test(code.lines[0]), code.lines[0]);
  assert.ok(m.items.some((i) => i.type === 'note' && /this code contains your medication list in coded form — share it only with people you trust/.test(i.text)), 'privacy line');
  const url = m.items.find((i) => i.type === 'url');
  assert.strictEqual(url.text, 'Open this search', 'the VISIBLE label is short (never the URL)');
  assert.strictEqual(url.link, 'https://planrobin.com/#abc');
  const s = P.passportStrings(m);
  assert.ok(!s.some((x) => /#abc|#v1\./.test(x)), 'the raw fragment URL never appears in print');
  assert.ok(s.includes(code.lines[0]), 'the code lines are in the parity contract');
});

t('reopen block is the SAME on both sheets (checkup page 2 == comparison page 2 structure)', () => {
  const tr = require('./ux/fixtures/results-two-roads.json');
  const cmp = P.passportModel(data, drugs, { shareUrl: 'https://planrobin.com/#X' });
  const chk = P.checkupModel(tr, drugs, { planId: 'H2041-001', planIdSource: 'typed', fill: { where: 'local', days: '1' }, perks: 'no', now: new Date('2026-07-16T12:00:00Z'), shareUrl: 'https://planrobin.com/#X' });
  const reopenTypes = (m) => { const i = m.items.findIndex((x) => x.type === 'reopen-h'); return m.items.slice(i).map((x) => x.type); };
  assert.deepStrictEqual(reopenTypes(chk), reopenTypes(cmp), 'identical reopen item structure on both sheets');
  // and the noun is the only difference in the heading
  assert.ok(chk.items.some((x) => x.type === 'reopen-h' && /Reopen this checkup/.test(x.text)));
  assert.ok(cmp.items.some((x) => x.type === 'reopen-h' && /Reopen this comparison/.test(x.text)));
});

t('filename is planrobin-comparison-YYYY-MM-DD.pdf', () => {
  const m = P.passportModel(data, drugs, { shareUrl: 'x' });
  assert.ok(/^planrobin-comparison-\d{4}-\d{2}-\d{2}\.pdf$/.test(m.filename), m.filename);
});

// ---- THE CHECKUP SHEET -------------------------------------------------------------------------
// The printed action plan IS the product's thesis, so this model gets the same discipline as the
// comparison's: deterministic, complete, and worded by the shared builders (never re-authored here).
const twoRoads = require('./ux/fixtures/results-two-roads.json');
const CK = { planId: 'H2041-001', planIdSource: 'typed', fill: { where: 'local', days: '1' }, perks: 'unsure', shareUrl: 'https://planrobin.com/checkup.html#abc' };
const NOW = new Date('2026-07-16T12:00:00Z');   // pinned: `now` is an input, never read from the clock
const ckModel = (o) => P.checkupModel(twoRoads, drugs, Object.assign({}, CK, { now: NOW }, o));

console.log('\nCheckup sheet — her plan, and what to do about it:');

t('no plan → no sheet (the screen shows the picker; a sheet about nobody’s plan is worse than none)', () => {
  assert.strictEqual(P.checkupModel(twoRoads, drugs, { now: NOW }), null);
  assert.strictEqual(ckModel({ planId: 'H7777-777' }), null);   // a real-looking ID that isn't here
});

t('model is deterministic (same inputs → same items, whoever renders them)', () => {
  assert.deepStrictEqual(P.passportStrings(ckModel()), P.passportStrings(ckModel()));
});

t('page 1: her plan, premium on its own line + qualified, basis on every price', () => {
  const m = ckModel();
  const s = P.passportStrings(m);
  const plan = m.items.find((i) => i.type === 'plan');
  // premium prominent AND still honestly labelled (MA-PD → the drug-coverage portion)
  assert.ok(/^\$[\d.]+\/mo drug coverage premium$/.test(plan.premium), plan.premium);
  // ...and therefore NOT repeated in the meta sub-line
  assert.ok(!/premium/.test(plan.sub), 'premium is not printed twice: ' + plan.sub);
  // parity order: name, total, premium, sub
  const i = s.indexOf(plan.total);
  assert.deepStrictEqual(s.slice(i - 1, i + 3), [plan.name, plan.total, plan.premium, plan.sub]);
  // a price never ships without its basis
  const B = require('../site/format.js').HEADLINE_BASIS;
  for (const cell of plan.drugs.map((r) => r[2]).filter((c) => /^\$/.test(c))) assert.ok(cell.includes(B.perLabel), cell);
});

t('the headline mirrors how she told us: typed = "Your plan", picked = "The plan you selected"', () => {
  assert.ok(P.passportStrings(ckModel({ planIdSource: 'typed' })).includes('Your plan'));
  assert.ok(P.passportStrings(ckModel({ planIdSource: 'picked' })).includes('The plan you selected'));
  // default (the comparison sheet's only path in) stays the confident one
  assert.ok(P.passportStrings(ckModel({ planIdSource: null })).includes('Your plan'));
});

t('the action plan gives its action — a recommendation without its action is incomplete (v2: in Questions)', () => {
  const s = P.passportStrings(ckModel());
  const C = P.checkupCopy;
  const hasMove = s.some((x) => /saving about \$/.test(x));
  if (hasMove) {
    assert.ok(s.includes(C.reassure), 'the move is reversible (stays with the action detail)');
    assert.ok(s.includes(C.moveQuestion), 'and the exact words to say live in Questions to ask (v2)');
  } else {
    assert.ok(s.includes(C.doNothing), 'or the do-nothing verdict is printed as an answer');
  }
  // the baseline assumption that could make a saving too big is ALWAYS printed
  assert.ok(s.some((x) => /^Measured against 30-day fills at a standard \(non-preferred\) local pharmacy\./.test(x)), 'baseline honesty (deduped): ' + s.join(' | '));
});

t('screen and sheet cannot word it differently — both render from checkupCopy', () => {
  // This is the parity that matters for the checkup: the sentences are not authored twice. If a
  // future session edits the verdict on screen, it edits this string, and the sheet changes with it.
  const C = P.checkupCopy;
  assert.strictEqual(typeof C.doNothing, 'string');
  assert.strictEqual(typeof C.moveQuestion, 'string');
  assert.strictEqual(typeof C.baseline, 'function');
  const src = require('fs').readFileSync(require('path').join(__dirname, '../site/checkup.js'), 'utf8');
  // checkup.js renders prose ONLY through the shared builders. If you're adding a sentence to the
  // screen, add it to checkupCopy — otherwise the printed sheet silently disagrees with the page.
  for (const sentence of [C.doNothing, C.reassure, C.fairStayPut, C.moveQuestion, C.exceptionPlanQ, C.shipQuestion]) {
    assert.ok(!src.includes(sentence.slice(0, 40)), 'checkup.js must not re-author: ' + sentence.slice(0, 40));
  }
});

t('fair-price fires on paper exactly when it fires on screen — and stays silent otherwise', () => {
  const F = require('../site/format.js');
  const m = ckModel();
  const group = F.groupPlans(twoRoads.plans, { road: null, planId: CK.planId });
  const fp = F.fairPriceCheck(group);
  const printed = P.passportStrings(m).some((x) => x === P.checkupCopy.fairHeading);
  assert.strictEqual(printed, fp.fires, `sheet ${printed ? 'prints' : 'omits'} but engine says ${fp.fires}`);
});

t('v2: perks questions ride in "Ask your plan" only when she said she doesn’t know', () => {
  const C = P.checkupCopy;
  const perkQ = C.perksQuestions[0];
  assert.ok(P.passportStrings(ckModel({ perks: 'unsure' })).includes(perkQ), 'unsure → the perks asks appear');
  assert.ok(P.passportStrings(ckModel({ perks: 'no' })).includes(perkQ), 'no → they appear');
  assert.ok(!P.passportStrings(ckModel({ perks: 'yes' })).includes(perkQ), 'yes → absent');
  assert.ok(!P.passportStrings(ckModel({ perks: null })).includes(perkQ), 'unanswered → absent');
  // they sit under the plan callee label, and the ANOC/EOC pointer still appears — never inventing a perk
  const s = P.passportStrings(ckModel({ perks: 'unsure' }));
  assert.ok(s.includes(C.calleeLabel.plan), 'grouped under "Ask your plan"');
  assert.ok(s.some((x) => /Annual Notice of Change/.test(x)), 'and points at the document that does');
});

t('v2: scorecard is counted-not-graded, and every gap/step traces to a computed rule', () => {
  const C = P.checkupCopy;
  const s = P.passportStrings(ckModel());
  // the scorecard header states counts, never a single-word verdict (#13)
  assert.ok(s.some((x) => /^\d+ of \d+ medications? covered at your best price/.test(x)), 'counted header: ' + s.find((x) => /covered at your best price/.test(x)));
  assert.ok(!s.some((x) => /\b(GOOD|FAIR|POOR|EXCELLENT)\b/.test(x)), 'no graded verdict word');
  // the next step is present and is one of the fixed kinds
  assert.ok(s.includes(C.nextStepHeading), 'the next-step heading');
});

t('v2: wouldSwitchingFix says No/Yes/Partly honestly, and never hides a gap (live 2026-07-19)', () => {
  const C = P.checkupCopy;
  const nw = { nowhere: [{ label: 'BrandX' }], elsewhere: [] };
  const el = { nowhere: [], elsewhere: [{ label: 'DrugY', plansCovering: 79 }] };
  const both = { nowhere: [{ label: 'BrandX' }], elsewhere: [{ label: 'DrugY', plansCovering: 79 }] };
  assert.ok(/^Would switching plans fix this\? No —/.test(C.wouldSwitchingFix(nw, 'St. Louis')), 'nowhere → No');
  assert.ok(/^Would switching plans fix this\? Yes — 79 plans/.test(C.wouldSwitchingFix(el, 'St. Louis')), 'elsewhere → Yes');
  const b = C.wouldSwitchingFix(both, 'St. Louis');
  assert.ok(/^Would switching plans fix this\? Partly\./.test(b), 'both → Partly');
  assert.ok(/BrandX/.test(b) && /DrugY/.test(b), 'and names BOTH gaps — neither is hidden: ' + b);
  assert.strictEqual(C.wouldSwitchingFix({ nowhere: [], elsewhere: [] }, 'X'), null, 'no gap → nothing to say');
});

// ---- founder PDF-review rider (C/D/E/F) ----
t('C: baseline sentence is deduped and composes cleanly for all three Q4 wheres', () => {
  const C = P.checkupCopy;
  const mk = (where) => C.baseline({ baseline: { where, days: '1' }, baselineAssumed: where === 'local' });
  // local (assumed standard): the "at a local pharmacy at a standard…" duplication is gone
  const local = mk('local');
  assert.ok(/at a standard \(non-preferred\) local pharmacy\./.test(local), local);
  assert.ok(!/local pharmacy at a standard/.test(local), 'no duplicated pharmacy phrase');
  assert.ok(/you may already pay less/.test(local), 'the hedge stays on the assumed-standard case');
  // preferred / mail: one clean phrase, no hedge
  assert.ok(/at one of your plan’s preferred pharmacies\.$/.test(mk('preferred')), mk('preferred'));
  assert.ok(/fills by mail\.$/.test(mk('mail')), mk('mail'));
  assert.ok(!/you may already pay less/.test(mk('preferred')) && !/you may already pay less/.test(mk('mail')), 'no hedge when she told us');
});

t('D: no "about" on a zero figure — "$0 for the year" (existing ruling)', () => {
  const C = P.checkupCopy;
  assert.strictEqual(C.perYear(0), '$0 for the year');
  assert.strictEqual(C.perYear(120), 'about $120/yr');
  assert.ok(/\$0 for the year/.test(C.goodNewsBullet({ kind: 'best-price', label: 'X', annual: 0 })));
  assert.ok(!/about \$0/.test(C.goodNewsBullet({ kind: 'best-price', label: 'X', annual: 0 })));
  // a move TO $0 says "$0 for the year", not "about $0/yr"
  assert.ok(/\$0 for the year/.test(C.moveLine({ label: 'X', current: 120, to: 0, saving: 120, days: '2' })));
});

t('E: partial anchor reads "covers N of your M medications" (matches the screen)', () => {
  // make EVERY plan partial (drop one drug) so a partial plan appears in the printed top-N
  const mixed = JSON.parse(JSON.stringify(data));
  for (const p of mixed.plans) { p.drugs['596926'] = { covered: false }; p.notCovered = 1; }
  const m = P.passportModel(mixed, drugs, { shareUrl: 'x' });
  const partialTotal = m.items.filter((i) => i.type === 'plan').map((i) => i.total).find((t) => /covers \d/.test(t));
  assert.ok(partialTotal, 'a partial total exists');
  assert.ok(/· covers 1 of your 2 medications$/.test(partialTotal), partialTotal);
  assert.ok(!/· for \d+ of \d+/.test(partialTotal), 'the old "for N of M" phrasing is gone');
});

t('F: the PA clause prints ONLY when a moved drug needs prior authorization (verified vs CMS)', () => {
  const C = P.checkupCopy;
  const F = require('../site/format.js');
  const cells = { standardRetail: { kind: 'copay', dollars: 30 }, preferredMail: { kind: 'copay', dollars: 3 }, standardMail: { kind: 'copay', dollars: 3 } };
  const mk = (pa) => ({ planId: 'H1-001', planName: 'T', planType: 'MA-PD', premium: 0, deductible: 0, notCovered: 0,
    drugs: { d1: { covered: true, tier: 2, flags: { priorAuth: pa }, headline: { kind: 'copay', dollars: 30 }, appliedOverrides: [],
      phases: { '1': { byDaysSupply: { '1': cells, '2': { preferredMail: { kind: 'copay', dollars: 12 }, standardMail: { kind: 'copay', dollars: 12 } } } } } } } });
  const list = [['d1', { label: 'DrugOne' }]];
  const withPa = F.actionPlan(mk(true), list, { where: 'local', days: '1' });
  assert.ok(withPa.moves.length === 1 && withPa.moves[0].pa === true, 'the move carries the PA flag');
  const noPa = F.actionPlan(mk(false), list, { where: 'local', days: '1' });
  assert.strictEqual(noPa.moves[0].pa, false);
  // the clause is accurate + hedged ("may")
  assert.ok(/mail-order pharmacy handles the same approval — your doctor may get a call/.test(C.paClause), C.paClause);
});

t('v2: the preferred-pharmacy switch renders as its own action, with true dollars + how-to question', () => {
  const C = P.checkupCopy;
  const pref = require('./ux/fixtures/results-preferred-switch.json');
  const s = P.passportStrings(P.checkupModel(pref, drugs, Object.assign({}, CK, { fill: { where: 'local', days: '1' }, now: NOW })));
  assert.ok(s.some((x) => /preferred pharmacies — saving about \$/.test(x)), 'the switch action head with its subtotal');
  assert.ok(s.some((x) => /at a preferred pharmacy\. Saving about \$/.test(x)), 'a per-drug switch line with true dollars');
  assert.ok(s.includes(C.switchQuestion), 'the how-to lives in Questions to ask (no named pharmacy)');
  assert.ok(!s.some((x) => /Walgreens|CVS|Walmart|Costco/.test(x)), 'no named pharmacy — that is Pharmacy Network V2');
  // next step is the switch, not "nothing to change"
  assert.ok(s.some((x) => /^Fill .* at one of your plan’s preferred pharmacies — about \$/.test(x)), 'switch is the next step');
});

t('v2: the formulary-exception path fires ONLY when NO county plan covers the drug', () => {
  const C = P.checkupCopy;
  const F = require('../site/format.js');
  // partial-gap fixture: one drug covered, one off-formulary on EVERY plan → nowhere → exception
  const gap = require('./ux/fixtures/results-partial-gap.json');
  const gs = P.passportStrings(P.checkupModel(gap, drugs, Object.assign({}, CK, { now: NOW })));
  assert.ok(gs.some((x) => /formulary exception/.test(x)), 'exception path present for a nowhere drug');
  assert.ok(gs.some((x) => /Can you request a formulary exception/.test(x)), 'the doctor question');
  assert.ok(gs.some((x) => /Would switching plans fix this\? No/.test(x)), 'and the honest switching fact');

  // two-roads fixture: her plan covers everything → NO gap → no exception anywhere
  const ok = P.passportStrings(ckModel());
  assert.ok(!ok.some((x) => /formulary exception/.test(x)), 'no exception path when nothing is a gap');
});

t('the season line is computed from the window on HER clock, never baked in', () => {
  const meta = { enrollment: { aep: { startMonth: 10, startDay: 15, endMonth: 12, endDay: 7, effective: 'January 1' } } };
  const inAep = P.passportStrings(ckModel({ meta, now: new Date('2026-11-01T12:00:00Z') }));
  const outside = P.passportStrings(ckModel({ meta, now: new Date('2026-07-16T12:00:00Z') }));
  // the compare sentence — NOT the share URL on page 2, which also contains "planrobin.com"
  const line = (s) => s.find((x) => /^If you’d like to compare, the full list/.test(x)) || '';
  // only assert when the fair-price section actually fires for this fixture
  if (line(inAep)) {
    assert.ok(/switching is open until December 7/.test(line(inAep)), line(inAep));
    assert.ok(/plan switching opens October 15/.test(line(outside)), line(outside));
  }
  // with no window on meta we never guess a date
  const none = line(P.passportStrings(ckModel({ meta: null })));
  if (none) assert.ok(!/October|December/.test(none), none);
});

t('page 2 is the reopen page, and the caveats key off what is ACTUALLY printed', () => {
  const s = P.passportStrings(ckModel());
  assert.ok(s.includes('Reopen this checkup'), 'the reopen page, named for this sheet');
  assert.ok(s.some((x) => /Use your phone’s camera/.test(x)), 'camera path');
  assert.ok(s.includes('Open this search'), 'the short tap-link label (never the raw fragment URL)');
  assert.ok(!s.some((x) => /#v1\.|#abc/.test(x)), 'the raw fragment URL is not printed');
  assert.ok(s.some((x) => /1-800-MEDICARE/.test(x)), 'confirm-it caveat');
  // ONE plan on this sheet → never the two-roads caveat (there is nothing to confuse it with)
  assert.ok(!s.some((x) => /not interchangeable/.test(x)), 'no two-roads caveat on a one-plan sheet');
  // her plan is MA-PD → the premium caveat IS carried
  assert.ok(s.some((x) => /separate medical premium not shown here/.test(x)), 'MA-PD premium caveat');
});

// REGRESSION (found while building the sheet, 2026-07-16). Her plan covered NOTHING she takes and the
// checkup answered "Good news — the way you're filling now is already the cheapest option on your
// plan. We checked." Two independent faults, both now pinned:
//   1. actionPlan `continue`d past not-covered drugs, so "no moves" read as "all is well".
//   2. fairPriceCheck's no-alternatives early-return preempted its own documented "not-covered ALWAYS
//      fires" rule, so the section that WOULD have told her never rendered.
// The result was a warm, confident, false verdict on the exact case that matters most.
t('REGRESSION: a plan covering nothing she takes never gets the good-news verdict', () => {
  const zero = require('./ux/fixtures/results-zero.json');
  const m = P.checkupModel(zero, drugs, Object.assign({}, CK, { now: NOW }));
  const s = P.passportStrings(m);
  assert.ok(!s.includes(P.checkupCopy.doNothing), 'NEVER "already the cheapest option" when a drug isn’t covered');
  // it names them, and points at the section that deals with it
  const warn = s.find((x) => /aren’t covered by your plan/.test(x));
  assert.ok(warn, 'names the uncovered drugs in the action section: ' + s.join(' | '));
  assert.ok(/see “Worth knowing” below/.test(warn), warn);
  assert.ok(s.includes(P.checkupCopy.fairHeading), 'and "Worth knowing" actually renders');
  // nothing was measured → no baseline note explaining a measurement that didn't happen
  assert.ok(!s.some((x) => /^Measured against/.test(x)), 'no baseline note when nothing was measured');
});

t('REGRESSION (v2): a plan covering nothing, with nowhere to switch, gets the exception path — not false calm', () => {
  const zero = require('./ux/fixtures/results-zero.json');
  const s = P.passportStrings(P.checkupModel(zero, drugs, Object.assign({}, CK, { now: NOW })));
  assert.ok(!s.includes(P.checkupCopy.doNothing), 'no false good-news verdict');
  assert.ok(!s.includes(P.checkupCopy.fairStayPut), 'no "staying put is fine" when there is nowhere to go');
  // the honest switching fact + the real remedy (a person + a process), never "0 other plans"
  assert.ok(s.some((x) => /Would switching plans fix this\? No/.test(x)), 'the honest switching fact');
  assert.ok(!s.some((x) => /^0 other|0 plans/.test(x)), 'never "0 other plans"');
  assert.ok(s.some((x) => /formulary exception/.test(x)), 'points at the exception process');
  assert.ok(s.some((x) => /Can you request a formulary exception/.test(x)), 'with the doctor question to ask');
});

t('allClear is the verdict’s gate: earned only when every drug was actually checkable', () => {
  const F = require('../site/format.js');
  const mk = (drugsObj) => ({ planId: 'H1-001', segmentId: '000', planName: 'T', planType: 'MA-PD', premium: 0, deductible: 0, notCovered: 0, annualComplete: true, breakdown: {}, drugs: drugsObj });
  const copayOnly = { phases: { '1': { byDaysSupply: { '1': { standardRetail: { kind: 'copay', dollars: 10 }, preferredMail: { kind: 'copay', dollars: 10 } } } } }, covered: true, tier: 1, flags: {}, headline: { kind: 'copay', dollars: 10 }, appliedOverrides: [] };
  const list = [['9', { label: 'a' }]];
  // nothing to move, everything checkable → the warm verdict is honest
  assert.strictEqual(F.actionPlan(mk({ '9': copayOnly }), list, { where: 'local', days: '1' }).allClear, true);
  // a drug the plan doesn't cover → NOT all clear, and it's reported rather than dropped
  const withGap = F.actionPlan(mk({ '9': { covered: false } }), list, { where: 'local', days: '1' });
  assert.strictEqual(withGap.allClear, false);
  assert.strictEqual(withGap.nothingToDo, true, 'still nothing to MOVE — the two are different questions');
  assert.deepStrictEqual(withGap.notCovered.map((x) => x.label), ['a']);
  // a coinsurance drug we can't compare → also not all clear (we said so, we don't pretend we checked)
  const coins = F.actionPlan(mk({ '9': { covered: true, tier: 4, flags: {}, headline: { kind: 'coinsurance', display: '25%' }, phases: {}, appliedOverrides: [] } }), list, { where: 'local', days: '1' });
  assert.strictEqual(coins.allClear, false);
  assert.strictEqual(coins.cant.length, 1);
});

t('filename is planrobin-checkup-YYYY-MM-DD.pdf (its own artifact, not the comparison’s)', () => {
  assert.ok(/^planrobin-checkup-\d{4}-\d{2}-\d{2}\.pdf$/.test(ckModel().filename), ckModel().filename);
});

console.log(`\nALL PASSPORT MODEL TESTS PASSED (${passed}).`);
