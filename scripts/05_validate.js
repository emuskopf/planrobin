'use strict';
// STEP 7 — Final validation table + written summary.
//
// Joins computed costs (out/priced.json) + formulary match detail (out/formulary_matches.json)
// against the ground-truth receipts (data/expected.txt) and prints:
//   DRUG | RXCUI | TIER | FLAGS | COMPUTED COST | EXPECTED COST | MATCH?
// then a short written summary with a hypothesis for every mismatch.
//
// expected.txt format, one per line:  DRUG NAME => $X.XX   (or "DRUG : X.XX")

const fs = require('fs');
const path = require('path');
const { INPUT, OUTFILE } = require('./lib/config');
const { renderTable } = require('../lib/validation_table');

function loadExpected() {
  if (!fs.existsSync(INPUT.expected)) return null;
  const map = [];
  for (const line of fs.readFileSync(INPUT.expected, 'utf8').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^(.*?)\s*(?:=>|:|=|->|\|)\s*\$?\s*(\d+(?:\.\d{1,2})?)/.exec(l);
    if (m) map.push({ name: m[1].trim(), dollars: parseFloat(m[2]) });
  }
  return map;
}

function strengths(s) {
  const out = []; const re = /(\d+(?:\.\d+)?)\s*(MG\/ML|MCG\/ML|MG|MCG|ML|G|%|UNITS?|MEQ)\b/gi;
  let m; while ((m = re.exec(s)) !== null) out.push(`${m[1]} ${m[2].toUpperCase()}`); return out;
}
// Name match with strength awareness: when two meds share a name but differ by strength
// (e.g. the same drug at 60 vs 30 mg), an expected line that names a strength must match it.
function findExpected(expected, input) {
  if (!expected) return null;
  const inName = input.name.toLowerCase();
  const inStr = strengths(input.dose || '');
  for (const e of expected) {
    const eStr = strengths(e.name);
    const eName = e.name.toLowerCase().replace(/(\d+(?:\.\d+)?)\s*(mg\/ml|mcg\/ml|mg|mcg|ml|g|%|units?|meq)\b/gi, '').trim();
    if (!(inName.includes(eName) || eName.includes(inName))) continue;
    if (eStr.length > 0 && inStr.length > 0 && !eStr.every((t) => inStr.includes(t))) continue; // strength must match
    return e;
  }
  return null;
}

function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }

