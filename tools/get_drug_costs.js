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
// The row-shaping is a PURE function (buildPlanResult) so the single-plan path here and the
// batched results path (lib/api/results_data.js) share ONE implementation — no drift.
//
// db is a handle from lib/db.js getDb(); the caller owns its lifecycle.

const { interpretCost, DAYS_LABEL, PHASE_LABEL, parsePlanId } = require('../lib/cost');
const { applyPerFillOverrides } = require('./overrides');

const nn = (v) => (v == null ? null : Number(v));
const median = (arr) => {
  const a = (arr || []).filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Plan-level insulin cost sharing (all four channels) keyed tier -> days -> channel, from rows.
function buildInsulinMaps(insulinRows) {
  const byTierDays = {}, byTierDaysChannel = {};
  for (const r of insulinRows || []) {
    const tk = r.tier == null ? 'null' : String(r.tier), dk = String(r.days_supply);
    (byTierDays[tk] = byTierDays[tk] || {})[dk] = { copay: nn(r.copay_nonpref), coin: nn(r.coin_nonpref) };
    const byCh = (byTierDaysChannel[tk] = byTierDaysChannel[tk] || {});
    const put = (ch, copay, coin) => { (byCh[ch] = byCh[ch] || {})[dk] = { copay, coin }; };
    put('standardRetail', nn(r.copay_nonpref), nn(r.coin_nonpref));
    put('preferredRetail', nn(r.copay_pref), nn(r.coin_pref));
    put('standardMail', nn(r.copay_mail_nonpref), nn(r.coin_mail_nonpref));
    put('preferredMail', nn(r.copay_mail_pref), nn(r.coin_mail_pref));
  }
  return { byTierDays, byTierDaysChannel };
}

// PURE — shape one plan's drug-cost result from pre-fetched rows (no DB access).
//   planInfo:     { planId, contractId, planId3, segmentId, planName, formularyId, ingestRunId }
//   drugTierRows: drug_tiers rows for this plan's formulary + the requested rxcuis
//   tierCostRows: tier_costs rows for this plan (all tiers)
//   priceRows:    drug_prices rows for this plan (days 30/90) for the requested ndcs
//   insulinRows:  insulin_costs rows for this plan
function buildPlanResult({ planInfo, planYear, rxcuis, drugTierRows, tierCostRows, priceRows, insulinRows }) {
  const { byTierDays: insulinByTierDays, byTierDaysChannel: insulinByTierDaysChannel } = buildInsulinMaps(insulinRows);

  const tiersByRxcui = new Map();
  for (const r of drugTierRows || []) { const k = String(r.rxcui); (tiersByRxcui.get(k) || tiersByRxcui.set(k, []).get(k)).push(r); }
  const costByTier = new Map();
  for (const c of tierCostRows || []) { const k = c.tier; (costByTier.get(k) || costByTier.set(k, []).get(k)).push(c); }
  const priceByNdc = new Map();
  for (const pRow of priceRows || []) { const k = String(pRow.ndc); (priceByNdc.get(k) || priceByNdc.set(k, []).get(k)).push(pRow); }

  const drugs = [];
  for (const rxcui of rxcuis) {
    const dRows = (tiersByRxcui.get(String(rxcui)) || []).slice()
      .sort((a, b) => (a.tier - b.tier) || String(a.ndc).localeCompare(String(b.ndc)));
    if (dRows.length === 0) {
      drugs.push({ rxcui: String(rxcui), found: false, reason: 'NOT ON FORMULARY', tier: null, tiers: [], flags: null, costsByPhase: {} });
      continue;
    }
    const tiers = [...new Set(dRows.map((r) => r.tier))].sort((a, b) => a - b);
    const tier = tiers[0]; // representative = lowest tier (mirrors Milestone 0)
    const rowsForTier = dRows.filter((r) => r.tier === tier);
    const any = (f) => rowsForTier.some((r) => r[f]);
    const flags = {
      priorAuth: any('prior_auth'), stepTherapy: any('step_therapy'), quantityLimit: any('quantity_limit'),
      qlAmount: rowsForTier.find((r) => r.ql_amount && r.ql_amount.trim())?.ql_amount?.trim() || null,
      qlDays: rowsForTier.find((r) => r.ql_days && r.ql_days.trim())?.ql_days?.trim() || null,
      selectedDrug: any('selected_drug'),
    };

    // Cost sharing for the representative tier, all phases + days-supplies + channels.
    const cRows = (costByTier.get(tier) || []).slice()
      .sort((a, b) => (a.coverage_level - b.coverage_level) || (a.days_supply - b.days_supply));
    const costsByPhase = {};
    for (const c of cRows) {
      const lvl = String(c.coverage_level);
      if (!costsByPhase[lvl]) costsByPhase[lvl] = { phase: PHASE_LABEL[c.coverage_level] || `level-${lvl}`, byDaysSupply: {} };
      costsByPhase[lvl].byDaysSupply[String(c.days_supply)] = {
        daysSupply: c.days_supply, daysLabel: DAYS_LABEL[c.days_supply] || `code-${c.days_supply}`,
        standardRetail: interpretCost(c.cost_type_nonpref, c.cost_amt_nonpref),
        preferredRetail: interpretCost(c.cost_type_pref, c.cost_amt_pref),
        standardMail: interpretCost(c.cost_type_mail_nonpref, c.cost_amt_mail_nonpref),
        preferredMail: interpretCost(c.cost_type_mail_pref, c.cost_amt_mail_pref),
        tierSpecialty: c.tier_specialty, dedApplies: c.ded_applies,
        ingestRunId: c.ingest_run_id,
      };
    }

    // --- Statutory override layer (applied at the calculation layer, not in display code) ---
    const initial = costsByPhase['1'] && costsByPhase['1'].byDaysSupply;
    const standardRetailByDays = {};
    const channelsByDays = { standardRetail: {}, preferredRetail: {}, standardMail: {}, preferredMail: {} };
    for (const d of ['1', '2', '4']) {
      if (!initial || !initial[d]) continue;
      standardRetailByDays[d] = initial[d].standardRetail;
      channelsByDays.standardRetail[d] = initial[d].standardRetail;
      channelsByDays.preferredRetail[d] = initial[d].preferredRetail;
      channelsByDays.standardMail[d] = initial[d].standardMail;
      channelsByDays.preferredMail[d] = initial[d].preferredMail;
    }
    const dedAppliesTier = !!(initial && (initial['1'] || initial['2'] || initial['4'] || {}).dedApplies);
    const insTier = insulinByTierDays[String(tier)] || insulinByTierDays['null'] || null;
    const insTierChannel = insulinByTierDaysChannel[String(tier)] || insulinByTierDaysChannel['null'] || null;
    const overrideModel = applyPerFillOverrides({
      rxcui: String(rxcui), tier, dedAppliesTier, planYear,
      standardRetailByDays, insulinByDays: insTier,
      channelsByDays, insulinByChannelDays: insTierChannel,
    });

    // --- Negotiated per-unit price (Pricing file), per-unit only (never × an assumed dose) ---
    const ndcs = [...new Set(rowsForTier.map((r) => r.ndc).filter(Boolean))];
    const rowsForDrug = [];
    for (const n of ndcs) for (const pRow of (priceByNdc.get(String(n)) || [])) rowsForDrug.push(pRow);
    let negotiatedPrice = null;
    if (rowsForDrug.length) {
      const byDays = {};
      for (const row of rowsForDrug) { const d = String(row.days_supply); (byDays[d] = byDays[d] || []).push(Number(row.unit_cost)); }
      negotiatedPrice = {
        unitCostByDays: { 30: median(byDays['30']), 90: median(byDays['90']) },
        ndcCount: ndcs.length, pricedNdcCount: new Set(rowsForDrug.map((r) => String(r.ndc))).size, source: 'pricing_file',
      };
    }
    const eff30 = overrideModel.perFill['1'] || (initial && initial['1'] && initial['1'].standardRetail);
    const effKind = eff30 && eff30.kind;
    const costBasis = effKind === 'coinsurance'
      ? (negotiatedPrice ? 'coinsurance_per_unit' : 'coinsurance_no_price')
      : (effKind === 'copay' ? 'copay' : 'unknown');

    drugs.push({
      rxcui: String(rxcui), found: true, tier, tiers, multiTier: tiers.length > 1,
      ndcs: [...new Set(dRows.map((r) => r.ndc))],
      flags, drugTierIngestRunId: dRows[0].ingest_run_id, costsByPhase,
      negotiatedPrice, costBasis,
      overrides: {
        applied: overrideModel.appliedOverrides,
        isInsulin: overrideModel.isInsulin, isVaccine: overrideModel.isVaccine,
        deductibleApplies: overrideModel.deductibleApplies,
        effectivePerFill: overrideModel.perFill,
        effectivePerFillByChannel: overrideModel.perFillByChannel,
      },
    });
  }

  return { found: true, planId: planInfo.planId, plan: planInfo, planYear, drugs };
}

// Single-plan convenience (used by the acceptance/channels/pricing tests + ad-hoc queries).
// Fetches this plan's rows in a handful of set-based queries, then shapes via buildPlanResult.
async function getDrugCosts(rxcuis, planId, db) {
  const { contract, plan, segment } = parsePlanId(planId);
  const rx = rxcuis.map((x) => String(x));

  const planRes = await db.query(
    `select contract_id, plan_id, segment_id, plan_name, formulary_id, ingest_run_id
       from plans where contract_id=$1 and plan_id=$2 and segment_id=$3`,
    [contract, plan, segment]
  );
  if (planRes.rows.length === 0) return { found: false, reason: 'PLAN NOT FOUND IN DATA', planId, plan: null, drugs: [] };
  const pr = planRes.rows[0];
  const planInfo = {
    planId: `${pr.contract_id}-${pr.plan_id}`, contractId: pr.contract_id, planId3: pr.plan_id,
    segmentId: pr.segment_id, planName: pr.plan_name, formularyId: pr.formulary_id, ingestRunId: pr.ingest_run_id,
  };
  const cy = await db.query(`select contract_year from formularies where formulary_id=$1`, [planInfo.formularyId]);
  const planYear = parseInt(cy.rows[0] && cy.rows[0].contract_year, 10) || 2026;

  const insRes = await db.query(
    `select tier, days_supply, copay_pref, copay_nonpref, copay_mail_pref, copay_mail_nonpref,
            coin_pref, coin_nonpref, coin_mail_pref, coin_mail_nonpref
       from insulin_costs where contract_id=$1 and plan_id=$2 and segment_id=$3`,
    [contract, plan, segment]
  );
  const rxPh = rx.map((_, i) => `$${i + 2}`).join(',');
  const dtRes = await db.query(
    `select rxcui, ndc, tier, prior_auth, step_therapy, quantity_limit, ql_amount, ql_days, selected_drug, ingest_run_id
       from drug_tiers where formulary_id=$1 and rxcui in (${rxPh})`,
    [planInfo.formularyId, ...rx]
  );
  const tcRes = await db.query(
    `select coverage_level, tier, days_supply, cost_type_pref, cost_amt_pref, cost_type_nonpref, cost_amt_nonpref,
            cost_type_mail_pref, cost_amt_mail_pref, cost_type_mail_nonpref, cost_amt_mail_nonpref,
            tier_specialty, ded_applies, ingest_run_id
       from tier_costs where contract_id=$1 and plan_id=$2 and segment_id=$3`,
    [contract, plan, segment]
  );
  const ndcs = [...new Set(dtRes.rows.map((r) => r.ndc).filter(Boolean))];
  let priceRows = [];
  if (ndcs.length) {
    const nPh = ndcs.map((_, i) => `$${i + 4}`).join(',');
    const prc = await db.query(
      `select ndc, days_supply, unit_cost from drug_prices
         where contract_id=$1 and plan_id=$2 and segment_id=$3 and ndc in (${nPh}) and days_supply in (30,90)`,
      [contract, plan, segment, ...ndcs]
    );
    priceRows = prc.rows;
  }

  return buildPlanResult({ planInfo, planYear, rxcuis: rx, drugTierRows: dtRes.rows, tierCostRows: tcRes.rows, priceRows, insulinRows: insRes.rows });
}

module.exports = { getDrugCosts, buildPlanResult };
