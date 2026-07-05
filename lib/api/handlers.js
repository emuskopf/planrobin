'use strict';
// API handlers — a thin, deterministic layer over the Phase 0b typed tools plus the
// RxNorm search. Each returns a plain { status, body, headers? } object so it can run
// unchanged in a Cloudflare Pages Function OR the local Node dev server. NO LLM anywhere.

const { getPlansForCounty } = require('../../tools/get_plans_for_county');
const { getDrugCosts } = require('../../tools/get_drug_costs');
const { projectAnnual, projectChannels, computeChannelSavings, CHANNELS } = require('../../tools/overrides');
const { searchProducts } = require('../rxnorm');

const PLAN_TYPE_LABEL = { MA: 'MA-PD', 'MA-regional': 'MA-PD (regional)', PDP: 'PDP' };
const ANNUAL_FORMULA = 'Estimated annual cost = (monthly premium × 12) + (each covered drug’s 30-day retail copay × 12), initial-coverage phase. Coinsurance drugs cannot be totaled here without a negotiated price and are shown as a % instead.';

// ---- GET /api/counties ---------------------------------------------------
async function countiesHandler(db) {
  const r = await db.query(`select ssa_code, name, state from counties order by name`);
  return { status: 200, body: { state: 'MO', counties: r.rows.map((c) => ({ code: c.ssa_code, name: c.name, state: c.state })) } };
}

// ---- GET /api/meta -------------------------------------------------------
async function metaHandler(db) {
  const r = await db.query(
    `select puf_quarter, finished_at, download_date, row_counts, scope
       from ingest_runs where status='completed' order by id desc limit 1`
  );
  if (r.rows.length === 0) return { status: 200, body: { quarter: null, ingestedAt: null, note: 'no completed ingest run' } };
  const m = r.rows[0];
  return { status: 200, body: { quarter: m.puf_quarter, ingestedAt: m.finished_at, downloadDate: m.download_date, scope: m.scope, rowCounts: m.row_counts, source: 'CMS Prescription Drug Plan Formulary, Pharmacy Network, and Pricing PUF' } };
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
  // Drug names/products change rarely — allow aggressive downstream caching.
  return { status: 200, body, headers: { 'Cache-Control': 'public, max-age=86400' } };
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

  const county_ = await getPlansForCounty(county, db);
  if (!county_.found) return { status: 404, body: { error: 'COUNTY NOT FOUND IN DATA', county } };
  const meta = (await metaHandler(db)).body;

  const plans = [];
  for (const p of county_.plans) {
    const dc = await getDrugCosts(rx, p.planId, db);
    const drugs = {};
    // Per-channel drug models fed to the statutory annual projection (rules 4-5). Standard
    // retail is the anchor (headline); the others drive the pharmacy-channel savings line.
    const drugModelsByChannel = { standardRetail: [], preferredRetail: [], standardMail: [], preferredMail: [] };
    const appliedRules = new Set();  // which overrides fired on this plan
    let notCovered = 0;
    for (const rxcui of rx) {
      const d = (dc.drugs || []).find((x) => x.rxcui === rxcui);
      if (!d || !d.found) { drugs[rxcui] = { covered: false }; notCovered++; continue; }
      const ov = d.overrides || { effectivePerFill: {}, effectivePerFillByChannel: null, applied: [], deductibleApplies: false };
      const fileSr = d.costsByPhase['1'] && d.costsByPhase['1'].byDaysSupply['1'] && d.costsByPhase['1'].byDaysSupply['1'].standardRetail;
      const headline = toHeadline(ov.effectivePerFill['1'] || fileSr); // override-applied
      const fileHeadline = toHeadline(fileSr);                          // file-derived (both kept)
      for (const o of ov.applied) appliedRules.add(o.rule);
      // Per-channel 30-day models for the annual projection (each uses that channel's override-
      // applied per-fill cost). A channel with no cost for this drug -> empty perFill -> the
      // projection marks that channel incomplete (NOT FOUND, never interpolated).
      const byCh = ov.effectivePerFillByChannel || { standardRetail: ov.effectivePerFill };
      for (const ch of CHANNELS) {
        drugModelsByChannel[ch].push({ rxcui, perFill: (byCh[ch] || {}), deductibleApplies: ov.deductibleApplies });
      }
      drugs[rxcui] = {
        covered: true, tier: d.tier, multiTier: d.multiTier,
        flags: { priorAuth: d.flags.priorAuth, stepTherapy: d.flags.stepTherapy, quantityLimit: d.flags.quantityLimit, qlAmount: d.flags.qlAmount, qlDays: d.flags.qlDays },
        headline, fileHeadline, appliedOverrides: ov.applied, isInsulin: ov.isInsulin, isVaccine: ov.isVaccine,
        deductibleApplies: ov.deductibleApplies, phases: d.costsByPhase, ingestRunId: d.drugTierIngestRunId,
      };
    }

    // Rules 4-5, per pharmacy channel (days-supply held at 30-day so we compare ONLY the channel).
    const planYear = dc.planYear || 2026;
    const chProj = projectChannels({ premium: p.premium, deductible: p.deductible, planYear, drugsByChannel: drugModelsByChannel, daysSupply: 1 });
    const proj = chProj.standardRetail; // the anchor == today's headline number (unchanged)
    if (proj.capHit.reached) appliedRules.add('oop_cap_' + proj.oopCap);

    // Sorting-neutral savings line: the biggest honest saving from a cheaper channel, or null.
    const savings = computeChannelSavings(chProj);

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

    plans.push({
      planId: p.planId, planName: p.planName, planType: PLAN_TYPE_LABEL[p.planType] || p.planType,
      premium: p.premium, deductible: p.deductible, snp: p.snp, formularyId: p.formularyId,
      annualPremium: proj.annualPremium, annualDrugs: proj.annualDrugOOP,
      annualEstimate: proj.annualTotal, annualComplete: !proj.incomplete,
      capHit: proj.capHit, oopCap: proj.oopCap, deductibleNote: proj.deductible.note,
      appliedOverrides: [...appliedRules], notCovered, drugs, ingestRunId: p.ingestRunId,
      channels, savings, // pharmacy-channel savings (V1)
    });
  }

  // Sort:
  //  1) fewest not-covered drugs first (covering all your drugs beats missing any; 3/4 beats 1/4);
  //  2) then fully-priced plans before ones with an incomplete total (a coinsurance drug we
  //     can't dollar-total) — so the top of the list is always a real, complete number;
  //  3) then by estimated annual cost ascending.
  plans.sort((a, b) =>
    a.notCovered - b.notCovered ||
    (a.annualComplete ? 0 : 1) - (b.annualComplete ? 0 : 1) ||
    a.annualEstimate - b.annualEstimate);

  return { status: 200, body: { county: county_.county, meta, formula: ANNUAL_FORMULA, planCount: plans.length, plans } };
}

module.exports = { countiesHandler, metaHandler, rxnormSearchHandler, resultsHandler, ANNUAL_FORMULA };
