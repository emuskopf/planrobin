'use strict';
// Central config: file paths and the fixed analysis parameters.
// Keep this boring and explicit — these scripts become the ingestion pipeline.

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const EXTRACTED = path.join(DATA, 'extracted');
const CROSSWALKS = path.join(DATA, 'crosswalks'); // committed MO ZIP/SSA/FIPS crosswalks
const OUT = path.join(ROOT, 'out');

// The quarter/plan-year of the PUF set we extracted. Documented in README.
const PUF_QUARTER = '2026-Q1';
const PUF_SOURCE_FILE = 'SPUF_2026_20260408.zip';

// Extracted pipe-delimited component files (see README for how they were unzipped).
const FILES = {
  planInfo: path.join(EXTRACTED, 'plan information  PPUF_2026Q1.txt'),
  basicFormulary: path.join(EXTRACTED, 'basic drugs formulary file  PPUF_2026Q1.txt'),
  excludedFormulary: path.join(EXTRACTED, 'excluded drugs formulary file  PPUF_2026Q1.txt'),
  beneficiaryCost: path.join(EXTRACTED, 'beneficiary cost file  PPUF_2026Q1.txt'),
  geoLocator: path.join(EXTRACTED, 'geographic locator file PPUF_2026Q1.txt'),
};

// Ground-truth input files (gitignored — real person's PII).
const INPUT = {
  plan: path.join(DATA, 'plan.txt'),       // one line: CONTRACT-PLAN[-SEGMENT], e.g. S5678-042 or H1234-001-000
  meds: path.join(DATA, 'meds.txt'),       // one drug per line: NAME | DOSE | brand|generic
  expected: path.join(DATA, 'expected.txt'), // one per line: DRUG NAME => $X.XX
};

// Pipeline hand-off files.
const OUTFILE = {
  plan: path.join(OUT, 'plan.json'),
  rxcui: path.join(OUT, 'rxcui.json'),
  formulary: path.join(OUT, 'formulary_matches.json'),
  priced: path.join(OUT, 'priced.json'),
  validationJson: path.join(OUT, 'validation.json'),
  validationTable: path.join(OUT, 'validation_table.txt'),
};

// Fixed analysis parameters for this validation (task spec: standard 30-day
// retail, initial coverage phase). These map to codes in the beneficiary cost file.
const PARAMS = {
  COVERAGE_LEVEL: '1', // 0=pre-deductible, 1=initial coverage, 3=catastrophic
  DAYS_SUPPLY: '1',    // 1=30 days, 2=90, 3=other, 4=60
  PHARMACY: 'NONPREF', // standard (non-preferred) retail; PREF = preferred retail
};

module.exports = { ROOT, DATA, EXTRACTED, CROSSWALKS, OUT, PUF_QUARTER, PUF_SOURCE_FILE, FILES, INPUT, OUTFILE, PARAMS };
