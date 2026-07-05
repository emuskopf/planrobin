'use strict';
// STATUTORY OVERRIDE LAYER — federal law overrides the raw CMS file cost-sharing in specific
// cases. Applied at the CALCULATION layer (get_drug_costs + the annual projection), never in
// display code. Every override keeps BOTH the file-derived and override-applied values and names
// which rule fired (appliedOverrides), so the UI can explain *why* a number changed.
//
// Rules (statutory basis on each function):
//   1. INSULIN $35 CAP            applyPerFillOverrides()   SSA 1860D-2(b)(9) / IRA 11406
//   2. ACIP VACCINE $0            applyPerFillOverrides()   SSA 1860D-2(b)(8) / IRA 11401
//   3. TIER DEDUCTIBLE APPLIES    applyPerFillOverrides()+projectAnnual()  (data: ded_applies per tier)
//   4. DAYS-SUPPLY x CHANNEL      projectAnnual()           (correct fills/year multiplication)
//   5. $2,100 ANNUAL OOP CAP      projectAnnual()           SSA 1860D-2(b)(4) / IRA 11201
//
// DATA LIMITATIONS (documented, not invented): the PUF gives cost-SHARING, not negotiated drug
// prices. So we cannot dollarize coinsurance, nor compute the exact dollars a member pays during
// the deductible phase for copay drugs. We therefore FLAG those cases rather than fabricate them.

const { paramsForYear, VACCINE_RULE } = require('./statutory-params');
const classification = require('./data/classification.json');

const INSULIN = new Set(classification.insulin.rxcuis.map((x) => String(x.rxcui)));
const VACCINE = new Set(classification.vaccines.rxcuis.map((x) => String(x.rxcui)));

const DAYS_MONTHS = { 1: 1, 2: 3, 4: 2 };      // 30-day supply covers 1 month, 90-day 3, 60-day 2
const FILLS_PER_YEAR = { 1: 12, 2: 4, 4: 6 };
const FILL_MONTHS = { 1: [1,2,3,4,5,6,7,8,9,10,11,12], 2: [1,4,7,10], 4: [1,3,5,7,9,11] };

function classify(rxcui) {
  const k = String(rxcui);
  return { isInsulin: INSULIN.has(k), isVaccine: VACCINE.has(k) };
}

// The four pharmacy channels the PUF prices, in the order we present them. Standard retail is
// the anchor (the headline number). Savings, if any, come from one of the other three.
const CHANNELS = ['standardRetail', 'preferredRetail', 'standardMail', 'preferredMail'];

// --- Rules 1-3 (per fill), computed for ONE pharmacy channel -----------------
// fileDerivedByDays: { '1': {kind,dollars,rate}, '2': {...}, '4': {...} } — this channel's
//                    file cost-sharing (initial coverage) per days-supply.
// insulinByDays:     { '1': {copay,coin}, ... } — this channel's insulin cost sharing, or null.
// The override RULES (which one fires) are channel-invariant; only the dollar inputs differ, so
// this returns just the per-fill cost map for the channel.
function channelPerFill({ isInsulin, isVaccine, p, fileDerivedByDays, insulinByDays }) {
  const fileDerived = fileDerivedByDays || {};
  const perFill = {};

  if (isVaccine) {
    // Rule 2 — ACIP adult vaccine: $0 cost-sharing, deductible-exempt.
    for (const d of ['1', '2', '4']) if (fileDerived[d]) perFill[d] = { kind: 'copay', dollars: 0, rate: null, source: 'override' };
    return perFill;
  }

  if (isInsulin) {
    // Rule 1 — covered insulin: min($35/30-day, plan insulin cost), deductible waived.
    for (const d of ['1', '2', '4']) {
      if (!fileDerived[d] && !(insulinByDays && insulinByDays[d])) continue;
      const capDollars = p.insulinMonthlyCap * (DAYS_MONTHS[d] || 1);
      const ins = insulinByDays && insulinByDays[d];
      let planCost = null, isCoin = false;
      if (ins && ins.copay != null) planCost = ins.copay;                 // plan's insulin copay
      else if (ins && ins.coin != null) { isCoin = true; planCost = null; } // coinsurance: dollars unknown
      else if (fileDerived[d] && fileDerived[d].kind === 'copay') planCost = fileDerived[d].dollars; // fallback to tier copay
      else if (fileDerived[d] && fileDerived[d].kind === 'coinsurance') { isCoin = true; planCost = null; }

      let dollars, capped, note;
      if (planCost != null) { dollars = Math.min(capDollars, planCost); capped = planCost > capDollars; note = capped ? `capped at $${capDollars} by federal insulin law` : 'plan insulin cost (already at/below the $35/mo cap)'; }
      else { dollars = capDollars; capped = true; note = `coinsurance capped at the $${capDollars} federal insulin ceiling (exact amount needs drug price)`; isCoin && (note += '; shown as the legal maximum'); }
      perFill[d] = { kind: 'copay', dollars, rate: null, capped, source: 'override', note };
    }
    return perFill;
  }

  // No product override: effective == file-derived; deductible handled by projectAnnual (Rule 3).
  for (const d of ['1', '2', '4']) if (fileDerived[d]) perFill[d] = { ...fileDerived[d], source: 'file' };
  return perFill;
}

