-- PlanRobin — Insulin Beneficiary Cost File (for the $35 insulin cap override).
-- Plan-level insulin cost sharing keyed by plan + tier + days-supply, per pharmacy channel.
-- Source: CMS Quarterly PUF "Insulin Beneficiary Cost File" (see SPUFRecordLayout-2026.pdf).
--   copay_* are dollar amounts; coin_* are rates (0.25 = 25%). Blank in the file -> NULL.
--   TIER is NULL for "defined standard" plans (the file omits it) — lookups fall back to the
--   NULL-tier row for such plans.
create table if not exists insulin_costs (
  contract_id       text    not null,
  plan_id           text    not null,
  segment_id        text    not null,
  tier              integer,          -- nullable: omitted for defined-standard plans
  days_supply       integer not null, -- 1=30, 2=90, 3=other, 4=60
  copay_pref        numeric(12,4),
  copay_nonpref     numeric(12,4),
  copay_mail_pref   numeric(12,4),
  copay_mail_nonpref numeric(12,4),
  coin_pref         numeric(12,4),
  coin_nonpref      numeric(12,4),
  coin_mail_pref    numeric(12,4),
  coin_mail_nonpref numeric(12,4),
  ingest_run_id     bigint  not null references ingest_runs(id)
);
-- Not a PK (tier is nullable); the ingest fully replaces this table each run, so no dupes.
create index if not exists idx_insulin_costs_lookup
  on insulin_costs (contract_id, plan_id, segment_id, tier, days_supply);
