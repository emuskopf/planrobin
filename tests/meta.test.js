'use strict';
// /api/meta must expose the out-of-pocket cap from the SAME statutory parameter the cost engine
// computes with — so the glossary/tooltip prose (which reads /api/meta) is incapable of disagreeing
// with the math. Run: node tests/meta.test.js
const assert = require('assert');
const { metaHandler } = require('../lib/api/handlers');
const { paramsForYear, ENROLLMENT } = require('../tools/overrides/statutory-params');
const PRFormat = require('../site/format.js');

const fakeDb = (rows) => ({ query: async () => ({ rows }) });
const run = (quarter, extra) => metaHandler(fakeDb(quarter === null ? [] : [Object.assign(
  { puf_quarter: quarter, finished_at: '2026-07-01T00:00:00Z', download_date: '2026-07-01', scope: 'MO', row_counts: {} }, extra)]));

(async () => {
  console.log('/api/meta exposes the OOP cap from the engine’s statutory parameter:');

  // 2026-Q1 → planYear 2026 → cap == the parameter the math uses (no second source)
  let r = await run('2026-Q1');
  assert.strictEqual(r.body.planYear, 2026);
  assert.strictEqual(r.body.oopCapAnnual, paramsForYear(2026).oopCapAnnual);
  assert.strictEqual(r.body.oopCapAnnual, 2100);
  console.log('  ok  2026-Q1 → planYear 2026, cap == paramsForYear(2026) == $2,100');

  // no completed ingest run → no cap fabricated
  r = await run(null);
  assert.ok(r.body.oopCapAnnual == null);
  console.log('  ok  no ingest run → no cap fabricated');

  // a plan year with no verified parameters → cap omitted (null), never thrown or guessed
  r = await run('2099-Q1');
  assert.strictEqual(r.body.planYear, 2099);
  assert.strictEqual(r.body.oopCapAnnual, null);
  console.log('  ok  unknown plan year → cap null (never guessed), and meta still returns 200');

  // The AEP window travels to the browser as DATA from the same parameter the engine holds — the
  // season sentence can't drift from the statute, and the cached response carries no stale verdict.
  r = await run('2026-Q1');
  assert.deepStrictEqual(r.body.enrollment, ENROLLMENT, '/api/meta serves the engine’s AEP window verbatim');
  assert.deepStrictEqual(r.body.enrollment.aep, { startMonth: 10, startDay: 15, endMonth: 12, endDay: 7, effective: 'January 1' });
  // and it's the shape PRFormat renders the season sentence from
  assert.strictEqual(PRFormat.seasonLine(r.body, new Date(2026, 10, 1)), 'switching is open until December 7');
  assert.strictEqual(PRFormat.seasonLine(r.body, new Date(2026, 6, 8)), 'plan switching opens October 15');
  console.log('  ok  /api/meta serves the AEP window from the engine parameter; seasonLine renders from it');

  console.log('\nALL META TESTS PASSED (4).');
})().catch((e) => { console.error(e); process.exit(1); });