// --- Rules 1-3 (per fill) -------------------------------------------------
// inputs:
//   rxcui, tier, dedAppliesTier (bool from tier_costs.ded_applies), planYear
//   standardRetailByDays: { '1': {kind,dollars,rate}, ... }  (file-derived, initial coverage, standard retail)
//   insulinByDays:        { '1': {copay,coin}, ... }  (standard-retail insulin cost sharing; null if none)
//   channelsByDays:       { standardRetail:{...}, preferredRetail:{...}, standardMail:{...}, preferredMail:{...} }
//                         each a per-days file cost map (optional — enables per-channel output)
//   insulinByChannelDays: same shape, per-channel insulin cost sharing (optional)
// returns a per-drug cost model with BOTH the file-derived and override-applied values,
// appliedOverrides, and (when channel data is supplied) perFillByChannel for all four channels.
function applyPerFillOverrides({ rxcui, tier, dedAppliesTier, planYear, standardRetailByDays, insulinByDays, channelsByDays, insulinByChannelDays }) {
  const p = paramsForYear(planYear);
  const { isInsulin, isVaccine } = classify(rxcui);
  const fileDerived = standardRetailByDays || {};
  const applied = [];

  // Standard-retail per-fill (the anchor; unchanged behavior, pinned by the unit tests).
  const perFill = channelPerFill({ isInsulin, isVaccine, p, fileDerivedByDays: fileDerived, insulinByDays });

  // A statutory override waives the deductible; otherwise it applies per the tier's data (Rule 3).
  const deductibleApplies = isInsulin || isVaccine ? false : !!dedAppliesTier;
  if (isVaccine) applied.push({ rule: 'acip_vaccine_free', statute: VACCINE_RULE.statute, note: 'ACIP-recommended adult vaccine — $0 under Part D by federal law' });
  if (isInsulin) applied.push({ rule: 'insulin_cap_35', statute: 'SSA 1860D-2(b)(9) / IRA 11406', note: `covered insulin capped at $${p.insulinMonthlyCap}/30-day supply; deductible waived` });

  const out = { rxcui: String(rxcui), tier, isInsulin, isVaccine, appliedOverrides: applied, deductibleApplies, perFill, fileDerived };

  // Per-channel per-fill: same rules, each channel's own file dollars. Standard retail is
  // recomputed here too so perFillByChannel.standardRetail === perFill (kept in lockstep).
  if (channelsByDays) {
    const perFillByChannel = {}, fileDerivedByChannel = {};
    for (const ch of CHANNELS) {
      const cd = channelsByDays[ch];
      if (!cd) { perFillByChannel[ch] = null; fileDerivedByChannel[ch] = null; continue; }
      perFillByChannel[ch] = channelPerFill({ isInsulin, isVaccine, p, fileDerivedByDays: cd,
        insulinByDays: insulinByChannelDays && insulinByChannelDays[ch] });
      fileDerivedByChannel[ch] = cd;
    }
    out.perFillByChannel = perFillByChannel;
    out.fileDerivedByChannel = fileDerivedByChannel;
  }
  return out;
}

// --- Rules 4-5 (annual projection) ----------------------------------------
// drugs: [{ rxcui, perFill: {<days>: {kind,dollars,rate}}, deductibleApplies }]
// Accrues member out-of-pocket month by month for the chosen days-supply, stops accruing covered-
// drug cost at the annual OOP cap (Rule 5), and multiplies by the correct fills/year (Rule 4).
function projectAnnual({ premium, deductible, planYear, drugs, daysSupply }) {
  const p = paramsForYear(planYear);
  const cap = p.oopCapAnnual;
  const d = String(daysSupply);
  const fillMonths = FILL_MONTHS[d] || FILL_MONTHS['1'];
  const applied = ['oop_cap_2100'];

  // Per-drug monthly-fill cost (copay only; coinsurance can't be dollarized -> incomplete).
  let incomplete = false;
  const anyDeductibleDrug = drugs.some((x) => x.deductibleApplies) && (deductible || 0) > 0;
  const perFillCost = drugs.map((x) => {
    const c = x.perFill && x.perFill[d];
    if (!c) return { unknown: true };
    if (c.kind === 'copay') return { dollars: c.dollars };
    incomplete = true; // coinsurance / not offered
    return { unknown: true, coinsurance: c.kind === 'coinsurance', rate: c.rate };
  });

  // Month-by-month accrual to the cap.
  let cumulative = 0, capHitMonth = null;
  const monthly = [];
  for (let m = 1; m <= 12; m++) {
    let oop = 0;
    if (fillMonths.includes(m)) {
      for (const pf of perFillCost) if (!pf.unknown) oop += pf.dollars;
    }
    if (capHitMonth) oop = 0;                 // catastrophic: $0 covered-drug cost after the cap
    else if (cumulative + oop >= cap) { oop = Math.max(0, cap - cumulative); capHitMonth = m; }
    cumulative += oop;
    monthly.push({ month: m, oop: Number(oop.toFixed(2)), cumulative: Number(cumulative.toFixed(2)), phase: capHitMonth && m >= capHitMonth ? 'catastrophic' : 'initial' });
  }

  const annualPremium = Number(((premium || 0) * 12).toFixed(2));
  const annualDrugOOP = Number(cumulative.toFixed(2));
  return {
    planYear, oopCap: cap, daysSupply: Number(daysSupply), fillsPerYear: FILLS_PER_YEAR[d],
    annualPremium,                                  // NOT part of the OOP cap; continues all year
    annualDrugOOP,
    annualTotal: Number((annualPremium + annualDrugOOP).toFixed(2)),
    capHit: { reached: capHitMonth != null, month: capHitMonth },
    // Rule 3 transparency: the PUF has no drug prices, so we flag deductible-applicable tiers and
    // the plan deductible rather than fabricating a deductible-phase dollar amount.
    deductible: { amount: deductible || 0, appliesToAnyDrug: anyDeductibleDrug,
      note: anyDeductibleDrug ? 'A deductible applies to at least one of your drugs; this estimate uses initial-coverage cost sharing and does not add the deductible dollar amount (the PUF provides cost sharing, not drug prices).' : 'No deductible applies to these drugs’ tiers.' },
    incomplete,                                     // true if a coinsurance drug could not be dollar-totaled
    appliedOverrides: applied,
    monthly,
  };
}

