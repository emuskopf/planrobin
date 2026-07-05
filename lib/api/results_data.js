'use strict';
// BATCHED results data fetch — replaces the old per-plan N+1 (getPlansForCounty + metaHandler +
// getDrugCosts-per-plan, ~1200 round trips for a 4-drug × 82-plan search) with a fixed 3 queries,
// independent of plans × drugs:
//   Q1  plans in county + formulary year + provenance (county via CTE, meta via lateral)
//   Q2  drug_tiers for all (formulary, rxcui)
//   Q3  tier_costs + drug_prices + insulin_costs in ONE round trip (UNION ALL of jsonb rows)
// The per-plan shaping reuses tools/get_drug_costs buildPlanResult, so output is byte-identical.

const { buildPlanResult } = require('../../tools/get_drug_costs');
const { INSULIN } = require('../../tools/overrides');

// jsonb comes back as an object on pg/pglite; tolerate a string just in case.
const asRow = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const groupBy = (rows, keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); (m.get(k) || m.set(k, []).get(k)).push(r); } return m; };

function shapeCounty(c) {
  return { ssaCode: c.ssa_code, fipsCode: c.fips_code, name: c.name, state: c.state, pdpRegion: c.pdp_region };
}
function shapeMeta(m) {
  if (!m) return { quarter: null, ingestedAt: null, note: 'no completed ingest run' };
  return {
    quarter: m.puf_quarter, ingestedAt: m.finished_at, downloadDate: m.download_date, scope: m.scope,
    rowCounts: m.row_counts, source: 'CMS Prescription Drug Plan Formulary, Pharmacy Network, and Pricing PUF',
  };
}
function shapePlan(r) {
  return {
    planId: `${r.contract_id}-${r.plan_id}`, contractId: r.contract_id, planId3: r.plan_id, segmentId: r.segment_id,
    planName: r.plan_name, contractName: r.contract_name, planType: r.plan_type, snp: r.snp,
    premium: r.premium == null ? null : Number(r.premium), deductible: r.deductible == null ? null : Number(r.deductible),
    formularyId: r.formulary_id, planYear: parseInt(r.contract_year, 10) || 2026, starRating: null, ingestRunId: r.ingest_run_id,
  };
}

