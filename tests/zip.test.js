'use strict';
// ZIP-FIRST LOCATION ENTRY — end-to-end on the fixture crosswalks (real MO values).
// Proves: the crosswalks ingest with provenance; counties.fips_code is backfilled; a ZIP
// resolves to its county/counties (likeliest first); multi-county ZIPs disambiguate in the
// right order; out-of-state ZIPs are honest, not empty; and get_plans_for_county now honors a
// literal county FIPS while SSA-code and county-name lookups keep working.
//
//   node tests/zip.test.js       (exit 0 = pass, 1 = fail)
//
// Fixture ZIPs (tests/fixtures/zip_county_mo.txt — real Census values):
//   63011 -> St. Louis County (single, 100%)      63108 -> St. Louis City (single)
//   65041 -> Gasconade 87.6% / Montgomery 10.3% / Warren 2.1% (three-county, ordered)

const assert = require('assert');
const path = require('path');
const { getDb, applyMigrations } = require('../lib/db');
const { ingestInto } = require('../ingest/run');
const { resolveZip } = require('../tools/resolve_zip');
const { getPlansForCounty } = require('../tools/get_plans_for_county');
const { zipHandler } = require('../lib/api/handlers');

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

    console.log('Crosswalks ingest with provenance + full FIPS backfill:');
    const runChecks = (await db.query(`select checks, row_counts from ingest_runs order by id desc limit 1`)).rows[0];
    assert.ok(runChecks.row_counts.zip_counties > 0 && runChecks.row_counts.ssa_fips >= 100, 'crosswalk rows counted');
    assert.strictEqual(runChecks.checks.fips_coverage.with_fips, runChecks.checks.fips_coverage.total, 'every county got a FIPS');
    assert.strictEqual(runChecks.checks.fips_coverage.fraction, 1, 'fips coverage = 100%');
    // St. Louis County: SSA 26940 <-> FIPS 29189.
    const stlc = (await db.query(`select fips_code from counties where ssa_code='26940'`)).rows[0];
    assert.strictEqual(stlc.fips_code, '29189', 'St. Louis County backfilled to FIPS 29189');
    t('crosswalks loaded, provenance recorded, all counties FIPS-backfilled');

    console.log('\nSingle-county ZIP resolves silently (confirmation, not a question):');
    const one = await resolveZip('63011', db);
    assert.strictEqual(one.status, 'ok');
    assert.strictEqual(one.multi, false);
    assert.strictEqual(one.counties.length, 1);
    assert.strictEqual(one.counties[0].code, '26940');       // SSA key results/share use
    assert.strictEqual(one.counties[0].name, 'St. Louis');
    assert.strictEqual(one.counties[0].fips, '29189');
    t('63011 -> St. Louis County, single, SSA code carried through');

    console.log('\nMulti-county ZIP disambiguates, likeliest (highest residential ratio) first:');
    const many = await resolveZip('65041', db);
    assert.strictEqual(many.status, 'ok');
    assert.strictEqual(many.multi, true);
    assert.strictEqual(many.counties.length, 3);
    assert.deepStrictEqual(many.counties.map((c) => c.name), ['Gasconade', 'Montgomery', 'Warren']);
    // Strictly descending residential ratio — the ordering the UI shows as big buttons.
    const ratios = many.counties.map((c) => c.resRatio);
    assert.ok(ratios[0] > ratios[1] && ratios[1] > ratios[2], 'ratios strictly descending');
    assert.ok(Math.abs(ratios[0] - 0.8762) < 1e-6, 'Gasconade ratio matches the Census file');
    t('65041 -> 3 counties, ordered Gasconade > Montgomery > Warren by residential ratio');

    console.log('\nOut-of-state / unknown ZIP is honest, never an empty guess:');
    const oos = await resolveZip('90210', db);   // Beverly Hills, CA
    assert.strictEqual(oos.status, 'out_of_area');
    assert.deepStrictEqual(oos.counties, undefined);
    const bad = await resolveZip('123', db);
    assert.strictEqual(bad.status, 'invalid');
    t('90210 -> out_of_area; "123" -> invalid');

    console.log('\nzipHandler HTTP shape (400 on invalid, 200 otherwise):');
    assert.strictEqual((await zipHandler(db, '123')).status, 400);
    assert.strictEqual((await zipHandler(db, '90210')).status, 200);   // out_of_area is a normal 200 body
    assert.strictEqual((await zipHandler(db, '63011')).body.status, 'ok');
    t('zipHandler: invalid=400, out_of_area=200, ok=200');

    console.log('\nget_plans_for_county now honors literal FIPS; SSA + name still work:');
    // St. Louis City has fixture plans; look it up three ways and confirm they agree.
    const bySsa = await getPlansForCounty('26950', db);      // SSA
    const byFips = await getPlansForCounty('29510', db);     // FIPS (the newly-working path)
    const byName = await getPlansForCounty('St. Louis City', db);
    assert.ok(bySsa.found && byFips.found && byName.found);
    assert.strictEqual(byFips.county.ssaCode, '26950', 'FIPS lookup lands on the right SSA county');
    assert.strictEqual(byFips.county.fipsCode, '29510');
    assert.strictEqual(byFips.count, bySsa.count, 'FIPS and SSA lookups return the same plans');
    assert.strictEqual(byName.count, bySsa.count, 'name lookup unchanged');
    t('county_fips 29510 == ssa 26950 == "St. Louis City" (all three agree)');

    console.log(`\nALL ZIP TESTS PASSED (${passed}).`);
    await db.end();
  } catch (e) {
    await db.end().catch(() => {});
    console.error('\nZIP FAIL:', e.stack || e.message);
    process.exit(1);
  } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    if (savedSup !== undefined) process.env.SUPABASE_DB_URL = savedSup;
    if (savedDir !== undefined) process.env.PGLITE_DIR = savedDir;
  }
}

main();
