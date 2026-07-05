'use strict';
// PRICING FILE + HONEST COST BREAKDOWN — integration test over the PGlite fixture.
// Proves: the Pricing file ingests (per-unit costs), coverage is tracked, coinsurance drugs get
// their real per-unit price (or the NOT-FOUND path when absent), and the results breakdown itemizes
// premium / flat-copay / coinsurance (un-annualized) / not-covered without ever inventing a total.
//
//   node tests/pricing.test.js       (exit 0 = pass, 1 = fail)
//
// Fixture coinsurance drugs on H4461-046 (tier 4 = 50% coinsurance):
//   9990001 / NDC 99990000101 — HAS a pricing row ($12.50/unit)  -> coinsurance_per_unit
//   9990002 / NDC 99990000201 — NO pricing row                    -> coinsurance_no_price

const assert = require('assert');
const path = require('path');
const { getDb, applyMigrations } = require('../lib/db');
const { ingestInto } = require('../ingest/run');
const { getDrugCosts } = require('../tools/get_drug_costs');
const { resultsHandler } = require('../lib/api/handlers');

const FIXTURES = path.resolve(__dirname, 'fixtures');
let passed = 0;
const t = (name) => { passed++; console.log(`  ok  ${name}`); };

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

    console.log('Pricing file ingests + coverage is tracked:');
    const dp = await db.query('select count(*)::int n from drug_prices');
    assert.ok(dp.rows[0].n > 0, 'drug_prices loaded');
    const cov = ing.stats ? null : null; // coverage lives on the run's checks
    const runChecks = (await db.query(`select checks from ingest_runs order by id desc limit 1`)).rows[0].checks;
    assert.deepStrictEqual(runChecks.price_coverage, { total: 2, priced: 1, fraction: 0.5 },
      'coverage: 1 of 2 coinsurance NDCs priced');
    t('drug_prices loaded; coinsurance price-coverage = 1/2 (50%)');

    console.log('\nget_drug_costs attaches the real per-unit price (or NOT-FOUND when absent):');
    const dc = await getDrugCosts(['596934', '9990001', '9990002'], 'H4461-046', db);
    const copay = dc.drugs.find((x) => x.rxcui === '596934');
    const coinsPriced = dc.drugs.find((x) => x.rxcui === '9990001');
    const coinsNoPrice = dc.drugs.find((x) => x.rxcui === '9990002');
    assert.strictEqual(copay.costBasis, 'copay');
    assert.strictEqual(coinsPriced.costBasis, 'coinsurance_per_unit');
    assert.strictEqual(coinsPriced.negotiatedPrice.unitCostByDays['30'], 12.5, 'per-unit $12.50');
    assert.strictEqual(coinsNoPrice.costBasis, 'coinsurance_no_price');
    assert.strictEqual(coinsNoPrice.negotiatedPrice, null, 'no price -> null, never invented');
    t('copay / coinsurance_per_unit / coinsurance_no_price bases resolve from real data');

    console.log('\nResults breakdown itemizes honestly; nothing invented, nothing hidden:');
    const out = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '9990001', '9990002', '000000'] });
    assert.strictEqual(out.status, 200);
    const plan = out.body.plans.find((p) => p.planId === 'H4461-046');
    assert.ok(plan, 'H4461-046 present');
    const b = plan.breakdown;
    assert.strictEqual(b.copayAnnual, 60, 'flat-copay line = duloxetine $5 × 12');
    assert.strictEqual(b.total, b.premiumAnnual + b.copayAnnual, 'headline total = premium + copays only');
    assert.deepStrictEqual(b.coinsuranceRxcuis.sort(), ['9990001', '9990002'], 'both coinsurance drugs listed separately');
    assert.deepStrictEqual(b.notCoveredRxcuis, ['000000'], 'not-covered drug listed, not folded in');
    assert.strictEqual(b.hasUnpriceable, true, 'flags the coinsurance drug with no price');
    assert.strictEqual(plan.annualComplete, false, 'incomplete: coinsurance present -> true total is higher');
    // The per-unit price rides along on the covered coinsurance drug; the un-priced one stays null.
    assert.strictEqual(plan.drugs['9990001'].negotiatedPrice.unitCostByDays['30'], 12.5);
    assert.strictEqual(plan.drugs['9990002'].negotiatedPrice, null);
    assert.strictEqual(plan.drugs['000000'].covered, false);
    t('breakdown: premium + copays total; coinsurance & not-covered itemized, never invented');

    console.log('\nM0 anchor unchanged (no coinsurance in the classic basket):');
    const m0 = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '596930'] });
    const m0plan = m0.body.plans.find((p) => p.planId === 'H4461-046');
    assert.strictEqual(m0plan.annualComplete, true, 'all-copay basket stays complete');
    assert.strictEqual(m0plan.breakdown.coinsuranceRxcuis.length, 0);
    assert.strictEqual(m0plan.breakdown.notCoveredRxcuis.length, 0);
    t('duloxetine-only basket: complete, no coinsurance/not-covered lines (M0 shape intact)');

    console.log(`\nALL PRICING TESTS PASSED (${passed}).`);
    await db.end();
  } catch (e) {
    await db.end().catch(() => {});
    console.error('\nPRICING FAIL:', e.stack || e.message);
    process.exit(1);
  } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    if (savedSup !== undefined) process.env.SUPABASE_DB_URL = savedSup;
    if (savedDir !== undefined) process.env.PGLITE_DIR = savedDir;
  }
}

main();
