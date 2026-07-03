'use strict';
// STEP 3 — Resolve the beneficiary's CONTRACT-PLAN[-SEGMENT] id to its FORMULARY_ID.
//
// Reads ground truth from data/plan.txt:
//     line 1: the plan id, e.g.  S5678-042   or   H1234-001-000
//     line 2 (optional): county: <name>      e.g.  county: Cole
// (CLI override: `node scripts/01_resolve_plan.js S5678-042 Cole`)
//
// Streams the Plan Information file to find every matching row, prints the plan's
// OFFICIAL name/carrier from the file so the user can confirm it matches her card,
// and resolves the county → SSA code → service region via the Geographic Locator.
// Writes out/plan.json for the rest of the pipeline.

const fs = require('fs');
const path = require('path');
const { streamRows } = require('./lib/puf');
const { FILES, INPUT, OUTFILE, OUT, PUF_QUARTER } = require('./lib/config');

function parsePlanId(raw) {
  // Split "S5678-042-000" → contract=S5678, plan=042, segment=000.
  const parts = raw.trim().toUpperCase().split('-');
  if (parts.length < 2) throw new Error(`Cannot parse plan id "${raw}" — expected CONTRACT-PLAN[-SEGMENT]`);
  const contract = parts[0];
  const plan = parts[1].padStart(3, '0');
  const segment = (parts[2] || '000').padStart(3, '0');
  return { contract, plan, segment, raw: raw.trim() };
}

