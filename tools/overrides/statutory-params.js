'use strict';
// Statutory parameters for the Part D override layer, VERIFIED against official sources for the
// 2026 plan year (July 2026). Parameterized by plan year so future years are a data change, not
// a code change. Do not edit a value without re-verifying and updating the citation.
//
// SReconciliation with our data: the CMS PUF max deductible for 2026 is $615 — matches the
// deductible we see on Missouri plans (e.g. H4461-046 = $615), a good cross-check.

const PLAN_YEAR_PARAMS = {
  // 2025: first year of the IRA redesign (OOP cap introduced at $2,000).
  2025: {
    oopCapAnnual: 2000,        // SSA §1860D-2(b)(4)(B); IRA §11201.
    insulinMonthlyCap: 35,     // SSA §1860D-2(b)(9); IRA §11406.
    maxDeductible: 590,
  },
  // 2026: OOP cap indexed from the 2025 $2,000 by the annual per-capita Part D expenditure factor.
  2026: {
    // $2,100 — CMS "Final CY2026 Part D Redesign Program Instructions"
    //   https://www.cms.gov/newsroom/fact-sheets/final-cy-2026-part-d-redesign-program-instructions
    //   (confirmed: NCOA 2026 Medicare cost guide, GoodRx). Indexed per SSA §1860D-2(b)(4)(B)(ii).
    oopCapAnnual: 2100,
    // $35/month cap on each COVERED (on-formulary) insulin product; the Part D deductible does
    // NOT apply to insulin. SSA §1860D-2(b)(9) (IRA §11406). Confirmed: KFF "The Facts About the
    // $35 Insulin Copay Cap in Medicare"; Medicare.gov/coverage/insulin. Cap is per 30-day supply;
    // pro-rate for other supply lengths (90-day => 3 × $35 = $105).
    insulinMonthlyCap: 35,
    // Max Part D deductible 2026 = $615 (matches our PUF data). CMS CY2026 Part D parameters.
    maxDeductible: 615,
  },
};

// ACIP-recommended adult vaccines covered under Part D have $0 cost-sharing AND are exempt from
// the deductible, effective plan years >= 2023. SSA §1860D-2(b)(8) (IRA §11401). Confirmed: CMS
// MLN908764 "Medicare Part D Vaccines"; CY2026 final rule (42 CFR 423.100 / 423.120). This is a
// binary rule (no dollar parameter) — see tools/overrides/data/classification.json for the list.
const VACCINE_RULE = {
  costSharing: 0,
  deductibleExempt: true,
  statute: 'SSA 1860D-2(b)(8) / IRA 11401; CMS MLN908764',
};

// The Medicare Open Enrollment window (AEP): October 15 – December 7 every year, with changes
// effective January 1. Set in statute/regulation, not indexed like the dollar params, so it is one
// constant rather than a per-year table — but it lives HERE, with the other verified parameters, so
// season-aware prose renders from the same source the rest of the engine does (never a hardcoded date
// in copy). VERIFIED: Medicare.gov "Open Enrollment"
//   https://www.medicare.gov/health-drug-plans/open-enrollment
//   (CMS Medicare Open Enrollment partner resources; 42 CFR 422.62(a)(5) / 423.38(b) — the AEP.)
// Re-verify each plan year before the season flips.
const ENROLLMENT = {
  aep: { startMonth: 10, startDay: 15, endMonth: 12, endDay: 7, effective: 'January 1' },
};

// Is `date` inside the AEP for its own year? Pure and timezone-naive on purpose: we compare local
// calendar month/day, which is how a person reads a date on a calendar.
function inAep(date, e) {
  const p = (e || ENROLLMENT).aep;
  const m = date.getMonth() + 1, d = date.getDate();
  const afterStart = m > p.startMonth || (m === p.startMonth && d >= p.startDay);
  const beforeEnd = m < p.endMonth || (m === p.endMonth && d <= p.endDay);
  return afterStart && beforeEnd;
}

function paramsForYear(planYear) {
  const y = String(planYear);
  const p = PLAN_YEAR_PARAMS[y];
  if (!p) throw new Error(`No verified statutory parameters for plan year ${planYear}`);
  return p;
}

module.exports = { PLAN_YEAR_PARAMS, VACCINE_RULE, paramsForYear, ENROLLMENT, inAep };
