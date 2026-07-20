// HAND-TYPED RESTORE CODE — the paper-only reopen path, for someone who can't scan the QR and won't
// re-type a whole basket. Same logical payload as the share fragment (share.js), a DIFFERENT encoding:
// one drug per line, digit-grouped, each line ending in a check digit. Names are NOT encoded — they're
// re-fetched from RxNorm by RXCUI on restore (brand vs generic is inherent in the RXCUI).
//
// Loaded in the browser (window.PRRestoreCode) and require()-d by tests.
//
// FORMAT (v2) — printed for humans, parsed by digits:
//   Line 1 (county + prefs):  V2.<county:5>.<prefs:1>-C<check:1>      e.g.  V2.26940.0-C3
//   Drug line:                <rxcui>.<qty:3>-C<check:1>              e.g.  596930.060-C7
//   • Fields are shown with dots / "-C" for readability, but PARSING strips every non-digit and reads
//     FIXED-WIDTH fields from the ends — so spaces, dashes, dots, the V/C letters and case are all
//     forgiven; only the digits matter. (Line 1 = exactly 8 digits; a drug line = rxcui + 3-digit qty
//     + 1-digit check.)
//   • prefs digit = whereIdx*2 + (days-1); whereIdx local=0 / preferred=1 / mail=2; days '1'=30d '2'=90d.
//     0 = the default (local, 30-day) and is always printed to keep Line 1 a fixed width.
//   • CHECK DIGIT is Damm (a single digit): it catches EVERY single-digit substitution and EVERY
//     adjacent transposition — the two ways a person mis-keys a number — with no false accepts.
(function (global) {
  'use strict';
  const VERSION = 2;
  const COUNTY_LEN = 5;   // MO SSA county codes are 5 digits
  const QTY_LEN = 3;      // zero-padded days-supply/quantity

  // Damm quasigroup operation table (the standard totally anti-symmetric one).
  const DAMM = [
    [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
    [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
    [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
    [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
    [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
    [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
    [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
    [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
    [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
    [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
  ];
  // The check digit that, appended to `digits`, makes the whole string's Damm interim 0.
  function dammDigit(digits) {
    let interim = 0;
    for (const ch of String(digits)) interim = DAMM[interim][+ch];
    return interim; // Damm's interim after the payload IS the check digit
  }
  // Valid iff running the digits INCLUDING the trailing check digit returns interim 0.
  function dammOk(digitsWithCheck) {
    let interim = 0;
    for (const ch of String(digitsWithCheck)) interim = DAMM[interim][+ch];
    return interim === 0;
  }

  const onlyDigits = (s) => String(s == null ? '' : s).replace(/\D+/g, '');
  const pad = (n, w) => { let s = String(n); while (s.length < w) s = '0' + s; return s; };

  // ---- prefs <-> digit ----
  const WHERE = ['local', 'preferred', 'mail'];
  function prefsToDigit(fill) {
    if (!fill) return 0;
    const w = Math.max(0, WHERE.indexOf(fill.where || 'local'));
    const d = String(fill.days) === '2' ? 1 : 0;
    return w * 2 + d;
  }
  function prefsFromDigit(p) {
    p = (+p) || 0;
    return { where: WHERE[Math.floor(p / 2)] || 'local', days: (p % 2) === 1 ? '2' : '1' };
  }

  // ---- encode: state -> printed lines ----
  // state: { county:'26940', drugs:[{rxcui,qty}] (or [rxcui,qty,...] / state.drugs Map entries), fill:{where,days} }
  function encode(state) {
    state = state || {};
    const county = pad(onlyDigits(state.county).slice(0, COUNTY_LEN), COUNTY_LEN);
    const prefs = prefsToDigit(state.fill);
    // Line 1: version + county + prefs + check
    const l1sig = String(VERSION) + county + String(prefs);
    const lines = [`V${VERSION}.${county}.${prefs}-C${dammDigit(l1sig)}`];
    // Drug lines: rxcui + qty(3) + check
    for (const d of normalizeDrugs(state.drugs)) {
      const rx = onlyDigits(d.rxcui);
      const qty = pad(onlyDigits(d.qty) || '30', QTY_LEN).slice(-QTY_LEN);
      const sig = rx + qty;
      lines.push(`${rx}.${qty}-C${dammDigit(sig)}`);
    }
    return lines;
  }

  // Accepts a drugs Map (state.drugs), an array of [rxcui,{qty}] entries, or [{rxcui,qty}] objects.
  function normalizeDrugs(drugs) {
    if (!drugs) return [];
    const entries = (typeof drugs.entries === 'function' && !(Array.isArray(drugs))) ? [...drugs.entries()] : drugs;
    return entries.map((e) => {
      if (Array.isArray(e)) return { rxcui: e[0], qty: (e[1] && e[1].qty != null) ? e[1].qty : (e[1] != null ? e[1] : 30) };
      return { rxcui: e.rxcui, qty: e.qty != null ? e.qty : 30 };
    }).filter((d) => onlyDigits(d.rxcui));
  }

  // ---- per-line validation (client-side, no server) ----
  // Returns { ok, kind:'county'|'drug', ... } for one typed line; friendly, isolated to the line.
  function parseLine(raw, index) {
    const digits = onlyDigits(raw);
    if (!digits) return { ok: false, empty: true };
    if (index === 0) {
      // county line: exactly version(1)+county(5)+prefs(1)+check(1) = 8 digits
      if (digits.length !== 3 + COUNTY_LEN) return { ok: false, kind: 'county', reason: 'length' };
      if (+digits[0] !== VERSION) return { ok: false, kind: 'county', reason: 'version', version: +digits[0] };
      if (!dammOk(digits)) return { ok: false, kind: 'county', reason: 'check' };
      return { ok: true, kind: 'county', county: digits.slice(1, 1 + COUNTY_LEN), prefs: +digits[COUNTY_LEN + 1] };
    }
    // drug line: rxcui(>=4) + qty(3) + check(1)
    if (digits.length < 4 + QTY_LEN + 1) return { ok: false, kind: 'drug', reason: 'length' };
    if (!dammOk(digits)) return { ok: false, kind: 'drug', reason: 'check' };
    const check = digits.length; // for slicing clarity
    const rxcui = digits.slice(0, check - QTY_LEN - 1);
    const qty = +digits.slice(check - QTY_LEN - 1, check - 1);
    return { ok: true, kind: 'drug', rxcui, qty };
  }

  // ---- decode: an array/blob of typed lines -> { ok, county, prefs, fill, drugs:[{rxcui,qty}], lines:[per-line] } ----
  function decode(input) {
    const rawLines = Array.isArray(input)
      ? input
      : String(input || '').split(/\r?\n/);
    const lines = rawLines.map((s) => String(s).trim()).filter((s) => onlyDigits(s).length > 0);
    if (!lines.length) return { ok: false, empty: true };
    const per = lines.map((l, i) => Object.assign({ raw: l, line: i + 1 }, parseLine(l, i)));
    const first = per[0];
    const drugs = [];
    for (let i = 1; i < per.length; i++) if (per[i].ok) drugs.push({ rxcui: per[i].rxcui, qty: per[i].qty });
    const ok = per.every((p) => p.ok) && first.kind === 'county';
    return {
      ok,
      county: first.ok ? first.county : null,
      prefs: first.ok ? first.prefs : 0,
      fill: first.ok ? prefsFromDigit(first.prefs) : null,
      drugs,
      lines: per,
    };
  }

  const api = { encode, decode, parseLine, dammDigit, dammOk, prefsToDigit, prefsFromDigit, VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PRRestoreCode = api;
})(typeof window !== 'undefined' ? window : globalThis);
