'use strict';
// PlanRobin drug checker — deterministic, no LLM. Talks only to our own /api/* endpoints.
// The medication list lives here in the browser; only RXCUIs are sent to the server.

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

const state = { county: '', drugs: new Map() /* rxcui -> {label, kind} */ };
const PHASES = [['0', 'Pre-deductible'], ['1', 'Initial coverage'], ['3', 'Catastrophic']];
const DAYS = [['1', '30-day'], ['2', '90-day']];

// Plain-English glossary for Medicare jargon. Project rule: if it's jargon, explain it
// in a sentence or two here, with a link to the fuller FAQ article (faq.html#slug).
const TERMS = {
  'pre-deductible': 'Early in the year, before you’ve met the plan’s deductible.',
  'initial-coverage': 'Your regular cost after meeting the deductible. This is the headline number above.',
  'catastrophic': 'After your yearly out-of-pocket spending reaches the cap ($2,000 in 2025), covered drugs are $0 for the rest of the year.',
  'standard-retail': 'Any in-network pharmacy.',
  'preferred-retail': 'Specific pharmacies the plan picks as lower-cost.',
  'preferred-mail': 'The plan’s mail-order pharmacy — often the cheapest, especially for 90-day fills.',
  'days-supply': 'How many days each fill covers. A 90-day fill is often cheaper per month.',
  // Plan types
  'ma-pd': 'Medicare Advantage plan that includes drug coverage — an all-in-one plan that replaces Original Medicare.',
  'pdp': 'A stand-alone Prescription Drug Plan you add on to Original Medicare.',
  // Costs
  'premium': 'The fixed monthly amount you pay to have the plan, no matter how many drugs you take.',
  'deductible': 'What you pay out of pocket for drugs each year before the plan starts sharing the cost.',
  'copay': 'A fixed dollar amount you pay per fill (for example, $10).',
  'coinsurance': 'A percentage of the drug’s price you pay per fill (for example, 25%) instead of a flat dollar amount.',
  // Drug-row terms
  'tier': 'Plans sort covered drugs into tiers; lower tiers usually cost you less.',
  'prior-authorization': 'PA — the plan must approve this drug before it’s covered.',
  'step-therapy': 'ST — you may need to try a preferred or lower-cost drug first.',
  'quantity-limit': 'QL — the plan caps how much of this drug is covered per fill or period.',
  'formulary': 'The plan’s official list of covered drugs.',
};
// A "Learn more in the FAQ →" link (opens a new tab so the in-progress results aren’t lost).
const faqLink = (slug, text = 'Learn more in the FAQ →') =>
  el('a', { href: 'faq.html#' + slug, target: '_blank', rel: 'noopener', className: 'faq-link', textContent: text });

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) { let d = {}; try { d = await r.json(); } catch {} throw new Error(d.error || `HTTP ${r.status}`); }
  return r.json();
}

// ---------- init ----------
async function init() {
  try {
    const meta = await getJSON('/api/meta');
    renderProvenance(meta);
  } catch { $('#provenance').textContent = 'Data: source unavailable'; }
  try {
    const { counties } = await getJSON('/api/counties');
    const sel = $('#county');
    sel.innerHTML = '';
    sel.append(el('option', { value: '', textContent: 'Select your county…' }));
    for (const c of counties) sel.append(el('option', { value: c.code, textContent: c.name }));
  } catch { $('#county').innerHTML = '<option>Could not load counties</option>'; }

  $('#county').addEventListener('change', (e) => { state.county = e.target.value; refreshGo(); syncResults(); });
  wireAutocomplete();
  $('#go').addEventListener('click', runResults);
}

function renderProvenance(meta) {
  if (!meta || !meta.quarter) { $('#provenance').textContent = 'Data: source unavailable'; return; }
  const d = meta.ingestedAt ? new Date(meta.ingestedAt) : null;
  const upd = d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown date';
  $('#provenance').textContent = `Data: CMS ${meta.quarter} Prescription Drug Plan files, loaded ${upd} (scope: ${meta.scope || 'MO'}).`;
}

