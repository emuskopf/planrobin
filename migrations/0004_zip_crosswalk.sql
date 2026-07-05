-- PlanRobin — ZIP-first location entry (closes the Phase 0b SSA->FIPS crosswalk gap).
-- Plain PostgreSQL (Supabase); also runs unmodified in embedded PGlite for tests.
--
-- Two small public crosswalk tables let a beneficiary enter a ZIP instead of hunting for
-- their county. The resolution chain is:
--   ZIP  --zip_counties-->  county FIPS  --counties.fips_code-->  SSA code  -->  plans
-- counties.fips_code (nullable since 0001) is backfilled during ingest from the SSA<->FIPS
-- crosswalk, so get_plans_for_county finally honors a literal county_fips.
--
-- Every row carries its ingest_run id, exactly like the CMS data tables.

-- ---------------------------------------------------------------------------
-- ZIP -> county (5-digit FIPS), with the share of the ZIP's residential
-- addresses that fall in each county. A ZIP that straddles a county line has
-- one row per county; res_ratio orders them likeliest-first for disambiguation.
-- Source: Census ZCTA-to-County relationship file (ZHUPCT = housing-unit share).
-- ---------------------------------------------------------------------------
create table if not exists zip_counties (
  zip           text    not null,          -- 5-digit ZIP / ZCTA
  county_fips   text    not null,          -- 5-digit county FIPS (state+county)
  res_ratio     numeric(6,4),              -- 0..1 share of the ZIP's housing units in this county
  ingest_run_id bigint  not null references ingest_runs(id),
  primary key (zip, county_fips)
);
create index if not exists idx_zip_counties_zip on zip_counties (zip);

-- ---------------------------------------------------------------------------
-- SSA <-> FIPS county crosswalk. CMS keys plans by SSA state/county code; the
-- rest of the world (ZIP crosswalks, Census) uses FIPS. This table bridges them
-- and is the source for backfilling counties.fips_code.
-- Source: NBER SSA-FIPS state/county crosswalk.
-- ---------------------------------------------------------------------------
create table if not exists ssa_fips (
  ssa_code      text primary key,          -- 5-char SSA state/county code (matches counties.ssa_code)
  fips_code     text not null,             -- 5-digit county FIPS
  county_name   text,
  state         text,
  ingest_run_id bigint not null references ingest_runs(id)
);
create index if not exists idx_ssa_fips_fips on ssa_fips (fips_code);
