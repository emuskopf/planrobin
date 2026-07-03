'use strict';
// STEP 5 — Join candidate RXCUIs against the basic formulary for our FORMULARY_ID.
//
// Reads out/plan.json (FORMULARY_ID, contract/plan) and out/rxcui.json (candidates).
// Streams the basic drugs formulary ONCE, collecting rows for our formulary whose
// RXCUI is a candidate. Also checks the excluded-drugs formulary (a plan's covered
// Part-D-excluded / supplemental drugs) as a secondary source before declaring a
// drug NOT FOUND. Output: per drug → matched RXCUI → tier → PA/ST/QL flags.

const fs = require('fs');
const path = require('path');
const { streamRows } = require('./lib/puf');
const { FILES, OUTFILE } = require('./lib/config');

function y(v) { return v === 'Y' || v === '1'; }

async function main() {
  const plan = JSON.parse(fs.readFileSync(OUTFILE.plan, 'utf8'));
  const rx = JSON.parse(fs.readFileSync(OUTFILE.rxcui, 'utf8'));
  if (!plan.formularyId) throw new Error('out/plan.json has no single formularyId — resolve the plan first.');
  const formularyId = plan.formularyId;
  const contract = plan.target.contract;
  const planId = plan.target.plan;

  console.log('='.repeat(70));
  console.log(`STEP 5 — Join candidate RXCUIs to formulary ${formularyId} (${plan.planName})`);
  console.log('='.repeat(70));

  // rxcui -> [drug index]. A candidate could in principle map to >1 input drug.
  const rxcuiToDrugs = new Map();
  rx.drugs.forEach((d, i) => {
    for (const c of d.candidates) {
      if (!rxcuiToDrugs.has(c.rxcui)) rxcuiToDrugs.set(c.rxcui, []);
      rxcuiToDrugs.get(c.rxcui).push(i);
    }
  });

  const basicByDrug = rx.drugs.map(() => []);
  const excludedByDrug = rx.drugs.map(() => []);

  // --- Basic formulary (keyed on FORMULARY_ID) ---
  for await (const row of streamRows(FILES.basicFormulary)) {
    if (row.FORMULARY_ID !== formularyId) continue;
    const idx = rxcuiToDrugs.get(row.RXCUI);
    if (!idx) continue;
    const rec = {
      rxcui: row.RXCUI, ndc: row.NDC, tier: row.TIER_LEVEL_VALUE,
      priorAuth: y(row.PRIOR_AUTHORIZATION_YN), stepTherapy: y(row.STEP_THERAPY_YN),
      quantityLimit: y(row.QUANTITY_LIMIT_YN), qlAmount: row.QUANTITY_LIMIT_AMOUNT, qlDays: row.QUANTITY_LIMIT_DAYS,
      selectedDrug: y(row.SELECTED_DRUG_YN),
      source: { file: path.basename(FILES.basicFormulary), line: row.__line },
    };
    for (const i of idx) basicByDrug[i].push(rec);
  }

  // --- Excluded drugs formulary (keyed on CONTRACT_ID + PLAN_ID) ---
  for await (const row of streamRows(FILES.excludedFormulary)) {
    if (row.CONTRACT_ID !== contract || row.PLAN_ID !== planId) continue;
    const idx = rxcuiToDrugs.get(row.RXCUI);
    if (!idx) continue;
    const rec = {
      rxcui: row.RXCUI, tier: row.TIER,
      priorAuth: y(row.PRIOR_AUTH_YN), stepTherapy: y(row.STEP_THERAPY_YN),
      quantityLimit: y(row.QUANTITY_LIMIT_YN), qlAmount: row.QUANTITY_LIMIT_AMOUNT, qlDays: row.QUANTITY_LIMIT_DAYS,
      cappedBenefit: y(row.CAPPED_BENEFIT_YN),
      source: { file: path.basename(FILES.excludedFormulary), line: row.__line },
    };
    for (const i of idx) excludedByDrug[i].push(rec);
  }

  const out = { generatedAt: new Date().toISOString(), formularyId, planName: plan.planName, drugs: [] };

  for (let i = 0; i < rx.drugs.length; i++) {
    const d = rx.drugs[i];
    const basic = basicByDrug[i];
    const excluded = excludedByDrug[i];
    const tiers = [...new Set(basic.map((b) => b.tier))].sort();
    let status;
    if (basic.length > 0) status = tiers.length > 1 ? 'MATCHED_MULTI_TIER' : 'MATCHED';
    else if (excluded.length > 0) status = 'MATCHED_EXCLUDED_FILE';
    else status = 'NOT_FOUND';

    const label = `${d.input.name}${d.input.dose ? ' ' + d.input.dose : ''}`;
    console.log(`\n${label}`);
    if (status === 'NOT_FOUND') {
      console.log(`  *** NOT FOUND IN DATA *** — none of [${d.candidateRxcuis.join(', ') || '(no candidates)'}] ` +
        `are on formulary ${formularyId} or in the excluded-drugs file for ${contract}-${planId}.`);
    } else {
      // Collapse identical (rxcui|tier|flags) rows for readability, keeping row refs.
      const seen = new Map();
      for (const b of basic) {
        const k = `${b.rxcui}|${b.tier}|${b.priorAuth}|${b.stepTherapy}|${b.quantityLimit}`;
        if (!seen.has(k)) seen.set(k, { ...b, ndcCount: 0, lines: [] });
        const e = seen.get(k); e.ndcCount++; e.lines.push(b.source.line);
      }
      for (const e of seen.values()) {
        const flags = [e.priorAuth && 'PA', e.stepTherapy && 'ST', e.quantityLimit && `QL(${e.qlAmount}/${e.qlDays}d)`, e.selectedDrug && 'NEGOTIATED'].filter(Boolean).join(',') || '-';
        console.log(`  rxcui ${e.rxcui} -> TIER ${e.tier} | flags ${flags} | ${e.ndcCount} NDC(s) | ${path.basename(FILES.basicFormulary)} line ${e.lines[0]}`);
      }
      if (status === 'MATCHED_MULTI_TIER') console.log(`  *** MULTIPLE TIERS across candidates: ${tiers.join(', ')} — FLAG ***`);
      if (excluded.length > 0) console.log(`  (also appears in excluded-drugs file: tier(s) ${[...new Set(excluded.map((e) => e.tier))].join(', ')})`);
    }

    out.drugs.push({ input: d.input, candidateRxcuis: d.candidateRxcuis, status, tiers, basicMatches: basic, excludedMatches: excluded });
  }

  fs.writeFileSync(OUTFILE.formulary, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), OUTFILE.formulary)}`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
