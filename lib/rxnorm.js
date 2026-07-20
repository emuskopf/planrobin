'use strict';
// RxNorm product search — misspelling-tolerant, NO model in the loop.
// Given a (possibly misspelled/partial) query, returns concrete drug PRODUCTS
// (rxcui + name + tty + brand/generic) at the strength/dose-form level that the
// formulary keys on. Same resolution approach proven in Milestone 0 script 02.
//
// Strategy: /drugs?name= first (fast, exact-ish). If that returns nothing (typo like
// "duloxatine" or a partial), fall back to /approximateTerm to recover the real name,
// then expand that name to products. Deterministic given RxNorm's responses.

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const PRODUCT_TTYS = new Set(['SCD', 'SBD', 'GPCK', 'BPCK']);
const BRAND_TTYS = new Set(['SBD', 'BPCK']);

async function getJson(url, fetchImpl, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, 300 * (i + 1)));
    }
  }
}

async function productsByName(name, fetchImpl) {
  const j = await getJson(`${RXNAV}/drugs.json?name=${encodeURIComponent(name)}`, fetchImpl);
  const groups = (j.drugGroup && j.drugGroup.conceptGroup) || [];
  const out = [];
  for (const g of groups) {
    if (!PRODUCT_TTYS.has(g.tty)) continue;
    for (const p of g.conceptProperties || []) out.push({ rxcui: p.rxcui, tty: p.tty, name: p.name });
  }
  return out;
}

// rxcui -> product name + brand/generic. Used by the restore-code entry to confirm each line with a
// human-readable name ("Line 1 ✓ duloxetine 60 MG…"). Best-effort: returns null if RxNorm is down or
// the rxcui is unknown, and the caller degrades gracefully (labels by rxcui, never blocks the search).
async function nameByRxcui(rxcui, fetchImpl) {
  const rx = String(rxcui || '').replace(/\D+/g, '');
  if (!rx) return null;
  try {
    const j = await getJson(`${RXNAV}/rxcui/${rx}/allProperties.json?prop=names+attributes`, fetchImpl);
    const props = (j.propConceptGroup && j.propConceptGroup.propConcept) || [];
    const byName = (n) => { const p = props.find((x) => x.propName === n); return p ? p.propValue : null; };
    const name = byName('RxNorm Name') || byName('name');
    if (!name) return null;
    const tty = byName('TTY') || '';
    const isBrand = /SBD|BN/.test(tty);
    return { rxcui: rx, name, tty, kind: isBrand ? 'brand' : 'generic' };
  } catch (_) { return null; }
}

async function approximateName(term, fetchImpl) {
  const ax = await getJson(`${RXNAV}/approximateTerm.json?term=${encodeURIComponent(term)}&maxEntries=8`, fetchImpl);
  const cands = (ax.approximateGroup && ax.approximateGroup.candidate) || [];
  // Prefer the highest-scored candidate that carries a name.
  const named = cands.find((c) => c.name);
  return named ? named.name : null;
}

// Returns up to `limit` product candidates for a query.
async function searchProducts(query, fetchImpl = fetch, limit = 30) {
  const q = String(query || '').trim();
  if (q.length < 2) return { query: q, approximatedFrom: null, results: [] };

  let raw = await productsByName(q, fetchImpl);
  let approximatedFrom = null;
  if (raw.length === 0) {
    const name = await approximateName(q, fetchImpl);
    if (name && name.toLowerCase() !== q.toLowerCase()) { approximatedFrom = name; raw = await productsByName(name, fetchImpl); }
  }

  // Dedupe by rxcui, annotate brand/generic, and sort: generics first, then by name.
  const seen = new Set();
  const results = [];
  for (const p of raw) {
    if (seen.has(p.rxcui)) continue;
    seen.add(p.rxcui);
    const isBrand = BRAND_TTYS.has(p.tty);
    results.push({ rxcui: p.rxcui, name: p.name, tty: p.tty, isBrand, kind: isBrand ? 'brand' : 'generic' });
  }
  results.sort((a, b) => (a.isBrand - b.isBrand) || a.name.localeCompare(b.name));
  return { query: q, approximatedFrom, results: results.slice(0, limit) };
}

module.exports = { searchProducts, productsByName, approximateName, nameByRxcui };
