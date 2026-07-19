'use strict';
// API handlers — a thin, deterministic layer over the Phase 0b typed tools plus the
// RxNorm search. Each returns a plain { status, body, headers? } object so it can run
// unchanged in a Cloudflare Pages Function OR the local Node dev server. NO LLM anywhere.

const { fetchResultsData } = require('./results_data');
const { resolveZip } = require('../../tools/resolve_zip');
const { projectAnnual, projectChannels, computeChannelSavings, CHANNELS } = require('../../tools/overrides');
const { paramsForYear, ENROLLMENT } = require('../../tools/overrides/statutory-params'); // the SAME source the math uses
const { searchProducts } = require('../rxnorm');
const PRFormat = require('../../site/format.js'); // shared coverage/rank definition (also used by the UI)

const PLAN_TYPE_LABEL = { MA: 'MA-PD', 'MA-regional': 'MA-PD (regional)', PDP: 'PDP' };
const DEFAULT_QTY = 30; // units per 30-day fill (once-daily) when the user hasn't specified
const round2 = (x) => Math.round(x * 100) / 100;
const ANNUAL_FORMULA = 'Estimated annual cost = (monthly premium × 12) + each covered drug’s yearly cost sharing (30-day fills, initial-coverage phase), stopping at the annual out-of-pocket cap. Copays are exact; coinsurance is estimated as your rate × the plan’s negotiated unit price × the quantity you entered — so it’s only as accurate as that quantity. A coinsurance drug with no published price stays out of the total.';

// ---- GET /api/counties ---------------------------------------------------
async function countiesHandler(db) {
  const r = await db.query(`select ssa_code, name, state from counties order by name`);
  return { status: 200, body: { state: 'MO', counties: r.rows.map((c) => ({ code: c.ssa_code, name: c.name, state: c.state })) } };
}

// ---- GET /api/zip?zip=63011 ----------------------------------------------
// Resolve a ZIP to its Missouri county/counties (likeliest first). Quarterly data -> cache hard.
async function zipHandler(db, zip) {
  const r = await resolveZip(zip, db);
  if (r.status === 'invalid') return { status: 400, body: { status: 'invalid', message: 'Enter a 5-digit ZIP code.' } };
  return { status: 200, body: r };
}

// ---- GET /api/meta -------------------------------------------------------
async function metaHandler(db) {
  const r = await db.query(
    `select puf_quarter, finished_at, download_date, row_counts, scope
       from ingest_runs where status='completed' order by id desc limit 1`
  );
  if (r.rows.length === 0) return { status: 200, body: { quarter: null, ingestedAt: null, note: 'no completed ingest run' } };
  const m = r.rows[0];
  // Plan year comes from the ingest quarter ("2026-Q1" → 2026) — the same year the cost engine uses;
  // expose the statutory OOP cap from the SAME parameter so explainer prose can't drift from the math.
  const planYear = parseInt(m.puf_quarter, 10) || null;
  let oopCapAnnual = null;
  if (planYear) { try { oopCapAnnual = paramsForYear(planYear).oopCapAnnual; } catch { /* year not in table → omit, never guess */ } }
  // `enrollment` is the verified AEP window; the client does the "is it open today?" comparison
  // against its own clock (this response is edge-cached, so a precomputed boolean would go stale
  // across the October 15 boundary — the WINDOW is cacheable, the verdict is not).
  return { status: 200, body: { quarter: m.puf_quarter, ingestedAt: m.finished_at, downloadDate: m.download_date, scope: m.scope, rowCounts: m.row_counts, planYear, oopCapAnnual, enrollment: ENROLLMENT, source: 'CMS Prescription Drug Plan Formulary, Pharmacy Network, and Pricing PUF' } };
}

