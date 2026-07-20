'use strict';
// PLAN PASSPORT — model parity (print DOM text == PDF text) + the PDF is a real, selectable,
// small text file. Both renderers run against the ONE shared model (site/passport.js).
const { test, expect } = require('@playwright/test');
const H = require('./harness');

// Every element that carries one logical model string, in document order. Shared by both sheets —
// if you add an item type to the model, add its class here or the parity test can't see it.
const SEL = '.pp-brand, .pp-asof, .pp-inputs > div, .pp-meds li, .pp-coverage, .pp-h, .pp-plan-name, '
  + '.pp-plan-total, .pp-plan-premium, .pp-plan-sub, .pp-partial, .pp-savings, .pp-drugs td, '
  + '.pp-verdict, .pp-bullet, .pp-strong, .pp-script, .pp-fine, '
  + '.pp-scorecard, .pp-nextstep, .pp-qlabel, .pp-q, .pp-codeline, '   // v2 (pp-scorestats is decorative — excluded)
  + '.pp-caveats li, .pp-h3, .pp-note, .pp-path-text, .pp-url';

test('print DOM and PDF render identical text from the shared model; PDF is text-based + small', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-complete.json' });
  await page.setViewportSize({ width: 900, height: 1000 }); // wide → Print button present too
  await page.goto('/');
  await H.runToResults(page);

  const r = await page.evaluate(async (SEL) => {
    await loadPdfLib();
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
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
      hasLink: /\/Subtype\s*\/Link/.test(bytesStr) && bytesStr.includes('/URI'),   // the share URL is a real clickable link
      sizeKb: Math.round(pdf.bytes.length / 1024),
      filename: pdf.filename,
      buttons: [...document.querySelectorAll('.share-actions .share-btn')].map((b) => b.textContent),
    };
  }, SEL);

  expect(r.stringCount).toBeGreaterThan(15);
  expect(r.domEqualsModel, 'print DOM strings must equal the model; first diff: ' + r.firstDomDiff).toBe(true);
  expect(r.pdfEqualsModel, 'PDF strings must equal the model').toBe(true);
  expect(r.domEqualsPdf, 'print DOM strings must equal PDF strings').toBe(true);   // the parity contract
  expect(r.isPdf).toBe(true);
  expect(r.hasFont, 'PDF embeds a text font (selectable, not an image)').toBe(true);
  expect(r.hasImage, 'PDF is not a screenshot/image render').toBe(false);
  expect(r.hasLink, 'PDF has a clickable URI link for the share URL').toBe(true);
  expect(r.sizeKb).toBeLessThan(300);                                        // ≤ a few hundred KB
  expect(r.filename).toMatch(/^planrobin-comparison-\d{4}-\d{2}-\d{2}\.pdf$/);
  expect(r.buttons).toContain('Download PDF');
  expect(r.buttons).toContain('Print');
});

// ---- THE CHECKUP'S SHEET ------------------------------------------------------------------------
// The printed action plan IS the product's thesis, so it gets the SAME contract as the comparison's:
// print DOM text == PDF text == the model, by construction. Beyond that, this asserts the thing the
// comparison never had to: the sheet says what the SCREEN said — because both render the same
// checkupCopy sentences, not two hand-kept copies of them.
test('checkup: print DOM == PDF == model, and the sheet says what the report said', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-two-roads.json' });
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto('/checkup.html');
  await H.setCounty(page);
  await H.addDrug(page, '20 MG');
  await page.fill('#road-plan-id', 'H2041-001');
  await page.click('.road-choice[data-fill-where="local"]');
  await page.click('.road-choice[data-fill-days="1"]');
  await page.click('.road-choice[data-perks="unsure"]');
  await page.click('#go');
  await page.waitForSelector('.action-plan');

  const r = await page.evaluate(async (SEL) => {
    await loadPdfLib();
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const model = passportModelNow(state.lastData);
    const modelStrings = PRPassport.passportStrings(model).map(norm);
    const domStrings = [...buildPassport(state.lastData).querySelectorAll(SEL)].map((e) => norm(e.textContent)).filter(Boolean);
    const pdf = await renderPassportPdf(model);
    const pdfStrings = pdf.drawn.map(norm);
    const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

    // The sentences the REPORT put on screen must be on the sheet, character for character. This is
    // what "by construction" has to mean: not a promise, a comparison.
    const C = PRPassport.checkupCopy;
    const reportText = norm(document.querySelector('#results').textContent);
    // v2 sentences the report shows on this fixture (all-covered, perks unknown): action heading,
    // reassure, the scorecard heading, the move/perks questions, the SHIP question.
    const shared = [C.actionHeading, C.reassure, C.scorecardHeading, C.questionsHeading, C.shipQuestion, C.perksQuestions[0]]
      .filter((s) => reportText.includes(norm(s)));
    return {
      domEqualsModel: eq(domStrings, modelStrings),
      pdfEqualsModel: eq(pdfStrings, modelStrings),
      domEqualsPdf: eq(domStrings, pdfStrings),
      firstDomDiff: domStrings.find((x, i) => x !== modelStrings[i]),
      stringCount: modelStrings.length,
      // every shared sentence the screen showed, also on the sheet
      sharedOnScreen: shared.length,
      sharedMissingFromSheet: shared.filter((s) => !modelStrings.includes(norm(s))),
      // The report's plan card and the sheet agree on the premium, verbatim. The MARKUP differs on
      // purpose — the screen gives the figure its own weight and the label its own line; paper says it
      // once — so the parts are read separately and joined, rather than pretending the DOM text is
      // the same shape as the printed line.
      screenPremium: [...document.querySelectorAll('.premium-prominent .pp-amt, .premium-prominent .pp-lbl')]
        .map((e) => norm(e.textContent)).join(' '),
      sheetPremium: model.items.find((i) => i.type === 'plan').premium,
      badge: norm(document.querySelector('.yours-badge').textContent),
      heading: modelStrings.find((s) => s === 'Your plan' || s === 'The plan you selected'),
      filename: pdf.filename,
      isPdf: String.fromCharCode(...pdf.bytes.slice(0, 5)) === '%PDF-',
      shareH: norm(document.querySelector('.share-h').textContent),
    };
  }, SEL);

  expect(r.stringCount).toBeGreaterThan(15);
  expect(r.domEqualsModel, 'print DOM must equal the model; first diff: ' + r.firstDomDiff).toBe(true);
  expect(r.pdfEqualsModel, 'PDF must equal the model').toBe(true);
  expect(r.domEqualsPdf, 'print DOM must equal PDF').toBe(true);
  expect(r.isPdf).toBe(true);
  expect(r.filename).toMatch(/^planrobin-checkup-\d{4}-\d{2}-\d{2}\.pdf$/);   // its own artifact
  expect(r.shareH).toBe('Save or share this checkup');                         // bound to THIS sheet
  // screen == sheet, on the sentences that carry the advice
  expect(r.sharedOnScreen, 'the report shows shared sentences worth checking').toBeGreaterThan(2);
  expect(r.sharedMissingFromSheet, 'every sentence on screen is on the sheet').toEqual([]);
  // the premium: same figure, same qualifier, both places
  expect(r.sheetPremium).toMatch(/drug coverage premium/);
  expect(r.screenPremium.replace(/\s+/g, ' ')).toBe(r.sheetPremium);
  // typed the ID → the confident word, on screen and on paper alike
  expect(r.badge).toBe('Your plan');
  expect(r.heading).toBe('Your plan');
});