// ---------- autocomplete ----------
function wireAutocomplete() {
  const input = $('#drug-input'), box = $('#suggestions');
  let timer = null, seq = 0;
  const close = () => { box.hidden = true; box.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      box.hidden = false; box.innerHTML = ''; box.append(el('li', { className: 'sugg-note', textContent: 'Searching…' }));
      input.setAttribute('aria-expanded', 'true');
      try {
        const data = await getJSON('/api/rxnorm/search?q=' + encodeURIComponent(q));
        if (mine !== seq) return; // stale
        renderSuggestions(data);
      } catch { if (mine === seq) { box.innerHTML = ''; box.append(el('li', { className: 'sugg-note error', textContent: 'Search failed — try again.' })); } }
    }, 220);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.autocomplete')) close(); });

  function renderSuggestions(data) {
    box.innerHTML = '';
    if (data.approximatedFrom) box.append(el('li', { className: 'sugg-note', textContent: `Showing results for “${data.approximatedFrom}”` }));
    const list = data.results.filter((r) => !state.drugs.has(r.rxcui));
    if (list.length === 0) { box.append(el('li', { className: 'sugg-note', textContent: 'No matching products.' })); return; }
    for (const r of list) {
      const li = el('li', { role: 'option' }, [
        el('span', { className: 'nm', textContent: r.name }),
        el('span', { className: 'badge ' + r.kind, textContent: r.kind }),
      ]);
      li.addEventListener('click', () => { addDrug(r); input.value = ''; close(); });
      box.append(li);
    }
  }
}

function addDrug(r) {
  if (state.drugs.size >= 10 || state.drugs.has(r.rxcui)) return;
  state.drugs.set(r.rxcui, { label: r.name, kind: r.kind });
  renderChips(); refreshGo(); syncResults();
}
function removeDrug(rxcui) { state.drugs.delete(rxcui); renderChips(); refreshGo(); syncResults(); }

function renderChips() {
  const ul = $('#drug-list'); ul.innerHTML = '';
  for (const [rxcui, d] of state.drugs) {
    const btn = el('button', { type: 'button', textContent: '×', title: 'Remove', ariaLabel: 'Remove ' + d.label });
    btn.addEventListener('click', () => removeDrug(rxcui));
    ul.append(el('li', {}, [el('span', { textContent: d.label }), el('span', { className: 'badge ' + d.kind, textContent: d.kind }), btn]));
  }
}

function refreshGo() {
  const ok = state.county && state.drugs.size >= 1;
  $('#go').disabled = !ok;
  $('#go-hint').textContent = ok ? `${state.drugs.size} drug(s) · ready` : 'Pick a county and at least one drug.';
}

// Keep the results in sync with the current list. If results are already showing and the
// county/drug list changes, re-run (costs + sort depend on the exact set); if the list is
// no longer valid, clear them so nothing stale lingers.
function syncResults() {
  if ($('#results').hidden) return;
  if (state.county && state.drugs.size >= 1) runResults();
  else clearResults();
}
function clearResults() { const b = $('#results'); b.hidden = true; b.innerHTML = ''; }

// ---------- results ----------
let runSeq = 0;
async function runResults() {
  const mine = ++runSeq; // guard against out-of-order responses when the list changes fast
  const box = $('#results'); box.hidden = false; box.innerHTML = '';
  box.append(el('p', { className: 'spinner', textContent: 'Checking every plan in your county…' }));
  try {
    const data = await getJSON('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ county: state.county, rxcuis: [...state.drugs.keys()] }),
    });
    if (mine !== runSeq) return; // a newer run superseded this one
    renderResults(data);
  } catch (e) {
    if (mine !== runSeq) return;
    box.innerHTML = ''; box.append(el('p', { className: 'error', textContent: 'Could not load results: ' + e.message }));
  }
}

function money(n) { return '$' + Number(n).toFixed(2); }

