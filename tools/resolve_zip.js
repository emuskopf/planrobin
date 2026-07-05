'use strict';
// TYPED TOOL — resolveZip(zip, db)
//
// Turns a 5-digit ZIP into the Missouri county (or counties) it belongs to, using the
// ZIP->county crosswalk joined to our plan counties via FIPS. Pure SQL, no LLM.
//
// Returns one of:
//   { status: 'invalid' }                          — not a 5-digit ZIP
//   { status: 'out_of_area', zip }                 — a valid ZIP we have no MO county for
//   { status: 'ok', zip, multi, counties: [...] }  — 1+ counties, likeliest (highest
//                                                     residential ratio) FIRST
// Each county: { code (SSA, the key results/share use), name, state, fips, resRatio }.
//
// "out_of_area" deliberately covers both out-of-state ZIPs and MO ZIPs we lack data for —
// the caller shows one honest "we only cover Missouri" message rather than an empty result.

async function resolveZip(zip, db) {
  const z = String(zip == null ? '' : zip).trim();
  if (!/^\d{5}$/.test(z)) return { status: 'invalid', zip: z };

  const r = await db.query(
    `select zc.county_fips, zc.res_ratio, c.ssa_code, c.name, c.state
       from zip_counties zc
       join counties c on c.fips_code = zc.county_fips
      where zc.zip = $1
      order by zc.res_ratio desc nulls last, c.name`,
    [z]
  );
  if (r.rows.length === 0) return { status: 'out_of_area', zip: z };

  const counties = r.rows.map((row) => ({
    code: row.ssa_code,
    name: row.name,
    state: row.state,
    fips: row.county_fips,
    resRatio: row.res_ratio == null ? null : Number(row.res_ratio),
  }));
  return { status: 'ok', zip: z, multi: counties.length > 1, counties };
}

module.exports = { resolveZip };
