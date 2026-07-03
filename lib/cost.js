'use strict';
// Shared interpretation of CMS cost-sharing codes (used by the query tools).
//   cost_type: 0 = not offered, 1 = copay ($ amount), 2 = coinsurance (rate; .25 = 25%)

const DAYS_LABEL = { 1: '30-day', 2: '90-day', 3: 'other', 4: '60-day' };
const PHASE_LABEL = { 0: 'pre-deductible', 1: 'initial', 3: 'catastrophic' };

// Postgres returns NUMERIC as strings; coerce safely.
const num = (v) => (v == null ? null : Number(v));

function interpretCost(type, amt) {
  const t = type == null ? null : Number(type);
  if (t === 1) return { kind: 'copay', type: 1, dollars: num(amt), rate: null };
  if (t === 2) return { kind: 'coinsurance', type: 2, dollars: null, rate: num(amt) };
  return { kind: 'not_offered', type: t, dollars: null, rate: null };
}

// Parse "H4461-046" or "H4461-046-000" -> {contract, plan, segment}.
function parsePlanId(raw) {
  const parts = String(raw).trim().toUpperCase().split('-');
  if (parts.length < 2) throw new Error(`Cannot parse plan id "${raw}" — expected CONTRACT-PLAN[-SEGMENT]`);
  return { contract: parts[0], plan: parts[1].padStart(3, '0'), segment: (parts[2] || '000').padStart(3, '0') };
}

module.exports = { DAYS_LABEL, PHASE_LABEL, interpretCost, parsePlanId, num };
