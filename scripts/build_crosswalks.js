'use strict';
// Build the Missouri ZIP/SSA/FIPS crosswalk files the ingest pipeline loads.
//
//   node scripts/build_crosswalks.js            # write data/crosswalks/*.txt (full MO)
//   node scripts/build_crosswalks.js --fixtures # ALSO refresh tests/fixtures/ subset
//
// Downloads two small, authoritative, public-domain crosswalks and filters them to
// Missouri, normalizing to the pipe-delimited format the rest of the pipeline uses
// (so ingest can reuse streamRows). The committed output is what ingest actually loads —
// deterministic, no live network at deploy or test time. Re-run this when a newer vintage
// is published (bump the URLs + the README "Downloaded" date).
//
// Sources (see README "Data sources"):
//   SSA<->FIPS : NBER SSA-FIPS state/county crosswalk (public domain).
//   ZIP->county: US Census ZCTA-to-County Relationship File. ZHUPCT = the share of the
//                ZCTA's HOUSING UNITS in that county = the residential ratio we order by.
//                (The HUD-USPS crosswalk is the modern equivalent but is now gated behind a
//                HUD account/API token; the Census file is the free authoritative substitute.)

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'crosswalks');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures');

const NBER_URL = 'https://data.nber.org/ssa-fips-state-county-crosswalk/2018/ssa_fips_state_county2018.csv';
const CENSUS_URL = 'https://www2.census.gov/geo/docs/maps-data/data/rel/zcta_county_rel_10.txt';
const STATE = 'MO';          // NBER 'state' value
const STATE_FIPS = '29';     // Census STATE (FIPS) value for Missouri

// A small, documented set of real MO ZIPs for the test fixture — one single-county STL-metro
// ZIP, one real 3-county ZIP (for disambiguation ordering), plus a couple more single-county.
const FIXTURE_ZIPS = new Set(['63011', '63108', '64108', '65201', '65041']);

function get(url) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'PlanRobin-crosswalk-builder/1.0 (+https://planrobin.com)' } };
    https.get(url, opts, (r) => {
      if (r.statusCode !== 200) { reject(new Error(`HTTP ${r.statusCode} for ${url}`)); return; }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

// Minimal RFC-4180-ish single-line CSV parser (handles quoted fields with embedded commas).
function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const stripBom = (s) => s.replace(/^﻿/, '');

async function buildSsaFips() {
  const text = stripBom(await get(NBER_URL));
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = parseCsvLine(lines[0]).map((h) => h.replace(/"/g, ''));
  const ix = (n) => header.indexOf(n);
  const iCounty = ix('county'), iState = ix('state'), iSsa = ix('ssacd'), iFips = ix('fipscounty');
  const rows = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c[iState] !== STATE) continue;
    const ssa = c[iSsa].trim(), fips = c[iFips].trim();
    if (!ssa || !fips || seen.has(ssa)) continue;
    seen.add(ssa);
    rows.push({ ssa_code: ssa, fips_code: fips, county_name: c[iCounty].trim(), state: STATE });
  }
  rows.sort((a, b) => a.ssa_code.localeCompare(b.ssa_code));
  return rows;
}

async function buildZipCounty() {
  const text = stripBom(await get(CENSUS_URL));
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const header = lines[0].split(',');
  const iZip = header.indexOf('ZCTA5'), iState = header.indexOf('STATE'),
        iGeoid = header.indexOf('GEOID'), iHu = header.indexOf('ZHUPCT');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c[iState] !== STATE_FIPS) continue;
    const zip = c[iZip].trim(), fips = c[iGeoid].trim();
    const pct = parseFloat(c[iHu]);
    if (!/^\d{5}$/.test(zip) || !/^\d{5}$/.test(fips)) continue;
    const ratio = Number.isFinite(pct) ? Math.round((pct / 100) * 10000) / 10000 : '';
    rows.push({ zip, county_fips: fips, res_ratio: ratio });
  }
  // Order for readability + so the file itself reads likeliest-first per ZIP.
  rows.sort((a, b) => a.zip.localeCompare(b.zip) || (Number(b.res_ratio) - Number(a.res_ratio)));
  return rows;
}

function writePipe(file, header, rows, cols) {
  const lines = [header.join('|')];
  for (const r of rows) lines.push(cols.map((c) => r[c]).join('|'));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(`  wrote ${path.relative(ROOT, file)}  (${rows.length} rows)`);
}

async function main() {
  const fixtures = process.argv.includes('--fixtures');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Building MO crosswalks…');
  const ssa = await buildSsaFips();
  const zip = await buildZipCounty();
  if (ssa.length < 100) throw new Error(`SSA<->FIPS: expected ~115 MO rows, got ${ssa.length}`);
  if (zip.length < 500) throw new Error(`ZIP->county: expected many MO rows, got ${zip.length}`);

  writePipe(path.join(OUT_DIR, 'ssa_fips_mo.txt'), ['ssa_code', 'fips_code', 'county_name', 'state'], ssa, ['ssa_code', 'fips_code', 'county_name', 'state']);
  writePipe(path.join(OUT_DIR, 'zip_county_mo.txt'), ['zip', 'county_fips', 'res_ratio'], zip, ['zip', 'county_fips', 'res_ratio']);

  if (fixtures) {
    const zipSub = zip.filter((r) => FIXTURE_ZIPS.has(r.zip));
    if (!zipSub.some((r) => r.zip === '65041')) throw new Error('fixture ZIP 65041 (multi-county) missing from source');
    // Full SSA<->FIPS (only ~115 rows) so the fixture can backfill every county's fips_code.
    writePipe(path.join(FIXTURE_DIR, 'ssa_fips_mo.txt'), ['ssa_code', 'fips_code', 'county_name', 'state'], ssa, ['ssa_code', 'fips_code', 'county_name', 'state']);
    writePipe(path.join(FIXTURE_DIR, 'zip_county_mo.txt'), ['zip', 'county_fips', 'res_ratio'], zipSub, ['zip', 'county_fips', 'res_ratio']);
  }
  console.log('Done.');
}

main().catch((e) => { console.error('build_crosswalks FAILED:', e.message); process.exit(1); });
