// SINGLE SOURCE OF TRUTH for the Plan Passport. Pure — no DOM, no PDF library. Turns the results
// data + the user's drug list into an ordered list of content `items`; the on-screen print DOM AND
// the downloadable PDF both render from THIS, so layout may differ but the words and numbers cannot.
// Loaded in the browser (window.PRPassport) and require()-d by tests. All money/coverage/id/savings
// strings go through PRFormat, so the passport can't diverge from the on-screen results either.
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
      for (const k of ['text', 'name', 'total', 'sub', 'partial', 'savings']) if (it[k]) it[k] = pdfSafe(it[k]);
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
        if (res.headline.kind === 'copay') cost = money(res.headline.dollars) + '/fill';
        else if (res.estimated) cost = res.headline.display + ' ≈ ' + PRFormat.dollars(res.estimated.annual) + '/yr';
        else cost = res.headline.display;
        const rule = (res.appliedOverrides || [])[0];
        if (rule && LAW_BADGE[rule.rule]) cost += ' — ' + LAW_BADGE[rule.rule];
      }
      rows.push([meta.label, tier, cost]);
    }
    return rows;
  }

  // Build the model. `drugs` is an array of [rxcui, {label, qty}] (state.drugs entries). Pure: the
  // same inputs always yield the same items, whoever renders them.
  function passportModel(data, drugs, opts) {
    opts = opts || {};
    const meta = data.meta || {};
    const asOf = meta.ingestedAt ? new Date(meta.ingestedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown date';
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

    for (const p of top) {
      const cov = PRFormat.planCoverage(p);
      const total = cov.covered === 0
        ? (cov.total === 1 ? 'Doesn’t cover your medication' : 'Doesn’t cover any of your medications')
        : PRFormat.dollars(PRFormat.planDisplayTotal(p)) + '/yr' + (cov.complete ? (p.annualComplete ? '' : ' so far') : ` · for ${cov.covered} of ${cov.total}`);
      const item = {
        type: 'plan', name: p.planName, total,
        sub: `${p.planType} · ${PRFormat.planDisplayId(p, ambig)} · premium ${money(p.premium || 0)}/mo · deductible ${money(p.deductible || 0)}`,
        noCover: cov.covered === 0, partialFlag: !cov.complete && cov.covered > 0,
        drugs: planDrugRows(p, drugs),
      };
      if (!cov.complete && cov.covered > 0) {
        const names = cov.missing.map((rx) => { const e = drugs.find(([r]) => r === rx); return (e && e[1] && e[1].label) || rx; }).join(', ');
        item.partial = `Doesn't cover: ${names} — full price out of pocket, and not counted toward the ${PRFormat.dollars(p.oopCap || 2100)} cap.`;
      }
      if (p.savings) { const c = PRFormat.savingsCopy(p, SAVINGS_LOC[p.savings.channel] || "this plan's preferred pharmacies"); item.savings = 'Save about ' + c.amount + c.tail; }
      items.push(item);
    }

    items.push({ type: 'h', text: 'Before you decide', pageBreak: true });
    for (const c of [
      `Costs are estimates from public CMS files (as of CMS ${meta.quarter || ''}, loaded ${asOf}). Your actual cost can differ with pharmacy, days-supply, deductible status, and coverage phase.`,
      'Educational tool — not advice, and not an enrollment. PlanRobin does not sell insurance or enroll you in coverage.',
      'A private website — not affiliated with the federal Medicare program or any insurance company.',
      'Confirm any plan on Medicare.gov, or by calling 1-800-MEDICARE (1-800-633-4227), before enrolling.',
      'Free, unbiased help: your State Health Insurance Assistance Program (SHIP) — find a counselor at shiphelp.org.',
    ]) items.push({ type: 'caveat', text: c });
    // Three senior-first ways back in. Icons are decorative (DOM shows the emoji, the PDF shows a
    // plain marker) so they're NOT part of the parity strings — the sentences are what must match.
    items.push({ type: 'h3', text: 'Reopen this comparison' });
    items.push({ type: 'note', text: 'To see this search again — with the newest plan data — pick whichever is easiest for you:' });
    items.push({ type: 'path', icon: '📷', text: 'Use your phone’s camera. Open the camera as if you’re taking a picture, and point it at the square code below. You don’t need any special app. A link will pop up on the screen — tap it, and this exact search opens.' });
    items.push({ type: 'path', icon: '📝', text: 'Or simply re-add your medications from the list on page 1. The search box helps as you type — it takes about a minute.' });
    items.push({ type: 'path', icon: '🔗', text: 'Or tap the link below. If you’re reading this on a phone or computer, tap the web address and this exact search opens.' });
    items.push({ type: 'url', text: opts.shareUrl || '', link: opts.shareUrl || '' });
    items.push({ type: 'qr', url: opts.shareUrl || '' });

    sanitizeItems(items); // WinAnsi-safe strings shared by the DOM + PDF (no divergence, no crash)
    const dt = new Date();
    const filename = `planrobin-comparison-${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}.pdf`;
    return { items, filename, shareUrl: opts.shareUrl || '' };
  }

  // The ordered flat list of every user-visible string. Parity contract: the print DOM's text and the
  // PDF's text must both equal this exactly.
  function passportStrings(model) {
    const out = [];
    for (const it of model.items) {
      if (it.type === 'qr') continue;
      if (it.type === 'path') { out.push(it.text); continue; } // the sentence (not the decorative icon)
      if (it.type === 'plan') {
        out.push(it.name, it.total, it.sub);
        if (it.partial) out.push(it.partial);
        if (it.savings) out.push(it.savings);
        for (const row of it.drugs) for (const cell of row) if (cell) out.push(cell);
      } else if (it.text) out.push(it.text);
    }
    return out;
  }

  const api = { passportModel, passportStrings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRPassport = api;
})(typeof window !== 'undefined' ? window : globalThis);