function readPlanConfig() {
  // CLI args win over the file.
  const argId = process.argv[2];
  const argCounty = process.argv[3];
  if (argId) return { idLine: argId, county: argCounty || null };
  if (!fs.existsSync(INPUT.plan)) {
    throw new Error(
      `No plan id provided. Create data/plan.txt with the plan id on line 1 ` +
      `(e.g. "S5678-042"), or pass it as an argument.`
    );
  }
  const lines = fs.readFileSync(INPUT.plan, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let idLine = null;
  let county = null;
  for (const l of lines) {
    const m = /^county\s*[:=]\s*(.+)$/i.exec(l);
    if (m) county = m[1].trim();
    else if (!idLine) idLine = l;
  }
  if (!idLine) throw new Error('data/plan.txt has no plan id line.');
  return { idLine, county };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const cfg = readPlanConfig();
  const target = parsePlanId(cfg.idLine);
  const contractType = { H: 'Local MA', R: 'Regional MA', S: 'Stand-alone PDP' }[target.contract[0]] || 'Unknown';

  console.log('='.repeat(70));
  console.log(`STEP 3 — Resolve plan (PUF ${PUF_QUARTER})`);
  console.log(`Target: contract=${target.contract} plan=${target.plan} segment=${target.segment} (${contractType})`);
  if (cfg.county) console.log(`Ground-truth county: ${cfg.county}, Missouri`);
  console.log('='.repeat(70));

  // 1) Find matching rows in Plan Information. For a given plan there can be many
  //    rows (one per county for H plans); FORMULARY_ID should be constant.
  const matches = [];
  const formularyIds = new Set();
  const counties = new Set(); // COUNTY_CODE values (H plans)
  const pdpRegions = new Set();
  const maRegions = new Set();
  let planName = null, contractName = null, premium = null, deductible = null, snp = null, suppressed = null;

  for await (const row of streamRows(FILES.planInfo)) {
    if (row.CONTRACT_ID !== target.contract) continue;
    if (row.PLAN_ID !== target.plan) continue;
    // Segment: match if the user specified a non-default one; PDPs are always 000.
    if (target.segment !== '000' && row.SEGMENT_ID !== target.segment) continue;
    matches.push({
      line: row.__line, formularyId: row.FORMULARY_ID, state: row.STATE,
      countyCode: row.COUNTY_CODE, pdpRegion: row.PDP_REGION_CODE, maRegion: row.MA_REGION_CODE,
    });
    formularyIds.add(row.FORMULARY_ID);
    if (row.COUNTY_CODE && row.COUNTY_CODE.trim()) counties.add(row.COUNTY_CODE.trim());
    if (row.PDP_REGION_CODE && row.PDP_REGION_CODE.trim()) pdpRegions.add(row.PDP_REGION_CODE.trim());
    if (row.MA_REGION_CODE && row.MA_REGION_CODE.trim()) maRegions.add(row.MA_REGION_CODE.trim());
    planName = row.PLAN_NAME; contractName = row.CONTRACT_NAME;
    premium = row.PREMIUM; deductible = row.DEDUCTIBLE; snp = row.SNP; suppressed = row.PLAN_SUPPRESSED_YN;
  }

  if (matches.length === 0) {
    console.log('\n*** NOT FOUND IN DATA ***');
    console.log(`No row in the Plan Information file for contract=${target.contract} plan=${target.plan}` +
      (target.segment !== '000' ? ` segment=${target.segment}` : '') + '.');
    console.log('Check the id against her member card / Medicare.gov, or the PUF quarter may not carry this plan.');
    process.exit(2);
  }

  console.log(`\nMatched ${matches.length} Plan Information row(s).`);
  console.log(`  CONTRACT_NAME : ${contractName}`);
  console.log(`  PLAN_NAME     : ${planName}   <-- confirm this matches her card`);
  console.log(`  PREMIUM       : ${premium}   DEDUCTIBLE: ${deductible}   SNP: ${snp}   SUPPRESSED: ${suppressed}`);
  console.log(`  FORMULARY_ID  : ${[...formularyIds].join(', ')}` +
    (formularyIds.size > 1 ? '  <-- WARNING: multiple formulary ids for this plan!' : ''));
  console.log(`  source: plan information file, line(s) ${matches.slice(0, 5).map((m) => m.line).join(', ')}${matches.length > 5 ? ', …' : ''}`);

  // 2) County / service-area confirmation via Geographic Locator.
  let countyResolved = null;
  if (cfg.county) {
    // Normalize for comparison: drop punctuation (so "St. Foo" matches "ST FOO") but keep a
    // trailing "city" meaningful, since some MO entries distinguish a city from its county.
    const norm = (s) => s.trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+county$/, '').replace(/\s+/g, ' ').trim();
    const wantName = norm(cfg.county);
    for await (const g of streamRows(FILES.geoLocator)) {
      if (g.STATENAME.trim().toLowerCase() !== 'missouri') continue;
      if (norm(g.COUNTY) !== wantName) continue;
      countyResolved = {
        countyCode: g.COUNTY_CODE, county: g.COUNTY.trim(), state: g.STATENAME.trim(),
        pdpRegionCode: g.PDP_REGION_CODE.trim(), pdpRegion: g.PDP_REGION.trim(),
        maRegionCode: g.MA_REGION_CODE.trim(), maRegion: g.MA_REGION.trim(), line: g.__line,
      };
      break;
    }
    if (!countyResolved) {
      console.log(`\n  County "${cfg.county}" NOT FOUND in Missouri rows of the Geographic Locator — check spelling.`);
    } else {
      console.log(`\n  County resolved: ${countyResolved.county}, ${countyResolved.state}` +
        ` (SSA ${countyResolved.countyCode}) -> PDP region ${countyResolved.pdpRegionCode} "${countyResolved.pdpRegion}"`);
      // Service-area check.
      let inArea = null;
      if (target.contract[0] === 'S') {
        inArea = pdpRegions.has(countyResolved.pdpRegionCode);
        console.log(`  Plan PDP region(s): ${[...pdpRegions].join(', ') || '(none)'} -> county in service area: ${inArea ? 'YES' : 'NO'}`);
      } else if (target.contract[0] === 'H') {
        inArea = counties.has(countyResolved.countyCode);
        console.log(`  County in plan's county list: ${inArea ? 'YES' : 'NO'} (${counties.size} counties in plan)`);
      } else if (target.contract[0] === 'R') {
        inArea = maRegions.has(countyResolved.maRegionCode);
        console.log(`  Plan MA region(s): ${[...maRegions].join(', ')} -> county in service area: ${inArea ? 'YES' : 'NO'}`);
      }
      countyResolved.inServiceArea = inArea;
    }
  }

  if (formularyIds.size > 1) {
    console.log('\n*** Multiple FORMULARY_IDs — cannot pick one automatically. Resolve which segment/county applies. ***');
  }

  const out = {
    generatedAt: new Date().toISOString(),
    pufQuarter: PUF_QUARTER,
    target,
    contractType,
    contractName, planName, premium, deductible, snp, suppressed,
    formularyId: formularyIds.size === 1 ? [...formularyIds][0] : null,
    formularyIds: [...formularyIds],
    matchedRows: matches.length,
    countyInput: cfg.county || null,
    county: countyResolved,
    source: { file: path.basename(FILES.planInfo), matchedLines: matches.map((m) => m.line) },
  };
  fs.writeFileSync(OUTFILE.plan, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), OUTFILE.plan)}`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
