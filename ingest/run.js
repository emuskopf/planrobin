'use strict';
// Idempotent Missouri-scoped ingestion:  fetch(locate) -> parse(stream) -> validate -> load.
//
//   node ingest/run.js
//
// Env:
//   DATABASE_URL / SUPABASE_DB_URL   target Postgres (else embedded PGlite)
//   PGLITE_DIR                       persist PGlite to a dir (else in-memory)
//   SOURCE_DIR                       dir of extracted PUF .txt files (default: data/extracted)
//   PUF_QUARTER, PUF_SOURCE_FILE, DOWNLOAD_DATE   lineage overrides
//   GATE_MAX_DELTA (default 0.25)    max fractional row-count/premium shift vs prior run
//   FORCE=1                          bypass the validation gate (loudly recorded)
//
// Idempotency: the data tables are fully replaced inside one transaction each run, tagged
// with the new ingest_run id. Re-running the same quarter yields identical data, no dupes.
// The validation gate runs BEFORE the destructive load; on a wild shift it halts and loads
// nothing (exit code 3).

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { getDb, applyMigrations } = require('../lib/db');
const { parseMissouri } = require('./parse');
const cfg = require('../scripts/lib/config');

const CHUNK = 1000;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function median(nums) {
  const a = nums.filter((n) => n != null).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function computeStats(p) {
  const prem = p.plans.map((x) => x.premium).filter((n) => n != null);
  const tierCounts = {};
  for (const d of p.drugTiers) { const t = String(d.tier); tierCounts[t] = (tierCounts[t] || 0) + 1; }
  const tierDist = {};
  for (const t of Object.keys(tierCounts)) tierDist[t] = p.drugTiers.length ? tierCounts[t] / p.drugTiers.length : 0;
  return {
    row_counts: {
      counties: p.counties.length, plans: p.plans.length, plan_counties: p.planCounties.length,
      formularies: p.formularies.length, drug_tiers: p.drugTiers.length, tier_costs: p.tierCosts.length,
      insulin_costs: p.insulinCosts.length, drug_prices: (p.drugPrices || []).length,
      ssa_fips: (p.ssaFips || []).length, zip_counties: (p.zipCounties || []).length,
    },
    premium_mean: prem.length ? prem.reduce((a, b) => a + b, 0) / prem.length : null,
    premium_median: median(prem),
    tier_dist: tierDist,
  };
}

// Compare current stats to the prior completed run; return {halt, flags}.
function gate(prior, cur, maxDelta) {
  const flags = [];
  if (!prior) return { halt: false, flags, note: 'no prior completed run — gate skipped (first load)' };
  const rel = (a, b) => (a === 0 ? (b === 0 ? 0 : 1) : Math.abs(b - a) / a);
  for (const k of Object.keys(cur.row_counts)) {
    const old = (prior.row_counts || {})[k];
    if (old != null && old > 0 && rel(old, cur.row_counts[k]) > maxDelta) {
      flags.push(`row count ${k}: ${old} -> ${cur.row_counts[k]} (>${(maxDelta * 100).toFixed(0)}%)`);
    }
  }
  if (prior.premium_mean != null && cur.premium_mean != null && prior.premium_mean > 0 && rel(prior.premium_mean, cur.premium_mean) > maxDelta) {
    flags.push(`premium mean: ${prior.premium_mean.toFixed(2)} -> ${cur.premium_mean.toFixed(2)}`);
  }
  const tiers = new Set([...Object.keys(prior.tier_dist || {}), ...Object.keys(cur.tier_dist || {})]);
  for (const t of tiers) {
    const a = (prior.tier_dist || {})[t] || 0, b = (cur.tier_dist || {})[t] || 0;
    if (Math.abs(b - a) > 0.15) flags.push(`tier ${t} share: ${(a * 100).toFixed(1)}% -> ${(b * 100).toFixed(1)}%`);
  }
  return { halt: flags.length > 0, flags };
}

async function bulkInsert(db, table, columns, rows, runId) {
  const cols = [...columns, 'ingest_run_id'];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const tuples = chunk.map((row, r) => {
      const ph = cols.map((_, c) => `$${r * cols.length + c + 1}`);
      for (const col of columns) values.push(row[col]);
      values.push(runId);
      return `(${ph.join(',')})`;
    });
    await db.query(`insert into ${table} (${cols.join(',')}) values ${tuples.join(',')}`, values);
  }
}

