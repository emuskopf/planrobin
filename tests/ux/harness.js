'use strict';
// Shared UX-suite harness: replay canned APIs (no DB/network), drive the page into a named state,
// run the floor checkers, and format any violations into a humane failure string.

const fs = require('fs');
const path = require('path');
const { AxeBuilder } = require('@axe-core/playwright');
const { inPageAudit, OVERFLOW_EXEMPT, BODY_COPY } = require('./floors');

const FX = path.join(__dirname, 'fixtures');
const fx = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'));

// Replay every /api/* the site calls, from committed fixtures. `results` picks the state file.
async function interceptApis(page, { results = 'results-complete.json', rxnorm = 'rxnorm.json' } = {}) {
  const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/counties', (r) => r.fulfill(json(fx('counties.json'))));
  await page.route('**/api/meta', (r) => r.fulfill(json(fx('meta.json'))));
  await page.route('**/api/rxnorm/search**', (r) => r.fulfill(json(fx(rxnorm))));
  // rxcui -> name resolve (restore-code entry). Echo each requested rxcui with a generic name so the
  // round-trip is deterministic and offline; a real name isn't needed to prove the code restores.
  await page.route('**/api/rxnorm/resolve', (r) => {
    let rxcuis = [];
    try { rxcuis = (JSON.parse(r.request().postData() || '{}').rxcuis) || []; } catch (_) {}
    const results = rxcuis.map((rx) => ({ rxcui: String(rx), name: 'medication ' + rx, kind: 'generic', onFormulary: true }));
    return r.fulfill(json({ results }));
  });
  await page.route('**/api/zip**', (r) => {
    const zip = new URL(r.request().url()).searchParams.get('zip');
    if (zip === '65041') return r.fulfill(json(fx('zip-multi.json')));
    if (zip === '90210') return r.fulfill(json({ status: 'out_of_area', zip }));
    return r.fulfill(json(fx('zip-single.json')));
  });
  await page.route('**/api/results', (r) => r.fulfill(json(fx(results))));
}

// Add one drug via the (intercepted) autocomplete; optionally the long-name repro.
async function addDrug(page, matchText = '40 MG') {
  await page.fill('#drug-input', 'duloxetine');
  await page.waitForSelector('#suggestions li[role=option]', { state: 'visible' });
  const opt = page.locator('#suggestions li[role=option]', { hasText: matchText }).first();
  await (await opt.count() ? opt : page.locator('#suggestions li[role=option]').first()).click();
}

async function setCounty(page, code = '26940') {
  // The county select is the fallback path, tucked inside a collapsed <details> — open it so
  // Playwright can actually interact with the control.
  await page.evaluate(() => { const d = document.querySelector('#county-fallback'); if (d) d.open = true; });
  await page.selectOption('#county', code);
}

async function runToResults(page) {
  await setCounty(page);
  await addDrug(page);
  await page.click('#go');
  await page.waitForSelector('#results .plan', { state: 'visible' });
  // Expose the collapsed detail (breakdown + phase/channel table) so they're audited too.
  for (const d of await page.locator('#results details').all()) { await d.evaluate((n) => (n.open = true)); }
}

// Apply the large-font axis: 200% root font-size (rem tokens scale, viewport width unchanged —
// the Android "large font" case, distinct from browser zoom which also narrows the viewport).
async function setFontScale(page, scale) {
  if (scale && scale !== 1) await page.addStyleTag({ content: `html{font-size:${scale * 100}% !important}` });
}

// ---- run the checkers, return a flat list of {rule, ...} violations ----
async function collectViolations(page, { rules = ['overlap', 'overflow', 'touch', 'type', 'readability', 'contrast', 'focus'], overflowExempt = OVERFLOW_EXEMPT } = {}) {
  const out = [];
  const geo = await page.evaluate(inPageAudit, { overflowExempt, bodyCopy: BODY_COPY });
  for (const key of ['overlap', 'overflow', 'touch', 'type', 'readability']) {
    if (!rules.includes(key)) continue;
    for (const v of geo[key]) out.push({ rule: key.toUpperCase(), ...v });
  }
  if (rules.includes('contrast')) {
    const res = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    for (const v of res.violations) for (const n of v.nodes) out.push({ rule: 'CONTRAST', el: n.target.join(' '), detail: (n.failureSummary || '').split('\n').filter(Boolean).slice(-1)[0] || v.help });
  }
  if (rules.includes('focus')) {
    const f = await runFocus(page);
    for (const v of f) out.push({ rule: 'FOCUS', ...v });
  }
  return out;
}

// Focus: walk the page with the REAL keyboard (Tab), which triggers :focus-visible — so the ring
// actually applies (programmatic .focus() does not trigger it in Chromium). We assert every stop
// shows a ring and that traversal reaches interactive content before cycling.
async function runFocus(page) {
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  const noRing = new Map();
  const reached = new Set();
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const cs = getComputedStyle(el);
      const ring = (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none') || cs.boxShadow !== 'none';
      const key = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '|' + (el.textContent || '').trim().slice(0, 14);
      return { key, ring, tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') };
    });
    if (!info) continue;
    if (reached.has(info.key)) break; // cycled back to a prior stop — traversal complete
    reached.add(info.key);
    if (!info.ring) noRing.set(info.key, { el: info.tag, detail: 'no visible focus ring on keyboard focus' });
  }
  return [...noRing.values()];
}

function formatViolations(ctx, violations) {
  if (!violations.length) return '';
  const lines = violations.map((v) => {
    const extra = v.other ? ` ↔ ${v.other}` : '';
    return `    · [${v.rule}] ${v.el || v.detail}${extra}${v.el && v.detail ? ` — ${v.detail}` : ''}`;
  });
  return `UX FLOOR VIOLATIONS — ${ctx.state} @ ${ctx.viewport}px / ${ctx.font}\n${lines.join('\n')}`;
}

module.exports = { interceptApis, addDrug, setCounty, runToResults, setFontScale, collectViolations, formatViolations };
