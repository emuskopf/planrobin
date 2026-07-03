'use strict';
// Ad-hoc CLI for the typed tools (Node-side; uses lib/db → PGlite or DATABASE_URL).
//   node scripts/query.js drug   <planId> <rxcui> [rxcui...]
//   node scripts/query.js county <ssa_code | county name>
// e.g. PGLITE_DIR=.pglite node scripts/query.js drug H4461-046 596934 596930

const { getDb } = require('../lib/db');
const { getDrugCosts } = require('../tools/get_drug_costs');
const { getPlansForCounty } = require('../tools/get_plans_for_county');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = await getDb();
  try {
    let out;
    if (cmd === 'drug') { const [planId, ...rxcuis] = rest; out = await getDrugCosts(rxcuis, planId, db); }
    else if (cmd === 'county') { out = await getPlansForCounty(rest.join(' '), db); }
    else { console.error('usage: query.js drug <planId> <rxcui...> | county <key>'); process.exit(1); }
    console.log(JSON.stringify(out, null, 2));
  } finally { await db.end(); }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
