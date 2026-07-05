'use strict';
// PLAN PASSPORT — model parity (print DOM text == PDF text) + the PDF is a real, selectable,
// small text file. Both renderers run against the ONE shared model (site/passport.js).
const { test, expect } = require('@playwright/test');
const H = require('./harness');

test('print DOM and PDF render identical text from the shared model; PDF is text-based + small', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-complete.json' });
  await page.setViewportSize({ width: 900, height: 1000 }); // wide → Print button present too
  await page.goto('/');
  await H.runToResults(page);

  const r = await page.evaluate(async () => {
    await loadPdfLib();
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    // Every element that carries one logical model string, in document order.
    const SEL = '.pp-brand, .pp-asof, .pp-inputs > div, .pp-meds li, .pp-coverage, .pp-h, .pp-plan-name, .pp-plan-total, .pp-plan-sub, .pp-partial, .pp-savings, .pp-drugs td, .pp-caveats li, .pp-h3, .pp-note, .pp-url';

    const model = passportModelNow(state.lastData);
    const modelStrings = PRPassport.passportStrings(model).map(norm);

    const dom = buildPassport(state.lastData);                                  // print DOM, from the model
    const domStrings = [...dom.querySelectorAll(SEL)].map((e) => norm(e.textContent)).filter(Boolean);

    const pdf = await renderPassportPdf(model);                                 // PDF, from the same model
    const pdfStrings = pdf.drawn.map(norm);
    const head = String.fromCharCode(...pdf.bytes.slice(0, 5));
    const bytesStr = new TextDecoder('latin1').decode(pdf.bytes);
    const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    return {
      domEqualsModel: eq(domStrings, modelStrings),
      pdfEqualsModel: eq(pdfStrings, modelStrings),
      domEqualsPdf: eq(domStrings, pdfStrings),
      firstDomDiff: domStrings.find((x, i) => x !== modelStrings[i]),
      stringCount: modelStrings.length,
      isPdf: head === '%PDF-',
      hasFont: bytesStr.includes('Helvetica'),   // a font dict ⇒ real text, not a screenshot image
      hasImage: /\/Subtype\s*\/Image/.test(bytesStr),
      sizeKb: Math.round(pdf.bytes.length / 1024),
      filename: pdf.filename,
      buttons: [...document.querySelectorAll('.share-actions .share-btn')].map((b) => b.textContent),
    };
  });

  expect(r.stringCount).toBeGreaterThan(15);
  expect(r.domEqualsModel, 'print DOM strings must equal the model; first diff: ' + r.firstDomDiff).toBe(true);
  expect(r.pdfEqualsModel, 'PDF strings must equal the model').toBe(true);
  expect(r.domEqualsPdf, 'print DOM strings must equal PDF strings').toBe(true);   // the parity contract
  expect(r.isPdf).toBe(true);
  expect(r.hasFont, 'PDF embeds a text font (selectable, not an image)').toBe(true);
  expect(r.hasImage, 'PDF is not a screenshot/image render').toBe(false);
  expect(r.sizeKb).toBeLessThan(300);                                        // ≤ a few hundred KB
  expect(r.filename).toMatch(/^planrobin-comparison-\d{4}-\d{2}-\d{2}\.pdf$/);
  expect(r.buttons).toContain('Download PDF');
  expect(r.buttons).toContain('Print');
});

test('Download PDF actually produces a downloadable file', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-complete.json' });
  await page.setViewportSize({ width: 412, height: 900 });
  await page.goto('/');
  await H.runToResults(page);
  await page.locator('.share-bar').scrollIntoViewIfNeeded();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('.share-actions .share-btn:has-text("Download PDF")'),
  ]);
  expect(download.suggestedFilename()).toMatch(/^planrobin-comparison-\d{4}-\d{2}-\d{2}\.pdf$/);
});
