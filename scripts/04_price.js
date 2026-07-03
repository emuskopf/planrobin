'use strict';
// STEP 6 — Translate tiers into dollars via the Beneficiary Cost file.
//
// A tier number is not a price. The beneficiary cost file maps
//   (CONTRACT_ID, PLAN_ID, SEGMENT_ID, COVERAGE_LEVEL, TIER, DAYS_SUPPLY) -> cost share,
// separately for preferred/standard retail and mail, as copay OR coinsurance.
//
// Per the task we use STANDARD (non-preferred) RETAIL, 30-DAY supply, INITIAL coverage.
// We ALSO capture the pre-deductible (COVERAGE_LEVEL=0) cost for the same tier, because
// "what she actually pays" depends on whether her deductible is met — a prime source of
// apparent mismatches that the final summary needs to reason about.
//
// Copay: the amount is dollars (e.g. 2.65 -> $2.65). Coinsurance: the amount is a rate
// (e.g. .25 -> 25%); converting that to dollars requires the negotiated drug price from
// the Pricing file, which is flagged here rather than guessed.

const fs = require('fs');
const path = require('path');
const { streamRows } = require('./lib/puf');
const { FILES, OUTFILE, PARAMS } = require('./lib/config');

// Interpret a (COST_TYPE, COST_AMT) pair for one pharmacy channel.
function interpret(type, amt) {
  if (type === '1') return { kind: 'copay', dollars: parseFloat(amt), rate: null };
  if (type === '2') return { kind: 'coinsurance', dollars: null, rate: parseFloat(amt) };
  return { kind: 'not_offered', dollars: null, rate: null };
}

// DAYS_SUPPLY codes in the beneficiary cost file.
const DAYS_CODE = { '30': '1', '60': '4', '90': '2' };
const DAYS_LABEL = { '1': '30-day', '2': '90-day', '3': 'other', '4': '60-day' };

