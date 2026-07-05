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

  const api = { round, dollars, planDisplayTotal, savingsCopy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