// REGRESSION (2026-07-17, found on the live preview — no fixture had this shape). A sheet with BOTH a
// covered drug and a gap renders an action sub-heading ("Keep filling these where you do"), which used
// to reuse the `h3` type that OPENS the reopen block's two-column layout. Everything after it — the
// fair-price disclosure, the perks script, the small print — got nested inside that block: scrambled
// order, broken layout. Neither hermetic fixture produced a page-1 sub-heading, so both passed.
// Real Missouri data does this constantly (one generic covered, one brand off-formulary).
test('checkup: a sheet with a keep heading AND a gap keeps model order (partial coverage)', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-partial-gap.json' });
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.goto('/checkup.html');
  await H.setCounty(page);
  await H.addDrug(page, '20 MG');
  await H.addDrug(page, '60 MG');
  await page.fill('#road-plan-id', 'H2041-001');
  await page.click('.road-choice[data-perks="no"]');
  await page.click('#go');
  await page.waitForSelector('.action-plan');

  const r = await page.evaluate(async (SEL) => {
    await loadPdfLib();
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const model = passportModelNow(state.lastData);
    const ms = PRPassport.passportStrings(model).map(norm);
    const dom = [...buildPassport(state.lastData).querySelectorAll(SEL)].map((e) => norm(e.textContent)).filter(Boolean);
    const pdf = await renderPassportPdf(model);
    const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const firstDiff = dom.findIndex((x, i) => x !== ms[i]);
    return {
      domEqualsModel: eq(dom, ms), pdfEqualsModel: eq(pdf.drawn.map(norm), ms),
      diff: firstDiff < 0 ? null : { at: firstDiff, dom: dom[firstDiff], model: ms[firstDiff] },
      types: model.items.map((i) => i.type),
      // the page-1 sub-heading must NOT have opened a share block
      shareBlocks: buildPassport(state.lastData).querySelectorAll('.pp-share').length,
    };
  }, SEL);

  expect(r.types, 'this fixture must actually produce a page-1 sub-heading, or it proves nothing').toContain('h3');
  expect(r.types).toContain('reopen-h');
  expect(r.shareBlocks, 'exactly ONE share block — the reopen page. A sub-heading must not open one.').toBe(1);
  expect(r.domEqualsModel, 'print DOM must equal the model; diff: ' + JSON.stringify(r.diff)).toBe(true);
  expect(r.pdfEqualsModel, 'PDF must equal the model').toBe(true);
});

test('checkup: picking from the list softens the word — screen and sheet together', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-two-roads.json' });
  await page.setViewportSize({ width: 412, height: 900 });
  await page.goto('/checkup.html');
  await H.setCounty(page);
  await H.addDrug(page, '20 MG');
  await page.click('.road-choice[data-road="ma"]');
  await page.click('#go');
  await page.waitForSelector('.picker');
  await page.click('.picker-choice');                     // she selected; she didn't read an ID off a card
  await page.waitForSelector('.plan-yours');

  const r = await page.evaluate(() => ({
    badge: document.querySelector('.yours-badge').textContent.trim(),
    heading: PRPassport.passportStrings(passportModelNow(state.lastData))
      .find((s) => s === 'Your plan' || s === 'The plan you selected'),
  }));
  expect(r.badge).toBe('The plan you selected');
  expect(r.heading).toBe('The plan you selected');        // the sheet mirrors her confidence too
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