async function main() {
  const plan = JSON.parse(fs.readFileSync(OUTFILE.plan, 'utf8'));
  const formulary = JSON.parse(fs.readFileSync(OUTFILE.formulary, 'utf8'));
  const contract = plan.target.contract, planId = plan.target.plan, segment = plan.target.segment;

  // Primary days-supply for the computed figure: default 30-day (task spec), CLI-overridable
  // (`node scripts/04_price.js 90`) because a beneficiary's real fills may be 90-day.
  const daysArg = (process.argv[2] || '').trim();
  const primaryDays = DAYS_CODE[daysArg] || PARAMS.DAYS_SUPPLY;

  // Tiers we actually need cost rows for.
  const neededTiers = new Set();
  for (const d of formulary.drugs) for (const t of d.tiers) neededTiers.add(String(parseInt(t, 10)));

  console.log('='.repeat(70));
  console.log(`STEP 6 — Price tiers for ${contract}-${planId}-${segment} (${plan.planName})`);
  console.log(`Primary basis: standard retail (NONPREF), ${DAYS_LABEL[primaryDays]} (DAYS_SUPPLY=${primaryDays}), initial coverage (COVERAGE_LEVEL=1)`);
  console.log(`Plan deductible (from plan info): ${plan.deductible}`);
  console.log('='.repeat(70));

  // Collect cost rows: key = `${coverageLevel}|${tier}|${daysSupply}` (all supplies, so we
  // can show a 30/60/90 matrix and reconcile against however she actually fills).
  const costRows = new Map();
  for await (const row of streamRows(FILES.beneficiaryCost)) {
    if (row.CONTRACT_ID !== contract || row.PLAN_ID !== planId || row.SEGMENT_ID !== segment) continue;
    const tierNorm = String(parseInt(row.TIER, 10));
    if (!neededTiers.has(tierNorm)) continue;
    if (row.COVERAGE_LEVEL !== '0' && row.COVERAGE_LEVEL !== '1') continue;
    costRows.set(`${row.COVERAGE_LEVEL}|${tierNorm}|${row.DAYS_SUPPLY}`, {
      coverageLevel: row.COVERAGE_LEVEL, tier: tierNorm, daysSupply: row.DAYS_SUPPLY,
      preferred: interpret(row.COST_TYPE_PREF, row.COST_AMT_PREF),
      standard: interpret(row.COST_TYPE_NONPREF, row.COST_AMT_NONPREF),
      mailPreferred: interpret(row.COST_TYPE_MAIL_PREF, row.COST_AMT_MAIL_PREF),
      standardMinMax: { min: row.COST_MIN_AMT_NONPREF, max: row.COST_MAX_AMT_NONPREF },
      tierSpecialty: row.TIER_SPECIALTY_YN, dedApplies: row.DED_APPLIES_YN,
      source: { file: path.basename(FILES.beneficiaryCost), line: row.__line },
    });
  }
  const money = (c) => c.kind === 'copay' ? `$${c.dollars.toFixed(2)}` : c.kind === 'coinsurance' ? `${(c.rate * 100).toFixed(0)}%` : 'n/a';

  const out = { generatedAt: new Date().toISOString(), plan: `${contract}-${planId}-${segment}`, deductible: plan.deductible, params: { ...PARAMS, DAYS_SUPPLY: primaryDays }, daysLabel: DAYS_LABEL[primaryDays], drugs: [] };

  for (const d of formulary.drugs) {
    const label = `${d.input.name}${d.input.dose ? ' ' + d.input.dose : ''}`;
    console.log(`\n${label}  [${d.status}]`);
    if (d.status === 'NOT_FOUND') {
      console.log('  no tier — skipping pricing');
      out.drugs.push({ input: d.input, status: d.status, tier: null, computed: null });
      continue;
    }
    // Use the lowest matched tier as the representative (a drug on a lower tier is what
    // a rational pharmacy adjudication would apply); multi-tier is flagged upstream.
    const tier = String(Math.min(...d.tiers.map((t) => parseInt(t, 10))));
    const initial = costRows.get(`1|${tier}|${primaryDays}`);
    const preDed = costRows.get(`0|${tier}|${primaryDays}`);

    // Full 30/60/90 × channel matrix for this tier at initial coverage — reconciliation aid.
    const matrix = {};
    for (const days of ['1', '4', '2']) {
      const r = costRows.get(`1|${tier}|${days}`);
      if (r) matrix[DAYS_LABEL[days]] = { standardRetail: money(r.standard), preferredRetail: money(r.preferred), preferredMail: money(r.mailPreferred) };
    }
    const matrixLine = Object.entries(matrix).map(([k, v]) => `${k}: std-retail ${v.standardRetail}, pref-mail ${v.preferredMail}`).join('  |  ');
    console.log(`  tier ${tier} matrix (initial coverage): ${matrixLine}`);

    if (!initial) {
      console.log(`  *** NOT FOUND IN DATA *** — no beneficiary-cost row for tier ${tier}, ${DAYS_LABEL[primaryDays]}, initial coverage.`);
      out.drugs.push({ input: d.input, status: 'COST_NOT_FOUND', tier, matrix, computed: null, preDeductible: preDed || null });
      continue;
    }

    const s = initial.standard;
    let display, computedDollars = null;
    if (s.kind === 'copay') { display = `$${s.dollars.toFixed(2)} copay`; computedDollars = s.dollars; }
    else if (s.kind === 'coinsurance') display = `${(s.rate * 100).toFixed(0)}% coinsurance (needs Pricing file for $)`;
    else display = 'standard retail NOT OFFERED — see preferred';

    console.log(`  TIER ${tier}${initial.tierSpecialty === 'Y' ? ' (specialty)' : ''} -> ${display}`);
    console.log(`     standard retail: type=${s.kind} ${s.kind === 'copay' ? '$' + s.dollars : s.kind === 'coinsurance' ? (s.rate * 100) + '%' : ''}` +
      `   | ${initial.source.file} line ${initial.source.line}`);
    if (s.kind === 'not_offered' && initial.preferred.kind === 'copay') console.log(`     preferred retail copay: $${initial.preferred.dollars.toFixed(2)}`);
    console.log(`     deductible applies to this tier: ${initial.dedApplies}` +
      (preDed ? `  | pre-deductible standard: ${preDed.standard.kind === 'copay' ? '$' + preDed.standard.dollars : preDed.standard.kind}` : ''));

    out.drugs.push({
      input: d.input, status: d.status, tier, matrix,
      flags: representativeFlags(d, tier),
      computed: { pharmacy: PARAMS.PHARMACY, coverageLevel: '1', daysSupply: primaryDays, daysLabel: DAYS_LABEL[primaryDays], ...s, display, dollars: computedDollars, source: initial.source, tierSpecialty: initial.tierSpecialty, dedApplies: initial.dedApplies },
      preDeductible: preDed ? { ...preDed.standard, source: preDed.source } : null,
    });
  }

  fs.writeFileSync(OUTFILE.priced, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), OUTFILE.priced)}`);
}

// Pull the flags for the representative (lowest) tier from the formulary matches.
function representativeFlags(drug, tier) {
  const rows = drug.basicMatches.filter((b) => String(parseInt(b.tier, 10)) === tier);
  const any = (f) => rows.some((r) => r[f]);
  return { priorAuth: any('priorAuth'), stepTherapy: any('stepTherapy'), quantityLimit: any('quantityLimit'), selectedDrug: any('selectedDrug') };
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