// Core ingestion against an already-open, migrated db. Returns { runId, status, stats }.
// Pricing honesty metric: of the MO (plan, NDC) pairs whose tier is COINSURANCE at initial
// coverage / standard retail, how many have a real per-unit price in the Pricing file (30-day)?
async function priceCoverage(db) {
  const r = await db.query(`
    with coins as (
      select distinct p.contract_id, p.plan_id, p.segment_id, dt.ndc
        from plans p
        join drug_tiers dt on dt.formulary_id = p.formulary_id
        join tier_costs tc on tc.contract_id = p.contract_id and tc.plan_id = p.plan_id
             and tc.segment_id = p.segment_id and tc.tier = dt.tier
             and tc.coverage_level = 1 and tc.days_supply = 1 and tc.cost_type_nonpref = 2
    ),
    priced as (
      select c.* from coins c
        join drug_prices dp on dp.contract_id = c.contract_id and dp.plan_id = c.plan_id
             and dp.segment_id = c.segment_id and dp.ndc = c.ndc and dp.days_supply = 30
    )
    select (select count(*) from coins)::int total, (select count(*) from priced)::int priced`);
  const { total, priced } = r.rows[0];
  return { total, priced, fraction: total ? priced / total : null };
}

// Throws on failure (caller decides exit behavior). Does NOT close db.
async function ingestInto(db, opts = {}) {
  const sourceDir = opts.sourceDir || process.env.SOURCE_DIR || cfg.EXTRACTED;
  const crosswalkDir = opts.crosswalkDir || process.env.CROSSWALK_DIR || cfg.CROSSWALKS;
  const quarter = opts.quarter || process.env.PUF_QUARTER || cfg.PUF_QUARTER;
  const sourceFile = opts.sourceFile || process.env.PUF_SOURCE_FILE || cfg.PUF_SOURCE_FILE;
  const dlMatch = /_(\d{4})(\d{2})(\d{2})\./.exec(sourceFile);
  const downloadDate = opts.downloadDate || process.env.DOWNLOAD_DATE || (dlMatch ? `${dlMatch[1]}-${dlMatch[2]}-${dlMatch[3]}` : null);
  const maxDelta = opts.maxDelta != null ? opts.maxDelta : parseFloat(process.env.GATE_MAX_DELTA || '0.25');
  const force = opts.force != null ? opts.force : process.env.FORCE === '1';
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  log('='.repeat(70));
  log(`PlanRobin ingest — quarter ${quarter}, scope MO, source dir:\n  ${sourceDir}`);
  log('='.repeat(70));

  // Create the run row up front so every loaded row can reference it.
  const runRes = await db.query(
    `insert into ingest_runs (puf_quarter, source_file, download_date, scope, status) values ($1,$2,$3,'MO','running') returning id`,
    [quarter, sourceFile, downloadDate]
  );
  const runId = runRes.rows[0].id;
  log(`ingest_run id = ${runId}`);

  try {
    log('Parsing (streaming, MO filter)…');
    const parsed = await parseMissouri(sourceDir, { crosswalkDir });
    const stats = computeStats(parsed);
    log('Row counts:', JSON.stringify(stats.row_counts));

    // Checksums + per-file row counts for the audit trail. Optional components (pricing,
    // crosswalks) may be absent -> their file path is null; skip those rather than crashing.
    const fileStats = [];
    for (const [k, f] of Object.entries(parsed.files)) { if (f) fileStats.push({ role: k, name: path.basename(f), sha256: await sha256File(f) }); }

    // Validation gate vs the prior completed run.
    const priorRes = await db.query(`select row_counts, checks from ingest_runs where status='completed' and scope='MO' order by id desc limit 1`);
    const priorStats = priorRes.rows[0] ? { ...(priorRes.rows[0].checks || {}), row_counts: priorRes.rows[0].row_counts } : null;
    const g = gate(priorStats, stats, maxDelta);
    const checks = { ...stats, gate: g, maxDelta };

    if (g.halt && !force) {
      await db.query(`update ingest_runs set status='halted', finished_at=now(), row_counts=$2, file_stats=$3, checks=$4, notes=$5 where id=$1`,
        [runId, stats.row_counts, JSON.stringify(fileStats), JSON.stringify(checks), 'HALTED by validation gate']);
      return { runId, status: 'halted', stats, flags: g.flags };
    }
    if (g.halt && force) log('Gate flags present but FORCE=1 — proceeding:', g.flags.join('; '));

    // Idempotent load: replace all data in one transaction, tagged with this run.
    log('Loading (transactional replace)…');
    await db.query('BEGIN');
    for (const t of ['zip_counties', 'ssa_fips', 'drug_prices', 'insulin_costs', 'tier_costs', 'drug_tiers', 'plan_counties', 'counties', 'plans', 'formularies']) await db.query(`delete from ${t}`);
    await bulkInsert(db, 'formularies', ['formulary_id', 'contract_year'], parsed.formularies, runId);
    await bulkInsert(db, 'counties', ['ssa_code', 'fips_code', 'name', 'state', 'pdp_region'], parsed.counties, runId);
    await bulkInsert(db, 'ssa_fips', ['ssa_code', 'fips_code', 'county_name', 'state'], parsed.ssaFips || [], runId);
    await bulkInsert(db, 'zip_counties', ['zip', 'county_fips', 'res_ratio'], parsed.zipCounties || [], runId);
    // Backfill county FIPS from the SSA<->FIPS crosswalk so county_fips lookups + ZIP->county resolution work.
    await db.query(`update counties c set fips_code = s.fips_code from ssa_fips s where s.ssa_code = c.ssa_code`);
    await bulkInsert(db, 'plans', ['contract_id', 'plan_id', 'segment_id', 'plan_name', 'contract_name', 'plan_type', 'snp', 'premium', 'deductible', 'formulary_id'], parsed.plans, runId);
    await bulkInsert(db, 'plan_counties', ['contract_id', 'plan_id', 'segment_id', 'ssa_code'], parsed.planCounties, runId);
    await bulkInsert(db, 'drug_tiers', ['formulary_id', 'rxcui', 'ndc', 'tier', 'prior_auth', 'step_therapy', 'quantity_limit', 'ql_amount', 'ql_days', 'selected_drug'], parsed.drugTiers, runId);
    await bulkInsert(db, 'tier_costs', ['contract_id', 'plan_id', 'segment_id', 'coverage_level', 'tier', 'days_supply', 'cost_type_pref', 'cost_amt_pref', 'cost_type_nonpref', 'cost_amt_nonpref', 'cost_type_mail_pref', 'cost_amt_mail_pref', 'cost_type_mail_nonpref', 'cost_amt_mail_nonpref', 'tier_specialty', 'ded_applies'], parsed.tierCosts, runId);
    await bulkInsert(db, 'insulin_costs', ['contract_id', 'plan_id', 'segment_id', 'tier', 'days_supply', 'copay_pref', 'copay_nonpref', 'copay_mail_pref', 'copay_mail_nonpref', 'coin_pref', 'coin_nonpref', 'coin_mail_pref', 'coin_mail_nonpref'], parsed.insulinCosts, runId);
    await bulkInsert(db, 'drug_prices', ['contract_id', 'plan_id', 'segment_id', 'ndc', 'days_supply', 'unit_cost'], parsed.drugPrices || [], runId);
    await db.query('COMMIT');

    // Price coverage: of the MO (plan, drug NDC) pairs that are COINSURANCE (initial coverage,
    // standard retail), how many gained a real per-unit price? This is the honesty metric for the
    // pricing file — we surface prices only where the file actually has them.
    const pc = await priceCoverage(db);
    checks.price_coverage = pc;
    log(`Price coverage (coinsurance NDCs): ${pc.priced}/${pc.total}` + (pc.total ? ` (${(pc.fraction * 100).toFixed(1)}%)` : ''));

    // FIPS coverage: what share of MO counties got a FIPS backfilled from the SSA<->FIPS crosswalk?
    // Should be ~100% once the crosswalk is loaded; a dip means a county has no crosswalk match.
    const fc = (await db.query(`select count(*)::int total, count(fips_code)::int with_fips from counties`)).rows[0];
    checks.fips_coverage = { total: fc.total, with_fips: fc.with_fips, fraction: fc.total ? fc.with_fips / fc.total : null };
    log(`FIPS coverage (counties backfilled): ${fc.with_fips}/${fc.total}`);

    await db.query(`update ingest_runs set status='completed', finished_at=now(), row_counts=$2, file_stats=$3, checks=$4 where id=$1`,
      [runId, stats.row_counts, JSON.stringify(fileStats), JSON.stringify(checks)]);

    log(`\nOK — run ${runId} completed.`);
    log(g.note ? `  gate: ${g.note}` : `  gate: passed (${g.flags.length} flags)`);
    return { runId, status: 'completed', stats, flags: g.flags };
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    try { await db.query(`update ingest_runs set status='failed', finished_at=now(), notes=$2 where id=$1`, [runId, String(e.message)]); } catch (_) {}
    throw e;
  }
}

// CLI entrypoint: open db from env, migrate if needed, ingest, exit loudly on halt/failure.
async function main() {
  const db = await getDb();
  if (db.kind === 'pglite' || process.env.AUTO_MIGRATE === '1') { await applyMigrations(db); }
  try {
    const res = await ingestInto(db);
    if (res.status === 'halted') {
      console.error('\n*** VALIDATION GATE HALT — no data loaded ***');
      res.flags.forEach((f) => console.error('  - ' + f));
      console.error('Re-run with FORCE=1 to override after review.');
      await db.end();
      process.exit(3);
    }
    await db.end();
  } catch (e) {
    try { await db.end(); } catch (_) {}
    console.error('INGEST FAILED:', e.message);
    process.exit(1);
  }
}

module.exports = { ingestInto, computeStats, gate };

if (require.main === module) main();
