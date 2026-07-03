'use strict';
// ACCEPTANCE / REGRESSION TEST — the Milestone 0 validation, reproduced through the
// database and the get_drug_costs tool instead of raw files. Hermetic: spins up an
// in-memory PGlite, applies the migrations, ingests a small REAL fixture subset of the
// CMS PUF, then asserts the rendered table is byte-for-byte identical to Milestone 0's.
//
//   node tests/acceptance.test.js      (exit 0 = pass, 1 = fail)
//
// No network, no gitignored inputs, no secrets — safe to run in CI on every push.

const assert = require('assert');
const path = require('path');
const { getDb, applyMigrations } = require('../lib/db');
const { ingestInto } = require('../ingest/run');
const { getDrugCosts } = require('../tools/get_drug_costs');
const { getPlansForCounty } = require('../tools/get_plans_for_county');
const { renderTable } = require('../lib/validation_table');

const FIXTURES = path.resolve(__dirname, 'fixtures');

// Milestone 0 ground truth (the answer key), and the exact table M0 produced on the
// 90-day basis. This is the permanent contract the DB path must keep reproducing.
const PLAN_ID = 'H4461-046';
const INPUTS = [
  { drug: 'duloxetine 60 mg', rxcui: '596934', expected: 15.00 },
  { drug: 'duloxetine 30 mg', rxcui: '596930', expected: 15.00 },
];
const GOLDEN_META = {
  planId: 'H4461-046', planName: 'Humana Total Complete H4461-046 (HMO)', formularyId: '00026408',
  pufQuarter: '2026-Q1', basis: 'standard retail, 90-day, initial coverage',
};
const GOLDEN_ROWS = [
  { drug: 'duloxetine 60 mg', rxcui: '596934', tier: '2', flags: 'QL', computed: '$15.00', expected: '$15.00', match: 'YES' },
  { drug: 'duloxetine 30 mg', rxcui: '596930', tier: '2', flags: 'QL', computed: '$15.00', expected: '$15.00', match: 'YES' },
];

function flagStr(flags) {
  return [flags.priorAuth && 'PA', flags.stepTherapy && 'ST', flags.quantityLimit && 'QL', flags.selectedDrug && 'NEG'].filter(Boolean).join(',') || '-';
}

async function main() {
  // Force embedded PGlite even if DATABASE_URL is set in the environment (hermetic).
  const savedUrl = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  const savedSup = process.env.SUPABASE_DB_URL; delete process.env.SUPABASE_DB_URL;
  const savedDir = process.env.PGLITE_DIR; delete process.env.PGLITE_DIR; // in-memory

  const db = await getDb();
  assert.strictEqual(db.kind, 'pglite', 'acceptance test must run on embedded PGlite');
  try {
    await applyMigrations(db);
    const ing = await ingestInto(db, { sourceDir: FIXTURES, quiet: true, quarter: '2026-Q1', sourceFile: 'SPUF_2026_20260408.zip' });
    assert.strictEqual(ing.status, 'completed', 'fixture ingest should complete');

    // Query the DB through the real tool, exactly as the agent layer will.
    const res = await getDrugCosts(INPUTS.map((i) => i.rxcui), PLAN_ID, db);
    assert.ok(res.found, 'plan must be found');
    assert.ok(res.plan.ingestRunId != null, 'plan carries ingest_run id');

    const dbRows = INPUTS.map((inp) => {
      const d = res.drugs.find((x) => x.rxcui === inp.rxcui);
      assert.ok(d && d.found, `drug ${inp.rxcui} must be on formulary`);
      // Traceability: every number carries an ingest_run id.
      assert.ok(d.drugTierIngestRunId != null, `drug ${inp.rxcui} tier has ingest_run id`);
      const initial = d.costsByPhase['1'] && d.costsByPhase['1'].byDaysSupply['2']; // initial coverage, 90-day
      assert.ok(initial, `drug ${inp.rxcui} has initial-coverage 90-day cost`);
      assert.ok(initial.ingestRunId != null, `cost for ${inp.rxcui} has ingest_run id`);
      const sr = initial.standardRetail;
      assert.strictEqual(sr.kind, 'copay', `drug ${inp.rxcui} standard-retail is a copay`);
      const computed = sr.dollars;
      return {
        drug: inp.drug, rxcui: inp.rxcui, tier: String(d.tier), flags: flagStr(d.flags),
        computed: `$${computed.toFixed(2)}`, expected: `$${inp.expected.toFixed(2)}`,
        match: Math.abs(computed - inp.expected) < 0.01 ? 'YES' : 'NO',
        _computed: computed,
      };
    });

    const meta = { planId: res.plan.planId, planName: res.plan.planName, formularyId: res.plan.formularyId, pufQuarter: '2026-Q1', basis: 'standard retail, 90-day, initial coverage' };

    const dbTable = renderTable(meta, dbRows.map(({ _computed, ...r }) => r));
    const goldenTable = renderTable(GOLDEN_META, GOLDEN_ROWS);

    console.log(dbTable);
    console.log();

    // THE acceptance assertion: DB-path table == Milestone 0 table, exactly.
    assert.strictEqual(dbTable, goldenTable, 'DB validation table must match Milestone 0 exactly');

    // Regimen total (each strength is its own claim/copay).
    const regimenComputed = dbRows.reduce((a, r) => a + r._computed, 0);
    const regimenExpected = INPUTS.reduce((a, i) => a + i.expected, 0);
    assert.strictEqual(regimenComputed.toFixed(2), '30.00');
    assert.strictEqual(regimenExpected.toFixed(2), '30.00');

    // Bonus: get_plans_for_county resolves the plan's county and lists the plan.
    const pc = await getPlansForCounty('26950', db); // St. Louis City SSA code
    assert.ok(pc.found && pc.plans.some((p) => p.planId === 'H4461-046'), 'get_plans_for_county returns the plan');

    console.log('ACCEPTANCE PASS — DB + get_drug_costs reproduce Milestone 0 exactly.');
    console.log(`  regimen total: computed $${regimenComputed.toFixed(2)} == expected $${regimenExpected.toFixed(2)}`);
    console.log(`  every number carries an ingest_run id (traceable)`);
    await db.end();
  } catch (e) {
    await db.end().catch(() => {});
    console.error('\nACCEPTANCE FAIL:', e.message);
    process.exit(1);
  } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    if (savedSup !== undefined) process.env.SUPABASE_DB_URL = savedSup;
    if (savedDir !== undefined) process.env.PGLITE_DIR = savedDir;
  }
}

main();
