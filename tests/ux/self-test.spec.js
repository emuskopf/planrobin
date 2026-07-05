'use strict';
// META-TEST — proves the floor checkers actually CATCH violations (so a green suite means
// something). We render a deliberately-broken fixture page and assert each checker reports the
// planted defect with a humane message. This test PASSES by confirming the failures are detected.
const { test, expect } = require('@playwright/test');
const H = require('./harness');

// A tiny page that violates every rule on purpose.
const BROKEN = `<!doctype html><html><head><style>
  body{margin:0;font-family:system-ui}
  .overprint{position:relative}
  .a{position:absolute;left:0;top:0;width:200px}
  .b{position:absolute;left:0;top:0;width:200px;color:#111}
  .wide{width:900px;background:#eee}
  .tiny{font-size:9px}
  .lowcontrast{color:#c8c8c8;background:#fff}
  .smallbtn{width:20px;height:20px}
  .nofocus:focus-visible{outline:none;box-shadow:none}
  /* a text column crushed by a fixed-width sibling — min-width:0 lets it collapse to a sliver */
  .crushrow{display:flex;width:300px;font-size:19px}
  .crushname{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
  .crushsib{flex:none;width:268px;background:#ddd}
  /* a full-width grid stuffed into a narrow scroll box — cells crush instead of scrolling */
  .detail-scroll{overflow-x:auto;width:110px;font-size:16px}
  .detail-scroll table{width:100%;border-collapse:collapse}
  .detail-scroll td{border:1px solid #ccc}
</style></head><body>
  <div class="overprint"><span class="a">Aaaa bbbb cccc</span><span class="b">Xxxx yyyy zzzz</span></div>
  <div class="wide">too wide — horizontal overflow</div>
  <p class="tiny">9px legal line below the floor</p>
  <p class="lowcontrast">low contrast body text that axe should flag</p>
  <button class="smallbtn nofocus">x</button>
  <div class="crushrow"><span class="crushname">metoprolol succinate extended release tablet</span><span class="crushsib">badge</span></div>
  <div class="detail-scroll"><table><tr><td>Preferred</td><td>Standard</td><td>Catastrophic</td></tr></table></div>
</body></html>`;

test('checkers catch a deliberately-broken page (humane report)', async ({ page }) => {
  // Note: overprint spans are position:absolute, which the site's overlap rule intentionally skips
  // (floating overlays). Force them into the flow so the OVERLAP checker sees a real collision.
  const flowBroken = BROKEN.replace(/position:absolute/g, 'position:static').replace('.overprint{position:relative}', '.overprint{position:relative;height:0}.a,.b{display:block;margin-top:0}');
  await page.setContent(flowBroken);
  await page.setViewportSize({ width: 360, height: 800 });
  const violations = await H.collectViolations(page, {});
  const rules = new Set(violations.map((v) => v.rule));
  const report = H.formatViolations({ state: 'self-test/broken', viewport: 360, font: 'default' }, violations);

  // The suite would fail loudly on this page — confirm the humane report names concrete defects.
  expect(violations.length, report).toBeGreaterThan(0);
  expect(rules, report).toContain('OVERFLOW');   // .wide runs off the right edge
  expect(rules, report).toContain('TOUCH');      // 20x20 button < 44px
  expect(rules, report).toContain('TYPE');       // 9px text < 14px floor
  expect(rules, report).toContain('CONTRAST');     // #c8c8c8 on #fff fails AA
  expect(rules, report).toContain('READABILITY');  // name column crushed to a sliver by a fixed sibling
  expect(report, report).toMatch(/grid crushed/);  // a table stuffed into a narrow scroll box crushes its cells
  // report is human-readable: "· [RULE] element — detail"
  expect(report).toMatch(/\[(OVERFLOW|TOUCH|TYPE|CONTRAST|READABILITY)\]/);
});

test('a clean page produces zero violations', async ({ page }) => {
  await page.setContent(`<!doctype html><html><body style="margin:0;font-family:system-ui">
    <p style="font-size:19px;color:#1c2733;background:#fff;padding:16px">Calm, legible body copy at the 19px floor with AAA contrast.</p>
    <button style="min-width:44px;height:44px;font-size:19px;color:#fff;background:#0f5f76">OK</button>
  </body></html>`);
  await page.setViewportSize({ width: 360, height: 800 });
  const violations = await H.collectViolations(page, {});
  expect(violations, H.formatViolations({ state: 'self-test/clean', viewport: 360, font: 'default' }, violations)).toEqual([]);
});