function renderResults(data) {
  const box = $('#results'); box.innerHTML = '';
  box.append(el('h2', {}, `Plans in ${data.county.name}, ${data.county.state}`));
  const d = data.meta && data.meta.ingestedAt ? new Date(data.meta.ingestedAt) : null;
  box.append(el('div', { className: 'result-meta' }, [
    el('span', { className: 'muted small', textContent: `${data.planCount} plans · sorted by estimated annual cost` }),
    el('span', { className: 'muted small', textContent: data.meta && data.meta.quarter ? `Data: CMS ${data.meta.quarter}${d ? ', loaded ' + d.toLocaleDateString() : ''}` : '' }),
  ]));
  box.append(el('div', { className: 'formula', textContent: data.formula }));
  box.append(renderKey());

  for (const p of data.plans) box.append(renderPlan(p));
}

// One-time "what do these terms mean?" key so the rows stay uncluttered. Sourced from the
// central TERMS glossary; project rule: explain every Medicare term (see faq.html).
function renderKey() {
  const det = el('details', { className: 'terms-key' });
  det.append(el('summary', { textContent: 'What do these terms mean?' }));
  const group = (heading, items) => {
    const dl = el('dl', { className: 'key-dl' });
    for (const [label, slug] of items) { dl.append(el('dt', { textContent: label })); dl.append(el('dd', { textContent: TERMS[slug] })); }
    det.append(el('h4', { className: 'key-h', textContent: heading }));
    det.append(dl);
  };
  group('Plan types', [['MA-PD', 'ma-pd'], ['PDP', 'pdp']]);
  group('Costs', [['Premium', 'premium'], ['Deductible', 'deductible'], ['Copay', 'copay'], ['Coinsurance', 'coinsurance']]);
  group('On each drug', [['Tier', 'tier'], ['PA', 'prior-authorization'], ['ST', 'step-therapy'], ['QL', 'quantity-limit'], ['Formulary', 'formulary']]);
  det.append(faqLink('tiers-flags', 'Full definitions in the FAQ →'));
  return det;
}

const planTypeSlug = (label) => (label && label.startsWith('PDP')) ? 'pdp' : 'ma-pd';

function renderPlan(p) {
  const annual = el('div', { className: 'annual' }, [
    el('div', { className: 'num' + (p.annualComplete ? '' : ' incomplete'), textContent: money(p.annualEstimate) + (p.annualComplete ? '' : '+') }),
    el('div', { className: 'lbl', textContent: p.annualComplete ? 'est. per year' : 'est. per year (excludes coinsurance)' }),
  ]);
  const head = el('div', { className: 'plan-head' }, [
    el('div', {}, [
      el('div', { className: 'plan-name', textContent: p.planName }),
      el('div', { className: 'plan-sub' }, [
        el('span', { className: 'term', title: TERMS[planTypeSlug(p.planType)], textContent: p.planType }),
        document.createTextNode(' · '),
        el('span', { className: 'term', title: TERMS.premium, textContent: `premium ${money(p.premium || 0)}/mo` }),
        document.createTextNode(' · '),
        el('span', { className: 'term', title: TERMS.deductible, textContent: `deductible ${money(p.deductible || 0)}` }),
      ]),
    ]),
    annual,
  ]);
  const card = el('div', { className: 'plan' }, [head]);
  for (const [rxcui, meta] of state.drugs) card.append(renderDrugRow(rxcui, meta, p.drugs[rxcui]));
  return card;
}

