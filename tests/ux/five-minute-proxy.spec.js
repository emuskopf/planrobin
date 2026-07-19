'use strict';
// ================================================================================================
// THE FIVE-MINUTE PROXY — a MECHANICAL proxy, deliberately NOT a stopwatch.
//
// The 5-Minute Checkup makes a promise in its name. A scripted browser can't keep that promise —
// it can't read, it doesn't hesitate, it never re-reads a sentence — so timing a robot would prove
// nothing about whether a 74-year-old finishes in five minutes. **The real gate is Evan's hand test
// on preview**, with a phone and an actual stopwatch. That judgment is not automatable and this file
// does not pretend otherwise.
//
// What IS automatable is the mechanical budget the promise sits on: how many taps it takes, how many
// questions are compulsory, whether every state offers a way forward, whether anything is asked
// twice, and whether she can start typing before the network answers. Those can silently double in a
// refactor while every other gate stays green — a new "quick question", a required field, a picker
// that forgets. This file is the ratchet against that drift.
//
// A failure here does NOT mean "it now takes longer than five minutes". It means the mechanical
// budget the five-minute claim rests on has moved, and a human needs to re-time it before shipping.
// ================================================================================================
const { test, expect } = require('@playwright/test');
const H = require('./harness');

// The budget. Raising a number here is a product decision, not a test fix: it must come with a fresh
// hand-timed run on a real phone (see UX-REVIEW.md). The current path is 8 taps — the headroom is
// deliberate, not an invitation.
const BUDGET = {
  taps: 10,                 // discrete pointer interactions, cold load → rendered report
  compulsory: 2,            // ZIP + at least one medication. Everything else must be skippable.
  presentedQuestions: 5,    // the name on the door says five. A sixth is a rename, not a tweak.
  timeToFirstInputMs: 1500, // she can type into #zip this soon, EVEN IF the API is slow
};

// Count every real click the page receives (capture phase, so nothing can swallow it).
async function countTaps(page, run) {
  await page.evaluate(() => { window.__taps = 0; document.addEventListener('click', () => { window.__taps++; }, true); });
  await run();
  return page.evaluate(() => window.__taps);
}

// The minimum happy path: she has her card in hand and answers everything.
async function fastestPath(page) {
  await page.click('#zip');
  await page.fill('#zip', '63011');
  await H.addDrug(page, '20 MG');                       // tap the box, type, tap the suggestion
  await page.fill('#road-plan-id', 'H2041-001');
  await page.click('.road-choice[data-fill-where="local"]');
  await page.click('.road-choice[data-fill-days="1"]');
  await page.click('.road-choice[data-perks="unsure"]');
  await page.click('#go');
  await page.waitForSelector('.action-plan');
}

