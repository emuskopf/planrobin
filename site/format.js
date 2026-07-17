// Shared display formatting for the results view. Loaded in the browser (window.PRFormat) and
// require()-d by tests. Whole-dollar formatting for TOTALS (anchor, breakdown lines, savings);
// cents stay in the per-fill detail rows and the phase table, where they're exact.
//
// Rounding rule (so itemized lines always visibly add up): the displayed total is the SUM OF THE
// ROUNDED components — never round(sum-of-raw) — so premium + copays + coinsurance-estimates shown
// on screen add up to the total shown. When the out-of-pocket cap binds, the total is the capped
// value and the cap note explains that it's less than the components add up to.
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

  // ---- Phase/channel detail as plain-English lines (replaces a 6-column grid that can't survive a
  // phone). Pure + deterministic on the same rows the table used, so it's unit-testable and the
  // screen + any future consumer read identically. Rules: collapse equal phases ("all year"),
  // collapse equal preferred channels ("preferred pharmacies (or by mail)"), and treat the 90-day
  // = 3× retail case as ONE shared footnote — stating 90-day per-channel only where it ISN'T 3×
  // (a real mail discount). Exact dollars/percent, no editorializing; an unoffered channel is simply
  // omitted (never a blank cell). ----
  function phaseSummary(phases, opts) {
    opts = opts || {};
    const P = phases || {};
    const at = (lvl, ds, chan) => { const p = P[lvl] && P[lvl].byDaysSupply && P[lvl].byDaysSupply[ds]; return p ? p[chan] : null; };
    const offered = (c) => !!c && (c.kind === 'copay' || c.kind === 'coinsurance');
    const pkey = (c) => !offered(c) ? 'na' : (c.kind === 'copay' ? 'c' + c.dollars : 'r' + c.rate);
    const ptext = (c) => !offered(c) ? null : (c.kind === 'copay' ? '$' + Number(c.dollars).toFixed(2) : Math.round(c.rate * 100) + '%');

    // 30-day price across phases for a channel -> a sentence fragment, or null if not offered.
    function pattern(chan) {
      const p0 = at('0', '1', chan), p1 = at('1', '1', chan), p3 = at('3', '1', chan);
      if (!offered(p1)) return null;
      let s = (offered(p0) && pkey(p0) !== pkey(p1)) ? (ptext(p0) + ' before you meet the deductible, then ' + ptext(p1)) : ptext(p1);
      if (offered(p3) && pkey(p3) !== pkey(p1)) s += ' until you reach catastrophic coverage, then ' + ptext(p3);
      else s += ' all year';
      return s;
    }
    // 90-day vs 3× the 30-day (copay channels only). '3x' | {kind:'discount', ...} | null.
    function ninety(chan) {
      const p1 = at('1', '1', chan), p90 = at('1', '2', chan);
      if (!offered(p1) || !offered(p90) || p1.kind !== 'copay' || p90.kind !== 'copay') return null;
      const triple = p1.dollars * 3;
      if (Math.abs(p90.dollars - triple) < 0.005) return { kind: '3x' };
      if (p90.dollars < triple - 0.005) return { kind: 'discount', text: '$' + p90.dollars.toFixed(2), zero: p90.dollars < 0.005 };
      return null;
    }
    // The phase story and the 90-day discount are SEPARATE sentences — welding them (with an em-dash)
    // read as if the 90-day price were a phase outcome (e.g. the catastrophic $0). The 90-day price is
    // always-true, so anchor it in time ("all year"); when it's $0, say so plainly and drop the "less
    // than three 30-day fills" comparison (a comparison only helps when there's a nonzero price to weigh).
    // Returns 1–2 lines to spread into the list.
    const withNinety = (line, chan, byMail) => {
      const out = [line];
      const n = ninety(chan);
      if (n && n.kind === 'discount') {
        const where = byMail ? ' by mail' : '';
        out.push(n.zero
          ? 'A 90-day supply' + where + ' is $0 all year.'
          : 'A 90-day supply' + where + ' is ' + n.text + ', less than three 30-day fills.');
      }
      return out;
    };

    const lines = [];
    const std = pattern('standardRetail');
    if (std) lines.push(...withNinety('At a standard pharmacy: ' + std + '.', 'standardRetail', false));

    const pr = pattern('preferredRetail'), pm = pattern('preferredMail');
    if (pr && pm && pr === pm) lines.push(...withNinety('At this plan’s preferred pharmacies (or by mail): ' + pr + '.', 'preferredMail', true));
    else {
      if (pr) lines.push(...withNinety('At this plan’s preferred pharmacies: ' + pr + '.', 'preferredRetail', false));
      if (pm) lines.push(...withNinety('By this plan’s mail-order pharmacy: ' + pm + '.', 'preferredMail', true));
    }

    const CH = ['standardRetail', 'preferredRetail', 'preferredMail', 'standardMail'];
    const anyCoins = CH.some((c) => { const x = at('1', '1', c); return x && x.kind === 'coinsurance'; });
    if (anyCoins) lines.push('These are coinsurance rates — your dollar cost depends on the drug’s price and how much you take.');

    const ns = CH.map(ninety).filter(Boolean);
    let footnote = (ns.length && ns.every((n) => n.kind === '3x')) ? 'A 90-day supply at a pharmacy costs about three 30-day fills.' : null;
    if (opts.deductibleExempt) footnote = (footnote ? footnote + ' ' : '') + 'This drug skips the plan’s deductible.';

    return { lines, footnote };
  }

  // The out-of-pocket cap as prose ("$2,100 in 2026") — straight from the statutory parameter the
  // engine computes with (served on /api/meta). Explainer prose and the math read the SAME number, so
  // they can't disagree. Null when meta lacks it, so callers can fall back to a number-free phrase.
  function capPhrase(meta) {
    if (!meta || meta.oopCapAnnual == null || meta.planYear == null) return null;
    return dollars(meta.oopCapAnnual) + ' in ' + meta.planYear;
  }

  // ---- The two roads ----------------------------------------------------------------------------
  // A Medicare Advantage (MA-PD / regional MA-PD) plan? Works on the raw type ("MA","MA-regional")
  // or the display label ("MA-PD","MA-PD (regional)") — all start with "MA"; a PDP never does.
  function isMaPd(planType) { return /^MA/i.test(String(planType || '')); }
  // Which road a plan lives on. 'ma' = an all-in-one Medicare Advantage plan (replaces Original
  // Medicare). 'original' = a stand-alone drug plan that sits ON TOP of Original Medicare. These are
  // not interchangeable: enrolling in a PDP while on an MA plan disenrolls you from the MA plan and
  // returns you to Original Medicare (Medicare.gov, "Switch, drop, or rejoin drug coverage").
  function roadOf(planType) { return isMaPd(planType) ? 'ma' : 'original'; }
  // The user's road, from the answer they gave — or inferred from a plan ID they typed. CMS contract
  // prefixes: H/R = Medicare Advantage → they're on the MA road; S = stand-alone PDP → a PDP only
  // exists alongside Original Medicare, so they're on the Original-Medicare road.
  function roadFromPlanId(planId) {
    const c = String(planId || '').trim().charAt(0).toUpperCase();
    if (c === 'H' || c === 'R') return 'ma';
    if (c === 'S') return 'original';
    return null;
  }
  // Only a KNOWN current road can group results; "new to Medicare" and "not sure" have no road yet.
  const KNOWN_ROADS = ['ma', 'original'];
  function isKnownRoad(road) { return KNOWN_ROADS.indexOf(road) !== -1; }
  // Split plans into [sameRoad, otherRoad] WITHOUT dropping any — grouping never filters. Order
  // within each group is preserved, so the complete-vs-partial ranking underneath is untouched.
  function partitionByRoad(plans, road) {
    const all = plans || [];
    if (!isKnownRoad(road)) return { same: all.slice(), other: [], grouped: false };
    return {
      same: all.filter((p) => roadOf(p.planType) === road),
      other: all.filter((p) => roadOf(p.planType) !== road),
      grouped: true,
    };
  }
  // Do both roads appear in this result set? (Premium comparability + the "both kinds" line hang on this.)
  function roadsMix(plans) {
    const all = plans || [];
    return all.some((p) => roadOf(p.planType) === 'ma') && all.some((p) => roadOf(p.planType) === 'original');
  }

  // ---- Price basis (a price never ships without its basis) ---------------------------------------
  // The headline per-drug number's basis IS the basis the engine projects with: days-supply code '1'
  // = a 30-day fill, 12 fills a year, standard retail, initial coverage. The label and the
  // arithmetic live together here so the words and the math cannot disagree (a node test asserts this
  // matches the engine's FILLS_PER_YEAR). Change the engine's basis → change it here, once.
  const HEADLINE_BASIS = {
    daysSupplyCode: '1',
    days: 30,
    fillsPerYear: 12,
    perLabel: 'per 30-day fill',      // "$10.00 per 30-day fill"
    ofEachLabel: 'of each 30-day fill', // "25% of each 30-day fill"
  };
  // Annualize a headline per-fill copay on that same basis.
  function headlineAnnual(dollars) { return (Number(dollars) || 0) * HEADLINE_BASIS.fillsPerYear; }
  // The premium figure we show is the CMS Plan Information PREMIUM field. For a PDP that IS the whole
  // premium; for an MA-PD it's only the Part D drug-coverage portion (the medical/Part C premium is
  // separate and not in this file), so we label it honestly. See planrobin-premium-semantics.
  function premiumLabel(planType) { return isMaPd(planType) ? 'drug coverage premium' : 'premium'; }

  const api = { round, dollars, planDisplayTotal, savingsCopy, planCoverage, planRank, ambiguousPlanIds, planDisplayId, phaseSummary, capPhrase, isMaPd, premiumLabel,
    roadOf, roadFromPlanId, isKnownRoad, partitionByRoad, roadsMix, HEADLINE_BASIS, headlineAnnual };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
