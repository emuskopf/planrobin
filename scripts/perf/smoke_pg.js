'use strict';
// Smoke-test the batched results path against LIVE Supabase using the SAME driver the Cloudflare
// Workers runtime uses (postgres.js, via lib/db_pg.js) — catches driver-specific quirks (jsonb
// parsing, param binding, VALUES/CTE handling) that the local PGlite tests cannot. Read-only.
//
//   DATABASE_URL=... node scripts/perf/smoke_pg.js

const { makePgDb } = require('../../lib/db_pg');
const { instrument } = require('../../lib/perf');
const { fetchResultsData } = require('../../lib/api/results_data');
const { resultsHandler } = require('../../lib/api/handlers');

const COUNTY = '26940';
const BASKET = ['617310', '314076', '860975', '966221'];
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1)]; };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
  const raw = makePgDb(url, {}); // ssl 'require' by default — direct to the pooler
  const db = instrument(raw);
  try {
    const times = []; let queries = 0;
    for (let i = 0; i < 10; i++) {
      db.stats.queries = 0; db.stats.dbMs = 0;
      const t = Date.now();
      const r = await resultsHandler(db, { county: COUNTY, rxcuis: BASKET });
      times.push(Date.now() - t);
      if (i === 0) {
        queries = db.stats.queries;
        if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
        if (!r.body.plans.length) throw new Error('no plans returned');
      }
    }
    console.log(`[postgres.js @ LIVE Supabase] 4-drug search (${COUNTY}): p50 ${pct(times, 50)}ms  p95 ${pct(times, 95)}ms  | round trips: ${queries}`);
    const data = await fetchResultsData(COUNTY, BASKET, db);
    const sample = Object.values(data.costsByPlan)[0];
    console.log(`plans: ${data.plans.length} | sample plan ${sample.planId} first drug basis: ${sample.drugs[0].costBasis}`);
    console.log('SMOKE OK ✓  (batched jsonb/UNION/CTE query works on the Workers driver)');
  } finally {
    await raw.end();
  }
})().catch((e) => { console.error('SMOKE FAIL:', e.stack || e.message); process.exit(1); });
