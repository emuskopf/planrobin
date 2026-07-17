// SINGLE SOURCE OF TRUTH for the printed sheets. Pure — no DOM, no PDF library. Turns the results
// data + the user's drug list into an ordered list of content `items`; the on-screen print DOM AND
// the downloadable PDF both render from THIS, so layout may differ but the words and numbers cannot.
// Loaded in the browser (window.PRPassport) and require()-d by tests. All money/coverage/id/savings
// strings go through PRFormat, so the passport can't diverge from the on-screen results either.
//
// TWO SHEETS, ONE DISCIPLINE:
//   passportModel(...) — the comparison (every plan, ranked). The first door's artifact.
//   checkupModel(...)  — the 5-Minute Checkup (her plan + what to do about it). The second door's.
// They share the plan card, the caveats and the reopen page, so a fix to any of those reaches both.
//
// `checkupCopy` holds every SENTENCE the checkup says. The on-screen report (checkup.js) renders from
// these same builders — so the sheet in her hand and the page she read it on cannot word a thing
// differently. That's the point: the printed action plan IS the product's thesis, and a paper that
// disagreed with the screen would break it.
(function (global) {
  'use strict';
  const PRFormat = (typeof require !== 'undefined') ? require('./format.js') : global.PRFormat;

  // Standard PDF fonts (Helvetica) encode WinAnsi (Latin-1 + the CP1252 specials). Normalize the few
  // characters outside it — mainly "≈" — so the ONE model can't crash the PDF, and so the print DOM,
  // the PDF, and the parity contract all read exactly the same characters.
  const WINSAFE_EXTRA = '‘’“”–—•…';
  const pdfSafe = (s) => String(s).replace(/≈/g, '~').replace(/→/g, '->').split('').map((ch) => (ch.codePointAt(0) <= 0xff || WINSAFE_EXTRA.includes(ch)) ? ch : '?').join('');
  function sanitizeItems(items) {
    for (const it of items) {
      for (const k of ['text', 'name', 'total', 'premium', 'sub', 'partial', 'savings']) if (it[k]) it[k] = pdfSafe(it[k]);
      if (it.drugs) it.drugs = it.drugs.map((row) => row.map(pdfSafe));
    }
    return items;
  }

  const money = (n) => '$' + Number(n || 0).toFixed(2);
  const FREQ = { 30: '1 a day', 60: '2 a day', 90: '3 a day', 1: '1 a month' };
  const qtyLabel = (q) => FREQ[q] || (q + '/fill');
  // A federal-law override → a plain badge (same mapping as the results view).
  const LAW_BADGE = { insulin_cap_35: 'capped by federal law', acip_vaccine_free: 'free by federal law' };
  const SAVINGS_LOC = { preferredRetail: "this plan's preferred pharmacies", standardMail: "this plan's mail-order pharmacy", preferredMail: "this plan's preferred mail-order pharmacy" };

  // Per-drug [label, tier+flags, cost] rows for one plan — the same wording the print DOM used.
  function planDrugRows(p, drugs) {
    const rows = [];
    for (const [rxcui, meta] of drugs) {
      const res = p.drugs[rxcui];
      let tier = '', cost;
      if (!res || !res.covered) cost = 'Not covered — you’d pay full price';
      else {
        const fl = [res.flags.priorAuth && 'PA', res.flags.stepTherapy && 'ST', res.flags.quantityLimit && 'QL'].filter(Boolean).join(' ');
        tier = 'Tier ' + res.tier + (fl ? ' ' + fl : '');
        // A price never ships without its basis — same shared constant the screen uses, so the
        // printed sheet, the PDF, and the results page state the same "per what supply".
        const B = PRFormat.HEADLINE_BASIS;
        if (res.headline.kind === 'copay') cost = money(res.headline.dollars) + ' ' + B.perLabel;
        else if (res.estimated) cost = res.headline.display + ' ' + B.ofEachLabel + ' ≈ ' + PRFormat.dollars(res.estimated.annual) + '/yr';
        else cost = res.headline.display + ' ' + B.ofEachLabel;
        const rule = (res.appliedOverrides || [])[0];
        if (rule && LAW_BADGE[rule.rule]) cost += ' — ' + LAW_BADGE[rule.rule];
      }
      rows.push([meta.label, tier, cost]);
    }
    return rows;
  }

  // One plan card, shared by both sheets. `opts.premiumProminent` gives the premium its own line
  // (the checkup: the first thing a real reader asked out loud was "how much is this a month?") and
  // takes it out of the meta sub-line, so the figure is never printed twice.
  function planItem(p, drugs, ambig, opts) {
    opts = opts || {};
    const cov = PRFormat.planCoverage(p);
    const total = cov.covered === 0
      ? (cov.total === 1 ? 'Doesn’t cover your medication' : 'Doesn’t cover any of your medications')
      : PRFormat.dollars(PRFormat.planDisplayTotal(p)) + '/yr' + (cov.complete ? (p.annualComplete ? '' : ' so far') : ` · for ${cov.covered} of ${cov.total}`);
    const id = PRFormat.planDisplayId(p, ambig);
    const prem = `${PRFormat.premiumLabel(p.planType)} ${money(p.premium || 0)}/mo`;
    const item = {
      type: 'plan', name: p.planName, total,
      sub: opts.premiumProminent
        ? `${p.planType} · ${id} · deductible ${money(p.deductible || 0)}`
        : `${p.planType} · ${id} · ${prem} · deductible ${money(p.deductible || 0)}`,
      noCover: cov.covered === 0, partialFlag: !cov.complete && cov.covered > 0,
      drugs: planDrugRows(p, drugs),
    };
    // Same label rule as everywhere else: an MA-PD figure is the drug-coverage portion, not the whole
    // premium (planrobin-premium-semantics). Prominence never buys it a shorter, less honest label.
    if (opts.premiumProminent) item.premium = `${money(p.premium || 0)}/mo ${PRFormat.premiumLabel(p.planType)}`;
    if (!cov.complete && cov.covered > 0) {
      const names = cov.missing.map((rx) => { const e = drugs.find(([r]) => r === rx); return (e && e[1] && e[1].label) || rx; }).join(', ');
      item.partial = `Doesn't cover: ${names} — full price out of pocket, and not counted toward the ${PRFormat.dollars(p.oopCap || 2100)} cap.`;
    }
    if (p.savings) { const c = PRFormat.savingsCopy(p, SAVINGS_LOC[p.savings.channel] || "this plan's preferred pharmacies"); item.savings = 'Save about ' + c.amount + c.tail; }
    return item;
  }

  // The "Before you decide" caveats, shared by both sheets. `printed` is the plans actually ON the
  // sheet — every conditional below keys off that, so no sheet carries a note it doesn't need.
  function caveatTexts(printed, meta, asOf) {
    const out = [
      `Costs are estimates from public CMS files (as of CMS ${meta.quarter || ''}, loaded ${asOf}). Your actual cost can differ with pharmacy, days-supply, deductible status, and coverage phase.`,
      'Educational tool — not advice, and not an enrollment. PlanRobin does not sell insurance or enroll you in coverage.',
      'A private website — not affiliated with the federal Medicare program or any insurance company.',
    ];
    // Both roads on one printed sheet: the on-screen divider isn't on paper, so the sheet has to carry
    // the consequence itself. Conditional — a one-road sheet says nothing it doesn't need to.
    if (PRFormat.roadsMix(printed)) {
      out.push('The plans above are two different kinds, and they are not interchangeable. A drug-only plan (PDP) works alongside Original Medicare; an all-in-one Medicare Advantage plan replaces it. Joining a drug-only plan while you have a Medicare Advantage plan would end that plan and return you to Original Medicare — medical coverage included. A few rare plan types work differently. Ask a SHIP counselor before you switch.');
    }
    // Only when an MA-PD is actually printed: the premium shown is the Part D drug-coverage portion,
    // not the plan's full premium. Conditional so a PDP-only sheet carries no note it doesn't need.
    if (printed.some((p) => PRFormat.isMaPd(p.planType))) {
      out.push("Medicare Advantage plans may also have a separate medical premium not shown here — the premiums printed are the drug-coverage portion, which is what matters for comparing drug costs. Confirm a plan's full premium on Medicare.gov or with a SHIP counselor.");
    }
    out.push(
      'Confirm any plan on Medicare.gov, or by calling 1-800-MEDICARE (1-800-633-4227), before enrolling.',
      'Free, unbiased help: your State Health Insurance Assistance Program (SHIP) — find a counselor at shiphelp.org.',
    );
    return out;
  }

  // The reopen page — identical on both sheets. Three senior-first ways back in. Icons are decorative
  // (DOM shows the emoji, the PDF shows a plain marker) so they're NOT part of the parity strings —
  // the sentences are what must match. `noun` only names the thing she's reopening.
  function reopenItems(noun, shareUrl) {
    return [
      // `reopen-h` is STRUCTURAL, not just a heading: it opens the two-column block the QR sits beside.
      // It is deliberately NOT `h3` — a plain sub-heading (the action plan uses several) must never
      // open a share column, or everything after it ends up nested inside one.
      { type: 'reopen-h', text: `Reopen this ${noun}` },
      { type: 'note', text: 'To see this search again — with the newest plan data — pick whichever is easiest for you:' },
      { type: 'path', icon: '📷', text: 'Use your phone’s camera. Open the camera as if you’re taking a picture, and point it at the square code below. You don’t need any special app. A link will pop up on the screen — tap it, and this exact search opens.' },
      { type: 'path', icon: '📝', text: 'Or simply re-add your medications from the list on page 1. The search box helps as you type — it takes about a minute.' },
      { type: 'path', icon: '🔗', text: 'Or tap the link below. If you’re reading this on a phone or computer, tap the web address and this exact search opens.' },
      { type: 'url', text: shareUrl || '', link: shareUrl || '' },
      { type: 'qr', url: shareUrl || '' },
    ];
  }

  const asOfOf = (meta) => meta.ingestedAt ? new Date(meta.ingestedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown date';
  function filenameFor(kind) {
    const dt = new Date();
    return `planrobin-${kind}-${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}.pdf`;
  }

  // Build the model. `drugs` is an array of [rxcui, {label, qty}] (state.drugs entries). Pure: the
  // same inputs always yield the same items, whoever renders them.
  function passportModel(data, drugs, opts) {
    opts = opts || {};
    const meta = data.meta || {};
    const asOf = asOfOf(meta);
    const nDrugs = drugs.length;
    const ambig = PRFormat.ambiguousPlanIds(data.plans);
    const complete = data.plans.filter((p) => p.notCovered === 0);
    const partial = data.plans.filter((p) => p.notCovered > 0);
    const top = (complete.length >= 3 ? complete : [...complete, ...partial]).slice(0, 5);

    const items = [];
    items.push({ type: 'brand', text: 'PlanRobin — Medicare drug plan comparison' });
    items.push({ type: 'asof', text: `Data: CMS ${meta.quarter || ''}, loaded ${asOf}` });
    items.push({ type: 'kv', text: `County: ${data.county.name}, ${data.county.state}` });
    items.push({ type: 'label', text: 'Medications (30-day fills):' });
    for (const [, d] of drugs) items.push({ type: 'med', text: `${d.label} — ${qtyLabel(d.qty)}` });
    items.push({ type: 'coverage', text: complete.length
      ? `${complete.length} of ${data.planCount} plans cover ${nDrugs === 1 ? 'your medication' : `all ${nDrugs} of your medications`}. The plans below are ranked by yearly cost among those. A plan that skips one of your drugs would leave you paying full price for it, so it isn’t shown as a top plan even if it looks cheaper.`
      : `No plan in ${data.county.name} covers every medication on your list. The plans below cover the most, ranked by yearly cost; each plan flags what it misses.` });
    items.push({ type: 'h', text: complete.length ? `Top ${top.length} plans that cover all your medications, by yearly cost` : `Top ${top.length} plans by coverage, then yearly cost`, page1Heading: true });

    for (const p of top) items.push(planItem(p, drugs, ambig));

    items.push({ type: 'h', text: 'Before you decide', pageBreak: true });
    for (const c of caveatTexts(top, meta, asOf)) items.push({ type: 'caveat', text: c });
    for (const it of reopenItems('comparison', opts.shareUrl)) items.push(it);

    sanitizeItems(items); // WinAnsi-safe strings shared by the DOM + PDF (no divergence, no crash)
    return { items, filename: filenameFor('comparison'), shareUrl: opts.shareUrl || '' };
  }

  // ---- THE CHECKUP ------------------------------------------------------------------------------
  // Every sentence the checkup says, in one place. checkup.js (screen) and checkupModel (paper) both
  // call these — so there is exactly ONE wording of the do-nothing verdict, the mail-order script and
  // the baseline caveat, and no future edit can change one without changing the other.
  const DAYS_WORD = { '1': '30-day', '2': '90-day' };
  const nameList = (arr) => arr.map((x) => x.label).join(', ');
  // Named once: the action section points at this section by name, so a rename can't strand the pointer.
  const FAIR_HEADING = 'Worth knowing';

  const checkupCopy = {
    planHeading: (source) => PRFormat.yoursLabel(source),
    actionHeading: 'What you can do about it',
    // The do-nothing verdict is a designed ANSWER, not an empty section: she came for a decision and
    // "nothing to change" is one. It says we checked, because the checking is the value.
    doNothing: 'Good news — the way you’re filling now is already the cheapest option on your plan. We checked.',
    doNothingKeep: (a) => a.keep.length ? `Keep filling ${nameList(a.keep)} where you do — already your best price.` : null,
    // Her plan doesn't cover something she takes. There is no pharmacy price to improve on a drug the
    // plan won't pay for, so the pharmacy verdict is beside the point — and "you're already on the
    // cheapest option" would be a lie of omission. Name it, then hand off to the section that deals
    // with it. This line OUTRANKS the good-news verdict; it is never printed alongside it.
    actionNotCovered: (a) => `${nameList(a.notCovered)} ${a.notCovered.length === 1 ? 'isn’t' : 'aren’t'} covered by your plan, so there’s no pharmacy price for ${a.notCovered.length === 1 ? 'it' : 'them'} to improve — see “${FAIR_HEADING}” below.`,
    moveHead: (a) => {
      const n = a.moves.length;
      const verb = a.baseline.where === 'mail'
        ? `Switch ${n === 1 ? 'this one' : 'these ' + n} to ${DAYS_WORD[a.moves[0].days]} fills by mail`
        : `Send ${n === 1 ? 'this one' : 'these ' + n} to mail order`;
      return `${verb} — saving about ${PRFormat.dollars(a.saving)}/yr`;
    },
    moveLine: (m) => `${m.label} — ${PRFormat.dollars(m.current)}/yr now, about ${PRFormat.dollars(m.to)}/yr as a ${DAYS_WORD[m.days]} fill by mail. Saving about ${PRFormat.dollars(m.saving)}/yr.`,
    // A recommendation without its action is incomplete (CONTENT-RULES 16) — so the words to say are
    // part of the recommendation, not a footnote.
    howHead: 'How to do it, in one call:',
    script: 'Call the number on the back of your insurance card and say: “I’d like to move my prescriptions to your mail-order pharmacy.” They’ll ask for your medication names and your doctor’s name, and they do the rest.',
    // Small, reversible, losing nothing (CONTENT-RULES 15).
    reassure: 'This is a split, not a switch: you keep the same plan and the same pharmacy for anything else — your pharmacist stays yours. You can change back at any time.',
    keepHead: 'Keep filling these where you do',
    keepBody: (a) => `${nameList(a.keep)} — already your best price on this plan.`,
    // Never modelled: say plainly what we can't compare and why (rule 6 + trade-off honesty).
    cant: (a) => `We can’t compare pharmacies for ${nameList(a.cant)} — ${a.cant.length === 1 ? 'it’s' : 'they’re'} priced as coinsurance, which depends on the drug’s price and how much you take. Your plan’s member line can quote it.`,
    // The baseline we measured from — including the assumption that could make a saving too big.
    baseline: (a) => `Measured against ${DAYS_WORD[a.baseline.days]} fills ${a.baseline.where === 'mail' ? 'by mail' : 'at a local pharmacy'}`
      + (a.baselineAssumed
        ? ' at a standard (non-preferred) pharmacy. If yours is one of your plan’s preferred pharmacies you may already pay less than we’ve shown, which would make the saving smaller.'
        : '.'),
    fairHeading: FAIR_HEADING,
    fairNotCoveredLead: (fp, labels) => `Your plan doesn’t cover ${labels} — you’d pay full price for ${fp.yourCoverage.missing.length === 1 ? 'it' : 'them'}, and it wouldn’t count toward your yearly out-of-pocket cap.`,
    // n === 0: no plan on her road covers everything either. That's a fact worth stating plainly —
    // it stops her hunting for a plan that doesn't exist — and it's why this sentence is a builder
    // and not a template with a number jammed in it ("0 other plans cover everything" reads as a bug).
    fairNotCoveredOthers: (fp) => fp.n === 0
      ? `No other ${PRFormat.ROAD_NOUN[fp.road] || ''} plan in your county covers everything on your list either — so switching plans wouldn’t fix this by itself.`
      : `${fp.n} other ${PRFormat.ROAD_NOUN[fp.road] || ''} ${fp.n === 1 ? 'plan' : 'plans'} in your county ${fp.n === 1 ? 'covers' : 'cover'} everything on your list${fp.atLeast ? `, and at least one for about ${PRFormat.dollars(fp.atLeast)} less per year` : ''}.`,
    // What to do when no plan covers it: the answer is a person, not a plan switch. (Ask about a
    // formulary exception; a SHIP counselor is free.) Only printed when there's nowhere to switch to.
    fairNoWhereToSwitch: 'Your plan can be asked for a “formulary exception” — your doctor explains why you need this exact drug. A SHIP counselor can walk you through it, free; the number is below.',
    fairCheaper: (fp) => `${fp.n} other ${PRFormat.ROAD_NOUN[fp.road] || ''} ${fp.n === 1 ? 'plan' : 'plans'} in your county would cover these same medications for at least ${PRFormat.dollars(fp.atLeast)} less per year.`,
    // Disclosure, not alarm: staying put is explicitly a good choice, and we name what we don't check.
    fairStayPut: 'If you’re happy with your plan’s doctors, staying put and using the steps above is a perfectly good choice — cheaper plans may not include your doctors, and this checkup doesn’t check networks.',
    // Paper can't be tapped, so the sheet prints the address the screen puts behind a link.
    fairComparePaper: (season) => 'If you’d like to compare, the full list of plans in your county is at planrobin.com.' + (season ? ` (${season}.)` : ''),
    perksHeading: 'Your plan may include benefits nobody reminded you about',
    perksLead: 'Dental, vision, over-the-counter allowances, gym memberships — many plans include them, and they’re real money. We don’t have benefits data, so we won’t guess at yours. Here’s how to find out in one call:',
    perksAsk: 'Call the number on the back of your card and ask:',
    perksQuestions: [
      '“What extra benefits does my plan include this year?”',
      '“Do I have an over-the-counter allowance — and how do I use it?”',
      '“Is there anything in my plan I haven’t used this year?”',
    ],
    perksPointerPaper: 'It’s also in your plan’s Annual Notice of Change (ANOC) or Evidence of Coverage (EOC) — the booklet it mails you — and on your plan’s page at Medicare.gov. A SHIP counselor can read it with you, free.',
  };

  // The checkup's sheet. Page 1 is her plan and what to do about it; page 2 is the same reopen page
  // the comparison prints. Pure, like the comparison model: `now` and the meta window come IN (the
  // season verdict is computed on HER clock, never baked into a cached artifact).
  // Returns null when we don't know which plan is hers — the screen shows the picker instead, and a
  // sheet about nobody's plan is worse than no sheet.
  function checkupModel(data, drugs, opts) {
    opts = opts || {};
    const meta = data.meta || {};
    const asOf = asOfOf(meta);
    const group = PRFormat.groupPlans(data.plans, { road: opts.road, planId: opts.planId });
    const you = group.yourPlan;
    if (!you) return null;
    const ambig = PRFormat.ambiguousPlanIds(data.plans);
    const labelOf = (rx) => { const e = drugs.find(([r]) => r === rx); return (e && e[1] && e[1].label) || rx; };

    const items = [];
    items.push({ type: 'brand', text: 'PlanRobin — your 5-Minute Medicare Checkup' });
    items.push({ type: 'asof', text: `Data: CMS ${meta.quarter || ''}, loaded ${asOf}` });
    items.push({ type: 'kv', text: `County: ${data.county.name}, ${data.county.state}` });
    items.push({ type: 'label', text: 'Medications (30-day fills):' });
    for (const [, d] of drugs) items.push({ type: 'med', text: `${d.label} — ${qtyLabel(d.qty)}` });

    // 1 — her plan, premium given the prominence a real reader asked for out loud.
    items.push({ type: 'h', text: checkupCopy.planHeading(opts.planIdSource), page1Heading: true });
    items.push(planItem(you, drugs, ambig, { premiumProminent: true }));

    // 2 — the action plan, grouped by ACTION with the words to say.
    const a = PRFormat.actionPlan(you, drugs, opts.fill);
    items.push({ type: 'h', text: checkupCopy.actionHeading });
    // A gap outranks a verdict about pharmacies: she hears about the drug her plan won't pay for
    // BEFORE she hears that her pharmacy choice is fine.
    if (a.notCovered.length) items.push({ type: 'verdict', kind: 'warn', text: checkupCopy.actionNotCovered(a) });
    if (a.allClear) {
      items.push({ type: 'verdict', kind: 'good', text: checkupCopy.doNothing });
      const k = checkupCopy.doNothingKeep(a);
      if (k) items.push({ type: 'note', text: k });
    } else {
      if (a.moves.length) {
        items.push({ type: 'h3', text: checkupCopy.moveHead(a) });
        for (const m of a.moves) items.push({ type: 'bullet', text: checkupCopy.moveLine(m) });
        items.push({ type: 'strong', text: checkupCopy.howHead });
        items.push({ type: 'script', text: checkupCopy.script });
        items.push({ type: 'note', text: checkupCopy.reassure });
      }
      if (a.keep.length) {
        items.push({ type: 'h3', text: checkupCopy.keepHead });
        items.push({ type: 'note', text: checkupCopy.keepBody(a) });
      }
      if (a.cant.length) items.push({ type: 'fine', text: checkupCopy.cant(a) });
    }
    // The baseline note explains a measurement — so it only prints when something was measured.
    if (a.moves.length || a.keep.length) items.push({ type: 'fine', text: checkupCopy.baseline(a) });

    // 3 — the fair-price check. Silence is a designed outcome: nothing prints when it doesn't fire.
    const fp = PRFormat.fairPriceCheck(group);
    if (fp.fires) {
      items.push({ type: 'h', text: checkupCopy.fairHeading });
      if (fp.reason === 'not-covered') {
        items.push({ type: 'verdict', kind: 'warn', text: checkupCopy.fairNotCoveredLead(fp, fp.yourCoverage.missing.map(labelOf).join(', ')) });
        items.push({ type: 'note', text: checkupCopy.fairNotCoveredOthers(fp) });
      } else {
        items.push({ type: 'note', text: checkupCopy.fairCheaper(fp) });
      }
      // "Staying put is a perfectly good choice" only makes sense when there's somewhere to go. With
      // no alternative that covers everything, the honest next step is a person, not a plan switch.
      if (fp.n > 0) {
        items.push({ type: 'note', text: checkupCopy.fairStayPut });
        items.push({ type: 'note', text: checkupCopy.fairComparePaper(PRFormat.seasonLine(opts.meta, opts.now || new Date())) });
      } else {
        items.push({ type: 'note', text: checkupCopy.fairNoWhereToSwitch });
      }
      // (No SHIP line here — the "Before you decide" caveats on page 2 already carry it.)
    }

    // 4 — perks, only when she told us she doesn't know. Script + pointers; never a priced perk.
    if (opts.perks === 'no' || opts.perks === 'unsure') {
      items.push({ type: 'h', text: checkupCopy.perksHeading });
      items.push({ type: 'note', text: checkupCopy.perksLead });
      items.push({ type: 'strong', text: checkupCopy.perksAsk });
      for (const q of checkupCopy.perksQuestions) items.push({ type: 'script', text: q });
      items.push({ type: 'fine', text: checkupCopy.perksPointerPaper });
    }

    // Page 2 — one plan on this sheet, so caveatTexts prints the MA-PD note only if HER plan is MA-PD,
    // and never the two-roads note (nothing to confuse it with).
    items.push({ type: 'h', text: 'Before you decide', pageBreak: true });
    for (const c of caveatTexts([you], meta, asOf)) items.push({ type: 'caveat', text: c });
    for (const it of reopenItems('checkup', opts.shareUrl)) items.push(it);

    sanitizeItems(items);
    return { items, filename: filenameFor('checkup'), shareUrl: opts.shareUrl || '' };
  }

  // The ordered flat list of every user-visible string. Parity contract: the print DOM's text and the
  // PDF's text must both equal this exactly.
  function passportStrings(model) {
    const out = [];
    for (const it of model.items) {
      if (it.type === 'qr') continue;
      if (it.type === 'path') { out.push(it.text); continue; } // the sentence (not the decorative icon)
      if (it.type === 'plan') {
        // Order matches both renderers exactly: name, total, [premium], sub, …
        out.push(it.name, it.total);
        if (it.premium) out.push(it.premium);
        out.push(it.sub);
        if (it.partial) out.push(it.partial);
        if (it.savings) out.push(it.savings);
        for (const row of it.drugs) for (const cell of row) if (cell) out.push(cell);
      } else if (it.text) out.push(it.text);
    }
    return out;
  }

  const api = { passportModel, checkupModel, passportStrings, checkupCopy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRPassport = api;
})(typeof window !== 'undefined' ? window : globalThis);
