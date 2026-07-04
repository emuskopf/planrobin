'use strict';
// BUILD-TIME generator (run locally, output committed). Produces the explicit RXCUI lists
// the statutory overrides key on, SCOPED to products actually on our Missouri formularies.
// Re-run after each quarterly ingest and REVIEW the printed names before committing.
//
//   PGLITE_DIR=.pglite node tools/overrides/build-classification.js
//
// INSULIN source: RxNorm/RxClass ATC class A10A ("Insulins and analogues") — reliable and
//   complete for insulin (incl. insulin+GLP-1 combos Xultophy/Soliqua, which CMS treats as
//   covered insulin under the $35 cap). Expanded to product RXCUIs.
//
// VACCINE source: an EXPLICIT curated list of ACIP-recommended ADULT vaccine brands that are
//   covered under Part D, per the CDC ACIP Adult Immunization Schedule (2025) and CMS MLN908764
//   "Medicare Part D Vaccines". We do NOT use ATC J07 — RxNorm's J07 mapping both misses the
//   key adult vaccines (Shingrix, RSV) and pulls in pediatric DTaP combos. Part B–administered
//   vaccines (influenza, pneumococcal, COVID) are intentionally excluded — those are $0 under
//   Part B, not this Part D provision.
//   MAINTENANCE: when ACIP updates the adult schedule or new products launch, edit VACCINE_BRANDS
//   and re-run. Hep B has partial Part B overlap; HPV is ACIP-recommended through age 45.

const fs = require('fs');
const path = require('path');
const { getDb } = require('../../lib/db');

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const PRODUCT_TTYS = new Set(['SCD', 'SBD', 'GPCK', 'BPCK']);
const gj = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

// ACIP-recommended adult vaccines covered under Part D (brand -> ACIP category, for review).
const VACCINE_BRANDS = [
  ['Shingrix', 'zoster (shingles)'],
  ['Boostrix', 'Tdap'], ['Adacel', 'Tdap'], ['Tenivac', 'Td'],
  ['Arexvy', 'RSV'], ['Abrysvo', 'RSV'], ['mRESVIA', 'RSV'],
  ['Havrix', 'hepatitis A'], ['Vaqta', 'hepatitis A'], ['Twinrix', 'hepatitis A/B'],
  ['Heplisav-B', 'hepatitis B'], ['Engerix-B', 'hepatitis B'], ['PreHevbrio', 'hepatitis B'],
  ['Gardasil 9', 'HPV'],
  ['M-M-R II', 'MMR'], ['Varivax', 'varicella'],
  ['Bexsero', 'meningococcal B'], ['Trumenba', 'meningococcal B'],
  ['Menveo', 'meningococcal ACWY'], ['MenQuadfi', 'meningococcal ACWY'], ['Penbraya', 'meningococcal ABCWY'],
];

async function insulinProducts() {
  const cm = await gj(`${RXNAV}/rxclass/classMembers.json?classId=A10A&relaSource=ATC`);
  const ings = ((cm.drugMemberGroup && cm.drugMemberGroup.drugMember) || []).map((m) => m.minConcept.rxcui);
  const products = new Map();
  for (const ing of ings) {
    const rel = await gj(`${RXNAV}/rxcui/${ing}/related.json?tty=SCD+SBD+GPCK+BPCK`);
    for (const g of (rel.relatedGroup && rel.relatedGroup.conceptGroup) || []) {
      for (const p of g.conceptProperties || []) products.set(p.rxcui, p.name);
    }
  }
  return products;
}

async function vaccineProducts() {
  const products = new Map(); // rxcui -> { name, category }
  for (const [brand, category] of VACCINE_BRANDS) {
    const j = await gj(`${RXNAV}/drugs.json?name=${encodeURIComponent(brand)}`);
    for (const g of (j.drugGroup && j.drugGroup.conceptGroup) || []) {
      if (!PRODUCT_TTYS.has(g.tty)) continue;
      for (const p of g.conceptProperties || []) products.set(p.rxcui, { name: p.name, category });
    }
  }
  return products;
}

async function main() {
  const db = await getDb();
  const inForm = new Set((await db.query('select distinct rxcui from drug_tiers')).rows.map((r) => String(r.rxcui)));

  const insP = await insulinProducts();
  const insulin = [...insP].filter(([rx]) => inForm.has(rx)).map(([rxcui, name]) => ({ rxcui, name })).sort((a, b) => a.name.localeCompare(b.name));

  const vacP = await vaccineProducts();
  const vaccines = [...vacP].filter(([rx]) => inForm.has(rx)).map(([rxcui, v]) => ({ rxcui, name: v.name, category: v.category })).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const out = {
    generatedAt: new Date().toISOString(),
    note: 'Explicit override classification, scoped to MO drug_tiers. Insulin: ATC A10A. Vaccines: curated ACIP adult Part D brands (CDC ACIP Adult Schedule 2025 + CMS MLN908764). Review names before committing; re-run each quarter (see build-classification.js header).',
    insulin: { source: 'RxClass ATC A10A (Insulins and analogues)', count: insulin.length, rxcuis: insulin },
    vaccines: { source: 'Curated ACIP adult Part D vaccines (see VACCINE_BRANDS); excludes Part B flu/pneumococcal/COVID', count: vaccines.length, rxcuis: vaccines },
  };
  fs.writeFileSync(path.join(__dirname, 'data', 'classification.json'), JSON.stringify(out, null, 2));

  console.log(`INSULIN (${insulin.length}) — sample:`); insulin.slice(0, 6).forEach((x) => console.log(`  ${x.rxcui}  ${x.name}`));
  console.log(`\nVACCINES (${vaccines.length}):`); vaccines.forEach((x) => console.log(`  ${x.rxcui}  [${x.category}]  ${x.name.slice(0, 60)}`));
  console.log('\nWrote tools/overrides/data/classification.json');
  await db.end();
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
