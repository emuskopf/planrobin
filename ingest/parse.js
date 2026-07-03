'use strict';
// Streaming parser that turns the CMS PUF component files into Missouri-scoped rows
// ready for loading. Nothing is held beyond the MO subset; the big basic-formulary file
// is filtered to MO formularies as it streams.
//
// Missouri scope:
//   - counties: Geographic Locator rows with STATENAME = Missouri (SSA codes + PDP region)
//   - plans:    Local MA (H) plans listing an MO county; PDP (S) plans in an MO PDP region;
//               Regional MA (R) plans in the MO MA-region (15)
//   - formularies / drug_tiers: only formularies referenced by those MO plans
//   - tier_costs: only the MO plans

const fs = require('fs');
const path = require('path');
const { streamRows } = require('../scripts/lib/puf');

const yn = (v) => v === 'Y' || v === '1';
const numOrNull = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const intOrNull = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// Locate a component file in a source dir by substrings (CMS names have double spaces).
function findFile(dir, includes, excludes = []) {
  const inc = includes.map((s) => s.toLowerCase());
  const exc = excludes.map((s) => s.toLowerCase());
  const hit = fs.readdirSync(dir).find((f) => {
    const l = f.toLowerCase();
    return l.endsWith('.txt') && inc.every((s) => l.includes(s)) && exc.every((s) => !l.includes(s));
  });
  if (!hit) throw new Error(`No file matching [${includes.join(', ')}] in ${dir}`);
  return path.join(dir, hit);
}

function resolveFiles(dir) {
  return {
    planInfo: findFile(dir, ['plan information'], ['sample']),
    basicFormulary: findFile(dir, ['basic drugs formulary'], ['sample']),
    beneficiaryCost: findFile(dir, ['beneficiary cost'], ['sample', 'insulin']),
    geoLocator: findFile(dir, ['geographic locator'], ['sample']),
  };
}

