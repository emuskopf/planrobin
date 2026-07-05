'use strict';
// PHARMACY-CHANNEL SAVINGS — integration test over REAL Missouri PUF fixture data.
// Hermetic: in-memory PGlite, migrations, the same real fixture subset as the acceptance test,
// then drives getDrugCosts -> per-channel projection -> savings, and the results API handler.
//
//   node tests/channels.test.js       (exit 0 = pass, 1 = fail)
//
// The fixture plan H4461-046 (duloxetine, tier 2) has, in the REAL file:
//   30-day: std retail $5, preferred retail not-offered, std mail $20, preferred mail $5
//   90-day: std retail $15, preferred retail not-offered, std mail $60, preferred mail $0
// So it is BOTH a "plan with a real preferred/standard differential" (preferred mail beats
// standard at 90-day) AND a "plan with no differential" (at 30-day nothing beats standard).

const assert = require('assert');
const path = require('path');
const { getDb, applyMigrations } = require('../lib/db');
const { ingestInto } = require('../ingest/run');
const { getDrugCosts } = require('../tools/get_drug_costs');
const { projectChannels, computeChannelSavings } = require('../tools/overrides');
const { resultsHandler } = require('../lib/api/handlers');

const FIXTURES = path.resolve(__dirname, 'fixtures');
const PLAN_ID = 'H4461-046';
const RX = ['596934', '596930']; // duloxetine 60mg + 30mg, both tier 2

let passed = 0;
const t = (name) => { passed++; console.log(`  ok  ${name}`); };

// Build the per-channel drug models the handler feeds to projectChannels (mirrors handlers.js).
function modelsByChannel(dc) {
  const CH = ['standardRetail', 'preferredRetail', 'standardMail', 'preferredMail'];
  const by = { standardRetail: [], preferredRetail: [], standardMail: [], preferredMail: [] };
  for (const d of dc.drugs) {
    const byCh = d.overrides.effectivePerFillByChannel;
    for (const ch of CH) by[ch].push({ rxcui: d.rxcui, perFill: byCh[ch] || {}, deductibleApplies: d.overrides.deductibleApplies });
  }
  return by;
}

async function main() {
  const savedUrl = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  const savedSup = process.env.SUPABASE_DB_URL; delete process.env.SUPABASE_DB_URL;
  const savedDir = process.env.PGLITE_DIR; delete process.env.PGLITE_DIR;

  const db = await getDb();
  assert.strictEqual(db.kind, 'pglite', 'must run on embedded PGlite');
  try {
    await applyMigrations(db);
    const ing = await ingestInto(db, { sourceDir: FIXTURES, quiet: true, quarter: '2026-Q1', sourceFile: 'SPUF_2026_20260408.zip' });
    assert.strictEqual(ing.status, 'completed');

    const dc = await getDrugCosts(RX, PLAN_ID, db);
    assert.ok(dc.found);
    const d60 = dc.drugs.find((x) => x.rxcui === '596934');

    console.log('Per-channel effective per-fill matches the REAL file (duloxetine 60mg, tier 2):');
    const ch = d60.overrides.effectivePerFillByChannel;
    assert.ok(ch, 'effectivePerFillByChannel present');
    // 30-day (days-supply "1")
    assert.strictEqual(ch.standardRetail['1'].dollars, 5, 'std retail 30-day $5');
    assert.strictEqual(ch.preferredRetail['1'].kind, 'not_offered', 'preferred retail 30-day not offered');
    assert.strictEqual(ch.standardMail['1'].dollars, 20, 'std mail 30-day $20');
    assert.strictEqual(ch.preferredMail['1'].dollars, 5, 'preferred mail 30-day $5');
    // 90-day (days-supply "2")
    assert.strictEqual(ch.standardRetail['2'].dollars, 15, 'std retail 90-day $15');
    assert.strictEqual(ch.preferredMail['2'].dollars, 0, 'preferred mail 90-day $0 (real differential)');
    t('per-channel per-fill traces to real fixture numbers');

    console.log('\nReal differential at 90-day -> honest saving on the cheaper channel:');
    const models = modelsByChannel(dc);
    const proj90 = projectChannels({ premium: 0, deductible: 0, planYear: 2026, drugsByChannel: models, daysSupply: 2 });
    // std retail: 2 drugs × $15 × 4 fills = $120; preferred mail: 2 × $0 × 4 = $0.
    assert.strictEqual(proj90.standardRetail.annualDrugOOP, 120);
    assert.strictEqual(proj90.preferredMail.annualDrugOOP, 0);
    assert.strictEqual(proj90.preferredRetail.incomplete, true, 'preferred retail not offered -> incomplete, not $0');
    const save90 = computeChannelSavings(proj90);
    assert.ok(save90, 'a saving is reported at 90-day');
    assert.strictEqual(save90.channel, 'preferredMail');
    assert.strictEqual(save90.amount, 120);
    assert.strictEqual(save90.channelLabel, 'preferred mail order');
    t('90-day: preferred mail saves $120/yr vs standard retail (real MO data)');

    console.log('\nNo differential at 30-day (the anchor) -> show nothing, not "$0 savings":');
    const proj30 = projectChannels({ premium: 0, deductible: 0, planYear: 2026, drugsByChannel: models, daysSupply: 1 });
    // std retail: 2 × $5 × 12 = $120; preferred mail equal ($120); std mail more ($480); pref retail incomplete.
    assert.strictEqual(proj30.standardRetail.annualDrugOOP, 120);
    assert.strictEqual(proj30.preferredMail.annualDrugOOP, 120);
    assert.strictEqual(proj30.standardMail.annualDrugOOP, 480);
    assert.strictEqual(computeChannelSavings(proj30), null, 'no cheaper channel at 30-day -> null');
    t('30-day: no channel beats standard retail -> savings null');

    console.log('\nResults API: default anchor unchanged; per-channel projections + savings present:');
    const out = await resultsHandler(db, { county: '26950', rxcuis: RX });
    assert.strictEqual(out.status, 200);
    const plan = out.body.plans.find((p) => p.planId === PLAN_ID);
    assert.ok(plan, 'H4461-046 present in results');
    // Anchor (default, 30-day standard retail) is exactly the standard-retail channel number.
    assert.strictEqual(plan.channels.standardRetail.annualEstimate, plan.annualEstimate);
    assert.strictEqual(plan.annualDrugs, 120); // premium $0 in fixture -> annual == drug OOP
    // All four channel objects carry projection numbers (traceable via each drug's ingestRunId).
    for (const c of ['standardRetail', 'standardMail', 'preferredMail']) assert.ok(plan.channels[c], `channel ${c} present`);
    assert.strictEqual(plan.channels.standardMail.annualEstimate, 480);
    // The 30-day feature shows no savings line for this plan (honest: no 30-day differential).
    assert.strictEqual(plan.savings, null, 'no 30-day savings line for H4461-046');
    t('resultsHandler: anchor == standardRetail channel, savings field present (null here), channels populated');

    console.log(`\nALL PHARMACY-CHANNEL TESTS PASSED (${passed}).`);
    await db.end();
  } catch (e) {
    await db.end().catch(() => {});
    console.error('\nCHANNELS FAIL:', e.stack || e.message);
    process.exit(1);
  } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    if (savedSup !== undefined) process.env.SUPABASE_DB_URL = savedSup;
    if (savedDir !== undefined) process.env.PGLITE_DIR = savedDir;
  }
}

main();