// --- Pharmacy-channel savings (V1) ----------------------------------------
// Project the annual cost separately for each pharmacy channel, holding days-supply constant
// at the anchor (so we compare ONLY the channel, never quietly assume a days-supply change),
// then report the single biggest honest saving vs. standard retail — or nothing.
//
// Channel-level only: this compares "standard retail" vs "preferred retail / mail" as the PUF
// prices them. It does NOT name specific pharmacies (that's the Pharmacy Network file, later).

const SAVINGS_MIN = 25; // below this annual saving we stay quiet (don't cry "opportunity" over $3)
const CHANNEL_COPY = {
  preferredRetail: { label: 'preferred pharmacy', phrase: 'by using one of its preferred pharmacies' },
  standardMail:    { label: 'mail order',         phrase: 'by using mail order' },
  preferredMail:   { label: 'preferred mail order', phrase: 'by using the plan’s preferred mail-order pharmacy' },
};

// Round a saving to a calm, non-false-precision figure: nearest $10 at/above $100, else nearest $5.
function roundSavings(x) { return x >= 100 ? Math.round(x / 10) * 10 : Math.round(x / 5) * 5; }

// drugsByChannel: { standardRetail:[{rxcui,perFill,deductibleApplies}], preferredRetail:[...], ... }
// A channel with no data (null) projects to null — never interpolated.
function projectChannels({ premium, deductible, planYear, drugsByChannel, daysSupply }) {
  const out = {};
  for (const ch of CHANNELS) {
    out[ch] = drugsByChannel && drugsByChannel[ch]
      ? projectAnnual({ premium, deductible, planYear, drugs: drugsByChannel[ch], daysSupply })
      : null;
  }
  return out;
}

// Given per-channel projections, return the best honest saving vs. standard retail, or null.
// Rules: the anchor must be a complete dollar total; a candidate channel must also be complete
// (a coinsurance/not-offered channel can't be totaled -> skipped, NOT treated as $0); and the
// saving must clear the minimum threshold. If nothing qualifies, return null (show nothing —
// never "$0 savings").
function computeChannelSavings(channelProjections, opts = {}) {
  const minSavings = opts.minSavings == null ? SAVINGS_MIN : opts.minSavings;
  const base = channelProjections && channelProjections.standardRetail;
  if (!base || base.incomplete) return null; // no complete anchor -> can't compare honestly
  let best = null;
  for (const ch of ['preferredRetail', 'standardMail', 'preferredMail']) {
    const proj = channelProjections[ch];
    if (!proj || proj.incomplete) continue;                 // absent or un-totalable -> skip
    const raw = Number((base.annualTotal - proj.annualTotal).toFixed(2));
    if (raw < minSavings) continue;                         // trivial (or none) -> stay quiet
    if (!best || raw > best.amount) best = { channel: ch, amount: raw, channelTotal: proj.annualTotal };
  }
  if (!best) return null;
  const copy = CHANNEL_COPY[best.channel];
  return {
    channel: best.channel, channelLabel: copy.label, phrase: copy.phrase,
    amount: best.amount, displayAmount: roundSavings(best.amount),
    vsChannel: 'standardRetail', anchorTotal: base.annualTotal, channelTotal: best.channelTotal,
  };
}

module.exports = {
  classify, applyPerFillOverrides, projectAnnual, projectChannels, computeChannelSavings,
  roundSavings, CHANNELS, SAVINGS_MIN, INSULIN, VACCINE, DAYS_MONTHS, FILLS_PER_YEAR,
};
