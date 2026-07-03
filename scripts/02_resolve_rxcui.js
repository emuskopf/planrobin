'use strict';
// STEP 4 — Resolve each med (name + dosage) to candidate drug-product RXCUIs.
//
// The formulary keys on specific drug-product RXCUIs (SCD/SBD/GPCK/BPCK level, which
// carry strength + dose form), NOT bare ingredient RXCUIs. So we resolve to the
// dosage-form level and keep ALL candidates per drug — plural, by design.
//
// Input  data/meds.txt, one drug per line:  NAME | DOSE | brand|generic
//   e.g.  lisinopril | 10 mg | generic
//         Eliquis | 5 mg | brand
//   (DOSE and brand|generic are optional; a bare name still resolves, just wider.)
// Output out/rxcui.json
//
// Uses only the free public RxNorm REST API (https://rxnav.nlm.nih.gov/REST/).

const fs = require('fs');
const path = require('path');
const { INPUT, OUTFILE, OUT } = require('./lib/config');

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const PRODUCT_TTYS = new Set(['SCD', 'SBD', 'GPCK', 'BPCK']);
const BRAND_TTYS = new Set(['SBD', 'BPCK']);

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
}

function parseMedsLine(line) {
  const parts = line.split('|').map((s) => s.trim());
  const name = parts[0];
  const dose = parts[1] || '';
  let brandGeneric = (parts[2] || '').toLowerCase();
  if (!['brand', 'generic'].includes(brandGeneric)) brandGeneric = '';
  return { raw: line.trim(), name, dose, brandGeneric };
}

// Extract normalized strength tokens ("10 MG", "12.5 MG", "5 MG/ML") from any string.
// Order matters: match the compound units (MG/ML) before the bare ones (MG).
function strengthTokens(s) {
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(MG\/ML|MCG\/ML|MG|MCG|ML|G|%|UNITS?|MEQ)\b/gi;
  let m;
  while ((m = re.exec(s)) !== null) out.push(`${m[1]} ${m[2].toUpperCase()}`);
  return out;
}

// A candidate matches the dose only if EVERY requested strength token appears as a
// whole strength in the candidate's own name. Comparing token-sets (not substrings)
// avoids "2.5 MG" spuriously matching a requested "5 MG", and "5 MG/ML" matching "5 MG".
function nameMatchesDose(candName, tokens) {
  if (tokens.length === 0) return null; // no dose specified → cannot judge
  const have = new Set(strengthTokens(candName));
  return tokens.every((t) => have.has(t));
}

async function candidatesForName(name) {
  // Primary: /drugs?name= returns product concepts grouped by TTY.
  const j = await getJson(`${RXNAV}/drugs.json?name=${encodeURIComponent(name)}`);
  const groups = (j.drugGroup && j.drugGroup.conceptGroup) || [];
  const cands = [];
  for (const g of groups) {
    if (!PRODUCT_TTYS.has(g.tty)) continue;
    for (const p of g.conceptProperties || []) {
      cands.push({ rxcui: p.rxcui, tty: p.tty, name: p.name });
    }
  }
  return cands;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const medsPath = process.argv[2] || INPUT.meds; // CLI override mainly for smoke tests
  if (!fs.existsSync(medsPath)) {
    throw new Error(`No meds file at ${medsPath}. Create data/meds.txt, one drug per line: "NAME | DOSE | brand|generic".`);
  }
  const lines = fs.readFileSync(medsPath, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) throw new Error('data/meds.txt is empty.');

  console.log('='.repeat(70));
  console.log(`STEP 4 — Resolve ${lines.length} med(s) to candidate RXCUIs via RxNorm`);
  console.log('='.repeat(70));

  const drugs = [];
  for (const line of lines) {
    const med = parseMedsLine(line);
    const tokens = strengthTokens(med.dose);
    const notes = [];
    let raw = [];
    try {
      raw = await candidatesForName(med.name);
    } catch (e) {
      notes.push(`RxNorm /drugs failed: ${e.message}`);
    }
    // Fallback: approximate match on the name if nothing came back.
    if (raw.length === 0) {
      try {
        const ax = await getJson(`${RXNAV}/approximateTerm.json?term=${encodeURIComponent(med.name)}&maxEntries=5`);
        const cand = ((ax.approximateGroup && ax.approximateGroup.candidate) || [])[0];
        if (cand && cand.name) {
          notes.push(`name not found directly; approximated to "${cand.name}"`);
          raw = await candidatesForName(cand.name);
        }
      } catch (e) { notes.push(`approximateTerm failed: ${e.message}`); }
    }

    // Annotate + filter by dose and brand/generic.
    const inputIsCombo = /\band\b|\//.test(med.name);
    let candidates = raw.map((c) => ({
      ...c,
      isBrand: BRAND_TTYS.has(c.tty),
      isCombination: / \/ /.test(c.name), // e.g. "hydrochlorothiazide 12.5 MG / lisinopril 10 MG ..."
      doseMatched: nameMatchesDose(c.name, tokens),
    }));

    const doseHits = candidates.filter((c) => c.doseMatched === true);
    if (tokens.length > 0) {
      if (doseHits.length > 0) {
        candidates = doseHits; // keep only the ones at the specified strength
      } else {
        notes.push(`dose "${med.dose}" (${tokens.join(', ')}) matched no candidate name — keeping all strengths, FLAG for review`);
      }
    }
    // Drop combination products when the user asked for a single ingredient (a bare
    // "lisinopril 10 mg" should not resolve to lisinopril/HCTZ combos). Keep them if
    // the input itself names a combination, or if nothing single-ingredient remains.
    if (!inputIsCombo) {
      const single = candidates.filter((c) => !c.isCombination);
      if (single.length > 0 && single.length < candidates.length) {
        notes.push(`dropped ${candidates.length - single.length} combination-product candidate(s) (input is single-ingredient)`);
        candidates = single;
      }
    }
    // Brand/generic preference: keep the requested class if the user was explicit and both exist.
    if (med.brandGeneric === 'brand') {
      const b = candidates.filter((c) => c.isBrand);
      if (b.length) candidates = b; else notes.push('requested brand but only generic products found');
    } else if (med.brandGeneric === 'generic') {
      const gc = candidates.filter((c) => !c.isBrand);
      if (gc.length) candidates = gc; else notes.push('requested generic but only brand products found');
    }

    if (candidates.length === 0) notes.push('NO CANDIDATE RXCUIs RESOLVED');

    console.log(`\n${med.name}${med.dose ? ' ' + med.dose : ''}${med.brandGeneric ? ' [' + med.brandGeneric + ']' : ''}`);
    console.log(`  ${candidates.length} candidate rxcui(s): ${candidates.map((c) => `${c.rxcui}(${c.tty})`).join(', ') || '(none)'}`);
    for (const c of candidates.slice(0, 8)) console.log(`     ${c.rxcui} | ${c.tty} | ${c.name}`);
    notes.forEach((n) => console.log(`  NOTE: ${n}`));

    drugs.push({ input: med, strengthTokens: tokens, candidates, candidateRxcuis: candidates.map((c) => c.rxcui), notes });
  }

  const out = { generatedAt: new Date().toISOString(), source: 'RxNorm REST API (rxnav.nlm.nih.gov)', drugs };
  fs.writeFileSync(OUTFILE.rxcui, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), OUTFILE.rxcui)}`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
