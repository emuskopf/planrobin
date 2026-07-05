'use strict';
// CMS plan ID is displayed where the user needs it: the results meta line AND the printed Passport.
// The fixture is a real DB-captured /api/results response, so a match proves the shown ID equals the
// contract-plan key we've keyed on since Milestone 0.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const H = require('./harness');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'results-complete.json'), 'utf8'));
const DB_ID = fixture.plans[0].planId; // e.g. "H2041-001" — the government contract-plan key
const ID_RE = /^[HSR]\d{4}-\d{3}/; // CMS plan-id shape

test('results meta line shows the CMS plan ID (matches the DB key) with the one-tap explainer', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-complete.json' });
  await page.setViewportSize({ width: 412, height: 900 });
  await page.goto('/');
  await H.runToResults(page);

  expect(DB_ID).toMatch(ID_RE);
  const firstSub = page.locator('#results .plan .plan-sub').first();
  await expect(firstSub).toContainText(DB_ID);           // the exact DB key is on screen
  const idTerm = page.locator('#results .plan .plan-sub .plan-id').first();
  await expect(idTerm).toHaveText(DB_ID);
  await expect(idTerm).toHaveAttribute('title', /official Medicare ID/); // the explainer text
});

test('Passport page 1 prints the CMS plan ID with each plan', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-complete.json' });
  await page.setViewportSize({ width: 816, height: 1056 });
  await page.goto('/');
  await H.runToResults(page);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  const ppSubs = page.locator('.pp-plan .pp-plan-sub');
  await expect(ppSubs.first()).toContainText(DB_ID);
  // every printed plan carries an id of the CMS shape (independent lookup by a counselor/sibling)
  const texts = await ppSubs.allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) expect(t).toMatch(/[HSR]\d{4}-\d{3}/);
});
