# PlanRobin — Milestone 0: Validate the Drug-Tier Lookup Engine

Goal: prove that public CMS formulary data + the RxNorm API can reproduce the drug
tiers and out-of-pocket costs of one real person's actual Medicare drug plan. This is
**validation only** — plain Node.js scripts and printed output. No app, no UI, no DB.

If the validation table matches her pharmacy receipts (or every mismatch has a
documented, understood cause), the engine is proven and these scripts become the
ingestion pipeline next session.

---

## Data sources

| What | Source | Downloaded |
|---|---|---|
| Quarterly Prescription Drug Plan Formulary, Pharmacy Network, and Pricing Information (PUF) | CMS: <https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/quarterly-prescription-drug-plan-formulary-pharmacy-network-and-pricing-information> | 2026-07-01 (by user) |
| RxNorm REST API (drug name/dose → RXCUI) | NLM: <https://rxnav.nlm.nih.gov/REST/> | live calls |

**PUF set used:** plan year **2026, Q1 refresh**, inner file `SPUF_2026_20260408.zip`
(published on/around 2026-04-08). A 2025-Q1 set (`SPUF_2025_20250410.zip`) is also on
disk but unused. The bundled `SPUFRecordLayout-2026.pdf`, `Methodology-SPUF-2026.pdf`,
and `AGREEMENT-FOR-USE.pdf` are the authoritative documentation and live in `data/`.

> ⚠️ **Quarter matching matters.** Her receipts reflect the formulary/pricing in effect
> when she filled the prescription. If those fills predate or postdate 2026-Q1, a
> mismatch may simply be a stale/ahead quarter — pull the matching quarter to confirm.

### Zip structure (triple-nested)

```
Quarterly ... Information.zip
└── 2026-Q1/
    ├── SPUFRecordLayout-2026.pdf        (record layout — the spec)
    ├── Methodology-SPUF-2026.pdf
    ├── AGREEMENT-FOR-USE.pdf
    └── SPUF_2026_20260408.zip           (the data)
        ├── plan information  PPUF_2026Q1.zip          → .txt
        ├── basic drugs formulary file  PPUF_2026Q1.zip → .txt  (~58 MB unzipped)
        ├── beneficiary cost file  PPUF_2026Q1.zip     → .txt
        ├── excluded drugs formulary file  ...zip       → .txt
        ├── geographic locator file  ...zip             → .txt
        ├── insulin beneficiary cost file  ...zip        → .txt
        ├── pharmacy networks file ... part 1-6.zip     (~2.3 GB, NOT extracted)
        └── pricing file PPUF_2026Q1.zip                (~219 MB, NOT extracted yet)
```

## Repo layout

```
scripts/          one script per pipeline step (+ lib/)
  lib/puf.js        streaming pipe-delimited row reader (constant memory)
  lib/config.js     file paths + fixed analysis parameters
  01_resolve_plan.js    STEP 3: CONTRACT-PLAN → FORMULARY_ID (+ official name, county)
  02_resolve_rxcui.js   STEP 4: meds → candidate drug-product RXCUIs (RxNorm)
  03_join_formulary.js  STEP 5: RXCUIs ⋈ formulary → tier + PA/ST/QL flags
  04_price.js           STEP 6: tier → dollars (beneficiary cost file)
  05_validate.js        STEP 7: final table + mismatch hypotheses
data/             downloads + extracted/ + ground-truth inputs — GITIGNORED (large + PII)
  *.template        format docs for the three ground-truth input files (tracked)
out/              pipeline hand-off JSON + the final validation table
```

## One-time data prep (extraction)

The scripts read the extracted `.txt` files under `data/extracted/`. To regenerate them
from the downloaded outer zip (Windows PowerShell, run from the repo root):

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
# 1) outer zip → inner SPUF zip + docs (into data/)
# 2) inner SPUF zip → the small component zips we need (into data/)
# 3) each component zip → its .txt (into data/extracted/)
```

We skip the pharmacy-networks parts (~2.3 GB) and the pricing file (~219 MB) for now;
neither is needed for tier + copay validation. The Pricing file is only required to turn
a **coinsurance** tier into dollars (see Limitations).

## How to run

```bash
# 0) create the three input files from the templates in data/
cp data/plan.txt.template data/plan.txt        # her CONTRACT-PLAN id (+ county)
cp data/meds.txt.template data/meds.txt         # her drugs: NAME | DOSE | brand|generic
cp data/expected.txt.template data/expected.txt # answer key: DRUG => $X.XX

