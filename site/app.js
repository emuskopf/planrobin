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

  $('#county').addEventListener('change', (e) => { state.county = e.target.value; refreshGo(); });
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
  renderChips(); refreshGo();
}
function removeDrug(rxcui) { state.drugs.delete(rxcui); renderChips(); refreshGo(); }

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

// ---------- results ----------
async function runResults() {
  const box = $('#results'); box.hidden = false; box.innerHTML = '';
  box.append(el('p', { className: 'spinner', textContent: 'Checking every plan in your county…' }));
  try {
    const data = await getJSON('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ county: state.county, rxcuis: [...state.drugs.keys()] }),
    });
    renderResults(data);
  } catch (e) {
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

  for (const p of data.plans) box.append(renderPlan(p));
}

function renderPlan(p) {
  const annual = el('div', { className: 'annual' }, [
    el('div', { className: 'num' + (p.annualComplete ? '' : ' incomplete'), textContent: money(p.annualEstimate) + (p.annualComplete ? '' : '+') }),
    el('div', { className: 'lbl', textContent: p.annualComplete ? 'est. per year' : 'est. per year (excludes coinsurance)' }),
  ]);
  const head = el('div', { className: 'plan-head' }, [
    el('div', {}, [
      el('div', { className: 'plan-name', textContent: p.planName }),
      el('div', { className: 'plan-sub', textContent: `${p.planType} · premium ${money(p.premium || 0)}/mo · deductible ${money(p.deductible || 0)}` }),
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
    return el('div', { className: 'drug-row' }, [name, el('span', { className: 'notcovered', textContent: 'Not covered by this plan’s formulary' })]);
  }
  const flags = el('span', { className: 'flags' });
  if (res.flags.priorAuth) flags.append(el('span', { className: 'flag', title: 'Prior authorization', textContent: 'PA' }));
  if (res.flags.stepTherapy) flags.append(el('span', { className: 'flag', title: 'Step therapy', textContent: 'ST' }));
  if (res.flags.quantityLimit) flags.append(el('span', { className: 'flag', title: `Quantity limit ${res.flags.qlAmount || ''}/${res.flags.qlDays || ''}d`, textContent: 'QL' }));

  const left = el('div', {}, [name, el('span', { className: 'muted small', textContent: ` · Tier ${res.tier}` }), flags]);
  const right = el('span', { className: 'headline', textContent: res.headline.display });
  const row = el('div', { className: 'drug-row' }, [left, right]);
  row.append(renderPhases(res.phases));
  return row;
}

function renderPhases(phases) {
  const det = el('details', { className: 'phases' });
  det.append(el('summary', { textContent: 'Other phases & pharmacy channels' }));
  const t = el('table', { className: 'detail' });
  t.append(el('thead', {}, el('tr', {}, [
    el('th', { textContent: 'Phase' }), el('th', { textContent: 'Days' }),
    el('th', { textContent: 'Std retail' }), el('th', { textContent: 'Pref retail' }),
    el('th', { textContent: 'Pref mail' }),
  ])));
  const tb = el('tbody');
  for (const [lvl, plabel] of PHASES) {
    const ph = phases[lvl]; if (!ph) continue;
    for (const [ds, dlabel] of DAYS) {
      const e = ph.byDaysSupply[ds]; if (!e) continue;
      tb.append(el('tr', {}, [
        el('td', { textContent: plabel }), el('td', { textContent: dlabel }),
        el('td', { textContent: cell(e.standardRetail) }), el('td', { textContent: cell(e.preferredRetail) }),
        el('td', { textContent: cell(e.preferredMail) }),
      ]));
    }
  }
  t.append(tb); det.append(t);
  return det;
}

function cell(c) {
  if (!c) return '—';
  if (c.kind === 'copay') return money(c.dollars);
  if (c.kind === 'coinsurance') return Math.round(c.rate * 100) + '%';
  return 'n/a';
}

init();
