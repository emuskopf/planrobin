'use strict';
// Share-link codec tests (site/share.js). Round-trip, version tolerance, graceful decode.
// Pure, no DB, no network. Run: node tests/share.test.js
//
// NETWORK ASSERTION (documented): the share state lives in the URL FRAGMENT (#...). Per the
// HTTP/URL spec, browsers strip the fragment before sending a request — it is never placed in
// the request line or Referer. So a fragment-bearing URL leaks nothing to the server. This is a
// property of fragments, verified in-browser via preview_network; here we only test the codec.

const assert = require('assert');
const S = require('../site/share.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

t('round-trip: encode → decode restores identical state', () => {
  const state = { county: '26940', drugs: [
    ['617310', 30, 'atorvastatin 20 MG Oral Tablet', 'generic'],
    ['2058877', 1, '1 ML galcanezumab-gnlm 120 MG/ML Auto-Injector [Emgality]', 'brand'],
  ] };
  const frag = S.encode(state);
  assert.ok(frag.startsWith('v1.'), 'versioned payload');
  const d = S.decode('#' + frag);
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.county, '26940');
  assert.strictEqual(d.drugs.length, 2);
  assert.deepStrictEqual(d.drugs[0], { rxcui: '617310', qty: 30, name: 'atorvastatin 20 MG Oral Tablet', kind: 'generic' });
  assert.strictEqual(d.drugs[1].rxcui, '2058877');
  assert.strictEqual(d.drugs[1].qty, 1);
});

t('decode tolerates a leading # or none', () => {
  const frag = S.encode({ county: '26090', drugs: [['861960', 30, 'armodafinil 200 MG Oral Tablet', 'generic']] });
  assert.strictEqual(S.decode(frag).ok, true);
  assert.strictEqual(S.decode('#' + frag).ok, true);
});

t('version tolerance: a hand-built v1 link parses', () => {
  // Construct a v1 payload by hand (as an "old" link would look) and confirm it still reads.
  const json = JSON.stringify({ v: 1, c: '26510', d: [['617310', 60, 'atorvastatin 20 MG Oral Tablet', 'generic']] });
  const b64 = Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const d = S.decode('v1.' + b64);
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.county, '26510');
  assert.strictEqual(d.drugs[0].qty, 60);
});

t('unknown/unfamiliar version is rejected cleanly (no throw)', () => {
  assert.strictEqual(S.decode('v2.whatever').ok, false);
  assert.strictEqual(S.decode('garbage').ok, false);
  assert.strictEqual(S.decode('v1.!!!notbase64!!!').ok, false);
  assert.strictEqual(S.decode('').empty, true);
});

t('graceful: an unknown RXCUI in the fragment still decodes (restore + let results flag it)', () => {
  const frag = S.encode({ county: '26940', drugs: [['999999999', 30, 'Made Up Drug 999', 'generic']] });
  const d = S.decode(frag);
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.drugs[0].rxcui, '999999999');
  assert.strictEqual(d.drugs[0].name, 'Made Up Drug 999'); // name carried so the chip restores without a lookup
});

t('missing/invalid quantity defaults to 30 (once-daily)', () => {
  const json = JSON.stringify({ v: 1, c: '26940', d: [['617310', 0, 'x', 'generic'], ['314076']] });
  const b64 = Buffer.from(json, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const d = S.decode('v1.' + b64);
  assert.strictEqual(d.drugs[0].qty, 30);
  assert.strictEqual(d.drugs[1].qty, 30);
});

console.log(`\nALL SHARE TESTS PASSED (${passed}).`);
