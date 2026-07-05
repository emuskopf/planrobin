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
| Quarterly Prescription Drug Plan Formulary, Pharmacy Network, and Pricing Information (PUF) — dataset page | CMS: <https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers/quarterly-prescription-drug-plan-formulary-pharmacy-network-and-pricing-information> | 2026-07-01 (by user) |
| 2026-Q1 direct download (the `SPUF_2026_20260408.zip` used by ingest — set as the `PUF_URL` for the ingest job) | CMS: <https://data.cms.gov/sites/default/files/2026-04/65e8dafd-c42b-4c2a-93c2-551bbc80bef9/SPUF_2026_20260408.zip> | 2026-04-08 (published) |
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

---

# Phase 0b — Ingestion pipeline + first typed tools

Turns the Milestone 0 scripts into a repeatable database pipeline and exposes the first two
typed query tools. Still no app / UI. Scoped to **Missouri** plans.

## Layout added
```
migrations/0001_init.sql   Supabase (Postgres) schema — run it yourself against Supabase
lib/db.js                  one query() API over Supabase (pg) OR embedded PGlite (local/CI)
lib/cost.js                CMS cost-code interpretation (copay/coinsurance) + plan-id parse
lib/validation_table.js    single-source renderer shared by M0 script and the acceptance test
ingest/fetch.sh            download + unnest the quarterly PUF zip -> the 4 needed .txt files
ingest/parse.js            streaming MO-scope parser -> rows
ingest/run.js              idempotent job: create run -> parse -> validation gate -> load
tools/get_drug_costs.js    typed tool (pure SQL, structured return, ingest_run id on every #)
tools/get_plans_for_county.js
tests/acceptance.test.js   hermetic regression: DB path must equal Milestone 0, exactly
tests/fixtures/            small REAL PUF subset for the acceptance test
.github/workflows/         acceptance (every push) + ingest (quarterly cron + manual)
```

## Schema (7 tables, every row carries `ingest_run_id`)
`ingest_runs` (audit: quarter, source file, download date, row counts, per-file sha256,
validation-gate result), `counties`, `formularies`, `plans` (contract+plan+segment),
`plan_counties` (service area), `drug_tiers` (formulary+rxcui+ndc → tier + PA/ST/QL),
`tier_costs` (plan + coverage phase + tier + days-supply → copay/coinsurance by channel).

## Run it
```bash
# Local / CI (no setup): embedded PGlite, in-memory.
npm test                    # hermetic acceptance test (ingests fixture, asserts == M0)

# Full Missouri ingest into a local PGlite dir, then query with the tools:
PGLITE_DIR=.pglite npm run ingest
PGLITE_DIR=.pglite node tools/get_drug_costs.js H4461-046 596934 596930
PGLITE_DIR=.pglite node tools/get_plans_for_county.js 26950

# Against Supabase: apply migrations/0001_init.sql yourself, then:
DATABASE_URL='postgres://…' bash ingest/fetch.sh "<PUF_URL>" ./puf
DATABASE_URL='postgres://…' SOURCE_DIR=./puf npm run ingest
```

## Design notes
- **Idempotent:** each run replaces all data inside one transaction, tagged with the new
  `ingest_run` id. Re-running the same quarter yields identical data — no duplicates.
- **Validation gate:** before the (destructive) load, row counts + premium mean + tier-share
  distribution are compared to the prior completed run. A shift beyond `GATE_MAX_DELTA`
  (default 25%) **halts** the run (exit 3), loads nothing, and records the flags. `FORCE=1`
  overrides after review. In CI a halt fails the job red.
- **Tools are pure SQL, no LLM,** and return structured objects (not strings) with the
  source `ingest_run_id` attached to every number. A drug not on formulary → `found:false`
  (never dropped); an unknown plan/county → a `NOT FOUND` result.