// ---- GET /api/rxnorm/search?q= -------------------------------------------
async function rxnormSearchHandler(query, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const cache = deps.cache; // optional Map-like
  const db = deps.db;       // optional — used to flag products no plan covers
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return { status: 200, body: { query: q, results: [] } };
  if (cache && cache.has(q)) return { status: 200, body: cache.get(q), headers: { 'x-cache': 'hit' } };

  const body = await searchProducts(q, fetchImpl);

  // Annotate each candidate with whether ANY loaded (Missouri) formulary covers it, so the
  // UI can flag specialized products (e.g. "Sprinkle …") that no plan lists — and sort them
  // last. Best-effort: if the DB is unavailable, results are simply left unannotated.
  if (db && body.results.length) {
    try {
      const rxcuis = body.results.map((r) => r.rxcui);
      // Explicit placeholder list ($1,$2,…) rather than = any($1::text[]) — array-param
      // serialization differs across drivers (postgres.js vs pglite); this works on all.
      const ph = rxcuis.map((_, i) => `$${i + 1}`).join(',');
      const cov = await db.query(`select distinct rxcui from drug_tiers where rxcui in (${ph})`, rxcuis);
      const covered = new Set(cov.rows.map((r) => String(r.rxcui)));
      for (const r of body.results) r.onFormulary = covered.has(r.rxcui);
      // On-formulary first, then generics before brands, then by name.
      body.results.sort((a, b) => (b.onFormulary ? 1 : 0) - (a.onFormulary ? 1 : 0) || (a.isBrand - b.isBrand) || a.name.localeCompare(b.name));
    } catch (_) { /* leave unannotated */ }
  }

  if (cache) cache.set(q, body);
  // Drug names/products change rarely (a slow-moving vocabulary) — cache for a week at the edge,
  // and serve stale-while-revalidate for another week so a warm result is essentially always ready.
  return { status: 200, body, headers: { 'Cache-Control': 'public, max-age=604800, stale-while-revalidate=604800' } };
}

// ---- POST /api/results  { county, rxcuis:[] } ----------------------------
// Render a 30-day standard-retail per-fill cost object into a display headline.
function toHeadline(sr) {
  if (!sr) return { kind: 'unknown', display: 'no 30-day retail cost on file', dollars: null, rate: null };
  if (sr.kind === 'copay') return { kind: 'copay', dollars: Number(sr.dollars), rate: null, display: `$${Number(sr.dollars).toFixed(2)}` };
  if (sr.kind === 'coinsurance') return { kind: 'coinsurance', dollars: null, rate: sr.rate, display: `${Math.round(sr.rate * 100)}% coinsurance` };
  return { kind: sr.kind || 'not_offered', dollars: null, rate: null, display: 'standard retail not offered' };
}