async function fetchResultsData(countyKey, rxcuis, db) {
  const key = String(countyKey).trim();
  const rx = rxcuis.map((x) => String(x));

  // Q1 — plans in the county, with formulary year + provenance folded in.
  const q1 = await db.query(
    `with cty as (
       select ssa_code, fips_code, name, state, pdp_region from counties
        where ssa_code=$1 or fips_code=$1 or lower(name)=lower($1) limit 1)
     select p.contract_id, p.plan_id, p.segment_id, p.plan_name, p.contract_name, p.plan_type,
            p.snp, p.premium, p.deductible, p.formulary_id, p.ingest_run_id, f.contract_year,
            c.ssa_code c_ssa, c.fips_code c_fips, c.name c_name, c.state c_state, c.pdp_region c_pdp,
            r.puf_quarter, r.finished_at, r.download_date, r.scope, r.row_counts
       from cty c
       join plan_counties pc on pc.ssa_code = c.ssa_code
       join plans p on p.contract_id=pc.contract_id and p.plan_id=pc.plan_id and p.segment_id=pc.segment_id
       left join formularies f on f.formulary_id=p.formulary_id
       left join lateral (select puf_quarter, finished_at, download_date, scope, row_counts
                            from ingest_runs where status='completed' order by id desc limit 1) r on true
      order by p.plan_type, p.contract_id, p.plan_id, p.segment_id`,
    [key]
  );

  if (q1.rows.length === 0) {
    // 0 rows = county-not-found OR a (rare) county with no plans — one cheap disambiguating check.
    const cc = await db.query(
      `select ssa_code, fips_code, name, state, pdp_region from counties
        where ssa_code=$1 or fips_code=$1 or lower(name)=lower($1) limit 1`, [key]);
    if (cc.rows.length === 0) return { found: false, county: null, meta: null, plans: [], costsByPlan: {} };
    const meta = (await db.query(`select puf_quarter, finished_at, download_date, scope, row_counts from ingest_runs where status='completed' order by id desc limit 1`)).rows[0];
    return { found: true, county: shapeCounty(cc.rows[0]), meta: shapeMeta(meta), plans: [], costsByPlan: {} };
  }

  const first = q1.rows[0];
  const county = shapeCounty({ ssa_code: first.c_ssa, fips_code: first.c_fips, name: first.c_name, state: first.c_state, pdp_region: first.c_pdp });
  const meta = shapeMeta(first);
  const plans = q1.rows.map(shapePlan);

  // Q2 — drug_tiers for every (plan formulary, requested rxcui).
  const formularies = [...new Set(plans.map((p) => p.formularyId).filter(Boolean))];
  let drugTiersByFormulary = new Map(), ndcs = [];
  if (formularies.length && rx.length) {
    const fPh = formularies.map((_, i) => `$${i + 1}`).join(',');
    const rPh = rx.map((_, i) => `$${formularies.length + i + 1}`).join(',');
    const dt = await db.query(
      `select formulary_id, rxcui, ndc, tier, prior_auth, step_therapy, quantity_limit, ql_amount, ql_days, selected_drug, ingest_run_id
         from drug_tiers where formulary_id in (${fPh}) and rxcui in (${rPh})`,
      [...formularies, ...rx]
    );
    drugTiersByFormulary = groupBy(dt.rows, (r) => String(r.formulary_id));
    ndcs = [...new Set(dt.rows.map((r) => r.ndc).filter(Boolean))];
  }

  // Q3 — tier_costs + drug_prices + insulin_costs for these plans in ONE round trip.
  const tcByPlan = new Map(), dpByPlan = new Map(), icByPlan = new Map();
  {
    const keyVals = [], keyParams = [];
    plans.forEach((p, i) => {
      const b = i * 3, cast = i === 0 ? '::text' : '';
      keyVals.push(`($${b + 1}${cast},$${b + 2}${cast},$${b + 3}${cast})`);
      keyParams.push(p.contractId, p.planId3, p.segmentId);
    });
    const ndcPh = ndcs.map((_, i) => `$${keyParams.length + i + 1}`).join(',');
    const hasInsulin = rx.some((r) => INSULIN.has(String(r)));
    const branches = ["select 'tc' src, to_jsonb(t) jrow from tier_costs t join keys k on t.contract_id=k.c and t.plan_id=k.p and t.segment_id=k.s"];
    if (ndcs.length) branches.push(`select 'dp' src, to_jsonb(d) jrow from drug_prices d join keys k on d.contract_id=k.c and d.plan_id=k.p and d.segment_id=k.s where d.ndc in (${ndcPh}) and d.days_supply in (30,90)`);
    if (hasInsulin) branches.push("select 'ic' src, to_jsonb(i) jrow from insulin_costs i join keys k on i.contract_id=k.c and i.plan_id=k.p and i.segment_id=k.s");
    const sql = `with keys(c,p,s) as (values ${keyVals.join(',')}) ${branches.join(' union all ')}`;
    const params = ndcs.length ? [...keyParams, ...ndcs] : keyParams;
    const combined = await db.query(sql, params);
    for (const row of combined.rows) {
      const r = asRow(row.jrow); const k = `${r.contract_id}|${r.plan_id}|${r.segment_id}`;
      const m = row.src === 'tc' ? tcByPlan : row.src === 'dp' ? dpByPlan : icByPlan;
      (m.get(k) || m.set(k, []).get(k)).push(r);
    }
  }

  const costsByPlan = {};
  for (const p of plans) {
    const k = `${p.contractId}|${p.planId3}|${p.segmentId}`;
    const planInfo = { planId: p.planId, contractId: p.contractId, planId3: p.planId3, segmentId: p.segmentId, planName: p.planName, formularyId: p.formularyId, ingestRunId: p.ingestRunId };
    costsByPlan[p.planId] = buildPlanResult({
      planInfo, planYear: p.planYear, rxcuis: rx,
      drugTierRows: drugTiersByFormulary.get(String(p.formularyId)) || [],
      tierCostRows: tcByPlan.get(k) || [], priceRows: dpByPlan.get(k) || [], insulinRows: icByPlan.get(k) || [],
    });
  }

  return { found: true, county, meta, plans, costsByPlan };
}

module.exports = { fetchResultsData };
