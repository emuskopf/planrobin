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

  // ---- Conditional notes must EARN their reassurance (UX-REVIEW #13: FALSE REASSURANCE) ----------
  // A note that says something comforting about "your medications" is only true of the medications
  // this plan actually covers. A drug that's on NO tier is not "on a tier the deductible skips" —
  // saying so is vacuously true and reads as an all-clear. Two rules, both enforced HERE so screen,
  // passport and any future consumer can't disagree:
  //   • suppressed entirely unless at least one basket drug is genuinely covered;
  //   • when coverage is PARTIAL, the sentence scopes itself to the drugs it's true of.
  // The API guards the zero case too (`deductibleExempt`), but the client re-checks from the shared
  // coverage definition: a payload is not allowed to be the only thing standing between a reader and
  // a false all-clear. Returns null (render nothing) or the pieces the renderer needs.
  function deductibleExemptNote(plan) {
    const b = (plan && plan.breakdown) || {};
    if (!b.deductibleExempt) return null;
    const cov = planCoverage(plan);
    if (cov.covered === 0) return null;            // nothing is on any tier — there is no good news here
    const ded = '$' + Number(b.deductibleAmount || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const which = cov.complete ? 'your medications' : 'the medications it covers';
    return {
      amount: b.deductibleAmount || 0, complete: cov.complete,
      text: `This plan's ${ded} deductible doesn't apply to ${which} — they're on tiers the deductible skips.`,
    };
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
  // Only a KNOWN current road can group results; "new to Medicare" and "not sure" have no road yet.
  const KNOWN_ROADS = ['ma', 'original'];
  function isKnownRoad(road) { return KNOWN_ROADS.indexOf(road) !== -1; }

  // A CMS plan ID as printed on a membership card: a letter, four digits, a dash, three digits
  // ("H1234-001"). Spaces and case are ignored — she's reading it off a card, not typing a key.
  const PLAN_ID_RE = /^[A-Z]\d{4}-\d{3}$/;
  const PLAN_ID_PREFIX_RE = /^[A-Z]?\d{0,4}-?\d{0,3}$/; // still could BECOME valid → don't nag yet
  function normalizePlanId(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase(); }
  function isPlanIdShape(v) { return PLAN_ID_RE.test(normalizePlanId(v)); }
  function isPlanIdPrefix(v) { return PLAN_ID_PREFIX_RE.test(normalizePlanId(v)); }

  // ---- THE grouping definition (one source of truth) ---------------------------------------------
  // Everything that needs to know "which plans go where" reads THIS: the rendered list, the headline
  // count, and (next) the checkup. Three buckets, and it NEVER filters — every input plan lands in
  // exactly one bucket, order preserved, so the complete-vs-partial ranking underneath is untouched.
  //
  //   yourPlan        the plan whose ID she typed, EXTRACTED from its group (renders first, always)
  //   sameRoadOthers  the rest of the plans on her road
  //   otherRoad       the plans on the other road (never hidden — just below a divider)
  //
  // Her road comes from the plan we matched (authoritative) or, failing that, from what she told us.
  // A well-formed ID we could NOT match does not imply a road: if we can't find the plan, we don't
  // assume things about it — the UI asks her to pick a road instead.
  function groupPlans(plans, opts) {
    opts = opts || {};
    const all = (plans || []).slice();
    const wanted = opts.planId ? normalizePlanId(opts.planId) : '';
    let yourPlan = null, rest = all;
    if (wanted) {
      const i = all.findIndex((p) => normalizePlanId(p && p.planId) === wanted);
      if (i !== -1) { yourPlan = all[i]; rest = all.slice(0, i).concat(all.slice(i + 1)); }
    }
    const road = yourPlan ? roadOf(yourPlan.planType) : opts.road;
    // planIdMissed: she gave us a real-looking ID and it isn't in this county's results — a designed
    // state, not an error (see the not-found note).
    const planIdMissed = !!wanted && !yourPlan;
    if (!isKnownRoad(road)) {
      return { yourPlan, sameRoadOthers: rest, otherRoad: [], grouped: false, road: null, planIdMissed };
    }
    return {
      yourPlan,
      sameRoadOthers: rest.filter((p) => roadOf(p.planType) === road),
      otherRoad: rest.filter((p) => roadOf(p.planType) !== road),
      grouped: true,
      road,
      planIdMissed,
    };
  }

  // What we call each road's plans, in her words.
  const ROAD_NOUN = { ma: 'Medicare Advantage', original: 'drug-only' };
  const otherRoadOf = (road) => (road === 'ma' ? 'original' : 'ma');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The headline count, spoken in the SAME grouping the page renders — so the number can never
  // contradict the layout. Her own plan is counted inside her road's total (it IS one of them).
  function resultsCountLine(group, countyName) {
    const g = group || {};
    const total = (g.yourPlan ? 1 : 0) + (g.sameRoadOthers || []).length + (g.otherRoad || []).length;
    if (!g.grouped) return plural(total, 'plan', 'plans');
    const sameN = (g.yourPlan ? 1 : 0) + (g.sameRoadOthers || []).length;
    const otherN = (g.otherRoad || []).length;
    const where = countyName ? ` in ${countyName}` : '';
    const same = plural(sameN, `${ROAD_NOUN[g.road]} plan`, `${ROAD_NOUN[g.road]} plans`) + where;
    if (!otherN) return same;
    const other = plural(otherN, `${ROAD_NOUN[otherRoadOf(g.road)]} plan`, `${ROAD_NOUN[otherRoadOf(g.road)]} plans`);
    return `${same} — plus ${other} on a different road, below`;
  }
  // Do both roads appear in this result set? (Premium comparability + the "both kinds" line hang on this.)
  function roadsMix(plans) {
    const all = plans || [];
    return all.some((p) => roadOf(p.planType) === 'ma') && all.some((p) => roadOf(p.planType) === 'original');
  }

  // ---- Season awareness --------------------------------------------------------------------------
  // The AEP window is a verified statutory parameter (tools/overrides/statutory-params.js) served on
  // /api/meta. We take it as DATA and do the comparison here, once — the window has one home, the
  // arithmetic has one implementation, and no date is ever re-typed into copy.
  // Calendar-naive (month/day) on purpose: that's how a person reads a date.
  function inAep(aep, now) {
    if (!aep) return null;                       // no window → we don't know; say nothing seasonal
    const d = now || new Date();
    const m = d.getMonth() + 1, day = d.getDate();
    const afterStart = m > aep.startMonth || (m === aep.startMonth && day >= aep.startDay);
    const beforeEnd = m < aep.endMonth || (m === aep.endMonth && day <= aep.endDay);
    return afterStart && beforeEnd;
  }
  const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthDay = (m, d) => `${MONTH_NAME[m - 1]} ${d}`;
  // "switching is open until December 7" (inside AEP) / "plan switching opens October 15" (outside).
  // Null when meta carries no window — we never guess a date.
  function seasonLine(meta, now) {
    const aep = meta && meta.enrollment && meta.enrollment.aep;
    const open = inAep(aep, now);
    if (open === null) return null;
    return open
      ? `switching is open until ${monthDay(aep.endMonth, aep.endDay)}`
      : `plan switching opens ${monthDay(aep.startMonth, aep.startDay)}`;
  }

  // ---- The fair-price check ----------------------------------------------------------------------
  // Deterministic disclosure, never a grade. Compares HER plan's basket against the plans on HER road
  // that cover EVERY drug on her list (anything else isn't a fair compare). Rules:
  //   • fires when at least one such plan is >= floor cheaper per year
  //   • ALWAYS fires when her own plan misses one of her drugs — a gap is worth knowing at any price
  //   • otherwise SILENCE: we disclose gaps, we don't rank loyalty ("your plan looks good" is a grade)
  //
  // FLOOR — $100/yr is an UNTUNED PLACEHOLDER. It has NOT been measured against real Missouri
  // distributions; that tuning needs the live DB and lands with the counters work. The tests pin the
  // BOUNDARY BEHAVIOUR, not this number, so re-tuning is a one-line data change.
  const FAIR_PRICE_FLOOR_UNTUNED = 100;

  function fairPriceCheck(group, opts) {
    opts = opts || {};
    const floor = opts.floor == null ? FAIR_PRICE_FLOOR_UNTUNED : opts.floor;
    const you = group && group.yourPlan;
    if (!you) return { fires: false, reason: 'no-plan', floor };
    const yourCoverage = planCoverage(you);
    const road = group.road;
    // Same road + covers everything she takes.
    const alts = (group.sameRoadOthers || []).filter((p) => planCoverage(p).complete);
    const yourTotal = planDisplayTotal(you);
    // Gaps are computed from the DISPLAYED totals (planDisplayTotal = the sum of rounded components,
    // i.e. the number printed on each card), so "at least $Y" is always the figure she could work out
    // herself from the two cards. Math.floor is a belt-and-braces guard: the claim can never exceed
    // the gap on screen.
    const deltas = alts.map((p) => yourTotal - planDisplayTotal(p));
    const cheaper = deltas.filter((d) => d >= floor);
    const atLeast = cheaper.length ? Math.floor(Math.min.apply(null, cheaper)) : null;

    // Her plan doesn't cover everything she takes → she needs to know, whatever the money says AND
    // whether or not anything better exists. This check comes FIRST, above the no-alternatives exit:
    // "no plan in your county covers everything" is exactly the case where a silent report would be
    // worst, and n === 0 is a fact the copy can state, not a reason to say nothing.
    if (!yourCoverage.complete) {
      return { fires: true, reason: 'not-covered', n: alts.length, atLeast, floor, road, yourCoverage };
    }
    if (!alts.length) return { fires: false, reason: 'no-alternatives', floor, road, yourCoverage };
    if (!cheaper.length) return { fires: false, reason: 'below-floor', floor, road, yourCoverage };
    return { fires: true, reason: 'cheaper', n: cheaper.length, atLeast, floor, road, yourCoverage };
  }

  // ---- The action plan ---------------------------------------------------------------------------
  // Grouped by ACTION, not by drug — she does one thing (move these two to mail), not five separate
  // errands. Every dollar is a published cell × the engine's fills-per-year; nothing is modelled.
  // Only COPAY cells annualise honestly: a coinsurance drug needs a price AND her dose, so those are
  // listed as "can't compare by pharmacy" rather than guessed (rule 6).
  //
  // BASELINE HONESTY: "a local pharmacy" is anchored to standardRetail — the same anchor the whole
  // product ranks on. If her local pharmacy happens to be one of the plan's PREFERRED ones she may
  // already pay less, which would make a claimed saving too big; the renderer must say so. We never
  // silently assume the worse baseline to inflate a number.
  const ACTION_FILLS = { '1': 12, '2': 4 };  // mirrors the engine's FILLS_PER_YEAR (pinned by test)
  const MAIL_CHANNELS = ['preferredMail', 'standardMail'];
  const ACTION_MIN_DEFAULT = 25;             // the engine's calm floor — don't cry opportunity over $3

  function cellAt(phases, ds, chan) {
    const lvl = phases && phases['1'] && phases['1'].byDaysSupply && phases['1'].byDaysSupply[ds];
    return lvl ? lvl[chan] : null;
  }
  const annualOfCell = (cell, ds) => (cell && cell.kind === 'copay' && ACTION_FILLS[ds])
    ? Number(cell.dollars) * ACTION_FILLS[ds] : null;

  // Cheapest option across a set of days-supplies × channels — or null if none is a priceable copay.
  function bestAcross(res, daysList, channels) {
    let best = null, bd = null, bc = null;
    for (const ds of daysList) for (const ch of channels) {
      const a = annualOfCell(cellAt(res.phases, ds, ch), ds);
      if (a !== null && (best === null || a < best)) { best = a; bd = ds; bc = ch; }
    }
    return best === null ? null : { annual: best, days: bd, channel: bc };
  }

  // baseline = { where: 'local'|'preferred'|'mail', days: '1'|'2' } (Q4). Defaults to the product's
  // anchor: a 30-day fill at a STANDARD local pharmacy.
  //
  // TWO pharmacy levers, each a distinct ACTION (never two competing actions for one drug):
  //   • mail move       — the cheapest mail price (searched across both days-supplies: 90-day is the point)
  //   • preferred switch — preferred retail at HER current days-supply (a location change, same supply)
  // Per drug we take the LARGER saving as the action and mention the runner-up in one clause. When she
  // told us (Q4) she already uses a preferred pharmacy, the baseline IS preferredRetail, so a preferred
  // switch can't fire on a drug already at that price — baseline honesty, not a made-up saving.
  function actionPlan(plan, drugs, baseline, opts) {
    const min = (opts && opts.min != null) ? opts.min : ACTION_MIN_DEFAULT;
    const where = (baseline && baseline.where) || 'local';
    const days = (baseline && baseline.days) || '1';
    const baseChannel = where === 'mail' ? 'preferredMail' : (where === 'preferred' ? 'preferredRetail' : 'standardRetail');
    const moves = [], switches = [], keep = [], cant = [], notCovered = [];
    for (const entry of (drugs || [])) {
      const rxcui = entry[0], meta = entry[1] || {};
      const res = plan && plan.drugs && plan.drugs[rxcui];
      // Not-covered drugs have no pharmacy price to improve, so they're not an ACTION — but they are
      // REPORTED, never silently dropped (that's what let "nothing to move" read as "all is well").
      if (!res || !res.covered) { notCovered.push({ rxcui: rxcui, label: meta.label }); continue; }
      const current = annualOfCell(cellAt(res.phases, days, baseChannel), days);
      if (current === null) { cant.push({ rxcui: rxcui, label: meta.label }); continue; }

      const mail = bestAcross(res, ['1', '2'], MAIL_CHANNELS);   // mail: 90-day is the point → search both
      const prefA = annualOfCell(cellAt(res.phases, days, 'preferredRetail'), days); // preferred: her supply
      const pref = prefA === null ? null : { annual: prefA, days: days, channel: 'preferredRetail' };
      const mailDelta = mail ? current - mail.annual : -Infinity;
      const prefDelta = pref ? current - pref.annual : -Infinity;

      // Larger saving is the action; ties go to mail (the product's established lever). The other lever,
      // if it ALSO clears the floor, is the runner-up (one clause, never a second action for this drug).
      const mailWins = mailDelta >= prefDelta;
      const primary = mailWins ? { opt: mail, delta: mailDelta, kind: 'mail' } : { opt: pref, delta: prefDelta, kind: 'switch' };
      const runner  = mailWins ? { opt: pref, delta: prefDelta, kind: 'switch' } : { opt: mail, delta: mailDelta, kind: 'mail' };
      if (primary.opt && primary.delta >= min) {
        const runnerUp = (runner.opt && runner.delta >= min) ? { channel: runner.kind, saving: round(runner.delta), to: runner.opt.annual } : null;
        const item = { rxcui: rxcui, label: meta.label, current: current, to: primary.opt.annual, saving: round(primary.delta), days: primary.opt.days, channel: primary.opt.channel, runnerUp: runnerUp };
        (primary.kind === 'mail' ? moves : switches).push(item);
      } else {
        keep.push({ rxcui: rxcui, label: meta.label, annual: current });
      }
    }
    const sumSaving = (arr) => round(arr.reduce((s, x) => s + x.saving, 0));
    return {
      moves: moves, switches: switches, keep: keep, cant: cant, notCovered: notCovered,
      saving: round(sumSaving(moves) + sumSaving(switches)),  // total across both levers
      moveSaving: sumSaving(moves), switchSaving: sumSaving(switches),
      // No action of ANY kind to take. NOT the same as "all is well" — read with cant/notCovered too.
      nothingToDo: moves.length === 0 && switches.length === 0,
      // The warm do-nothing verdict is earned ONLY when no action of any kind fires and every drug was
      // actually checkable (covered, priced as a copay, already at its best channel).
      allClear: moves.length === 0 && switches.length === 0 && cant.length === 0 && notCovered.length === 0,
      baseline: { where: where, days: days, channel: baseChannel },
      // only the STANDARD-local baseline is an assumption we should hedge ("you may already pay less");
      // if she told us preferred or mail, we're not assuming.
      baselineAssumed: where === 'local',
      min: min,
    };
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

  // She told us which plan is hers with two different levels of confidence: typing the ID off her card
  // is a claim of ownership; picking a name out of a list is a selection. The card, the math and the
  // honesty are identical either way — only the word changes, so the page never sounds more certain
  // about her life than she was. Default is "Your plan" (on the comparison page, typing is the only way in).
  const YOURS_LABEL = { typed: 'Your plan', picked: 'The plan you selected' };
  function yoursLabel(source) { return YOURS_LABEL[source] || YOURS_LABEL.typed; }

  // ---- Checkup v2 engine: county-wide coverage, the exception split, the scorecard --------------
  // All computed from the SAME data the picker uses (data.plans = every plan in her county), so the
  // exception path and the "would switching fix this" fact trace to a published cell, never a guess.

  // For each basket drug, how many plans IN HER COUNTY cover it at all (any tier). This is the fact
  // the exception path turns on: a drug covered by ZERO county plans can't be gotten by switching.
  function countyDrugCoverage(plans, drugs) {
    const out = {};
    for (const entry of (drugs || [])) {
      const rx = entry[0];
      let n = 0;
      for (const p of (plans || [])) if (p.drugs && p.drugs[rx] && p.drugs[rx].covered) n++;
      out[rx] = n;
    }
    return out; // { rxcui: number-of-county-plans-covering-it }
  }

  // Split the drugs HER plan misses into two buckets, because they have opposite remedies:
  //   • nowhere   — no plan in the county covers it → switching CAN'T fix it → the exception path
  //   • elsewhere — some county plan covers it     → switching COULD fix it → the comparison path
  // The exception line must fire ONLY for `nowhere` (spec item 1: never where switching would fix it).
  function exceptionSplit(plans, yourPlan, drugs) {
    const county = countyDrugCoverage(plans, drugs);
    const nowhere = [], elsewhere = [];
    for (const entry of (drugs || [])) {
      const rx = entry[0], label = (entry[1] || {}).label || rx;
      const yours = yourPlan && yourPlan.drugs && yourPlan.drugs[rx] && yourPlan.drugs[rx].covered;
      if (yours) continue;                              // her plan covers it — not a gap
      if (county[rx] > 0) elsewhere.push({ rxcui: rx, label, plansCovering: county[rx] });
      else nowhere.push({ rxcui: rx, label });
    }
    return { nowhere, elsewhere };
  }

  // Counted, never graded (spec item 2 + UX-REVIEW #13). Buckets are MECE over the basket, each with a
  // stated reason, so reviewed = best + attention + coinsurance always holds:
  //   • best        — covered AND confirmed already at her cheapest channel (actionPlan.keep)
  //   • attention   — a gap (not covered) OR a cheaper option exists (actionPlan.moves)
  //   • coinsurance — covered but priced as coinsurance, so we can't confirm best price (actionPlan.cant)
  // NO single-word verdict — the header states the counts and lets her read them.
  function checkupScorecard(a) {
    // attention = a gap (not covered) OR a cheaper option exists (a mail move OR a preferred switch).
    // A switch drug is NOT "at your best price" — she could pay less — so it counts as attention, not
    // best; leaving it out entirely (as an earlier version did) dropped it from the tally, so the
    // counts didn't add up to her basket size.
    const attention = a.notCovered.length + a.moves.length + (a.switches ? a.switches.length : 0);
    const best = a.keep.length;
    const coinsurance = a.cant.length;
    return { reviewed: attention + best + coinsurance, best, attention, coinsurance };
  }

  // The single next action, chosen by the spec's fixed priority (item 3). Sourced from the action
  // plan's top item + the exception split — one named thing to do, before any detail. Note: "preferred
  // switch" is in the spec's priority list but actionPlan currently searches mail channels only, so it
  // is never produced here yet (flagged, not invented).
  // Priority: exception (a gap nothing covers) > mail move (save money) > compare (a gap OTHERS cover)
  // > nothing. `compare` matters: a plan that misses a drug OTHER plans cover is NOT "nothing to
  // change" — saying so would be false reassurance (#13). It's a real gap; the honest step is to
  // compare. ("preferred switch" is in the spec's list but actionPlan searches mail channels only, so
  // it isn't produced yet — flagged, not invented.)
  function nextStep(a, split) {
    if (split && split.nowhere.length) return { kind: 'exception', drugs: split.nowhere };
    if (a.moves.length) return { kind: 'move', saving: a.moveSaving, days: a.moves[0].days, n: a.moves.length, drugs: a.moves };
    if (a.switches.length) return { kind: 'switch', saving: a.switchSaving, n: a.switches.length, drugs: a.switches };
    if (split && split.elsewhere.length) return { kind: 'compare', drugs: split.elsewhere };
    return { kind: 'nothing' };
  }

  // Good news — ONLY computed-true bullets, each traceable to a cell or a check that ran (spec item 5).
  // Returns [] when there's nothing verifiable to say; the caller renders NO section rather than pad
  // one. `fp` is the fairPriceCheck result; `floor` is the same floor it used.
  function goodNewsBullets(plan, a, fp, floorArg) {
    const floor = floorArg == null ? FAIR_PRICE_FLOOR_UNTUNED : floorArg;
    const out = [];
    // per-drug: each covered drug already at its cheapest channel, with the figure she can verify
    for (const k of a.keep) out.push({ kind: 'best-price', rxcui: k.rxcui, label: k.label, annual: k.annual });
    // the deductible skips her covered drugs (only when actually true — the #13 guard lives in the note)
    const ded = deductibleExemptNote(plan);
    if (ded) out.push({ kind: 'deductible', text: ded.text });
    // the comparison check RAN and found nothing cheaper past the floor — stated as what ran, not as a grade
    if (fp && fp.reason === 'below-floor') out.push({ kind: 'compared', floor });
    return out;
  }

  const api = { round, dollars, planDisplayTotal, savingsCopy, planCoverage, planRank, ambiguousPlanIds, planDisplayId, phaseSummary, capPhrase, isMaPd, premiumLabel, yoursLabel, deductibleExemptNote,
    roadOf, isKnownRoad, groupPlans, resultsCountLine, roadsMix, ROAD_NOUN,
    normalizePlanId, isPlanIdShape, isPlanIdPrefix, HEADLINE_BASIS, headlineAnnual,
    inAep, seasonLine, fairPriceCheck, FAIR_PRICE_FLOOR_UNTUNED, actionPlan,
    countyDrugCoverage, exceptionSplit, checkupScorecard, nextStep, goodNewsBullets };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
