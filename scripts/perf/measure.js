'use strict';
// PERFORMANCE MEASUREMENT — hot-path timing, DB round-trip census, EXPLAIN, table sizes.
// Runs against whatever getDb() resolves: DATABASE_URL set => live Postgres; else PGLITE_DIR/local.
//
//   node scripts/perf/measure.js                 (local .pglite, full MO data)
//   DATABASE_URL=... node scripts/perf/measure.js (live Supabase)
//
// No writes. Read-only. Prints a plain-text report.

const { getDb } = require('../../lib/db');
const { instrument } = require('../../lib/perf');
const { getPlansForCounty } = require('../../tools/get_plans_for_county');
const { resultsHandler } = require('../../lib/api/handlers');

const COUNTY = '26940'; // St. Louis County (82 plans)
const BASKET = ['617310', '314076', '860975', '966221']; // atorvastatin20, lisinopril10, metformin500, levothyrox50
const RUNS = 10;

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); const i = Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1); return a[Math.max(0, i)]; };
const ms = (n) => `${n.toFixed(0)}ms`;

async function timeIt(fn) { const t0 = Date.now(); await fn(); return Date.now() - t0; }

async function main() {
  const raw = await getDb();
  const db = instrument(raw);
  console.log(`\n=== PlanRobin perf — backend: ${raw.kind} ===`);

  // --- A2/A3: hot-path timing + round-trip census ------------------------------------------
  const planTimes = [], searchTimes = [];
  let searchQueries = 0, planQueries = 0;
  for (let i = 0; i < RUNS; i++) {
    db.stats.queries = 0; db.stats.dbMs = 0;
    planTimes.push(await timeIt(() => getPlansForCounty(COUNTY, db)));
    if (i === 0) planQueries = db.stats.queries;
  }
  for (let i = 0; i < RUNS; i++) {
    db.stats.queries = 0; db.stats.dbMs = 0;
    searchTimes.push(await timeIt(() => resultsHandler(db, { county: COUNTY, rxcuis: BASKET })));
    if (i === 0) searchQueries = db.stats.queries;
  }
  console.log(`\n[hot paths] ${RUNS} runs each, St. Louis County (26940)`);
  console.log(`  get_plans_for_county : p50 ${ms(pct(planTimes, 50))}  p95 ${ms(pct(planTimes, 95))}  | round trips: ${planQueries}`);
  console.log(`  full 4-drug search   : p50 ${ms(pct(searchTimes, 50))}  p95 ${ms(pct(searchTimes, 95))}  | round trips: ${searchQueries}`);
  const pc = await getPlansForCounty(COUNTY, db);
  console.log(`  (county has ${pc.count} plans; basket = ${BASKET.length} drugs -> N+1 if round trips scale with plans×drugs)`);

  // --- A4: EXPLAIN ANALYZE the hot queries (look for Seq Scan on big tables) ----------------
  console.log('\n[EXPLAIN ANALYZE] hot queries (flagging Seq Scan on large tables)');
  const fid = pc.plans[0] && pc.plans[0].formularyId;
  const p0 = pc.plans[0];
  const explains = [
    ['plans⋈plan_counties (county list)',
      `select p.contract_id from plans p join plan_counties pc on pc.contract_id=p.contract_id and pc.plan_id=p.plan_id and pc.segment_id=p.segment_id where pc.ssa_code='${COUNTY}'`],
    ['drug_tiers (formulary_id, rxcui)',
      `select * from drug_tiers where formulary_id='${fid}' and rxcui='${BASKET[0]}'`],
    ['tier_costs (plan+tier)',
      `select * from tier_costs where contract_id='${p0.contractId}' and plan_id='${p0.planId3}' and segment_id='${p0.segmentId}' and tier=2`],
    ['drug_prices (plan+ndc)',
      `select * from drug_prices where contract_id='${p0.contractId}' and plan_id='${p0.planId3}' and segment_id='${p0.segmentId}' and ndc='00093505698' and days_supply in (30,90)`],
  ];
  for (const [label, q] of explains) {
    try {
      const r = await db.query(`explain analyze ${q}`);
      const text = r.rows.map((row) => Object.values(row)[0]).join('\n');
      const seq = /Seq Scan on (drug_tiers|tier_costs|drug_prices|plans|plan_counties|insulin_costs)/i.exec(text);
      const timeM = /actual time=[\d.]+\.\.([\d.]+)/.exec(text);
      console.log(`  ${label}: ${seq ? 'SEQ SCAN ⚠ ' + seq[0] : 'index scan ✓'}${timeM ? '  (~' + timeM[1] + 'ms)' : ''}`);
    } catch (e) { console.log(`  ${label}: EXPLAIN failed — ${e.message}`); }
  }

  // --- A5: table sizes + free-tier runway --------------------------------------------------
  console.log('\n[table sizes] rows + on-disk (post-pricing ingest)');
  const tables = ['drug_prices', 'drug_tiers', 'tier_costs', 'insulin_costs', 'plan_counties', 'plans', 'counties', 'formularies', 'ingest_runs'];
  let totalBytes = 0;
  const supportsSize = raw.kind !== 'pglite';
  for (const t of tables) {
    let n = 0, bytes = null;
    try { n = (await db.query(`select count(*)::bigint n from ${t}`)).rows[0].n; } catch (_) {}
    if (supportsSize) { try { bytes = Number((await db.query(`select pg_total_relation_size('${t}') b`)).rows[0].b); totalBytes += bytes; } catch (_) {} }
    console.log(`  ${t.padEnd(14)} ${String(n).padStart(9)} rows${bytes != null ? '   ' + (bytes / 1048576).toFixed(1) + ' MB' : ''}`);
  }
  if (supportsSize) {
    const mb = totalBytes / 1048576;
    console.log(`  ${'TOTAL'.padEnd(14)} ${''.padStart(9)}      ${mb.toFixed(1)} MB  (${(mb / 500 * 100).toFixed(1)}% of Supabase free 500MB)`);
    console.log(`  runway: ~${mb.toFixed(0)} MB for 1 state (MO) -> ~${(500 / Math.max(mb, 1)).toFixed(0)} states fit in free tier (rough, MO-sized)`);
  } else {
    console.log('  (on-disk size needs real Postgres — run with DATABASE_URL against Supabase for MB + free-tier %)');
  }

  await raw.end();
  console.log('');
}

main().catch((e) => { console.error('perf measure failed:', e.stack || e.message); process.exit(1); });
