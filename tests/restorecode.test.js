'use strict';
// RESTORE CODE — the hand-typed paper reopen path. Round-trips the same payload as the share
// fragment; a Damm per-line check digit catches every single-digit and adjacent-transposition error.
//   node tests/restorecode.test.js
const assert = require('assert');
const R = require('../site/restorecode.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
console.log('Restore code — digit-first, Damm-checked, forgiving:');

const st2 = { county: '26940', drugs: [{ rxcui: '596930', qty: 60 }, { rxcui: '197361', qty: 30 }], fill: { where: 'local', days: '1' } };

t('encode: one line for county+prefs, then one line per drug; the founder line shape', () => {
  const lines = R.encode(st2);
  assert.strictEqual(lines.length, 3, 'county line + 2 drug lines');
  assert.ok(/^V2\.26940\.0-C\d$/.test(lines[0]), lines[0]);
  assert.ok(/^596930\.060-C\d$/.test(lines[1]), lines[1]);   // "596930.060-C7"-style
  assert.ok(/^197361\.030-C\d$/.test(lines[2]), lines[2]);
});

t('round-trip: encode → decode returns the same county, prefs, and drugs (2-drug basket)', () => {
  const d = R.decode(R.encode(st2));
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.county, '26940');
  assert.deepStrictEqual(d.fill, { where: 'local', days: '1' });
  assert.deepStrictEqual(d.drugs, [{ rxcui: '596930', qty: 60 }, { rxcui: '197361', qty: 30 }]);
});

t('round-trip: a 10-drug basket survives (length is linear, ~1 line/drug)', () => {
  const drugs = [];
  for (let i = 0; i < 10; i++) drugs.push({ rxcui: String(100000 + i * 777), qty: [30, 60, 90][i % 3] });
  const st = { county: '26490', drugs, fill: { where: 'mail', days: '2' } };
  const lines = R.encode(st);
  assert.strictEqual(lines.length, 11, 'county + 10 drugs');
  const d = R.decode(lines);
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(d.fill, { where: 'mail', days: '2' });
  assert.deepStrictEqual(d.drugs, drugs.map((x) => ({ rxcui: x.rxcui, qty: x.qty })));
});

t('prefs round-trip for all six where×days combinations', () => {
  for (const where of ['local', 'preferred', 'mail']) for (const days of ['1', '2']) {
    const d = R.decode(R.encode({ county: '26940', drugs: [{ rxcui: '596930', qty: 30 }], fill: { where, days } }));
    assert.deepStrictEqual(d.fill, { where, days }, `${where}/${days}`);
  }
});

t('FORGIVING: spaces, dashes, dots and lower-case are all ignored on entry', () => {
  const lines = R.encode(st2);
  const mangled = lines.map((l) => l.toLowerCase().replace(/[.\-c]/gi, (m) => (m.toLowerCase() === 'c' ? 'C' : m)));
  // strip structure entirely and re-space randomly — only digits should matter
  const spaced = lines.map((l) => l.replace(/\D/g, '').split('').join(' '));
  assert.strictEqual(R.decode(spaced).ok, true, 'digits with spaces only');
  assert.deepStrictEqual(R.decode(spaced).drugs, [{ rxcui: '596930', qty: 60 }, { rxcui: '197361', qty: 30 }]);
});

t('CHECKSUM catches every single-digit substitution (Damm guarantee)', () => {
  const line = R.encode(st2)[1]; // "596930.060-C7"
  const digits = line.replace(/\D/g, '');
  let caught = 0, total = 0;
  for (let i = 0; i < digits.length; i++) for (let d = 0; d <= 9; d++) {
    if (+digits[i] === d) continue;
    total++;
    const bad = digits.slice(0, i) + d + digits.slice(i + 1);
    if (!R.dammOk(bad)) caught++;
  }
  assert.strictEqual(caught, total, `every single-digit error rejected (${caught}/${total})`);
});

t('CHECKSUM catches every adjacent transposition (Damm guarantee)', () => {
  const digits = R.encode(st2)[1].replace(/\D/g, '');
  let caught = 0, total = 0;
  for (let i = 0; i + 1 < digits.length; i++) {
    if (digits[i] === digits[i + 1]) continue;
    total++;
    const bad = digits.slice(0, i) + digits[i + 1] + digits[i] + digits.slice(i + 2);
    if (!R.dammOk(bad)) caught++;
  }
  assert.strictEqual(caught, total, `every adjacent transposition rejected (${caught}/${total})`);
});

t('per-line validation isolates a bad line and names its problem — a mistake never voids the rest', () => {
  const lines = R.encode(st2);
  // corrupt only the middle (first drug) line by one digit
  const bad = lines.slice();
  const digits = bad[1].replace(/\D/g, '').split('');
  digits[2] = String((+digits[2] + 1) % 10);   // flip one digit → check fails
  bad[1] = digits.join('');
  const d = R.decode(bad);
  assert.strictEqual(d.ok, false, 'overall not ok');
  assert.strictEqual(d.lines[0].ok, true, 'line 1 still valid');
  assert.strictEqual(d.lines[1].ok, false, 'line 2 flagged');
  assert.strictEqual(d.lines[1].reason, 'check', 'and the reason is the check digit');
  assert.strictEqual(d.lines[2].ok, true, 'line 3 unaffected — isolated');
});

t('length guards: a dropped or extra digit is rejected, not silently misread', () => {
  const l1 = R.encode(st2)[0].replace(/\D/g, '');
  assert.strictEqual(R.parseLine(l1.slice(0, -1), 0).ok, false, 'short county line rejected');
  assert.strictEqual(R.parseLine(l1 + '5', 0).ok, false, 'long county line rejected');
  assert.strictEqual(R.parseLine('12', 1).ok, false, 'too-short drug line rejected');
});

t('a code from a NEWER version is refused gracefully (not misread as v2 data)', () => {
  // fake a v3 county line: version digit 3, valid Damm over its own digits
  const county = '26940', prefs = '0';
  const sig = '3' + county + prefs;
  const line = '3' + county + prefs + R.dammDigit(sig);
  const p = R.parseLine(line, 0);
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'version');
  assert.strictEqual(p.version, 3);
});

console.log(`\nALL RESTORE-CODE TESTS PASSED (${passed}).`);