# 1) run the pipeline
npm run 01:plan       # → out/plan.json     (confirm the printed PLAN_NAME matches her card!)
npm run 02:rxcui      # → out/rxcui.json
npm run 03:join       # → out/formulary_matches.json
npm run 04:price      # → out/priced.json
npm run 05:validate   # → out/validation_table.txt  (+ printed)
# or: npm run all
```

---

## File layout verification (checked against the real 2026-Q1 files)

All files are **pipe-delimited with a header row as the first line** (confirmed by
reading the actual first rows — noted here because older CMS PUFs shipped headerless).
Column counts match `SPUFRecordLayout-2026.pdf` exactly:

- Plan Information — 14 cols. Key: `CONTRACT_ID|PLAN_ID|SEGMENT_ID` → `FORMULARY_ID`, `PLAN_NAME`, `STATE`, `COUNTY_CODE`, `PDP_REGION_CODE`.
- Basic Drugs Formulary — 12 cols. Key: `FORMULARY_ID` + `RXCUI` + `NDC` → `TIER_LEVEL_VALUE`, `PRIOR_AUTHORIZATION_YN`, `STEP_THERAPY_YN`, `QUANTITY_LIMIT_*`, `SELECTED_DRUG_YN`.
- Beneficiary Cost — 24 cols. Key: `CONTRACT_ID|PLAN_ID|SEGMENT_ID` + `COVERAGE_LEVEL` + `TIER` + `DAYS_SUPPLY` → copay/coinsurance per pharmacy channel.
- Geographic Locator — 7 cols. Key: `COUNTY_CODE` → `STATENAME`, `COUNTY`, `PDP_REGION_CODE`.
- Excluded Drugs Formulary — 10 cols. Key: `CONTRACT_ID|PLAN_ID` + `RXCUI` (plan's covered Part-D-excluded/supplemental drugs).

### Key semantics used
- **RXCUI level:** the formulary keys on drug-**product** RXCUIs (SCD/SBD/GPCK/BPCK — carry
  strength + form), *not* bare ingredient RXCUIs. `02_resolve_rxcui.js` resolves to that
  level and keeps all candidates. Verified: resolved RXCUIs for lisinopril/atorvastatin/
  apixaban all appear in the basic formulary file.
- **Coverage phase:** `COVERAGE_LEVEL` 0=pre-deductible, 1=initial, 3=catastrophic. We use **1**.
- **Days supply:** `DAYS_SUPPLY` 1=30, 2=90, 3=other, 4=60. We use **1 (30-day)**.
- **Pharmacy:** standard retail = the `*_NONPREF` columns; preferred retail = `*_PREF`. We use **standard/NONPREF**.
- **Cost amount:** if `COST_TYPE=1` (copay) the amount is dollars (`2.65` → $2.65); if
  `COST_TYPE=2` (coinsurance) the amount is a rate (`.25` → 25%); `0` = not offered.

## Ground rules honored
- Never invent/estimate/hardcode a number. Every figure prints its source file + line.
- No support in the data ⇒ the scripts print **`NOT FOUND IN DATA`** loudly; drugs are
  never silently dropped.
- Layout is read from the files themselves, not assumed.

## Known limitations / open items
1. **Coinsurance → dollars needs two more inputs.** For a coinsurance tier (typ. tier 3+/
   specialty), dollars = rate × negotiated price × dispensed quantity. That requires the
   **Pricing file** (`UNIT_COST`, not yet extracted) *and* her **fill quantity** (not in
   CMS data). Copay tiers are exact today; coinsurance is reported as a % and flagged.
2. **Deductible phase.** If a tier has `DED_APPLIES_YN=Y` and she hadn't met the annual
   deductible at that fill, she paid the pre-deductible amount, not the initial-coverage
   copay. `04_price.js` captures both so `05_validate.js` can reason about it.
3. **Preferred vs standard pharmacy / mail order** materially change the number.
4. **Quarter must match the fill date** (see warning above).

## Status — VALIDATED ✅ (2026-07-02)

First real validation passed against one live Missouri Medicare Advantage (Part D) plan
and a real beneficiary's pharmacy receipts. Every computed figure matched the receipts,
per-claim and in total, and each traced to a specific CMS file + row. (Plan id, member,
and medication details are intentionally omitted here — the ground-truth inputs live only
in gitignored `data/` files, and the reproducible proof is in gitignored `out/`.)

**Key finding / gotcha worth carrying forward:** on the task-default **30-day** basis the
engine computed a value that did NOT match the receipts; the receipts were **90-day** fills
(`04_price.js 90` reproduced them exactly). **Days-supply — not a data error — drove the
discrepancy.** Deductible phase was ruled out from the file (`DED_APPLIES_YN=N` for the
relevant tier). Lesson: pricing must be evaluated at the beneficiary's actual days-supply /
pharmacy channel / coverage phase, not an assumed default (see the four pricing axes below).

Also confirmed: a regimen the beneficiary thinks of as a single daily dose can be **multiple
products** (e.g. two strengths of the same drug), each a separate claim with its own copay.
Price at the **claim grain and sum**; don't infer a clinical dose down into a single price.

Milestone 0 goal met: computed cost matches actual pharmacy cost with a documented,
understood basis. Per the roadmap, work stops here; next session turns these scripts into
the scheduled ingestion pipeline + `get_drug_costs` / `get_plans_for_county` query tools.
