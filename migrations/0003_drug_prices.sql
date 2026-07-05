-- PlanRobin — Pricing File (plan-level negotiated drug prices).
-- Source: CMS Quarterly PUF "Pricing File" (see SPUFRecordLayout-2026.pdf).
--   UNIT_COST is the AVERAGE UNIT COST (e.g. per pill) for the given days-supply at in-area
--   retail pharmacies — NOT a per-fill total. Turning a coinsurance rate into fill dollars would
--   require the quantity dispensed (the dose), which no PUF file provides and which we refuse to
--   invent. So we store the per-unit price as published and surface it honestly (per unit), never
--   fabricating an annual coinsurance total. (See project memory: pricing-grain principle.)
--   DAYS_SUPPLY here is the actual day count (30, 60, or 90) — NOT the beneficiary-cost-file code.
create table if not exists drug_prices (
  contract_id   text    not null,
  plan_id       text    not null,
  segment_id    text    not null,
  ndc           text    not null,          -- 11-digit proxy NDC (joins to drug_tiers.ndc)
  days_supply   integer not null,          -- 30, 60, or 90 (actual days, per the Pricing File)
  unit_cost     numeric(12,4),             -- average per-unit (e.g. per pill) negotiated cost
  ingest_run_id bigint  not null references ingest_runs(id)
);
-- Not a PK (keep loads simple; the ingest fully replaces this table each run, so no dupes).
create index if not exists idx_drug_prices_lookup
  on drug_prices (contract_id, plan_id, segment_id, ndc, days_supply);
