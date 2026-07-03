'use strict';
// API handlers — a thin, deterministic layer over the Phase 0b typed tools plus the
// RxNorm search. Each returns a plain { status, body, headers? } object so it can run
// unchanged in a Cloudflare Pages Function OR the local Node dev server. NO LLM anywhere.

const { getPlansForCounty } = require('../../tools/get_plans_for_county');
const { getDrugCosts } = require('../../tools/get_drug_costs');
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
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return { status: 200, body: { query: q, results: [] } };
  if (cache && cache.has(q)) return { status: 200, body: cache.get(q), headers: { 'x-cache': 'hit' } };
  const body = await searchProducts(q, fetchImpl);
  if (cache) cache.set(q, body);
  // Drug names/products change rarely — allow aggressive downstream caching.
  return { status: 200, body, headers: { 'Cache-Control': 'public, max-age=86400' } };
}

// ---- POST /api/results  { county, rxcuis:[] } ----------------------------
function headlineOf(drug) {
  // 30-day (days_supply=1), initial coverage (level 1), standard retail.
  const e = drug.costsByPhase && drug.costsByPhase['1'] && drug.costsByPhase['1'].byDaysSupply['1'];
  const sr = e && e.standardRetail;
  if (!sr) return { kind: 'unknown', display: 'no 30-day retail cost on file', dollars: null, rate: null };
  if (sr.kind === 'copay') return { kind: 'copay', dollars: sr.dollars, rate: null, display: `$${sr.dollars.toFixed(2)}` };
  if (sr.kind === 'coinsurance') return { kind: 'coinsurance', dollars: null, rate: sr.rate, display: `${Math.round(sr.rate * 100)}% coinsurance` };
  return { kind: 'not_offered', dollars: null, rate: null, display: 'standard retail not offered' };
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
    let annualDrugs = 0, annualComplete = true, notCovered = 0;
    for (const rxcui of rx) {
      const d = (dc.drugs || []).find((x) => x.rxcui === rxcui);
      if (!d || !d.found) {
        drugs[rxcui] = { covered: false };
        notCovered++; annualComplete = false;
        continue;
      }
      const headline = headlineOf(d);
      if (headline.kind === 'copay') annualDrugs += headline.dollars * 12;
      else annualComplete = false; // coinsurance/unknown can't be totaled
      drugs[rxcui] = {
        covered: true, tier: d.tier, multiTier: d.multiTier,
        flags: { priorAuth: d.flags.priorAuth, stepTherapy: d.flags.stepTherapy, quantityLimit: d.flags.quantityLimit, qlAmount: d.flags.qlAmount, qlDays: d.flags.qlDays },
        headline, phases: d.costsByPhase, ingestRunId: d.drugTierIngestRunId,
      };
    }
    const annualPremium = (p.premium || 0) * 12;
    plans.push({
      planId: p.planId, planName: p.planName, planType: PLAN_TYPE_LABEL[p.planType] || p.planType,
      premium: p.premium, deductible: p.deductible, snp: p.snp, formularyId: p.formularyId,
      annualPremium, annualDrugs, annualEstimate: annualPremium + annualDrugs, annualComplete,
      notCovered, drugs, ingestRunId: p.ingestRunId,
    });
  }

  // Sort: plans covering all your drugs first, then by estimated annual cost ascending.
  plans.sort((a, b) => (a.notCovered > 0) - (b.notCovered > 0) || a.annualEstimate - b.annualEstimate);

  return { status: 200, body: { county: county_.county, meta, formula: ANNUAL_FORMULA, planCount: plans.length, plans } };
}

module.exports = { countiesHandler, metaHandler, rxnormSearchHandler, resultsHandler, ANNUAL_FORMULA };
