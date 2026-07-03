'use strict';
// TYPED TOOL — get_plans_for_county(countyKey, db)
//
// Pure SQL, no LLM. Returns all Missouri-scoped plans available in a county, with
// premium, plan type, a star-rating placeholder (not in this PUF), and formulary_id.
// Returns structured objects, not strings. Every row carries its ingest_run id.
//
// countyKey resolves against, in order: SSA state/county code, FIPS code (nullable in
// this dataset — see README), or county name. The task's nominal signature is
// get_plans_for_county(county_fips); since CMS ships SSA codes (not FIPS), the parameter
// is generalized and documented rather than faking a FIPS crosswalk.

async function getPlansForCounty(countyKey, db) {
  const key = String(countyKey).trim();
  const cRes = await db.query(
    `select ssa_code, fips_code, name, state, pdp_region from counties
       where ssa_code=$1 or fips_code=$1 or lower(name)=lower($1) limit 1`,
    [key]
  );
  if (cRes.rows.length === 0) {
    return { found: false, reason: 'COUNTY NOT FOUND IN DATA', countyKey: key, county: null, plans: [] };
  }
  const county = cRes.rows[0];

  const pRes = await db.query(
    `select p.contract_id, p.plan_id, p.segment_id, p.plan_name, p.contract_name, p.plan_type,
            p.snp, p.premium, p.deductible, p.formulary_id, p.ingest_run_id
       from plans p
       join plan_counties pc
         on pc.contract_id=p.contract_id and pc.plan_id=p.plan_id and pc.segment_id=p.segment_id
      where pc.ssa_code=$1
      order by p.plan_type, p.contract_id, p.plan_id, p.segment_id`,
    [county.ssa_code]
  );

  const plans = pRes.rows.map((r) => ({
    planId: `${r.contract_id}-${r.plan_id}`, contractId: r.contract_id, planId3: r.plan_id, segmentId: r.segment_id,
    planName: r.plan_name, contractName: r.contract_name, planType: r.plan_type, snp: r.snp,
    premium: r.premium == null ? null : Number(r.premium),
    deductible: r.deductible == null ? null : Number(r.deductible),
    formularyId: r.formulary_id,
    starRating: null, // placeholder — star ratings are not in this PUF set
    ingestRunId: r.ingest_run_id,
  }));

  return {
    found: true,
    county: { ssaCode: county.ssa_code, fipsCode: county.fips_code, name: county.name, state: county.state, pdpRegion: county.pdp_region },
    count: plans.length, plans,
  };
}

module.exports = { getPlansForCounty };

// CLI: node tools/get_plans_for_county.js <ssa_code | county name>
if (require.main === module) {
  (async () => {
    const key = process.argv.slice(2).join(' ');
    if (!key) { console.error('usage: node tools/get_plans_for_county.js <ssa_code | county name>'); process.exit(1); }
    const { getDb } = require('../lib/db');
    const db = await getDb();
    const out = await getPlansForCounty(key, db);
    console.log(JSON.stringify(out, null, 2));
    await db.end();
  })().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
