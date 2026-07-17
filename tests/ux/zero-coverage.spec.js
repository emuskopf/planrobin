'use strict';
// ================================================================================================
// UX-REVIEW #13 — FALSE REASSURANCE, at the DOM.
//
// "Good news must be EARNED by an assertion the reader could verify. Empty, silent, and
//  not-applicable states must never wear the same clothes as verified-fine states."
//
// This file guards the zero-coverage card: the state where every comforting sentence on the page is
// vacuously true and therefore a lie of tone. The engine-level rules live in tests/format.test.js;
// these assert what actually reaches her eye — what renders, what does NOT, and which of the two
// wins the visual hierarchy.
// ================================================================================================
const { test, expect } = require('@playwright/test');
const H = require('./harness');

// Drive the checkup to her-plan-covers-nothing. The breakdown is open by default on her own card,
// so everything under test is on screen without a tap.
async function zeroCoverageCheckup(page) {
  await page.goto('/checkup.html');
  await H.setCounty(page);
  await H.addDrug(page, '20 MG');
  await page.fill('#road-plan-id', 'H2041-001');
  await page.click('#go');
  await page.waitForSelector('.plan-yours');
}

test.describe('zero-coverage card — reassurance must be earned (UX-REVIEW #13)', () => {
  test('no vacuously-true note renders: exemption, savings, cap, or total', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-zero.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await zeroCoverageCheckup(page);
    const card = page.locator('.plan-yours');

    // The instance Evan caught: "your medications are on tiers the deductible skips" — when the drug
    // is on no tier at all.
    await expect(card.locator('.bd-ded'), 'no deductible-exemption note').toHaveCount(0);
    await expect(card.getByText(/deductible doesn't apply/i), 'not by any wording').toHaveCount(0);
    // Siblings that could reassure just as vacuously.
    await expect(card.locator('.savings'), 'no savings line on a plan that covers nothing').toHaveCount(0);
    await expect(card.locator('.bd-cap'), 'no cap-month milestone').toHaveCount(0);
    await expect(card.locator('.bd-incomplete'), 'no "true cost is higher" note (nothing was counted)').toHaveCount(0);
    // A total of premium-only is the fake-$0 in breakdown clothing.
    await expect(card.locator('.bd-total'), 'no Estimated total').toHaveCount(0);
    await expect(card.getByText(/Estimated total/i)).toHaveCount(0);
  });

  test('the badge owns the card — and outranks the premium', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-zero.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await zeroCoverageCheckup(page);

    const badge = page.locator('.plan-yours .no-cover-anchor');
    await expect(badge, 'the not-covered badge renders on THIS surface too').toBeVisible();
    // icon + word + colour — never colour alone, sentence case, no caps.
    await expect(badge.locator('.ic'), 'carries its icon (not colour alone)').toHaveCount(1);
    const text = (await badge.textContent()).trim();
    expect(text).toMatch(/^Doesn’t cover (your medication|any of your medications)$/);
    expect(text, 'sentence case, never a shout').not.toMatch(/[A-Z]{3,}/);

    const r = await page.evaluate(() => {
      const b = document.querySelector('.plan-yours .no-cover-anchor');
      const p = document.querySelector('.plan-yours .premium-prominent .pp-amt');
      const px = (el) => parseFloat(getComputedStyle(el).fontSize);
      return {
        badgePx: px(b), premiumPx: p ? px(p) : null,
        badgeTop: b.getBoundingClientRect().top,
        premiumTop: p ? p.getBoundingClientRect().top : null,
        badgeColor: getComputedStyle(b).color,
        premiumText: p ? p.textContent.trim() : null,
      };
    });
    // The premium is still shown and still true — it just no longer out-shouts the fact that the plan
    // can't fill her prescriptions. (It rendered at 28px against the badge's 16px before this fix.)
    expect(r.premiumText, 'the premium is still there — true, and hers').toMatch(/^\$[\d.]+\/mo$/);
    expect(r.badgeTop, 'badge sits above the premium').toBeLessThan(r.premiumTop);
    expect(r.badgePx, `badge (${r.badgePx}px) must outweigh the premium (${r.premiumPx}px)`).toBeGreaterThan(r.premiumPx);
    expect(r.badgeColor, 'semantic not-covered token, not default ink').toBe('rgb(154, 59, 47)');
  });

  test('the not-covered drug line is a badge, and carries no dollar figure', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-zero.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await zeroCoverageCheckup(page);

    const row = page.locator('.plan-yours .bd-notcov').first();
    await expect(row).toBeVisible();
    await expect(row.locator('.bd-notcov-badge'), 'semantic badge inline, not grey prose').toBeVisible();
    await expect(row.locator('.bd-notcov-badge')).toHaveText(/Not covered — you’d pay full price/);
    await expect(row.locator('.bd-notcov-badge .ic'), 'icon + word + colour, not colour alone').toHaveCount(1);
    // NO "$" anywhere on this line — there is no price to state.
    const rowText = await row.textContent();
    expect(rowText, `a dollar figure on a not-covered line is the fake-$0: "${rowText}"`).not.toContain('$');
  });

  test('the premium row keeps its own true $0 — the fact survives, the verdict does not', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-zero.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await zeroCoverageCheckup(page);
    const premiumRow = page.locator('.plan-yours .bd-line').first();
    await expect(premiumRow).toContainText('Premium');
    await expect(premiumRow, 'a real premium is a fact about the plan, not a verdict about her').toContainText('/yr');
  });

  test('PARTIAL coverage keeps the note — scoped to the drugs it is true of', async ({ page }) => {
    // The other side of the guard: suppression must not swallow a note that IS true. One drug covered
    // and exempt, one off-formulary — the real Missouri shape.
    await H.interceptApis(page, { results: 'results-partial-gap.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto('/checkup.html');
    await H.setCounty(page);
    await H.addDrug(page, '20 MG');
    await H.addDrug(page, '60 MG');
    await page.fill('#road-plan-id', 'H2041-001');
    await page.click('#go');
    await page.waitForSelector('.plan-yours');

    const ded = page.locator('.plan-yours .bd-ded');
    await expect(ded, 'the note is still earned here — a covered drug IS on an exempt tier').toBeVisible();
    await expect(ded).toHaveText(/doesn't apply to the medications it covers/);
    await expect(ded, 'and never claims the whole basket').not.toHaveText(/apply to your medications/);
    // partial still totals: some drugs ARE covered, so the number means something
    await expect(page.locator('.plan-yours .bd-total'), 'partial coverage keeps its total').toHaveCount(1);
  });
});
