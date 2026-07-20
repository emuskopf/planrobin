'use strict';
// HAND-TYPED RESTORE CODE — the full round-trip the founder specified: a search → its printed code →
// a FRESH page → typed entry → identical search restored. Plus a typo isolated + corrected, and the
// entry's forgiving/incremental validation. Hermetic (canned APIs) so it's deterministic and offline.
const { test, expect } = require('@playwright/test');
const H = require('./harness');

// Drive the intake, then read the printed restore code straight off the shared passport model.
async function codeFor(page, drugStrengths) {
  await page.goto('/checkup.html');
  await H.setCounty(page);
  for (const s of drugStrengths) await H.addDrug(page, s);
  await page.fill('#road-plan-id', 'H2041-001');
  // Set a non-default Q4 pref (preferred pharmacy, 90-day) to prove prefs survive the code. Use the
  // buttons' own handlers directly — Playwright's positional click flakes on the second fill button
  // when the long "preferred" option wraps and shifts the layout; the real handler is floor-tested.
  await page.evaluate(() => {
    document.querySelector('.road-choice[data-fill-where="preferred"]').click();
    document.querySelector('.road-choice[data-fill-days="2"]').click();
  });
  await page.click('#go');
  await page.waitForSelector('.action-plan');
  return page.evaluate(() => {
    const model = passportModelNow(state.lastData);
    const cl = model.items.find((i) => i.type === 'codelines');
    return { lines: cl ? cl.lines : [], county: state.county, drugs: [...state.drugs.keys()], fill: state.fill };
  });
}

test('round-trip: a 2-drug search → printed code → fresh page → typed entry → same county/drugs/prefs', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-two-roads.json' });
  await page.setViewportSize({ width: 412, height: 900 });
  const src = await codeFor(page, ['20 MG', '60 MG']);
  expect(src.lines.length).toBe(3); // county + 2 drug lines
  expect(src.fill).toEqual({ where: 'preferred', days: '2' });

  // FRESH page — nothing carried over.
  await page.goto('/checkup.html');
  await page.click('#code-restore > summary');
  await page.fill('#code-input', src.lines.join('\n'));
  // every line confirms, and the button enables
  await expect(page.locator('.code-line.cl-ok')).toHaveCount(3);
  await expect(page.locator('.code-line.cl-bad')).toHaveCount(0);
  await expect(page.locator('#code-go')).toBeEnabled();
  await page.click('#code-go');
  // The code reopens the SEARCH (county + drugs + prefs) — not her plan — so the checkup runs and lands
  // on the plan picker. That the search ran at all is the round-trip; the state is the proof.
  await page.waitForSelector('.picker, .action-plan');

  const got = await page.evaluate(() => ({ county: state.county, drugs: [...state.drugs.keys()].sort(), fill: state.fill }));
  expect(got.county).toBe(src.county);
  expect(got.drugs).toEqual(src.drugs.sort());
  expect(got.fill).toEqual({ where: 'preferred', days: '2' }); // the Q4 prefs came back too
});

test('round-trip: a 10-drug basket survives the code', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-two-roads.json' });
  await page.setViewportSize({ width: 412, height: 900 });
  await page.goto('/checkup.html');
  // encode a 10-drug state directly (the codec is what we're exercising end-to-end via the entry)
  const lines = await page.evaluate(() => {
    const drugs = [];
    for (let i = 0; i < 10; i++) drugs.push([String(100000 + i * 811), { qty: [30, 60, 90][i % 3] }]);
    return PRRestoreCode.encode({ county: '26940', drugs, fill: { where: 'mail', days: '1' } });
  });
  expect(lines.length).toBe(11);
  await page.click('#code-restore > summary');
  await page.fill('#code-input', lines.join('\n'));
  await expect(page.locator('.code-line.cl-ok')).toHaveCount(11);
  await expect(page.locator('#code-go')).toBeEnabled();
});

test('typo isolation: one wrong digit flags ONLY its line; fixing it restores; a mistake never voids the rest', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-two-roads.json' });
  await page.setViewportSize({ width: 412, height: 900 });
  const src = await codeFor(page, ['20 MG', '60 MG']);
  await page.goto('/checkup.html');
  await page.click('#code-restore > summary');

  // corrupt one digit in the SECOND line (first drug); the others stay valid
  const lines = src.lines.slice();
  const digits = lines[1].replace(/\D/g, '').split('');
  digits[2] = String((+digits[2] + 1) % 10);
  lines[1] = digits.join('');
  await page.fill('#code-input', lines.join('\n'));

  // exactly one bad line, isolated, with the friendly digit-by-digit message; button disabled
  await expect(page.locator('.code-line.cl-bad')).toHaveCount(1);
  await expect(page.locator('.code-line.cl-ok')).toHaveCount(2);
  await expect(page.locator('.code-line.cl-bad')).toContainText('check it digit by digit');
  await expect(page.locator('#code-go')).toBeDisabled();

  // fix just that line (retype the correct code) — a mistake didn't cost the whole thing
  await page.fill('#code-input', src.lines.join('\n'));
  await expect(page.locator('.code-line.cl-bad')).toHaveCount(0);
  await expect(page.locator('#code-go')).toBeEnabled();
  await page.click('#code-go');
  await page.waitForSelector('.picker, .action-plan');
  const got = await page.evaluate(() => [...state.drugs.keys()].sort());
  expect(got).toEqual(src.drugs.sort());
});

test('the entry is a <details>, NOT a sixth intake question (the five-minute promise holds)', async ({ page }) => {
  await H.interceptApis(page, { results: 'results-two-roads.json' });
  await page.goto('/checkup.html');
  // the code entry has a <summary>, not an <h2> — so the intake still asks exactly five questions
  await expect(page.locator('#code-restore > summary')).toHaveCount(1);
  const questionHeadings = await page.locator('main .card h2').count();
  expect(questionHeadings).toBe(5);
});