async function resultsHandler(db, body) {
  const county = body && body.county;
  const rxcuis = (body && body.rxcuis) || [];
  if (!county) return { status: 400, body: { error: 'county is required' } };
  if (!Array.isArray(rxcuis) || rxcuis.length < 1 || rxcuis.length > 10) {
    return { status: 400, body: { error: 'rxcuis must be an array of 1–10 items' } };
  }
  const rx = rxcuis.map((x) => String(x));

  // Per-drug quantity (units per 30-day fill) supplied by the user — this is the ONLY honest way
  // to dollarize coinsurance (the file gives price-per-unit, not per-fill; the dose is the user's).
  // Default DEFAULT_QTY (once-daily). Copay/insulin/vaccine drugs ignore it (their cost is flat).
  const quantities = (body && body.quantities) || {};
  const qtyFor = (rxcui) => {
    const q = Number(quantities[rxcui]);
    return Number.isFinite(q) && q > 0 && q <= 1000 ? q : DEFAULT_QTY;
  };

  // ONE batched fetch (3 round trips, independent of plans×drugs) instead of the old per-plan N+1.
  const data = await fetchResultsData(county, rx, db);
  if (!data.found) return { status: 404, body: { error: 'COUNTY NOT FOUND IN DATA', county } };
  const meta = data.meta;

  const plans = [];
  for (const p of data.plans) {
    const dc = data.costsByPlan[p.planId];
    const drugs = {};
    // Per-channel drug models fed to the statutory annual projection (rules 4-5). Standard
    // retail is the anchor (headline); the others drive the pharmacy-channel savings line.
    const drugModelsByChannel = { standardRetail: [], preferredRetail: [], standardMail: [], preferredMail: [] };
    const appliedRules = new Set();  // which overrides fired on this plan
    let notCovered = 0;
    const notCoveredRx = [];       // drugs not on this plan's formulary (loud, by name, never $0)
    const coinsEstRx = [];         // coinsurance drugs dollarized from the user's quantity
    const coinsNoPriceRx = [];     // coinsurance drugs with NO negotiated price (still un-totalable)
    for (const rxcui of rx) {
      const d = (dc.drugs || []).find((x) => x.rxcui === rxcui);
      if (!d || !d.found) { drugs[rxcui] = { covered: false }; notCovered++; notCoveredRx.push(rxcui); continue; }
      const ov = d.overrides || { effectivePerFill: {}, effectivePerFillByChannel: null, applied: [], deductibleApplies: false };
      const fileSr = d.costsByPhase['1'] && d.costsByPhase['1'].byDaysSupply['1'] && d.costsByPhase['1'].byDaysSupply['1'].standardRetail;
      const headline = toHeadline(ov.effectivePerFill['1'] || fileSr); // override-applied
      const fileHeadline = toHeadline(fileSr);                          // file-derived (both kept)
      for (const o of ov.applied) appliedRules.add(o.rule);

      // Coinsurance dollarization: member pays rate × negotiated unit price × quantity per fill.
      // The unit price is the file's in-area retail price (one number, not per-channel); each
      // channel applies its OWN coinsurance rate to it. Only when we have a price — else the drug
      // stays coinsurance (un-totalable) and the plan is flagged incomplete. The dose is the user's.
      const qty = qtyFor(rxcui);
      const unit30 = d.negotiatedPrice && d.negotiatedPrice.unitCostByDays && d.negotiatedPrice.unitCostByDays['30'];
      const byCh = ov.effectivePerFillByChannel || { standardRetail: ov.effectivePerFill, preferredRetail: null, standardMail: null, preferredMail: null };
      let estimated = null;
      for (const ch of CHANNELS) {
        let pf = byCh[ch] ? { ...byCh[ch] } : {};
        const c1 = pf['1'];
        if (c1 && c1.kind === 'coinsurance' && unit30 != null) {
          const dollars = round2(c1.rate * unit30 * qty);
          pf = { ...pf, '1': { kind: 'copay', dollars, rate: c1.rate, source: 'coinsurance_estimated', unitCost: unit30, quantity: qty } };
          if (ch === 'standardRetail') estimated = { perFill: dollars, annual: round2(dollars * 12), rate: c1.rate, unitCost: unit30, quantity: qty };
        }
        drugModelsByChannel[ch].push({ rxcui, perFill: pf, deductibleApplies: ov.deductibleApplies });
      }

      const isCoins = d.costBasis === 'coinsurance_per_unit' || d.costBasis === 'coinsurance_no_price';
      const costBasis = estimated ? 'coinsurance_estimated' : d.costBasis;
      if (estimated) coinsEstRx.push(rxcui);
      else if (isCoins) coinsNoPriceRx.push(rxcui);

      drugs[rxcui] = {
        covered: true, tier: d.tier, multiTier: d.multiTier,
        flags: { priorAuth: d.flags.priorAuth, stepTherapy: d.flags.stepTherapy, quantityLimit: d.flags.quantityLimit, qlAmount: d.flags.qlAmount, qlDays: d.flags.qlDays },
        headline, fileHeadline, appliedOverrides: ov.applied, isInsulin: ov.isInsulin, isVaccine: ov.isVaccine,
        deductibleApplies: ov.deductibleApplies, phases: d.costsByPhase, ingestRunId: d.drugTierIngestRunId,
        // Pricing file: the plan's negotiated per-unit price, the cost basis, and (for coinsurance
        // with a price + quantity) the dollarized estimate.
        costBasis, negotiatedPrice: d.negotiatedPrice, quantity: qty, estimated,
      };
    }

    // Rules 4-5, per pharmacy channel (days-supply held at 30-day so we compare ONLY the channel).
    const planYear = dc.planYear || 2026;
    const chProj = projectChannels({ premium: p.premium, deductible: p.deductible, planYear, drugsByChannel: drugModelsByChannel, daysSupply: 1 });
    const proj = chProj.standardRetail; // the anchor == today's headline number (unchanged)
    if (proj.capHit.reached) appliedRules.add('oop_cap_' + proj.oopCap);

    // Savings line only for plans that cover ALL your drugs — a partial plan isn't a comparable
    // choice, so it must not advertise a saving as if it were.
    const savings = notCovered === 0 ? computeChannelSavings(chProj) : null;

    // Compact, provenance-carrying per-channel summary for the API (each number traces to the
    // same tier_costs ingest_run already surfaced on each drug; overrides applied identically).
    const channels = {};
    for (const ch of CHANNELS) {
      const cp = chProj[ch];
      channels[ch] = cp ? {
        annualPremium: cp.annualPremium, annualDrugs: cp.annualDrugOOP, annualEstimate: cp.annualTotal,
        annualComplete: !cp.incomplete, capHit: cp.capHit,
      } : null;
    }

    // Itemized, honest breakdown (Half 2). Component sums are PRE-CAP annual costs (copays vs
    // coinsurance estimated from the user's quantity); the total is premium + the CAPPED drug OOP
    // (from the projection, which stops accruing at the $2,000 cap). When the cap binds, the total
    // is lower than the components add up to — surfaced with the cap milestone + a note. A
    // coinsurance drug with no price stays un-totalable and flags the plan incomplete. Not-covered
    // drugs are listed loudly and never contribute $0.
    let copayAnnual = 0, coinsuranceEstAnnual = 0;
    for (const m of drugModelsByChannel.standardRetail) {
      const c = m.perFill && m.perFill['1'];
      if (!c || c.kind !== 'copay') continue;
      const yearly = c.dollars * 12;
      if (c.source === 'coinsurance_estimated') coinsuranceEstAnnual += yearly; else copayAnnual += yearly;
    }
    copayAnnual = round2(copayAnnual); coinsuranceEstAnnual = round2(coinsuranceEstAnnual);
    const capBinds = proj.capHit.reached && round2(proj.annualDrugOOP) < round2(copayAnnual + coinsuranceEstAnnual) - 0.01;
    const breakdown = {
      premiumAnnual: proj.annualPremium,
      copayAnnual,                                    // flat copays (+ insulin/vaccine overrides)
      coinsuranceEstAnnual,                           // coinsurance dollarized from the user's dose
      coinsuranceEstRxcuis: coinsEstRx,               // labeled "estimated from your quantity"
      coinsuranceNoPriceRxcuis: coinsNoPriceRx,       // no price -> still un-totalable
      notCoveredRxcuis: notCoveredRx,                 // loud, listed by name, excluded from total
      cappedDrugOOP: round2(proj.annualDrugOOP),      // drug OOP after the $2,000 cap
      capBinds,                                       // total < components because the cap stops accrual
      total: proj.annualTotal,                        // premium + capped drug OOP
      hasUnpriceable: coinsNoPriceRx.length > 0,
      capHit: proj.capHit, oopCap: proj.oopCap,
      // Deductible exemption: plan has a deductible, but every covered drug is on a tier the
      // deductible skips (so we're not omitting it — it genuinely doesn't apply here).
      deductibleAmount: p.deductible || 0,
      deductibleExempt: (p.deductible || 0) > 0 && !proj.deductible.appliesToAnyDrug && (rx.length - notCovered) > 0,
    };

    plans.push({
      planId: p.planId, segmentId: p.segmentId, planName: p.planName, planType: PLAN_TYPE_LABEL[p.planType] || p.planType,
      premium: p.premium, deductible: p.deductible, snp: p.snp, formularyId: p.formularyId,
      annualPremium: proj.annualPremium, annualDrugs: proj.annualDrugOOP,
      annualEstimate: proj.annualTotal, annualComplete: !proj.incomplete,
      capHit: proj.capHit, oopCap: proj.oopCap, deductibleNote: proj.deductible.note,
      appliedOverrides: [...appliedRules], notCovered, drugs, ingestRunId: p.ingestRunId,
      channels, savings, breakdown, // pharmacy-channel savings (V1) + itemized breakdown (Half 2)
    });
  }

  // Partitioned rank (shared PRFormat.planRank): plans covering ALL your drugs come first (a
  // partial plan can never outrank a complete one, regardless of price), then fully-priced before
  // incomplete, then by estimated annual cost. The UI draws a divider at the complete→partial break.
  plans.sort(PRFormat.planRank);

  return { status: 200, body: { county: data.county, meta, formula: ANNUAL_FORMULA, planCount: plans.length, plans } };
}

module.exports = { countiesHandler, zipHandler, metaHandler, rxnormSearchHandler, resultsHandler, ANNUAL_FORMULA };
