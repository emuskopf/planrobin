'use strict';
// PlanRobin drug checker — deterministic, no LLM. Talks only to our own /api/* endpoints.
// The medication list lives here in the browser; only RXCUIs are sent to the server.

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};

// Small inline icons so semantic states never rely on color alone (icon + word + color).
const ICON = {
  check: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 10.5l3.5 3.5L16 5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" stroke-linecap="round"/></svg>',
  law: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 3v13M4 16h12M6.5 7h7M6.5 7L4.5 11.5a2 2 0 004 0L6.5 7zm7 0l-2 4.5a2 2 0 004 0L13.5 7z" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  save: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M10 4a6 6 0 100 12 6 6 0 000-12z"/><path d="M10 7v6M8 9.2c0-.8.9-1.2 2-1.2s2 .5 2 1.3-.9 1.2-2 1.2-2 .5-2 1.3.9 1.2 2 1.2 2-.4 2-1.2" stroke-linecap="round"/></svg>',
};
const ic = (name) => { const s = el('span', { className: 'ic' }); s.innerHTML = ICON[name]; return s; };
// Which applied override → a plain-English "by federal law" badge (the trust feature).
const LAW_BADGE = { insulin_cap_35: 'capped by federal law', acip_vaccine_free: 'free by federal law' };

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
  'preferred-pharmacy': 'A pharmacy this plan has negotiated lower copays with. Most big chains are “preferred” on some plans and “standard” on others — it depends on the plan, not just the pharmacy.',
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

// ---------- autocomplete (fully keyboard-navigable) ----------
function wireAutocomplete() {
  const input = $('#drug-input'), box = $('#suggestions');
  let timer = null, seq = 0, options = [], active = -1;

  const close = () => {
    box.hidden = true; box.innerHTML = ''; options = []; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  };
  const setActive = (i) => {
    if (!options.length) return;
    if (active >= 0) options[active].classList.remove('active');
    active = (i + options.length) % options.length;
    const li = options[active];
    li.classList.add('active'); li.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
  };
  const choose = (li) => { const r = li._data; addDrug(r); input.value = ''; input.focus(); close(); };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      box.hidden = false; box.innerHTML = ''; options = []; active = -1;
      box.append(el('li', { className: 'sugg-note', textContent: 'Searching…' }));
      input.setAttribute('aria-expanded', 'true');
      try {
        const data = await getJSON('/api/rxnorm/search?q=' + encodeURIComponent(q));
        if (mine !== seq) return; // stale
        renderSuggestions(data);
      } catch { if (mine === seq) { box.innerHTML = ''; box.append(el('li', { className: 'sugg-note error', textContent: 'Search couldn’t reach the drug database — please try again.' })); } }
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    if (box.hidden || !options.length) { if (e.key === 'Escape') input.value = ''; return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); choose(options[active]); } }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.autocomplete')) close(); });

  function renderSuggestions(data) {
    box.innerHTML = ''; options = []; active = -1;
    if (data.approximatedFrom) box.append(el('li', { className: 'sugg-note', textContent: `Showing results for “${data.approximatedFrom}”` }));
    const list = data.results.filter((r) => !state.drugs.has(r.rxcui));
    if (list.length === 0) { box.append(el('li', { className: 'sugg-note', textContent: 'No matching products.' })); return; }
    list.forEach((r, i) => {
      const kids = [el('span', { className: 'nm', textContent: r.name }), el('span', { className: 'badge ' + r.kind, textContent: r.kind })];
      if (r.onFormulary === false) kids.push(el('span', { className: 'badge nocover', title: 'No Missouri plan lists this exact product', textContent: 'not on MO plans' }));
      const li = el('li', { id: 'sugg-' + i, role: 'option', className: r.onFormulary === false ? 'sugg-nocover' : '' }, kids);
      li._data = r;
      li.addEventListener('click', () => choose(li));
      li.addEventListener('mousemove', () => { if (active >= 0) options[active].classList.remove('active'); active = options.indexOf(li); li.classList.add('active'); });
      box.append(li); options.push(li);
    });
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
  renderSkeleton(box);
  try {
    const data = await getJSON('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ county: state.county, rxcuis: [...state.drugs.keys()] }),
    });
    if (mine !== runSeq) return; // a newer run superseded this one
    renderResults(data);
  } catch (e) {
    if (mine !== runSeq) return;
    box.innerHTML = '';
    const wrap = el('div', { className: 'state error' }, [
      el('p', { textContent: 'We couldn’t load the plan comparison just now.' }),
      el('p', { className: 'muted small', textContent: 'This is usually a brief connection hiccup — nothing is wrong with your list.' }),
    ]);
    const retry = el('button', { className: 'retry', type: 'button', textContent: 'Try again' });
    retry.addEventListener('click', runResults);
    wrap.append(retry);
    box.append(wrap);
  }
}