- **County identity:** CMS ships **SSA** state/county codes, not FIPS. We store the SSA code
  as the key; `counties.fips_code` is nullable and stays NULL until an SSA→FIPS crosswalk is
  loaded. `get_plans_for_county` therefore accepts an SSA code or county name (the nominal
  `county_fips` parameter is generalized rather than faking a crosswalk).
- **`star_rating` is a documented placeholder** (`null`) — star ratings are not in this PUF.

## Acceptance / regression test
`tests/acceptance.test.js` spins up in-memory PGlite, applies the migrations, ingests the
real fixture in `tests/fixtures/`, calls `get_drug_costs`, and asserts the rendered table is
**byte-for-byte identical** to the Milestone 0 result (duloxetine 60/30 mg, tier 2, 90-day
standard retail $15 each, $30 regimen). It also asserts every number carries an ingest-run
id. Runs on every push via `.github/workflows/acceptance.yml`. Regenerate the fixture with
`npm run make-fixtures` (needs the full extracted PUF).

## Supabase / CI setup (for the maintainer)
1. Run `migrations/0001_init.sql` against your Supabase project.
2. Repo **secret** `DATABASE_URL` = your Supabase Postgres connection string.
3. Repo **variable** `PUF_URL` = the current quarter's zip download URL. `fetch.sh` accepts
   either the outer "Quarterly…" wrapper or the direct `SPUF_*.zip`. For 2026-Q1 that is
   `https://data.cms.gov/sites/default/files/2026-04/65e8dafd-c42b-4c2a-93c2-551bbc80bef9/SPUF_2026_20260408.zip`
   (or pass `puf_url` when dispatching the workflow manually).
4. The `ingest` workflow runs quarterly (1st of Jan/Apr/Jul/Oct, 09:00 UTC) and on demand.

---

# Phase 1 — The Drug Checker (first public artifact)

A one-page drug cost checker for planrobin.com. **Zero LLM calls** — deterministic end to
end: RxNorm autocomplete → typed tools → results table. Missouri-only beta.

## Layout added
```
site/                   static frontend (Cloudflare Pages output dir)
  index.html, styles.css, app.js
functions/api/          Cloudflare Pages Functions (thin wrappers over the typed tools)
  counties.js  meta.js  results.js  rxnorm/search.js
lib/rxnorm.js           misspelling-tolerant RxNorm product search (no model)
lib/api/handlers.js     deterministic handlers over get_plans_for_county + get_drug_costs
lib/db_pg.js            postgres.js adapter (Workers/Node) — same query() API as lib/db.js
lib/pages.js            Pages Function helpers (envDb, json)
dev/server.js           local Node dev server (serves site + api, backed by PGlite)
wrangler.toml           Pages config (output dir, nodejs_compat)
scripts/query.js        ad-hoc CLI for the typed tools
```

## Architecture (no credentials in the browser)
```
browser (site/app.js)  ──►  /api/* Pages Functions  ──►  typed tools  ──►  Supabase
                            └► /api/rxnorm/search  ──►  RxNorm REST (proxied + cached)
```
The browser talks only to our own `/api/*`. `DATABASE_URL` stays server-side (Pages env
var). RxNorm is proxied through a Function so caching/rate-limits live in one place
(`Cache-Control: max-age=86400`). **The medication list never leaves the browser except as
RXCUIs** in the `/api/results` request.

## Endpoints
- `GET /api/counties` → Missouri counties for the dropdown.
- `GET /api/meta` → data provenance from `ingest_runs` (quarter + load date), never hardcoded.
- `GET /api/rxnorm/search?q=` → product candidates (rxcui, name, tty, brand/generic).
  Misspellings like `duloxatine` resolve via RxNorm approximate-match — no model.
- `POST /api/results` `{ county, rxcuis[] }` → every plan in the county with premium, type,
  and per-drug tier + PA/ST/QL + copay/coinsurance. Sorted by estimated annual cost
  (`12×premium + 12×30-day copays`, shown in plain sight). Drugs off-formulary render as
  “Not covered by this plan’s formulary” and push the plan down — never omitted.

