-- PlanRobin Phase 0b — initial schema.
-- Plain PostgreSQL (Supabase). Also runs unmodified in embedded PGlite for tests.
-- Every data row references the ingest_run that produced it, so every number is traceable.
--
-- Scope note: the pipeline is currently loaded Missouri-only (scope='MO' on ingest_runs).
-- County identity note: CMS ships 5-char *SSA* state/county codes, NOT FIPS. We store the
-- SSA code as the county key; fips_code is nullable and stays NULL until an external
-- SSA->FIPS crosswalk is loaded (documented gap — see README).

-- ---------------------------------------------------------------------------
-- Audit: one row per ingestion attempt. Append-only; data tables point back here.
-- ---------------------------------------------------------------------------
create table if not exists ingest_runs (
  id            bigint generated always as identity primary key,
  puf_quarter   text        not null,               -- e.g. '2026-Q1'
  source_file   text        not null,               -- e.g. 'SPUF_2026_20260408.zip'
  download_date date,
  scope         text        not null default 'MO',
  status        text        not null default 'running', -- running|completed|halted|failed
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  row_counts    jsonb,   -- {counties, plans, plan_counties, formularies, drug_tiers, tier_costs}
  file_stats    jsonb,   -- [{name, rows, sha256}]
  checks        jsonb,   -- validation-gate comparison vs the prior completed run
  notes         text
);

-- ---------------------------------------------------------------------------
-- Reference / dimension tables
-- ---------------------------------------------------------------------------
create table if not exists counties (
  ssa_code      text primary key,          -- 5-char SSA state/county code (CMS Geographic Locator)
  fips_code     text,                       -- nullable; requires external SSA->FIPS crosswalk
  name          text not null,
  state         text not null,
  pdp_region    text,
  ingest_run_id bigint not null references ingest_runs(id)
);

create table if not exists formularies (
  formulary_id  text primary key,
  contract_year text,
  ingest_run_id bigint not null references ingest_runs(id)
);

-- ---------------------------------------------------------------------------
-- Plans, keyed contract+plan+segment, with county service area in plan_counties.
-- ---------------------------------------------------------------------------
create table if not exists plans (
  contract_id   text not null,
  plan_id       text not null,
  segment_id    text not null,
  plan_name     text,
  contract_name text,
  plan_type     text,                       -- 'MA' | 'MA-regional' | 'PDP'
  snp           text,                       -- 0=not SNP,1=chronic,2=dual,3=institutional
  premium       numeric(12,2),
  deductible    numeric(12,2),
  formulary_id  text references formularies(formulary_id),
  ingest_run_id bigint not null references ingest_runs(id),
  primary key (contract_id, plan_id, segment_id)
);

create table if not exists plan_counties (
  contract_id   text not null,
  plan_id       text not null,
  segment_id    text not null,
  ssa_code      text not null,
  ingest_run_id bigint not null references ingest_runs(id),
  primary key (contract_id, plan_id, segment_id, ssa_code)
);
create index if not exists idx_plan_counties_ssa on plan_counties (ssa_code);

-- ---------------------------------------------------------------------------
-- Formulary drug rows: (formulary_id + rxcui + ndc) -> tier + restriction flags.
-- ---------------------------------------------------------------------------
create table if not exists drug_tiers (
  formulary_id   text    not null,
  rxcui          text    not null,
  ndc            text    not null,
  tier           integer not null,
  prior_auth     boolean not null default false,
  step_therapy   boolean not null default false,
  quantity_limit boolean not null default false,
  ql_amount      text,
  ql_days        text,
  selected_drug  boolean not null default false,   -- Medicare Drug Price Negotiation Program
  ingest_run_id  bigint  not null references ingest_runs(id),
  primary key (formulary_id, rxcui, ndc)
);
create index if not exists idx_drug_tiers_rxcui on drug_tiers (formulary_id, rxcui);

-- ---------------------------------------------------------------------------
-- Beneficiary cost sharing: (plan + coverage phase + tier + days supply) ->
-- copay/coinsurance by pharmacy channel.
--   coverage_level: 0=pre-deductible, 1=initial, 3=catastrophic
--   days_supply:    1=30, 2=90, 3=other, 4=60
--   cost_type_*:    0=not offered, 1=copay ($ amount), 2=coinsurance (rate, .25=25%)
-- ---------------------------------------------------------------------------
create table if not exists tier_costs (
  contract_id            text    not null,
  plan_id                text    not null,
  segment_id             text    not null,
  coverage_level         integer not null,
  tier                   integer not null,
  days_supply            integer not null,
  cost_type_pref         integer,
  cost_amt_pref          numeric(12,4),
  cost_type_nonpref      integer,
  cost_amt_nonpref       numeric(12,4),
  cost_type_mail_pref    integer,
  cost_amt_mail_pref     numeric(12,4),
  cost_type_mail_nonpref integer,
  cost_amt_mail_nonpref  numeric(12,4),
  tier_specialty         boolean,
  ded_applies            boolean,
  ingest_run_id          bigint  not null references ingest_runs(id),
  primary key (contract_id, plan_id, segment_id, coverage_level, tier, days_supply)
);