// Calm skeleton — the page settles in, nothing spins forever.
function renderSkeleton(box) {
  const line = (w) => el('div', { className: 'sk-line', style: `width:${w}` });
  box.append(el('p', { className: 'muted small', textContent: 'Checking every plan in your county…' }));
  for (let i = 0; i < 3; i++) {
    box.append(el('div', { className: 'sk-card' }, [line('55%'), line('85%'), line('40%')]));
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
  box.append(renderCoverageSummary(data));
  box.append(el('div', { className: 'formula', textContent: data.formula }));
  box.append(renderKey());

  for (const p of data.plans) box.append(renderPlan(p));
}

// Coverage at a glance: how many plans cover ALL your drugs, and per drug how many cover it.
// A drug covered by 0 plans is called out loudly (usually a wrong product/form was picked).
function renderCoverageSummary(data) {
  const total = data.plans.length;
  const coversAll = data.plans.filter((p) => p.notCovered === 0).length;
  const wrap = el('div', { className: 'coverage-summary' });
  wrap.append(el('div', { className: 'cov-headline', textContent: `${coversAll} of ${total} plans cover all your drugs` }));
  for (const [rxcui, meta] of state.drugs) {
    const cov = data.plans.filter((p) => p.drugs[rxcui] && p.drugs[rxcui].covered).length;
    const zero = cov === 0;
    const line = el('div', { className: 'cov-line' + (zero ? ' cov-zero' : '') }, [
      ic(zero ? 'cross' : 'check'),
      el('span', { className: 'cov-name', textContent: meta.label }),
      el('span', { className: 'cov-count', textContent: `covered by ${cov} of ${total} plans` }),
    ]);
    if (zero) line.append(el('span', { className: 'cov-hint', textContent: 'Not on any plan here — double-check you picked the right product or form.' }));
    wrap.append(line);
  }
  return wrap;
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
  const sav = renderSavings(p);
  if (sav) card.append(sav);
  for (const [rxcui, meta] of state.drugs) card.append(renderDrugRow(rxcui, meta, p.drugs[rxcui]));
  return card;
}

// A calm, information-only savings line: if the SAME plan is cheaper through a preferred
// pharmacy or by mail, say so — rounded, never a re-ranking. Nothing shows when there's no
// real differential. One tap opens a plain-English explainer (we can't name pharmacies yet).
function renderSavings(p) {
  const s = p.savings;
  if (!s) return null;
  const wrap = el('div', { className: 'savings' });
  const line = el('div', { className: 'savings-line' }, [
    ic('save'),
    el('span', {}, [
      document.createTextNode('Save about '),
      el('strong', { textContent: '$' + Number(s.displayAmount).toLocaleString() + '/year' }),
      document.createTextNode(' on this same plan ' + s.phrase + '.'),
    ]),
  ]);
  wrap.append(line);

  const det = el('details', { className: 'savings-more' });
  det.append(el('summary', { textContent: 'What’s a preferred pharmacy?' }));
  det.append(el('p', { textContent: TERMS['preferred-pharmacy'] }));
  det.append(el('p', {}, [
    el('strong', { textContent: 'We can show the savings; your plan’s directory shows which pharmacies qualify. ' }),
    document.createTextNode('To find this plan’s preferred pharmacies, check the plan’s website or call 1-800-MEDICARE. ' +
      'The estimate above holds your days-supply the same and changes only where you fill — it’s information, not a recommendation.'),
  ]));
  det.append(faqLink('preferred-pharmacy'));
  wrap.append(det);
  return wrap;
}

function renderDrugRow(rxcui, meta, res) {
  if (!res || !res.covered) {
    const status = el('span', { className: 'status notcov', title: TERMS.formulary });
    status.append(ic('cross'), document.createTextNode(' Not covered'));
    return el('div', { className: 'drug-row' }, [
      el('div', { className: 'dr-left' }, [el('span', { className: 'drug-name', textContent: meta.label })]),
      status,
    ]);
  }
  const flags = el('span', { className: 'flags' });
  if (res.flags.priorAuth) flags.append(el('span', { className: 'flag', title: TERMS['prior-authorization'], textContent: 'PA' }));
  if (res.flags.stepTherapy) flags.append(el('span', { className: 'flag', title: TERMS['step-therapy'], textContent: 'ST' }));
  if (res.flags.quantityLimit) flags.append(el('span', { className: 'flag', title: `${TERMS['quantity-limit']} (limit ${res.flags.qlAmount || ''}/${res.flags.qlDays || ''} days)`, textContent: 'QL' }));

  const nameLine = el('div', {}, [
    el('span', { className: 'drug-name', textContent: meta.label }),
    el('span', { className: 'muted small term', title: TERMS.tier, textContent: ` · Tier ${res.tier}` }), flags,
  ]);
  const left = el('div', { className: 'dr-left' }, [ic('check'), nameLine]);

  const right = el('div', { className: 'headline' });
  if (res.headline.kind === 'copay') {
    right.append(el('span', { className: 'amt', textContent: `${money(res.headline.dollars)}/fill` }));
    right.append(el('span', { className: 'annual-drug', textContent: ` · ${money(res.headline.dollars * 12)}/yr` }));
  } else {
    right.append(el('span', { className: 'amt', textContent: res.headline.display }));
    right.append(el('span', { className: 'annual-drug', textContent: ' · not annualized' }));
  }
  // Trust feature: when federal law sets the price, say so plainly ("capped by federal law").
  const rule = (res.appliedOverrides || [])[0];
  if (rule && LAW_BADGE[rule.rule]) {
    const badge = el('span', { className: 'badge-law', title: rule.note || '' });
    badge.append(ic('law'), document.createTextNode(' ' + LAW_BADGE[rule.rule]));
    right.append(el('div', {}, [badge]));
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
