'use strict';
// UX FLOOR SUITE — every page and major UI state must pass all six floors at 360px & 412px,
// default and 200%/large-font. Deterministic (canned APIs). A failure names the state, viewport,
// font, rule, and element; a screenshot is attached automatically (screenshot: only-on-failure).
const { test, expect } = require('@playwright/test');
const H = require('./harness');

const VIEWPORTS = [360, 412];
const FONTS = [{ name: 'default', scale: 1 }, { name: '200%', scale: 2 }];

// Each state drives the page into a named condition. `results` picks the /api/results fixture.
const STATES = [
  { name: 'entry-empty', async setup(page) { await page.goto('/'); } },
  { name: 'entry-chips', async setup(page) { await page.goto('/'); await H.addDrug(page, '40 MG'); await H.addDrug(page, '20 MG'); } },
  { name: 'entry-autocomplete-open', async setup(page) { await page.goto('/'); await page.fill('#drug-input', 'duloxetine'); await page.waitForSelector('#suggestions li[role=option]', { state: 'visible' }); } },
  { name: 'entry-zip-disambiguation', async setup(page) { await page.goto('/'); await page.fill('#zip', '65041'); await page.waitForSelector('.county-choice', { state: 'visible' }); } },
  { name: 'entry-zip-confirmed', async setup(page) { await page.goto('/'); await page.fill('#zip', '63011'); await page.waitForSelector('.zip-confirm', { state: 'visible' }); } },
  { name: 'entry-zip-out-of-area', async setup(page) { await page.goto('/'); await page.fill('#zip', '90210'); await page.waitForSelector('.zip-status.warn', { state: 'visible' }); } },
  { name: 'results-complete', results: 'results-complete.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  { name: 'results-partial', results: 'results-partial.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  { name: 'results-zero', results: 'results-zero.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  { name: 'results-cap', results: 'results-cap.json', async setup(page) { await page.goto('/'); await H.runToResults(page); } },
  { name: 'faq', async setup(page) { await page.goto('/faq.html'); } },
  { name: 'story', async setup(page) { await page.goto('/story.html'); } },
];

for (const st of STATES) {
  test.describe(st.name, () => {
    for (const vw of VIEWPORTS) {
      for (const ft of FONTS) {
        test(`${st.name} @ ${vw}px / ${ft.name}`, async ({ page }) => {
          await H.interceptApis(page, { results: st.results });
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

// Passport is a PRINT artifact (letter width), not a mobile-viewport screen — audit it under print
// media at paper width for overlap/type/contrast (horizontal overflow + touch targets are N/A on paper).
test.describe('passport-print', () => {
  for (const ft of FONTS) {
    test(`passport-print @ 816px / ${ft.name}`, async ({ page }) => {
      await H.interceptApis(page, { results: 'results-complete.json' });
      await page.setViewportSize({ width: 816, height: 1056 });
      await page.goto('/');
      await H.runToResults(page);
      await page.emulateMedia({ media: 'print' });
      await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      await H.setFontScale(page, ft.scale);
      await page.waitForTimeout(80);
      // Print typography uses point sizes tuned for paper — the 14/18px SCREEN type floor and the
      // 44px touch rule don't apply. We still hold the passport to no-overlap + AA contrast.
      const violations = await H.collectViolations(page, { rules: ['overlap', 'contrast'] });
      expect(violations, H.formatViolations({ state: 'passport-print', viewport: 816, font: ft.name }, violations)).toEqual([]);
    });
  }
});