## Run locally (no Cloudflare, no Supabase)
```bash
PGLITE_DIR=.pglite npm run ingest     # once, to populate the local DB (Phase 0b)
npm run dev                           # http://localhost:8788  (serves site + api on PGlite)
```

## Deploy (Cloudflare Pages + Supabase)
1. Connect the repo to Cloudflare Pages. Build output dir `site`; Functions auto-discovered
   in `functions/`. `wrangler.toml` sets `nodejs_compat` (required by postgres.js).
2. Add Pages env var **`DATABASE_URL`** = your Supabase **transaction pooler** URL (port
   6543). It is read only in Functions and never shipped to the client.
3. Point the domain at the Pages project. Test Functions locally with
   `npx wrangler pages dev` (uses the real Functions against your `DATABASE_URL`).

### Supabase free tier PAUSES when idle — keep it warm
The Supabase free tier **pauses a project after ~1 week with no database activity**; the next
visitor would then hit a cold/sleeping DB (first request errors or stalls while it wakes).
- **Wake procedure (if it ever pauses):** open the project in the Supabase dashboard and click
  **Restore/Resume**, or just run any query (the next successful ingest/keep-warm run wakes it).
- **Prevention (automated):** `.github/workflows/keep-warm.yml` pings a DB-touching endpoint
  (`/api/meta`, cache-busted) **every 3 days** — well inside the ~1-week window — so the DB
  never goes idle long enough to pause. No secrets; fails red if the site/DB stops answering.

## Performance & caching
The results path was an N+1 (a 4-drug × 82-plan search issued **~1,200 DB round trips**). It's now
a fixed **3 queries** regardless of plans × drugs (`lib/api/results_data.js`):
1. plans in the county + formulary year + provenance (county CTE, meta lateral),
2. `drug_tiers` for all `(formulary, rxcui)`,
3. `tier_costs` + `drug_prices` + `insulin_costs` in one round trip (`UNION ALL` of `jsonb` rows).

Big tables stay on their indexes (`idx_drug_tiers_rxcui`, the `tier_costs`/`drug_prices` PK/lookup
indexes, `idx_plan_counties_ssa`) — verified with `EXPLAIN ANALYZE`; no sequential scans on large
tables. Per-request timing is logged as one structured line (`{path, ms, dbMs, queries, cache}`,
`lib/perf.js`) visible in the Cloudflare dashboard — no third-party analytics.

**What's cached, for how long, and how it busts** (data changes only quarterly, so we cache hard):

| Response | Where | TTL | Bust |
|---|---|---|---|
| `POST /api/results` | edge (`caches.default`) | 24h | key includes the **current `ingest_run` id** — a new quarterly ingest changes the id, so every key changes and the cache busts automatically (the run id is itself cached per-colo for 5 min) |
| `GET /api/counties`, `/api/meta` | browser/edge `Cache-Control` | 24h + 7d stale-while-revalidate | new quarter changes the payload; SWR serves instantly while refreshing |
| `GET /api/rxnorm/search` | browser/edge `Cache-Control` + per-isolate map | 7d + 7d SWR | drug vocabulary moves slowly |

The results cache is **fail-safe**: if the Cache API is unavailable (e.g. the Node dev server) or
any step throws, it silently serves the live result. Verify a hit with two identical requests —
the second returns header `x-cache: HIT` with `queries: 0` in its log line.

## Trust furniture (built in)
- Every results view shows **“Data: CMS {quarter} … loaded {date}”**, rendered from
  `ingest_runs` — verified live (`2026-Q1`, loaded July 2 2026).
- Persistent plain-English disclaimer: education, not advice or enrollment.
- The annual-cost **formula is shown on-screen** — no black-box scoring. Coinsurance drugs
  can’t be dollar-totaled without a price, so they show as `%` and the estimate is flagged
  incomplete (`$X+`) rather than silently under-counted.
- Brand vs generic is an **explicit pick** from the suggestions, never a silent substitution.
