// Shared display formatting for the results view. Loaded in the browser (window.PRFormat) and
// require()-d by tests. Whole-dollar formatting for TOTALS (anchor, breakdown lines, savings);
// cents stay in the per-fill detail rows and the phase table, where they're exact.
//
// Rounding rule (so itemized lines always visibly add up): the displayed total is the SUM OF THE
// ROUNDED components — never round(sum-of-raw) — so premium + copays + coinsurance-estimates shown
// on screen add up to the total shown. When the $2,000 cap binds, the total is the capped value and
// the cap note explains that it's less than the components add up to.
(function (global) {
  'use strict';
  const round = (n) => Math.round(Number(n) || 0);
  const dollars = (n) => '$' + round(n).toLocaleString();

  function planDisplayTotal(plan) {
    const b = plan.breakdown || {};
    if (b.capBinds) return round(plan.annualEstimate); // capped; components are pre-cap (note explains)
    let sum = round(b.premiumAnnual) + round(b.copayAnnual);
    for (const rx of (b.coinsuranceEstRxcuis || [])) {
      const est = (plan.drugs && plan.drugs[rx] && plan.drugs[rx].estimated) || {};
      sum += round(est.annual);
    }
    return sum;
  }

  // Savings sentence pieces. amount is bolded in the UI; the pair visibly agrees: anchor − amount = Y.
  function savingsCopy(plan, loc) {
    const s = plan.savings;
    const anchorD = planDisplayTotal(plan);
    const yD = round(s.channelTotal);
    const nD = anchorD - yD;
    const tail = yD === 0
      ? 'bringing your total to $0 for the year.'
      : 'bringing your total to about $' + yD.toLocaleString() + '/yr.';
    return {
      amount: '$' + nD.toLocaleString() + '/year',
      tail: ' at ' + loc + ' — ' + tail,
      full: 'Save about $' + nD.toLocaleString() + '/year at ' + loc + ' — ' + tail,
      anchorD, channelTotalD: yD, savingsD: nD,
    };
  }

  // ---- Coverage completeness — ONE definition, shared by results, sort, savings, and passport ----
  // A plan is "complete" only if it covers EVERY drug in the basket. Missing drugs are named, and a
  // missing drug is never totaled as $0 — it just isn't on the plan.
  function planCoverage(plan) {
    const drugs = (plan && plan.drugs) || {};
    const rxs = Object.keys(drugs);
    const missing = rxs.filter((rx) => !(drugs[rx] && drugs[rx].covered));
    return { total: rxs.length, covered: rxs.length - missing.length, missing, complete: missing.length === 0 };
  }

  // Ranking comparator: plans covering ALL basket drugs rank first (a partial plan can NEVER
  // outrank a complete one, regardless of price). Within the partial group, plans covering MORE of
  // your drugs rank higher — so a plan that's only "cheap" because it skips a drug can't float to
  // the top there either. Then fully-priced before incomplete, then by total. Used by the API sort
  // AND asserted in tests, so screen/print can't disagree.
  function planRank(a, b) {
    const ac = a.notCovered === 0, bc = b.notCovered === 0;
    if (ac !== bc) return ac ? -1 : 1;
    return (a.notCovered - b.notCovered)
      || ((a.annualComplete ? 0 : 1) - (b.annualComplete ? 0 : 1))
      || (a.annualEstimate - b.annualEstimate);
  }

  // ---- CMS plan ID for display — the government identity printed on the member's card ----
  // plan.planId is CONTRACT-PLAN (e.g. "H2228-042"). The segment suffix is reference noise for the
  // reader, so we show it ONLY when two displayed plans share the same contract-plan and would
  // otherwise be indistinguishable. ambiguousPlanIds(plans) returns that set. Shared by the results
  // header and the printed Passport so both read the same ID off the card.
  function ambiguousPlanIds(plans) {
    const counts = {};
    for (const p of (plans || [])) counts[p.planId] = (counts[p.planId] || 0) + 1;
    return new Set(Object.keys(counts).filter((id) => counts[id] > 1));
  }
  function planDisplayId(plan, ambiguous) {
    const base = plan.planId;
    const needSeg = ambiguous && (ambiguous.has ? ambiguous.has(base) : ambiguous[base]);
    return needSeg && plan.segmentId != null ? base + '-' + plan.segmentId : base;
  }

  const api = { round, dollars, planDisplayTotal, savingsCopy, planCoverage, planRank, ambiguousPlanIds, planDisplayId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
