'use strict';
// UX FLOOR SUITE — every page and major UI state must pass all six floors at 360px & 412px,
// default and 200%/large-font. Deterministic (canned APIs). A failure names the state, viewport,
// font, rule, and element; a screenshot is attached automatically (screenshot: only-on-failure).
const { test, expect } = require('@playwright/test');
const H = require('./harness');

const VIEWPORTS = [360, 412];
const FONTS = [{ name: 'default', scale: 1 }, { name: '200%', scale: 2 }];

// On failure, attach a full-page screenshot (the on-failure viewport shot lands wherever focus
// traversal left the scroll) so overflow at the top of the page is actually visible in the report.
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    try { await page.evaluate(() => window.scrollTo(0, 0)); await testInfo.attach('fullpage', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' }); } catch {}
  }
});

// Each state drives the page into a named condition. `results` picks the /api/results fixture.
const STATES = [
  { name: 'entry-empty', async setup(page) { await page.goto('/'); } },
  { name: 'entry-chips', async setup(page) { await page.goto('/'); await H.addDrug(page, '40 MG'); await H.addDrug(page, '20 MG'); } },
  { name: 'entry-autocomplete-open', async setup(page) { await page.goto('/'); await page.fill('#drug-input', 'duloxetine'); await page.waitForSelector('#suggestions li[role=option]', { state: 'visible' }); } },
  // Two-badge, long-name suggestion (brand + "not on MO plans") — the Toprol crush repro.
  { name: 'entry-autocomplete-crush', rxnorm: 'rxnorm-crush.json', async setup(page) { await page.goto('/'); await page.fill('#drug-input', 'toprol'); await page.waitForSelector('#suggestions li[role=option]', { state: 'visible' }); } },
  // Two-badge chip (brand + "not on MO plans") from an off-formulary pick.
  { name: 'entry-chip-crush', rxnorm: 'rxnorm-crush.json', async setup(page) { await page.goto('/'); await H.addDrug(page, 'Toprol'); await page.waitForSelector('#drug-list .chip-name'); } },
  { name: 'entry-zip-disambiguation', async setup(page) { await page.goto('/'); await page.fill('#zip', '65041'); await page.waitForSelector('.county-choice', { state: 'visible' }); } },
  { name: 'entry-zip-confirmed', async setup(page) { await page.goto('/'); await page.fill('#zip', '63011'); await page.waitForSelector('.zip-confirm', { state: 'visible' }); } },
  { name: 'entry-zip-out-of-area', async setup(page) { await page.goto('/'); await page.fill('#zip', '90210'); await page.waitForSelector('.zip-status.warn', { state: 'visible' }); } },
  { name: 'results-complete', results: 'results-complete.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  { name: 'results-partial', results: 'results-partial.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  { name: 'results-zero', results: 'results-zero.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  { name: 'results-cap', results: 'results-cap.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  // ---- the two roads. `results-two-roads.json` spans BOTH roads, so the framing/divider render. ----
  // "Not sure" opens the wallet check — a dense list inside an optional card.
  { name: 'entry-road-unsure', async setup(page) { await page.goto('/'); await page.click('.road-choice[data-road="unsure"]'); await page.waitForSelector('.wallet-check', { state: 'visible' }); } },
  // No road given: mixed list + the both-kinds line + the premium-comparability note.
  { name: 'results-roads-mixed', results: 'results-two-roads.json', async setup(page) { await page.goto('/'); await H.runToResults(page); await page.waitForSelector('.road-mixed'); } },
  // MA road: her plans first, then the divider carrying the disenrollment warning (the safety case).
  { name: 'results-road-ma', results: 'results-two-roads.json', async setup(page) { await page.goto('/'); await page.click('.road-choice[data-road="ma"]'); await H.runToResults(page); await page.waitForSelector('.road-divider'); } },
  // Original-Medicare road: the "choose by price alone" note + the other road below the divider.
  { name: 'results-road-original', results: 'results-two-roads.json', async setup(page) { await page.goto('/'); await page.click('.road-choice[data-road="original"]'); await H.runToResults(page); await page.waitForSelector('.road-divider'); } },
  // A typed plan ID anchors her plan first as a distinct card, breakdown open by default.
  { name: 'results-your-plan', results: 'results-two-roads.json', async setup(page) { await page.goto('/'); await page.fill('#road-plan-id', 'H2041-001'); await H.runToResults(page); await page.waitForSelector('.plan-yours'); } },
  // Her plan covering NOTHING, still first — placement exempt, honesty not.
  { name: 'results-your-plan-zero', results: 'results-zero.json', async setup(page) { await page.goto('/'); await page.fill('#road-plan-id', 'H2041-001'); await H.runToResults(page); await page.waitForSelector('.plan-yours'); } },
  // A real-looking ID that isn't in this county — the designed not-found state, results beneath.
  { name: 'results-planid-missed', results: 'results-two-roads.json', async setup(page) { await page.goto('/'); await page.fill('#road-plan-id', 'H7777-777'); await H.runToResults(page); await page.waitForSelector('.planid-missed'); } },
  // Malformed input — the friendly incremental hint.
  { name: 'entry-planid-malformed', async setup(page) { await page.goto('/'); await page.fill('#road-plan-id', 'HH99'); await page.waitForSelector('.planid-hint:not([hidden])'); } },
  { name: 'faq', async setup(page) { await page.goto('/faq.html'); } },
  { name: 'story', async setup(page) { await page.goto('/story.html'); } },
];

// ---- the 5-Minute Checkup (the second front door). It reuses the comparison page's intake, so the
// same crush/overflow surfaces apply — and the report adds four of its own.
async function checkupIntake(page, o) {
  await page.goto('/checkup.html');
  await H.setCounty(page);
  await H.addDrug(page, '20 MG');            // a drug the fixture actually prices
  if (o.planId) await page.fill('#road-plan-id', o.planId);
  if (o.road) await page.click(`.road-choice[data-road="${o.road}"]`);
  if (o.where) await page.click(`.road-choice[data-fill-where="${o.where}"]`);
  if (o.days) await page.click(`.road-choice[data-fill-days="${o.days}"]`);
  if (o.perks) await page.click(`.road-choice[data-perks="${o.perks}"]`);
  await page.click('#go');
}
STATES.push(
  // All five questions on screen at once — the whole intake before a single answer.
  { name: 'checkup-intake', async setup(page) { await page.goto('/checkup.html'); } },
  // Skip path: no plan ID → the picker, built from the plans we already priced.
  { name: 'checkup-picker', results: 'results-two-roads.json', async setup(page) { await checkupIntake(page, { road: 'ma' }); await page.waitForSelector('.picker'); } },
  // The full report: headline + action plan + fair-price + perks + bridge.
  { name: 'checkup-report', results: 'results-two-roads.json', async setup(page) { await checkupIntake(page, { planId: 'H2041-001', where: 'local', days: '1', perks: 'unsure' }); await page.waitForSelector('.action-plan'); } },
  // Her plan covers nothing she takes → the fair-price check must fire, not-covered leading.
  { name: 'checkup-report-notcovered', results: 'results-zero.json', async setup(page) { await checkupIntake(page, { planId: 'H2041-001', perks: 'no' }); await page.waitForSelector('.plan-yours'); } },
  // The preferred-pharmacy switch action: a covered drug cheapest at a preferred pharmacy (~1 in 3
  // real cases). Exercises the switch group + the 'switch' next-step + the switch question.
  { name: 'checkup-report-pref-switch', results: 'results-preferred-switch.json', async setup(page) {
    await page.goto('/checkup.html');
    await H.setCounty(page);
    await H.addDrug(page, '20 MG');
    await H.addDrug(page, '60 MG');
    await page.fill('#road-plan-id', 'H2041-001');
    await page.click('.road-choice[data-fill-where="local"]');
    await page.click('.road-choice[data-fill-days="1"]');
    await page.click('#go');
    await page.waitForSelector('.action-plan');
  } },
  // The shape real Missouri data takes: one drug covered, one off-formulary everywhere. Both a keep
  // heading AND a gap on one report — the combination neither other fixture produces.
  { name: 'checkup-report-partial-gap', results: 'results-partial-gap.json', async setup(page) {
    await page.goto('/checkup.html');
    await H.setCounty(page);
    await H.addDrug(page, '20 MG');
    await H.addDrug(page, '60 MG');
    await page.fill('#road-plan-id', 'H2041-001');
    await page.click('.road-choice[data-perks="no"]');
    await page.click('#go');
    await page.waitForSelector('.action-warn');
  } },
);

for (const st of STATES) {
  test.describe(st.name, () => {
    for (const vw of VIEWPORTS) {
      for (const ft of FONTS) {
        test(`${st.name} @ ${vw}px / ${ft.name}`, async ({ page }) => {
          await H.interceptApis(page, { results: st.results, rxnorm: st.rxnorm });
          await page.setViewportSize({ width: vw, height: 900 });
          await st.setup(page);
          await H.setFontScale(page, ft.scale);
          await page.waitForTimeout(80); // let layout settle after the font-scale reflow
          const violations = await H.collectViolations(page, {});
          expect(violations, H.formatViolations({ state: st.name, viewport: vw, font: ft.name }, violations)).toEqual([]);
        });
      }
    }
  });
}

// The passports are PRINT artifacts (letter width), not mobile-viewport screens — audited under print
// media at paper width for overlap/type/contrast (horizontal overflow + touch targets are N/A on
// paper). Both doors print a sheet, so both sheets get audited.
const SHEETS = [
  // the comparison: every plan, ranked
  { name: 'passport-print', results: 'results-complete.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  // the checkup: her plan + the action plan. Its own page 1 (verdict, bullets, scripts, small print).
  { name: 'checkup-passport-print', results: 'results-two-roads.json', async setup(page) {
    await page.goto('/checkup.html');
    await H.setCounty(page);
    await H.addDrug(page, '20 MG');
    await page.fill('#road-plan-id', 'H2041-001');
    await page.click('.road-choice[data-fill-where="local"]');
    await page.click('.road-choice[data-fill-days="1"]');
    await page.click('.road-choice[data-perks="unsure"]');
    await page.click('#go');
    await page.waitForSelector('.action-plan');
  } },
  // her plan covering nothing she takes: the warn verdict + "Worth knowing" on paper (the case that
  // used to print "Good news — already the cheapest option").
  { name: 'checkup-passport-print-notcovered', results: 'results-zero.json', async setup(page) {
    await page.goto('/checkup.html');
    await H.setCounty(page);
    await H.addDrug(page, '20 MG');
    await page.fill('#road-plan-id', 'H2041-001');
    await page.click('#go');
    await page.waitForSelector('.plan-yours');
  } },
  // a keep heading AND a gap — the real-data shape whose sub-heading used to open the reopen block's
  // column layout and scramble everything after it.
  { name: 'checkup-passport-print-partial-gap', results: 'results-partial-gap.json', async setup(page) {
    await page.goto('/checkup.html');
    await H.setCounty(page);
    await H.addDrug(page, '20 MG');
    await H.addDrug(page, '60 MG');
    await page.fill('#road-plan-id', 'H2041-001');
    await page.click('.road-choice[data-perks="no"]');
    await page.click('#go');
    await page.waitForSelector('.action-warn');
  } },
];

for (const sheet of SHEETS) {
  test.describe(sheet.name, () => {
    for (const ft of FONTS) {
      test(`${sheet.name} @ 816px / ${ft.name}`, async ({ page }) => {
        await H.interceptApis(page, { results: sheet.results });
        await page.setViewportSize({ width: 816, height: 1056 });
        await sheet.setup(page);
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
        await H.setFontScale(page, ft.scale);
        await page.waitForTimeout(80);
        // Print typography uses point sizes tuned for paper — the 14/18px SCREEN type floor and the
        // 44px touch rule don't apply. We still hold the passport to no-overlap + AA contrast.
        const violations = await H.collectViolations(page, { rules: ['overlap', 'contrast'] });
        expect(violations, H.formatViolations({ state: sheet.name, viewport: 816, font: ft.name }, violations)).toEqual([]);
      });
    }
  });
}