function renderDrugRow(rxcui, meta, res) {
  const name = el('span', { className: 'drug-name', textContent: meta.label });
  if (!res || !res.covered) {
    return el('div', { className: 'drug-row' }, [name,
      el('span', { className: 'notcovered term', title: TERMS.formulary, textContent: 'Not covered by this plan’s formulary' })]);
  }
  const flags = el('span', { className: 'flags' });
  if (res.flags.priorAuth) flags.append(el('span', { className: 'flag', title: TERMS['prior-authorization'], textContent: 'PA' }));
  if (res.flags.stepTherapy) flags.append(el('span', { className: 'flag', title: TERMS['step-therapy'], textContent: 'ST' }));
  if (res.flags.quantityLimit) flags.append(el('span', { className: 'flag', title: `${TERMS['quantity-limit']} (limit ${res.flags.qlAmount || ''}/${res.flags.qlDays || ''} days)`, textContent: 'QL' }));

  const left = el('div', {}, [name, el('span', { className: 'muted small term', title: TERMS.tier, textContent: ` · Tier ${res.tier}` }), flags]);
  // Per-drug cost: per-fill headline + its annualized contribution (12 × 30-day copay).
  const right = el('div', { className: 'headline' });
  if (res.headline.kind === 'copay') {
    right.append(el('span', { textContent: `${money(res.headline.dollars)}/fill` }));
    right.append(el('span', { className: 'muted small annual-drug', textContent: ` · ${money(res.headline.dollars * 12)}/yr` }));
  } else {
    right.append(el('span', { textContent: res.headline.display }));
    right.append(el('span', { className: 'muted small annual-drug', textContent: ' · not annualized' }));
  }
  const row = el('div', { className: 'drug-row' }, [left, right]);
  row.append(renderPhases(res.phases));
  return row;
}

function renderPhases(phases) {
  const det = el('details', { className: 'phases' });
  det.append(el('summary', { textContent: 'Other phases & pharmacy channels' }));

  // Plain-English intro so the table isn't a wall of Medicare jargon.
  det.append(el('p', { className: 'phase-intro', textContent:
    'Your cost for this drug changes during the year and by where you fill it. The number above is the everyday case — a 30-day fill at a standard pharmacy during initial coverage. Here’s the rest.' }));

  const th = (text, slug) => el('th', { textContent: text, title: TERMS[slug] || '' });
  const t = el('table', { className: 'detail' });
  t.append(el('thead', {}, el('tr', {}, [
    el('th', { textContent: 'Phase' }), th('Days', 'days-supply'),
    th('Std retail', 'standard-retail'), th('Pref retail', 'preferred-retail'), th('Pref mail', 'preferred-mail'),
  ])));
  const tb = el('tbody');
  for (const [lvl, plabel] of PHASES) {
    const ph = phases[lvl]; if (!ph) continue;
    const slug = { '0': 'pre-deductible', '1': 'initial-coverage', '3': 'catastrophic' }[lvl];
    for (const [ds, dlabel] of DAYS) {
      const e = ph.byDaysSupply[ds]; if (!e) continue;
      tb.append(el('tr', {}, [
        el('td', { textContent: plabel, title: TERMS[slug] || '' }), el('td', { textContent: dlabel }),
        el('td', { textContent: cell(e.standardRetail) }), el('td', { textContent: cell(e.preferredRetail) }),
        el('td', { textContent: cell(e.preferredMail) }),
      ]));
    }
  }
  t.append(tb); det.append(t);

  // Short definitions + a link to the fuller FAQ article.
  const legend = el('div', { className: 'phase-legend' });
  legend.append(el('p', {}, [el('strong', { textContent: 'Phases: ' }), document.createTextNode(
    `Pre-deductible = ${TERMS['pre-deductible']} Initial coverage = ${TERMS['initial-coverage']} Catastrophic = ${TERMS['catastrophic']}`)]));
  legend.append(el('p', {}, [el('strong', { textContent: 'Pharmacy: ' }), document.createTextNode(
    `Standard = ${TERMS['standard-retail']} Preferred = ${TERMS['preferred-retail']} Mail = ${TERMS['preferred-mail']}`)]));
  legend.append(faqLink('coverage-phases'));
  det.append(legend);
  return det;
}

function cell(c) {
  if (!c) return '—';
  if (c.kind === 'copay') return money(c.dollars);
  if (c.kind === 'coinsurance') return Math.round(c.rate * 100) + '%';
  return 'n/a';
}

init();