function main() {
  const plan = JSON.parse(fs.readFileSync(OUTFILE.plan, 'utf8'));
  const formulary = JSON.parse(fs.readFileSync(OUTFILE.formulary, 'utf8'));
  const priced = JSON.parse(fs.readFileSync(OUTFILE.priced, 'utf8'));
  const expected = loadExpected();

  const fByKey = new Map(formulary.drugs.map((d) => [d.input.raw, d]));
  const rows = [];
  const summary = [];

  for (const p of priced.drugs) {
    const f = fByKey.get(p.input.raw) || { basicMatches: [] };
    const label = `${p.input.name}${p.input.dose ? ' ' + p.input.dose : ''}`;
    const exp = findExpected(expected, p.input);
    const rxcui = p.tier
      ? [...new Set(f.basicMatches.filter((b) => String(parseInt(b.tier, 10)) === p.tier).map((b) => b.rxcui))].join('/')
      : (f.candidateRxcuis || []).join('/') || '-';
    const flags = p.flags
      ? [p.flags.priorAuth && 'PA', p.flags.stepTherapy && 'ST', p.flags.quantityLimit && 'QL', p.flags.selectedDrug && 'NEG'].filter(Boolean).join(',') || '-'
      : '-';

    let computedStr, computedDollars = null;
    if (p.status === 'NOT_FOUND') computedStr = 'NOT FOUND IN DATA';
    else if (p.status === 'COST_NOT_FOUND') computedStr = 'NO COST ROW';
    else if (p.computed && p.computed.kind === 'copay') { computedDollars = p.computed.dollars; computedStr = `$${p.computed.dollars.toFixed(2)}`; }
    else if (p.computed && p.computed.kind === 'coinsurance') computedStr = `${(p.computed.rate * 100).toFixed(0)}% (needs price)`;
    else computedStr = p.computed ? p.computed.display : '-';

    const expectedStr = exp ? `$${exp.dollars.toFixed(2)}` : (expected ? 'n/a' : 'no expected.txt');

    let match;
    if (!exp) match = expected ? 'NO EXPECTED' : '—';
    else if (computedDollars === null) match = 'CANNOT COMPARE';
    else match = Math.abs(computedDollars - exp.dollars) < 0.01 ? 'YES' : 'NO';

    rows.push({ label, rxcui, tier: p.tier || '-', flags, computedStr, expectedStr, match, computedDollars, expectedDollars: exp ? exp.dollars : null });

    // Hypotheses for anything that isn't a clean YES.
    if (match === 'NO') {
      const h = [];
      if (p.computed && p.computed.dedApplies === 'Y') h.push(`deductible applies to tier ${p.tier} (plan deductible $${priced.deductible}); if she hasn't met it she pays pre-deductible cost, not the initial-coverage copay`);
      h.push('possible: preferred vs standard pharmacy (we used standard/NONPREF), or wrong RXCUI level, or stale quarter');
      summary.push(`- ${label}: computed ${computedStr} vs expected ${expectedStr}. Hypotheses: ${h.join('; ')}.`);
    } else if (match === 'CANNOT COMPARE') {
      summary.push(`- ${label}: tier ${p.tier} is COINSURANCE (${computedStr}); dollar amount needs the Pricing file (UNIT_COST) AND her dispensed quantity for a 30-day fill. Provide the fill quantity to complete.`);
    } else if (computedStr === 'NOT FOUND IN DATA') {
      summary.push(`- ${label}: NOT FOUND on formulary ${formulary.formularyId}. Hypotheses: RXCUI resolved at wrong level, drug is Part-D-excluded, brand/generic mismatch, or not covered by this plan.`);
    }
  }

  // Render table via the single-source renderer shared with the DB acceptance test.
  const meta = {
    planId: plan.target.raw, planName: plan.planName, formularyId: formulary.formularyId,
    pufQuarter: plan.pufQuarter, basis: `standard retail, ${priced.daysLabel || '30-day'}, initial coverage`,
  };
  const table = renderTable(meta, rows.map((r) => ({
    drug: r.label, rxcui: r.rxcui, tier: r.tier, flags: r.flags,
    computed: r.computedStr, expected: r.expectedStr, match: r.match,
  })));
  console.log('\n' + table + '\n');

  console.log('SUMMARY');
  const yes = rows.filter((r) => r.match === 'YES').length;
  const no = rows.filter((r) => r.match === 'NO').length;
  const cc = rows.filter((r) => r.match === 'CANNOT COMPARE').length;
  console.log(`  ${yes} match, ${no} mismatch, ${cc} cannot-compare (coinsurance), of ${rows.length} drugs.`);
  // Regimen subtotal: sum the per-claim line items (each strength is a separate fill/copay).
  const compSum = rows.reduce((a, r) => a + (r.computedDollars || 0), 0);
  const expSum = rows.reduce((a, r) => a + (r.expectedDollars || 0), 0);
  const anyExp = rows.some((r) => r.expectedDollars !== null);
  console.log(`  Regimen total (all fills summed, ${priced.daysLabel || '30-day'}): computed $${compSum.toFixed(2)}` +
    (anyExp ? ` vs expected $${expSum.toFixed(2)} -> ${Math.abs(compSum - expSum) < 0.01 ? 'MATCH' : 'DIFF'}` : ''));
  if (!expected) console.log('  (No data/expected.txt found — provide her per-fill receipts to score MATCH.)');
  if (summary.length) { console.log('\nMismatch / gap hypotheses:'); summary.forEach((s) => console.log(s)); }

  fs.writeFileSync(OUTFILE.validationTable, table + '\n');
  fs.writeFileSync(OUTFILE.validationJson, JSON.stringify({ generatedAt: new Date().toISOString(), plan: plan.target.raw, planName: plan.planName, formularyId: formulary.formularyId, pufQuarter: plan.pufQuarter, rows, summary }, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), OUTFILE.validationTable)} and ${path.relative(process.cwd(), OUTFILE.validationJson)}`);
}

main();