test.describe('five-minute proxy (mechanical — the stopwatch is a human on preview)', () => {
  test('taps-to-report stays within budget', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-two-roads.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto('/checkup.html');
    const taps = await countTaps(page, () => fastestPath(page));
    expect(taps,
      `cold load → report took ${taps} taps (budget ${BUDGET.taps}). If this is a deliberate change, `
      + 're-time the checkup by hand on a phone and move BUDGET.taps with that evidence.').toBeLessThanOrEqual(BUDGET.taps);
  });

  test('taps-to-report stays within budget on the skip path (no plan ID → the picker)', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-two-roads.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto('/checkup.html');
    const taps = await countTaps(page, async () => {
      await page.click('#zip');
      await page.fill('#zip', '63011');
      await H.addDrug(page, '20 MG');
      await page.click('.road-choice[data-road="ma"]');
      await page.click('#go');
      await page.waitForSelector('.picker');
      await page.click('.picker-choice');                // the picker costs ONE extra tap, not a re-run
      await page.waitForSelector('.plan-yours');
    });
    expect(taps, `skip path took ${taps} taps (budget ${BUDGET.taps})`).toBeLessThanOrEqual(BUDGET.taps);
  });

  test('required interactions: only ZIP + one medication are compulsory', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-two-roads.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto('/checkup.html');
    // Answer NOTHING optional — no road, no plan ID, no fill habits, no perks.
    await page.fill('#zip', '63011');
    await H.addDrug(page, '20 MG');
    await expect(page.locator('#go'), `only ${BUDGET.compulsory} answers may be compulsory: a ZIP and one `
      + 'medication. If the button no longer enables here, a question has become mandatory.').toBeEnabled();
    await page.click('#go');
    // …and she still lands somewhere useful (the picker), not an error and not a demand.
    await page.waitForSelector('.picker');
    await expect(page.locator('.picker-choice').first(), 'skipping everything optional still reaches an answer').toBeVisible();
  });

  test('the intake asks five questions — the number on the door', async ({ page }) => {
    // A ratchet on the product's own promise, not a style rule. "The 5-Minute Checkup" earns its name
    // partly by being FIVE questions; a sixth is a product decision (and a rename), never a quiet add.
    await H.interceptApis(page, { results: 'results-two-roads.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto('/checkup.html');
    const asked = (await page.locator('main .card h2').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(asked.length, `the intake now asks ${asked.length}: ${asked.join(' | ')}`).toBe(BUDGET.presentedQuestions);
    // …and the two that are skippable say so, out loud, where she can see it.
    expect(asked.filter((t) => /optional/i.test(t)).length, 'the skippable ones are labelled Optional').toBe(2);
  });

  test('no dead ends: every state she can reach offers a way forward', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-two-roads.json' });
    await page.setViewportSize({ width: 412, height: 900 });

    // 1. the picker — must offer choices AND a way on if her plan isn't listed
    await page.goto('/checkup.html');
    await H.setCounty(page);
    await H.addDrug(page, '20 MG');
    await page.click('#go');
    await page.waitForSelector('.picker');
    expect(await page.locator('.picker-choice').count(), 'the picker lists plans').toBeGreaterThan(0);
    expect(await page.locator('.picker .fine').textContent(), 'and says what to do if hers isn’t there').toMatch(/Don’t see it\?/);

    // 2. a well-formed ID that isn't in this county — designed state, results still reachable
    await page.fill('#road-plan-id', 'H7777-777');
    await page.click('#go');
    await page.waitForSelector('.planid-missed');
    expect(await page.locator('.picker-choice').count(), 'she can still pick her plan from the list').toBeGreaterThan(0);

    // 3. the report — the terminal state must still hand her somewhere (SHIP, the comparison, a script)
    await page.fill('#road-plan-id', 'H2041-001');
    await page.click('#go');
    await page.waitForSelector('.action-plan');
    const links = await page.locator('#results a[href]').count();
    expect(links, 'the report always offers a next step').toBeGreaterThan(0);
    await expect(page.locator('.share-bar .share-btn').first(), 'and something to take away').toBeVisible();
  });

  test('nothing is asked twice', async ({ page }) => {
    await H.interceptApis(page, { results: 'results-two-roads.json' });
    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto('/checkup.html');

    // No question appears twice on the intake.
    const headings = (await page.locator('main .card h2').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(new Set(headings).size, `duplicate question: ${headings.join(' | ')}`).toBe(headings.length);

    // Her answers survive the run: the report doesn't re-ask what the intake already has.
    await fastestPath(page);
    expect(await page.inputValue('#zip'), 'ZIP is still answered').toBe('63011');
    expect(await page.inputValue('#road-plan-id'), 'her plan ID is still answered').toBe('H2041-001');
    expect(await page.locator('#drug-list li').count(), 'her medications are still there').toBeGreaterThan(0);
    // The report asks for nothing: no inputs, no question groups of its own.
    expect(await page.locator('#results input, #results select, #results .road-choice').count(),
      'the report answers; it does not interview').toBe(0);

    // The picker is a FALLBACK for the plan question, never a second asking of it: it appears only
    // when the ID went unanswered, and once answered it never returns.
    expect(await page.locator('.picker').count(), 'no picker when she typed her ID').toBe(0);
  });

  test('time-to-first-input: she can type before the network answers', async ({ page }) => {
    // The structural version of the metric. A wall-clock number on CI is noise; what matters is that
    // first input is never GATED on an API. Counties is stalled 3s — she must be typing long before.
    await H.interceptApis(page, { results: 'results-two-roads.json' });
    await page.route('**/api/counties*', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.setViewportSize({ width: 412, height: 900 });

    const t0 = Date.now();
    await page.goto('/checkup.html', { waitUntil: 'commit' });
    await page.locator('#zip').click();
    await page.locator('#zip').type('63');
    const dt = Date.now() - t0;

    expect(await page.inputValue('#zip'), 'the ZIP field accepted input while the API was still hanging').toBe('63');
    expect(dt, `time to first input was ${dt}ms (budget ${BUDGET.timeToFirstInputMs}ms) — is first input now `
      + 'waiting on a fetch?').toBeLessThan(BUDGET.timeToFirstInputMs);
  });
});
