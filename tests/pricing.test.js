'use strict';
// PRICING FILE + QUANTITY-DRIVEN COINSURANCE + HONEST BREAKDOWN — integration test on the fixture.
// Proves: pricing ingests (per-unit) with coverage tracked; coinsurance is dollarized from the
// USER'S quantity (rate × unit price × qty), flows into the total and the $2,000 cap; a coinsurance
// drug with NO price stays out (honest); not-covered is listed loudly; M0 stays flat where there's
// no coinsurance.
//
//   node tests/pricing.test.js       (exit 0 = pass, 1 = fail)
//
// Fixture coinsurance drugs on H4461-046 (tier 4 = 50% coinsurance):
//   9990001 / NDC 99990000101 — priced $12.50/unit  -> dollarized from quantity
//   9990002 / NDC 99990000201 — NO price             -> stays un-totalable (plan incomplete)

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
    const ing = await ingestInto(db, { sourceDir: FIXTURES, crosswalkDir: FIXTURES, quiet: true, quarter: '2026-Q1', sourceFile: 'SPUF_2026_20260408.zip' });
    assert.strictEqual(ing.status, 'completed');

    console.log('Pricing ingests + coverage tracked:');
    const runChecks = (await db.query(`select checks from ingest_runs order by id desc limit 1`)).rows[0].checks;
    assert.deepStrictEqual(runChecks.price_coverage, { total: 2, priced: 1, fraction: 0.5 });
    t('drug_prices loaded; coinsurance price-coverage = 1/2 (50%)');

    console.log('\nget_drug_costs still exposes per-unit price + basis (dose-agnostic data layer):');
    const dc = await getDrugCosts(['9990001', '9990002'], 'H4461-046', db);
    assert.strictEqual(dc.drugs.find((x) => x.rxcui === '9990001').costBasis, 'coinsurance_per_unit');
    assert.strictEqual(dc.drugs.find((x) => x.rxcui === '9990001').negotiatedPrice.unitCostByDays['30'], 12.5);
    assert.strictEqual(dc.drugs.find((x) => x.rxcui === '9990002').costBasis, 'coinsurance_no_price');
    t('per-unit price present for priced drug; no-price drug stays coinsurance_no_price');

    console.log('\nCoinsurance dollarized from the user\'s quantity; no-price drug stays out:');
    // qty 2/fill: est perFill = 50% × $12.50 × 2 = $12.50 -> $150/yr. Under cap; clean numbers.
    const out = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '9990001', '9990002', '000000'], quantities: { '9990001': 2 } });
    const p = out.body.plans.find((x) => x.planId === 'H4461-046');
    const b = p.breakdown;
    assert.strictEqual(b.copayAnnual, 60, 'duloxetine copay $5 × 12');
    assert.strictEqual(b.coinsuranceEstAnnual, 150, 'coinsurance estimated 50% × $12.50 × 2 × 12');
    assert.deepStrictEqual(b.coinsuranceEstRxcuis, ['9990001']);
    assert.deepStrictEqual(b.coinsuranceNoPriceRxcuis, ['9990002']);
    assert.deepStrictEqual(b.notCoveredRxcuis, ['000000']);
    assert.strictEqual(b.total, b.premiumAnnual + 60 + 150, 'total = premium + copay + coinsurance est (no cap)');
    assert.strictEqual(p.drugs['9990001'].estimated.annual, 150);
    assert.strictEqual(p.drugs['9990001'].quantity, 2);
    assert.strictEqual(p.annualComplete, false, 'still incomplete: 9990002 has no price');
    assert.strictEqual(b.hasUnpriceable, true);
    t('rate × unit price × quantity → real coinsurance dollars in the total; no-price stays out');

    console.log('\nCoinsurance drug races to the $2,000 cap (the originally-moot acceptance case):');
    // qty 400/fill: est perFill = 50% × $12.50 × 400 = $2,500 -> hits the $2,100 cap in month 1.
    const capOut = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '9990001'], quantities: { '9990001': 400 } });
    const cp = capOut.body.plans.find((x) => x.planId === 'H4461-046');
    assert.strictEqual(cp.annualComplete, true, 'both drugs priced -> complete');
    assert.strictEqual(cp.breakdown.capHit.reached, true, 'cap reached via coinsurance');
    assert.strictEqual(cp.breakdown.capHit.month, 1, 'reached in month 1');
    assert.strictEqual(cp.breakdown.cappedDrugOOP, 2100, 'drug OOP capped at $2,000-era cap ($2,100/2026)');
    assert.strictEqual(cp.breakdown.capBinds, true, 'total is less than uncapped components');
    assert.strictEqual(cp.annualEstimate, cp.premium * 12 + 2100, 'headline = premium + capped drug OOP');
    t('coinsurance-driven cap: month + capped OOP + capBinds correct');

    console.log('\nDefault quantity applies when omitted:');
    const defOut = await resultsHandler(db, { county: '26950', rxcuis: ['9990001'] }); // no quantities -> default 30
    const dp = defOut.body.plans.find((x) => x.planId === 'H4461-046');
    assert.strictEqual(dp.drugs['9990001'].quantity, 30, 'defaults to 30 (once-daily)');
    // per-drug estimate is uncapped: 50% × $12.50 × 30 × 12 = $2,250 (the cap applies to the total).
    assert.strictEqual(dp.drugs['9990001'].estimated.annual, 2250);
    t('missing quantity -> default 30 units/fill');

    console.log('\nM0 anchor unchanged (all-copay basket):');
    const m0 = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '596930'] });
    const m0p = m0.body.plans.find((x) => x.planId === 'H4461-046');
    assert.strictEqual(m0p.annualComplete, true);
    assert.strictEqual(m0p.breakdown.coinsuranceEstAnnual, 0);
    assert.strictEqual(m0p.breakdown.coinsuranceEstRxcuis.length, 0);
    assert.strictEqual(m0p.breakdown.total, m0p.breakdown.premiumAnnual + m0p.breakdown.copayAnnual);
    t('duloxetine-only basket: complete, no coinsurance lines, total = premium + copays');

    console.log('\nDeductible-exemption flag (nonzero deductible, all covered drugs on exempt tiers):');
    // H4461-046 has a $615 deductible; duloxetine is tier 2, which the deductible skips (ded_applies=N).
    const exemptOut = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '596930'] });
    const ep = exemptOut.body.plans.find((p) => p.planId === 'H4461-046');
    assert.strictEqual(ep.deductible, 615);
    assert.strictEqual(ep.breakdown.deductibleAmount, 615);
    assert.strictEqual(ep.breakdown.deductibleExempt, true, 'all-exempt basket + nonzero deductible -> exempt');
    // Add a tier-4 drug (ded_applies=Y) and the deductible is no longer exempt.
    const mixedOut = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '9990001'] });
    const mp = mixedOut.body.plans.find((p) => p.planId === 'H4461-046');
    assert.strictEqual(mp.breakdown.deductibleExempt, false, 'a deductible-applicable drug -> not exempt');
    t('deductibleExempt true only when every covered drug is on a deductible-exempt tier');

    console.log('\nPartial-coverage plans: suppressed savings + honest coverage (shared definition):');
    const PRFormat = require('../site/format.js');
    const partOut = await resultsHandler(db, { county: '26950', rxcuis: ['596934', '000000'] }); // 000000 not on formulary
    const pp = partOut.body.plans.find((p) => p.planId === 'H4461-046');
    assert.strictEqual(pp.notCovered, 1, 'one drug not covered -> partial plan');
    assert.strictEqual(pp.savings, null, 'partial plan must NOT show a savings line as if comparable');
    const cov = PRFormat.planCoverage(pp);
    assert.strictEqual(cov.complete, false);
    assert.strictEqual(cov.covered, 1);
    assert.deepStrictEqual(cov.missing, ['000000']);
    // The missing drug is named in the breakdown, never silently $0.
    assert.deepStrictEqual(pp.breakdown.notCoveredRxcuis, ['000000']);
    t('partial plan: savings suppressed, coverage flagged, missing drug named');

    console.log(`\nALL PRICING/QUANTITY TESTS PASSED (${passed}).`);
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
