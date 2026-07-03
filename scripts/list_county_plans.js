'use strict';
// HELPER (supports STEP 3) — reverse-resolve a plan when you don't have the H####-###
// id but DO know the county and (roughly) the carrier / plan name on the card.
//
// Usage:
//   node scripts/list_county_plans.js "<county>" [nameFilter]
//   e.g. node scripts/list_county_plans.js "Greene" Aetna
//
// Lists every plan serving that Missouri county whose carrier or plan name matches the
// filter, with its CONTRACT-PLAN id, official PLAN_NAME, and FORMULARY_ID — so the user
// can pick the row that matches her card. Streams the Plan Information file.

const { streamRows } = require('./lib/puf');
const { FILES } = require('./lib/config');

async function main() {
  const countyArg = (process.argv[2] || '').trim().toLowerCase().replace(/\s+county$/, '');
  const nameFilter = (process.argv[3] || '').trim().toLowerCase();
  if (!countyArg) { console.error('Usage: node scripts/list_county_plans.js "<county>" [nameFilter]'); process.exit(1); }

  // 1) county name -> SSA COUNTY_CODE (Missouri) + PDP region.
  let countyCode = null, pdpRegion = null;
  for await (const g of streamRows(FILES.geoLocator)) {
    if (g.STATENAME.trim().toLowerCase() !== 'missouri') continue;
    if (g.COUNTY.trim().toLowerCase() !== countyArg) continue;
    countyCode = g.COUNTY_CODE; pdpRegion = g.PDP_REGION_CODE.trim();
    break;
  }
  if (!countyCode) { console.error(`County "${process.argv[2]}" NOT FOUND in Missouri (check spelling).`); process.exit(2); }
  console.log(`County: ${process.argv[2]}, Missouri  (SSA ${countyCode}, PDP region ${pdpRegion})`);
  console.log(`Filter: ${nameFilter || '(none)'}\n`);

  // 2) Plans serving this county:
  //    - Local MA (H) plans list this COUNTY_CODE directly.
  //    - Stand-alone PDP (S) plans serve the whole PDP region (blank county in file).
  const seen = new Map(); // CONTRACT-PLAN -> {name, contractName, formulary, type}
  for await (const row of streamRows(FILES.planInfo)) {
    const c0 = row.CONTRACT_ID[0];
    let serves = false;
    if (c0 === 'H') serves = row.COUNTY_CODE.trim() === countyCode.trim();
    else if (c0 === 'S') serves = row.PDP_REGION_CODE.trim() === pdpRegion;
    else if (c0 === 'R') serves = false; // regional MA: skip (region join not needed here)
    if (!serves) continue;
    if (nameFilter && !(`${row.CONTRACT_NAME} ${row.PLAN_NAME}`.toLowerCase().includes(nameFilter))) continue;
    const key = `${row.CONTRACT_ID}-${row.PLAN_ID}`;
    if (!seen.has(key)) seen.set(key, { name: row.PLAN_NAME, contractName: row.CONTRACT_NAME, formulary: row.FORMULARY_ID, type: { H: 'MA', R: 'MA-reg', S: 'PDP' }[c0] });
  }

  const rows = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (rows.length === 0) { console.log('No matching plans found for that county/filter.'); return; }
  console.log(`${rows.length} plan(s):\n`);
  for (const [id, v] of rows) {
    console.log(`  ${id}  [${v.type}]  formulary ${v.formulary}`);
    console.log(`      ${v.name}   (${v.contractName})`);
  }
  console.log('\nPick the CONTRACT-PLAN whose name matches her card, then put it in data/plan.txt.');
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
