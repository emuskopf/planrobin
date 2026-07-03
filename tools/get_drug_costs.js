'use strict';
// TYPED TOOL — get_drug_costs(rxcuis, planId, db)
//
// Pure SQL, no LLM. Returns a structured object (not a string) describing, for each
// requested RXCUI on the given plan's formulary: its tier, restriction flags, and
// cost-sharing (copay/coinsurance) by coverage phase, days-supply, and pharmacy channel.
// EVERY number carries the ingest_run id that produced it, for full traceability.
//
// A drug that is not on the plan's formulary is reported found:false (never dropped).
// A plan that does not exist returns { found:false }.
//
// db is a handle from lib/db.js getDb(); the caller owns its lifecycle.

const { interpretCost, DAYS_LABEL, PHASE_LABEL, parsePlanId, num } = require('../lib/cost');

async function getDrugCosts(rxcuis, planId, db) {
  const { contract, plan, segment } = parsePlanId(planId);

  const planRes = await db.query(
    `select contract_id, plan_id, segment_id, plan_name, formulary_id, ingest_run_id
       from plans where contract_id=$1 and plan_id=$2 and segment_id=$3`,
    [contract, plan, segment]
  );
  if (planRes.rows.length === 0) {
    return { found: false, reason: 'PLAN NOT FOUND IN DATA', planId, plan: null, drugs: [] };
  }
  const pr = planRes.rows[0];
  const planInfo = {
    planId: `${pr.contract_id}-${pr.plan_id}`, contractId: pr.contract_id, planId3: pr.plan_id,
    segmentId: pr.segment_id, planName: pr.plan_name, formularyId: pr.formulary_id, ingestRunId: pr.ingest_run_id,
  };

  const drugs = [];
  for (const rxcui of rxcuis) {
    const dRes = await db.query(
      `select rxcui, ndc, tier, prior_auth, step_therapy, quantity_limit, ql_amount, ql_days, selected_drug, ingest_run_id
         from drug_tiers where formulary_id=$1 and rxcui=$2 order by tier, ndc`,
      [planInfo.formularyId, String(rxcui)]
    );
    if (dRes.rows.length === 0) {
      drugs.push({ rxcui: String(rxcui), found: false, reason: 'NOT ON FORMULARY', tier: null, tiers: [], flags: null, costsByPhase: {} });
      continue;
    }
    const tiers = [...new Set(dRes.rows.map((r) => r.tier))].sort((a, b) => a - b);
    const tier = tiers[0]; // representative = lowest tier (mirrors Milestone 0)
    const rowsForTier = dRes.rows.filter((r) => r.tier === tier);
    const any = (f) => rowsForTier.some((r) => r[f]);
    const flags = {
      priorAuth: any('prior_auth'), stepTherapy: any('step_therapy'), quantityLimit: any('quantity_limit'),
      qlAmount: rowsForTier.find((r) => r.ql_amount && r.ql_amount.trim())?.ql_amount?.trim() || null,
      qlDays: rowsForTier.find((r) => r.ql_days && r.ql_days.trim())?.ql_days?.trim() || null,
      selectedDrug: any('selected_drug'),
    };

    // Cost sharing for the representative tier, all phases + days-supplies + channels.
    const cRes = await db.query(
      `select coverage_level, tier, days_supply,
              cost_type_pref, cost_amt_pref, cost_type_nonpref, cost_amt_nonpref,
              cost_type_mail_pref, cost_amt_mail_pref, cost_type_mail_nonpref, cost_amt_mail_nonpref,
              tier_specialty, ded_applies, ingest_run_id
         from tier_costs where contract_id=$1 and plan_id=$2 and segment_id=$3 and tier=$4
         order by coverage_level, days_supply`,
      [contract, plan, segment, tier]
    );
    const costsByPhase = {};
    for (const c of cRes.rows) {
      const lvl = String(c.coverage_level);
      if (!costsByPhase[lvl]) costsByPhase[lvl] = { phase: PHASE_LABEL[c.coverage_level] || `level-${lvl}`, byDaysSupply: {} };
      costsByPhase[lvl].byDaysSupply[String(c.days_supply)] = {
        daysSupply: c.days_supply, daysLabel: DAYS_LABEL[c.days_supply] || `code-${c.days_supply}`,
        standardRetail: interpretCost(c.cost_type_nonpref, c.cost_amt_nonpref),
        preferredRetail: interpretCost(c.cost_type_pref, c.cost_amt_pref),
        standardMail: interpretCost(c.cost_type_mail_nonpref, c.cost_amt_mail_nonpref),
        preferredMail: interpretCost(c.cost_type_mail_pref, c.cost_amt_mail_pref),
        tierSpecialty: c.tier_specialty, dedApplies: c.ded_applies,
        ingestRunId: c.ingest_run_id, // source of these numbers
      };
    }

    drugs.push({
      rxcui: String(rxcui), found: true, tier, tiers, multiTier: tiers.length > 1,
      ndcs: [...new Set(dRes.rows.map((r) => r.ndc))],
      flags, drugTierIngestRunId: dRes.rows[0].ingest_run_id, costsByPhase,
    });
  }

  return { found: true, planId: planInfo.planId, plan: planInfo, drugs };
}

module.exports = { getDrugCosts };
// (Manual CLI removed so this stays Workers-bundle-safe — no node-only deps. Use the dev
//  server or scripts/query.js for ad-hoc queries.)