async function parseMissouri(sourceDir) {
  const files = resolveFiles(sourceDir);

  // 1) Missouri counties + the regions that define MO service area.
  const counties = [];
  const moCounties = new Set();
  const moPdpRegions = new Set();
  const MO_MA_REGION = '15'; // "Arkansas and Missouri"
  for await (const g of streamRows(files.geoLocator)) {
    if (g.STATENAME.trim().toLowerCase() !== 'missouri') continue;
    const ssa = g.COUNTY_CODE.trim();
    moCounties.add(ssa);
    if (g.PDP_REGION_CODE.trim()) moPdpRegions.add(g.PDP_REGION_CODE.trim());
    counties.push({ ssa_code: ssa, fips_code: null, name: g.COUNTY.trim(), state: g.STATENAME.trim(), pdp_region: g.PDP_REGION_CODE.trim() });
  }

  // 2) MO plans (aggregate the per-county rows), with served MO counties.
  const planMap = new Map(); // key contract|plan|segment
  for await (const r of streamRows(files.planInfo)) {
    const c0 = r.CONTRACT_ID[0];
    const county = r.COUNTY_CODE.trim();
    let serves = false, planType = null;
    if (c0 === 'H') { serves = moCounties.has(county); planType = 'MA'; }
    else if (c0 === 'S') { serves = moPdpRegions.has(r.PDP_REGION_CODE.trim()); planType = 'PDP'; }
    else if (c0 === 'R') { serves = r.MA_REGION_CODE.trim() === MO_MA_REGION; planType = 'MA-regional'; }
    if (!serves) continue;
    const key = `${r.CONTRACT_ID}|${r.PLAN_ID}|${r.SEGMENT_ID}`;
    let p = planMap.get(key);
    if (!p) {
      p = {
        contract_id: r.CONTRACT_ID, plan_id: r.PLAN_ID, segment_id: r.SEGMENT_ID,
        plan_name: r.PLAN_NAME, contract_name: r.CONTRACT_NAME, plan_type: planType,
        snp: r.SNP, premium: numOrNull(r.PREMIUM), deductible: numOrNull(r.DEDUCTIBLE),
        formulary_id: r.FORMULARY_ID, _counties: new Set(), _regionWide: c0 !== 'H',
      };
      planMap.set(key, p);
    }
    if (c0 === 'H' && moCounties.has(county)) p._counties.add(county);
  }

  // Region-wide plans (PDP/Regional MA) serve every MO county in scope.
  for (const p of planMap.values()) {
    if (p._regionWide) for (const c of moCounties) p._counties.add(c);
  }

  const plans = [];
  const planCounties = [];
  const moPlanKeys = new Set();
  const moFormularies = new Set();
  for (const [key, p] of planMap) {
    moPlanKeys.add(key);
    moFormularies.add(p.formulary_id);
    plans.push({
      contract_id: p.contract_id, plan_id: p.plan_id, segment_id: p.segment_id,
      plan_name: p.plan_name, contract_name: p.contract_name, plan_type: p.plan_type,
      snp: p.snp, premium: p.premium, deductible: p.deductible, formulary_id: p.formulary_id,
    });
    for (const ssa of p._counties) planCounties.push({ contract_id: p.contract_id, plan_id: p.plan_id, segment_id: p.segment_id, ssa_code: ssa });
  }

  // 3) drug_tiers for MO formularies (filter the big file as it streams). Capture
  //    contract_year per formulary along the way for the formularies dimension.
  const drugTiers = [];
  const formularyYear = new Map();
  for await (const r of streamRows(files.basicFormulary)) {
    if (!moFormularies.has(r.FORMULARY_ID)) continue;
    if (!formularyYear.has(r.FORMULARY_ID)) formularyYear.set(r.FORMULARY_ID, r.CONTRACT_YEAR);
    drugTiers.push({
      formulary_id: r.FORMULARY_ID, rxcui: r.RXCUI, ndc: r.NDC, tier: intOrNull(r.TIER_LEVEL_VALUE),
      prior_auth: yn(r.PRIOR_AUTHORIZATION_YN), step_therapy: yn(r.STEP_THERAPY_YN),
      quantity_limit: yn(r.QUANTITY_LIMIT_YN), ql_amount: r.QUANTITY_LIMIT_AMOUNT, ql_days: r.QUANTITY_LIMIT_DAYS,
      selected_drug: yn(r.SELECTED_DRUG_YN),
    });
  }
  const formularies = [...moFormularies].map((fid) => ({ formulary_id: fid, contract_year: formularyYear.get(fid) || null }));

  // 4) tier_costs for MO plans.
  const tierCosts = [];
  for await (const r of streamRows(files.beneficiaryCost)) {
    if (!moPlanKeys.has(`${r.CONTRACT_ID}|${r.PLAN_ID}|${r.SEGMENT_ID}`)) continue;
    tierCosts.push({
      contract_id: r.CONTRACT_ID, plan_id: r.PLAN_ID, segment_id: r.SEGMENT_ID,
      coverage_level: intOrNull(r.COVERAGE_LEVEL), tier: intOrNull(r.TIER), days_supply: intOrNull(r.DAYS_SUPPLY),
      cost_type_pref: intOrNull(r.COST_TYPE_PREF), cost_amt_pref: numOrNull(r.COST_AMT_PREF),
      cost_type_nonpref: intOrNull(r.COST_TYPE_NONPREF), cost_amt_nonpref: numOrNull(r.COST_AMT_NONPREF),
      cost_type_mail_pref: intOrNull(r.COST_TYPE_MAIL_PREF), cost_amt_mail_pref: numOrNull(r.COST_AMT_MAIL_PREF),
      cost_type_mail_nonpref: intOrNull(r.COST_TYPE_MAIL_NONPREF), cost_amt_mail_nonpref: numOrNull(r.COST_AMT_MAIL_NONPREF),
      tier_specialty: yn(r.TIER_SPECIALTY_YN), ded_applies: yn(r.DED_APPLIES_YN),
    });
  }

  return { files, counties, plans, planCounties, formularies, drugTiers, tierCosts };
}

module.exports = { parseMissouri, resolveFiles };
