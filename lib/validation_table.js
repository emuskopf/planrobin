'use strict';
// Single-source renderer for the Milestone 0 validation table. Used by both the
// raw-file pipeline (scripts/05_validate.js) and the database-backed acceptance test,
// so "the DB output matches Milestone 0 exactly" holds by construction.

const W = { drug: 26, rxcui: 22, tier: 5, flags: 10, comp: 20, exp: 14, match: 14 };

function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }

// meta: { planId, planName, formularyId, pufQuarter, basis }
// rows: [{ drug, rxcui, tier, flags, computed, expected, match }]
function renderTable(meta, rows) {
  const header = pad('DRUG', W.drug) + pad('RXCUI', W.rxcui) + pad('TIER', W.tier) + pad('FLAGS', W.flags) + pad('COMPUTED', W.comp) + pad('EXPECTED', W.exp) + pad('MATCH?', W.match);
  const sep = '-'.repeat(header.length);
  const lines = [];
  lines.push('='.repeat(header.length));
  lines.push('PlanRobin Milestone 0 — Validation Table');
  lines.push(`Plan: ${meta.planId}  ${meta.planName}  (formulary ${meta.formularyId})`);
  lines.push(`PUF: ${meta.pufQuarter}   Basis: ${meta.basis}`);
  lines.push('='.repeat(header.length));
  lines.push(header);
  lines.push(sep);
  for (const r of rows) {
    lines.push(pad(r.drug, W.drug) + pad(r.rxcui, W.rxcui) + pad(r.tier, W.tier) + pad(r.flags, W.flags) + pad(r.computed, W.comp) + pad(r.expected, W.exp) + pad(r.match, W.match));
  }
  lines.push(sep);
  return lines.join('\n');
}

module.exports = { renderTable, pad, W };
