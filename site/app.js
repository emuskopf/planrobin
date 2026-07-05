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

const state = { county: '', countySource: null /* 'zip' | 'county' | 'link' */, drugs: new Map() /* rxcui -> {label, kind, qty} */, lastData: null, restoredFromLink: false };
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
  'preferred-pharmacy': 'A pharmacy this plan has negotiated lower copays with. Most pharmacy chains are “preferred” on some plans and “standard” on others — it depends on the plan, not just the pharmacy.',
  'days-supply': 'How many days each fill covers. At a regular pharmacy a 90-day fill usually costs 3× the 30-day copay — the real 90-day savings come from mail order.',
  // Plan types
  'ma-pd': 'Medicare Advantage plan that includes drug coverage — an all-in-one plan that replaces Original Medicare.',
  'pdp': 'A stand-alone Prescription Drug Plan you add on to Original Medicare.',
  'plan-id': 'This is the plan’s official Medicare ID — it’s printed on the plan’s membership card, and it’s the surest way to confirm you’re looking at the right plan on Medicare.gov, with 1-800-MEDICARE, or with a SHIP counselor.',
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

  // Fallback path: choosing a county from the list confirms it, just like a ZIP would.
  $('#county').addEventListener('change', (e) => {
    if (!e.target.value) { setCounty('', null, null); renderZipStatus(null); return; }
    confirmCounty(e.target.value, e.target.selectedOptions[0].textContent, 'county');
  });
  wireZip();
  wireAutocomplete();
  $('#go').addEventListener('click', runResults);

  // Ctrl/⌘-P and the "Print this comparison" button both build the Plan Passport just before print.
  window.addEventListener('beforeprint', () => {
    if (!state.lastData) return;
    const host = ensurePassportHost();
    host.innerHTML = ''; host.append(buildPassport(state.lastData));
    document.body.classList.add('printing-passport');
  });
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing-passport'); });

  // A share link in the fragment restores the search and reruns it against CURRENT data.
  await maybeRestoreFromHash();
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
      // Badges live in their own group so they can wrap BELOW the name (line 2) on a narrow screen
      // instead of squeezing the name column — a name that can crush must wrap under what squeezed it.
      const badges = [el('span', { className: 'badge ' + r.kind, textContent: r.kind })];
      if (r.onFormulary === false) badges.push(el('span', { className: 'badge nocover', title: 'No Missouri plan lists this exact product', textContent: 'not on MO plans' }));
      const li = el('li', { id: 'sugg-' + i, role: 'option', className: r.onFormulary === false ? 'sugg-nocover' : '' },
        [el('span', { className: 'nm', textContent: r.name }), el('div', { className: 'sugg-badges' }, badges)]);
      li._data = r;
      li.addEventListener('click', () => choose(li));
      li.addEventListener('mousemove', () => { if (active >= 0) options[active].classList.remove('active'); active = options.indexOf(li); li.classList.add('active'); });
      box.append(li); options.push(li);
    });
  }
}

// Quantity presets — units per 30-day fill, framed by how often you take it (covers daily pills
// and monthly injectables). Only matters for coinsurance (%) drugs; copays are flat regardless.
const FREQ = [[30, '1 a day'], [60, '2 a day'], [90, '3 a day'], [1, '1 a month']];
const qtyLabel = (q) => { const f = FREQ.find(([v]) => v === q); return f ? f[1] : q + '/fill'; };

function addDrug(r) {
  if (state.drugs.size >= 10 || state.drugs.has(r.rxcui)) return;
  // offFormulary persists the "not on MO plans" warning onto the chip, so it doesn't vanish when the
  // dropdown closes (and gives the chip the same two-badge layout the suggestion has).
  state.drugs.set(r.rxcui, { label: r.name, kind: r.kind, qty: 30, offFormulary: r.onFormulary === false });
  renderChips(); refreshGo(); syncResults();
}
function removeDrug(rxcui) { state.drugs.delete(rxcui); renderChips(); refreshGo(); syncResults(); }

function renderChips() {
  const ul = $('#drug-list'); ul.innerHTML = '';
  for (const [rxcui, d] of state.drugs) {
    const freq = el('select', { className: 'qty', title: 'How often you take it — used to estimate percentage (coinsurance) costs', ariaLabel: 'How often you take ' + d.label });
    for (const [val, label] of FREQ) { const o = el('option', { value: String(val), textContent: label }); if (val === d.qty) o.selected = true; freq.append(o); }
    freq.addEventListener('change', () => { const e = state.drugs.get(rxcui); if (e) { e.qty = Number(freq.value); syncResults(); } });
    const btn = el('button', { type: 'button', textContent: '×', title: 'Remove', ariaLabel: 'Remove ' + d.label });
    btn.addEventListener('click', () => removeDrug(rxcui));
    // Two groups so nothing crushes the name: identity (name + generic/brand badge) wraps freely;
    // the fixed controls (quantity + remove) sit together and drop below the name on narrow screens.
    const idKids = [el('span', { className: 'chip-name', textContent: d.label }), el('span', { className: 'badge ' + d.kind, textContent: d.kind })];
    if (d.offFormulary) idKids.push(el('span', { className: 'badge nocover', title: 'No Missouri plan lists this exact product', textContent: 'not on MO plans' }));
    const idWrap = el('div', { className: 'chip-id' }, idKids);
    const controls = el('div', { className: 'chip-controls' }, [freq, btn]);
    ul.append(el('li', {}, [idWrap, controls]));
  }
}

// ---------- location (ZIP-first) ----------
// A ZIP is input convenience; the COUNTY (SSA code) is the real state — it's what results and
// share links use. Every path (ZIP resolve, county dropdown, restored link) funnels through
// setCounty so the two inputs and the confirmation line never disagree.
function setCounty(code, name, source) {
  state.county = code || '';
  state.countySource = code ? source : null;
  const sel = $('#county');
  if (sel) sel.value = (code && [...sel.options].some((o) => o.value === code)) ? code : '';
  refreshGo();
  syncResults();
}

// "St. Louis" -> "St. Louis County"; the independent city "St. Louis City" stays as-is.
function countyLabel(name) {
  if (!name) return '';
  return /\bcity\b/i.test(name) ? `${name}, Missouri` : `${name} County, Missouri`;
}

function confirmCounty(code, name, source) {
  setCounty(code, name, source);
  renderZipStatus({ kind: 'confirmed', name });
}

function changeLocation() {
  const z = $('#zip'); if (z) { z.value = ''; }
  setCounty('', null, null);
  renderZipStatus(null);
  if (z) z.focus();
}

// The single place the confirmation / disambiguation / not-covered message is drawn.
function renderZipStatus(p) {
  const box = $('#zip-status'); if (!box) return;
  box.innerHTML = ''; box.className = 'zip-status';
  if (!p) return;

  if (p.kind === 'loading') {
    box.append(el('p', { className: 'muted small', textContent: 'Looking up your ZIP…' }));
  } else if (p.kind === 'confirmed') {
    box.classList.add('ok');
    const line = el('div', { className: 'zip-confirm' });
    const check = el('span', { className: 'ic' }); check.innerHTML = ICON.check;
    line.append(check, el('span', { className: 'zip-place', textContent: countyLabel(p.name) }));
    const change = el('button', { type: 'button', className: 'zip-change', textContent: 'Change' });
    change.addEventListener('click', changeLocation);
    line.append(change);
    box.append(line);
  } else if (p.kind === 'choose') {
    box.classList.add('choose');
    const n = p.counties.length;
    box.append(el('p', { className: 'zip-ask', textContent: `This ZIP covers parts of ${n} counties — which is yours?` }));
    const btns = el('div', { className: 'county-choices' });
    for (const c of p.counties) {
      const b = el('button', { type: 'button', className: 'county-choice', textContent: countyLabel(c.name) });
      b.addEventListener('click', () => confirmCounty(c.code, c.name, 'zip'));
      btns.append(b);
    }
    box.append(btns);
  } else if (p.kind === 'notcovered') {
    box.classList.add('warn');
    box.append(el('p', {}, [
      document.createTextNode('We don’t have plan data for that ZIP yet — PlanRobin currently covers '),
      el('strong', { textContent: 'Missouri' }),
      document.createTextNode('. If you’re in Missouri, you can also pick your county from the list below.'),
    ]));
    $('#county-fallback').open = true;
  } else if (p.kind === 'error') {
    box.classList.add('warn');
    box.append(el('p', { className: 'small', textContent: 'We couldn’t look up that ZIP just now. You can pick your county from the list below instead.' }));
    $('#county-fallback').open = true;
  }
}

let zipSeq = 0;
async function doResolveZip(zip) {
  const mine = ++zipSeq;
  renderZipStatus({ kind: 'loading' });
  let r;
  try { r = await getJSON('/api/zip?zip=' + encodeURIComponent(zip)); }
  catch { if (mine === zipSeq) renderZipStatus({ kind: 'error' }); return; }
  if (mine !== zipSeq) return; // a newer keystroke superseded this lookup
  if (r.status === 'ok' && !r.multi) { confirmCounty(r.counties[0].code, r.counties[0].name, 'zip'); }
  else if (r.status === 'ok') { setCounty('', null, null); renderZipStatus({ kind: 'choose', counties: r.counties }); }
  else { setCounty('', null, null); renderZipStatus({ kind: 'notcovered' }); } // out_of_area / anything else
}

function wireZip() {
  const zip = $('#zip'); if (!zip) return;
  let timer = null;
  zip.addEventListener('input', () => {
    const digits = zip.value.replace(/\D/g, '').slice(0, 5);
    if (digits !== zip.value) zip.value = digits; // numeric only, keeps the numeric keypad honest
    // Editing the ZIP throws away a county that CAME FROM a ZIP; a county picked from the list stays.
    if (state.countySource === 'zip' || state.countySource === 'link') setCounty('', null, null);
    clearTimeout(timer);
    if (digits.length === 5) timer = setTimeout(() => doResolveZip(digits), 250);
    else renderZipStatus(null);
  });
}

function refreshGo() {
  const ok = state.county && state.drugs.size >= 1;
  $('#go').disabled = !ok;
  $('#go-hint').textContent = ok ? `${state.drugs.size} drug(s) · ready` : 'Enter your ZIP (or pick a county) and at least one drug.';
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
    const quantities = Object.fromEntries([...state.drugs].map(([rx, d]) => [rx, d.qty]));
    const data = await getJSON('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ county: state.county, rxcuis: [...state.drugs.keys()], quantities }),
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
// The CMS plan ID as shown to the user — segment suffix added only to disambiguate within the
// current results (shared definition in PRFormat, so screen + Passport read identically).
function displayPlanId(p) {
  return PRFormat.planDisplayId(p, PRFormat.ambiguousPlanIds((state.lastData && state.lastData.plans) || []));
}

function renderResults(data) {
  state.lastData = data;
  updateFragment(); // keep the address bar a shareable/bookmarkable link
  const box = $('#results'); box.innerHTML = '';
  box.append(el('h2', {}, `Plans in ${data.county.name}, ${data.county.state}`));
  const d = data.meta && data.meta.ingestedAt ? new Date(data.meta.ingestedAt) : null;
  box.append(el('div', { className: 'result-meta' }, [
    el('span', { className: 'muted small', textContent: `${data.planCount} plans · sorted by estimated annual cost` }),
    el('span', { className: 'muted small', textContent: data.meta && data.meta.quarter ? `Data: CMS ${data.meta.quarter}${d ? ', loaded ' + d.toLocaleDateString() : ''}` : '' }),
  ]));
  if (state.restoredFromLink) {
    box.append(el('div', { className: 'restore-note', textContent: `Reopened from a saved link — rerun against today's data (CMS ${data.meta && data.meta.quarter || ''}).` }));
  }
  box.append(renderShareBar(data));
  box.append(renderCoverageSummary(data));
  box.append(el('div', { className: 'formula', textContent: data.formula }));
  box.append(renderKey());

  // Partitioned display: plans covering ALL your drugs first, then a divider, then the rest.
  // data.plans is already sorted complete-first by the API (PRFormat.planRank).
  const complete = data.plans.filter((p) => p.notCovered === 0);
  const partial = data.plans.filter((p) => p.notCovered > 0);
  if (complete.length === 0) {
    const n = state.drugs.size;
    const noteMsg = n === 1
      ? `No plan in ${data.county.name} covers your medication — every plan below is missing it.`
      : `No plan in ${data.county.name} covers all ${n} of these medications. Every plan below is missing at least one — each shows which.`;
    box.append(el('div', { className: 'no-complete-note' }, [ic('cross'), el('span', { textContent: noteMsg })]));
  }
  for (const p of complete) box.append(renderPlan(p));
  if (partial.length) {
    // Divider only when there are complete plans above to divide from (else the note above says it).
    if (complete.length > 0) box.append(el('div', { className: 'partial-divider', textContent: 'These plans don’t cover all of your medications' }));
    for (const p of partial) box.append(renderPlan(p));
  }
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

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function renderPlan(p) {
  const cov = PRFormat.planCoverage(p);
  // Anchor. Complete plans: whole-dollar total + "est. per year" (with the standard-pharmacy
  // qualifier when a savings line fires). Partial plans (some covered): total for the covered drugs
  // only, labeled that way — never a bare "$0". Zero-coverage plans: NO dollar figure at all (a
  // yearly estimate for a plan covering nothing you take is meaningless) — just the not-covered badge.
  let annual;
  if (cov.covered === 0) {
    const msg = cov.total === 1 ? 'Doesn’t cover your medication' : 'Doesn’t cover any of your medications';
    annual = el('div', { className: 'annual' }, [
      el('div', { className: 'no-cover-anchor' }, [ic('cross'), el('span', { textContent: msg })]),
    ]);
  } else if (!cov.complete) {
    annual = el('div', { className: 'annual' }, [
      el('div', { className: 'num partial', textContent: PRFormat.dollars(PRFormat.planDisplayTotal(p)) }),
      el('div', { className: 'lbl', textContent: `est. per year · covers ${cov.covered} of your ${cov.total} meds` }),
    ]);
  } else {
    const baseLbl = p.annualComplete ? 'est. per year' : 'est. per year so far';
    annual = el('div', { className: 'annual' }, [
      el('div', { className: 'num' + (p.annualComplete ? '' : ' incomplete'), textContent: PRFormat.dollars(PRFormat.planDisplayTotal(p)) }),
      el('div', { className: 'lbl', textContent: p.savings ? baseLbl + ' at standard pharmacies' : baseLbl }),
    ]);
  }
  const head = el('div', { className: 'plan-head' }, [
    el('div', {}, [
      el('div', { className: 'plan-name', textContent: p.planName }),
      el('div', { className: 'plan-sub' }, [
        el('span', { className: 'term', title: TERMS[planTypeSlug(p.planType)], textContent: p.planType }),
        document.createTextNode(' · '),
        el('span', { className: 'term plan-id', title: TERMS['plan-id'], textContent: displayPlanId(p) }),
        document.createTextNode(' · '),
        el('span', { className: 'term', title: TERMS.premium, textContent: `premium ${money(p.premium || 0)}/mo` }),
        document.createTextNode(' · '),
        el('span', { className: 'term', title: TERMS.deductible, textContent: `deductible ${money(p.deductible || 0)}` }),
      ]),
    ]),
    annual,
  ]);
  const card = el('div', { className: 'plan' + (cov.complete ? '' : ' plan-partial') }, [head]);
  // Loud partial-coverage flag — names the missing drug(s). Only for plans covering SOME of your
  // drugs; a zero-coverage plan already says so in its anchor (and every drug row below is "not covered").
  if (!cov.complete && cov.covered > 0) {
    const names = cov.missing.map((rx) => (state.drugs.get(rx) || {}).label || rx).join(', ');
    const flag = el('div', { className: 'partial-flag' });
    flag.append(ic('cross'), el('span', { textContent: `Doesn’t cover: ${names} — you’d pay full price out of pocket, and it wouldn’t count toward the plan’s ${PRFormat.dollars(p.oopCap || 2100)} cap.` }));
    card.append(flag);
  }
  const sav = renderSavings(p); // null on partial plans (API suppresses it)
  if (sav) card.append(sav);
  card.append(renderBreakdown(p));
  for (const [rxcui, meta] of state.drugs) card.append(renderDrugRow(rxcui, meta, p.drugs[rxcui]));
  return card;
}

// Itemized, plain-English breakdown of exactly what's in (and out of) the headline number.
// Premium + flat copays + coinsurance-estimated make up the total (which stops at the $2,000 cap).
// Coinsurance is estimated from the quantity you picked; a coinsurance drug with no published
// price, and any not-covered drug, are shown by name and never folded in as a fake number.
function renderBreakdown(p) {
  const b = p.breakdown || {};
  const wrap = el('details', { className: 'breakdown' });
  wrap.append(el('summary', { textContent: 'See what’s included in this total' }));
  const rows = el('div', { className: 'bd-rows' });
  const line = (label, value, cls) => {
    const r = el('div', { className: 'bd-line' + (cls ? ' ' + cls : '') });
    r.append(el('span', { className: 'bd-label', textContent: label }));
    r.append(el('span', { className: 'bd-val', textContent: value }));
    return r;
  };
  const rateOf = (d) => (d && d.headline && d.headline.rate != null) ? Math.round(d.headline.rate * 100) + '%' : 'coinsurance';

  rows.append(line('Premium', PRFormat.dollars(b.premiumAnnual || 0) + '/yr'));
  if ((b.copayAnnual || 0) > 0) rows.append(line('Covered drugs (flat copays)', PRFormat.dollars(b.copayAnnual) + '/yr'));

  // Coinsurance drugs we CAN estimate — shows the dollar estimate + exactly how it was computed,
  // tied to the quantity selector so the reader knows it's their number to adjust.
  for (const rxcui of (b.coinsuranceEstRxcuis || [])) {
    const d = p.drugs[rxcui] || {}, meta = state.drugs.get(rxcui) || { label: rxcui }, est = d.estimated || {};
    const r = el('div', { className: 'bd-line bd-coins' });
    const top = el('span', { className: 'bd-coins-top' });
    top.append(el('strong', { textContent: meta.label }));
    top.append(el('span', { className: 'bd-val', textContent: '≈ ' + PRFormat.dollars(est.annual || 0) + '/yr' }));
    r.append(top);
    r.append(el('span', { className: 'bd-note', textContent:
      `${rateOf(d)} coinsurance, estimated from “${qtyLabel(est.quantity)}” at about ${money(est.unitCost || 0)}/unit. Change the quantity on this drug if that isn’t your dose.` }));
    rows.append(r);
  }

  // Coinsurance drugs with NO published price — honest NOT-FOUND, left out of the total.
  for (const rxcui of (b.coinsuranceNoPriceRxcuis || [])) {
    const meta = state.drugs.get(rxcui) || { label: rxcui };
    const r = el('div', { className: 'bd-line bd-coins' });
    r.append(el('span', { className: 'bd-label' }, [el('strong', { textContent: meta.label })]));
    r.append(el('span', { className: 'bd-note', textContent:
      `${rateOf(p.drugs[rxcui])} coinsurance — this plan’s negotiated price isn’t in the data, so we can’t include it. Your true total is higher.` }));
    rows.append(r);
  }

  // Not on the formulary — loud, by name, "you'd pay full price", never a fake $0.
  for (const rxcui of (b.notCoveredRxcuis || [])) {
    const meta = state.drugs.get(rxcui) || { label: rxcui };
    const r = el('div', { className: 'bd-line bd-notcov' });
    const lab = el('span', { className: 'bd-label' }); lab.append(ic('cross'), el('strong', { textContent: ' ' + meta.label }));
    r.append(lab);
    r.append(el('span', { className: 'bd-note', textContent: 'Not on this plan’s formulary — you’d pay full price. Not included in the total.' }));
    rows.append(r);
  }

  // Deductible exemption — the plan has a deductible, but the user's drugs are on tiers it skips.
  if (b.deductibleExempt) {
    const ded = '$' + Number(b.deductibleAmount || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    rows.append(el('div', { className: 'bd-line bd-ded' }, [
      el('span', { className: 'bd-note', textContent: `This plan's ${ded} deductible doesn't apply to your medications — they're on tiers the deductible skips.` }),
    ]));
  }

  // Cap milestone, where it binds.
  if (b.capHit && b.capHit.reached && b.capHit.month) {
    rows.append(el('div', { className: 'bd-line bd-cap' }, [
      el('span', { className: 'bd-note', textContent: `You’d reach your ${PRFormat.dollars(b.oopCap)} yearly out-of-pocket cap around ${MONTHS[b.capHit.month]}; covered drugs are $0 after that${b.capBinds ? ', so the total below is less than the lines above add up to' : ''}.` }),
    ]));
  }

  rows.append(line('Estimated total', PRFormat.dollars(PRFormat.planDisplayTotal(p)) + '/yr', 'bd-total'));
  if (b.hasUnpriceable) {
    rows.append(el('p', { className: 'bd-incomplete', textContent:
      'One or more of your drugs couldn’t be included (no published price) — your true yearly cost is higher.' }));
  }
  wrap.append(rows);
  return wrap;
}

// A calm, information-only savings line: if the SAME plan is cheaper through a preferred
// pharmacy or by mail, say so — rounded, never a re-ranking. Nothing shows when there's no
// real differential. One tap opens a plain-English explainer (we can't name pharmacies yet).
function renderSavings(p) {
  const s = p.savings;
  if (!s) return null;
  const LOC = {
    preferredRetail: "this plan's preferred pharmacies",
    standardMail: "this plan's mail-order pharmacy",
    preferredMail: "this plan's preferred mail-order pharmacy",
  };
  const loc = LOC[s.channel] || "this plan's preferred pharmacies";
  const copy = PRFormat.savingsCopy(p, loc); // whole dollars; anchor − amount = the "bringing to" total
  const wrap = el('div', { className: 'savings' });
  const line = el('div', { className: 'savings-line' }, [
    ic('save'),
    el('span', {}, [
      document.createTextNode('Save about '),
      el('strong', { textContent: copy.amount }),
      document.createTextNode(copy.tail),
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

// ---------- share link (state lives in the URL fragment) ----------
const SAVINGS_LOC = {
  preferredRetail: "this plan's preferred pharmacies",
  standardMail: "this plan's mail-order pharmacy",
  preferredMail: "this plan's preferred mail-order pharmacy",
};
function shareStateForUrl() {
  return { county: state.county, drugs: [...state.drugs].map(([rx, d]) => [rx, d.qty, d.label, d.kind]) };
}
function updateFragment() {
  try {
    if (state.county && state.drugs.size >= 1) history.replaceState(null, '', '#' + PRShare.encode(shareStateForUrl()));
  } catch (_) { /* fragment sync is best-effort */ }
}

async function maybeRestoreFromHash() {
  const dec = PRShare.decode(location.hash);
  if (!dec.ok) return;
  const sel = $('#county');
  const opt = [...sel.options].find((o) => o.value === dec.county);
  if (opt) confirmCounty(dec.county, opt.textContent, 'link');
  for (const d of dec.drugs) {
    if (state.drugs.size >= 10) break;
    state.drugs.set(d.rxcui, { label: d.name || d.rxcui, kind: d.kind || 'drug', qty: d.qty });
  }
  renderChips(); refreshGo();
  state.restoredFromLink = true;
  if (state.county && state.drugs.size >= 1) {
    runResults(); // reruns against CURRENT data; unresolved drugs show as "not covered"
  } else if (dec.drugs.length) {
    // County didn't resolve — restore the list, say so plainly, let them enter their location.
    $('#go-hint').textContent = 'Restored your medication list from a link — enter your ZIP or pick your county to see plans.';
  }
}

function renderShareBar(data) {
  const bar = el('div', { className: 'share-bar' });
  bar.append(el('h3', { className: 'share-h', textContent: 'Save or share this search' }));
  const actions = el('div', { className: 'share-actions' });

  const copyBtn = el('button', { type: 'button', className: 'share-btn', textContent: 'Copy link' });
  copyBtn.addEventListener('click', async () => {
    updateFragment();
    try { await navigator.clipboard.writeText(location.href); copyBtn.textContent = 'Link copied ✓'; setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000); }
    catch (_) { window.prompt('Copy this link:', location.href); }
  });
  actions.append(copyBtn);

  if (navigator.share) {
    const shareBtn = el('button', { type: 'button', className: 'share-btn', textContent: 'Share' });
    shareBtn.addEventListener('click', async () => { updateFragment(); try { await navigator.share({ title: 'PlanRobin drug plan comparison', url: location.href }); } catch (_) {} });
    actions.append(shareBtn);
  }

  const printBtn = el('button', { type: 'button', className: 'share-btn', textContent: 'Print this comparison' });
  printBtn.addEventListener('click', () => window.print());
  actions.append(printBtn);
  bar.append(actions);

  bar.append(el('p', { className: 'share-warn', textContent: 'This link contains your medication list. Anyone you send it to can see it — share only with people you trust.' }));
  bar.append(el('p', { className: 'share-super', textContent: 'Bookmark it and reopen it this fall — it reruns against the newest plan data automatically.' }));
  return bar;
}

// ---------- Plan Passport (client-side 2-page print/PDF) ----------
function ensurePassportHost() {
  let host = document.getElementById('passport');
  if (!host) { host = el('div', { id: 'passport', className: 'passport' }); document.body.append(host); }
  return host;
}

function buildQR(text) {
  try {
    if (typeof qrcode === 'undefined') return null;
    const qr = qrcode(0, 'L'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(), cell = 4, margin = 4 * cell, size = n * cell + margin * 2;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('class', 'pp-qr'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code linking to this comparison');
    const bg = document.createElementNS(NS, 'rect'); bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff'); svg.append(bg);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) {
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', margin + c * cell); rect.setAttribute('y', margin + r * cell); rect.setAttribute('width', cell); rect.setAttribute('height', cell); rect.setAttribute('fill', '#000');
      svg.append(rect);
    }
    return svg;
  } catch (_) { return null; } // the URL is printed as text regardless
}

function buildPassportPlan(p) {
  const cov = PRFormat.planCoverage(p);
  const card = el('div', { className: 'pp-plan' + (cov.complete ? '' : ' pp-plan-partial') });
  const totalText = cov.covered === 0
    ? (cov.total === 1 ? 'Doesn’t cover your medication' : 'Doesn’t cover any of your medications')
    : PRFormat.dollars(PRFormat.planDisplayTotal(p)) + '/yr' + (cov.complete ? (p.annualComplete ? '' : ' so far') : ` · for ${cov.covered} of ${cov.total}`);
  card.append(el('div', { className: 'pp-plan-head' }, [
    el('div', { className: 'pp-plan-name', textContent: p.planName }),
    el('div', { className: 'pp-plan-total' + (cov.covered === 0 ? ' pp-no-cover' : ''), textContent: totalText }),
  ]));
  // The CMS plan ID prints with each plan so a counselor/sibling can look it up independently.
  card.append(el('div', { className: 'pp-plan-sub', textContent: `${p.planType} · ${displayPlanId(p)} · premium ${money(p.premium || 0)}/mo · deductible ${money(p.deductible || 0)}` }));
  if (!cov.complete && cov.covered > 0) {
    const names = cov.missing.map((rx) => (state.drugs.get(rx) || {}).label || rx).join(', ');
    card.append(el('div', { className: 'pp-partial', textContent: `Doesn't cover: ${names} — full price out of pocket, and not counted toward the ${PRFormat.dollars(p.oopCap || 2100)} cap.` }));
  }
  if (p.savings) {
    const c = PRFormat.savingsCopy(p, SAVINGS_LOC[p.savings.channel] || "this plan's preferred pharmacies");
    card.append(el('div', { className: 'pp-savings', textContent: 'Save about ' + c.amount + c.tail }));
  }
  const tbl = el('table', { className: 'pp-drugs' });
  for (const [rxcui, meta] of state.drugs) {
    const res = p.drugs[rxcui];
    let tier = '', cost;
    if (!res || !res.covered) { cost = 'Not covered — you’d pay full price'; }
    else {
      const fl = [res.flags.priorAuth && 'PA', res.flags.stepTherapy && 'ST', res.flags.quantityLimit && 'QL'].filter(Boolean).join(' ');
      tier = 'Tier ' + res.tier + (fl ? ' ' + fl : '');
      if (res.headline.kind === 'copay') cost = money(res.headline.dollars) + '/fill';
      else if (res.estimated) cost = res.headline.display + ' ≈ ' + PRFormat.dollars(res.estimated.annual) + '/yr';
      else cost = res.headline.display;
      const rule = (res.appliedOverrides || [])[0];
      if (rule && LAW_BADGE[rule.rule]) cost += ' — ' + LAW_BADGE[rule.rule];
    }
    tbl.append(el('tr', {}, [el('td', { textContent: meta.label }), el('td', { textContent: tier }), el('td', { textContent: cost })]));
  }
  card.append(tbl);
  return card;
}

function buildPassport(data) {
  const meta = data.meta || {};
  const asOf = meta.ingestedAt ? new Date(meta.ingestedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown date';
  const doc = el('div', { className: 'passport-doc' });

  // --- Page 1: inputs + top plans ---
  const p1 = el('section', { className: 'pp-page' });
  p1.append(el('div', { className: 'pp-head' }, [
    el('div', { className: 'pp-brand', textContent: 'PlanRobin — Medicare drug plan comparison' }),
    el('div', { className: 'pp-asof', textContent: `Data: CMS ${meta.quarter || ''}, loaded ${asOf}` }),
  ]));
  const inputs = el('div', { className: 'pp-inputs' });
  inputs.append(el('div', {}, [el('strong', { textContent: 'County: ' }), document.createTextNode(`${data.county.name}, ${data.county.state}`)]));
  inputs.append(el('div', {}, [el('strong', { textContent: 'Medications (30-day fills): ' })]));
  const meds = el('ul', { className: 'pp-meds' });
  for (const [rxcui, d] of state.drugs) meds.append(el('li', { textContent: `${d.label} — ${qtyLabel(d.qty)}` }));
  inputs.append(meds);
  p1.append(inputs);

  // Rank among plans that cover ALL the drugs. A cheaper-looking plan that skips one of your
  // medications would leave you paying full price for it, so it isn't shown as a "top" plan —
  // this is the same ranking the on-screen results use, made explicit so the numbers aren't a
  // surprise next to the $0 partial-coverage plans lower in the list.
  // Top plans come from the COMPLETE group; only if fewer than 3 cover everything do partial
  // plans appear (each with its own flag), so the passport never leads with a plan that silently
  // skips a drug. Same coverage definition as the on-screen results (PRFormat.planCoverage).
  const complete = data.plans.filter((p) => p.notCovered === 0);
  const partial = data.plans.filter((p) => p.notCovered > 0);
  const top = (complete.length >= 3 ? complete : [...complete, ...partial]).slice(0, 5);
  const nDrugs = state.drugs.size;
  p1.append(el('div', { className: 'pp-coverage', textContent: complete.length
    ? `${complete.length} of ${data.planCount} plans cover ${nDrugs === 1 ? 'your medication' : `all ${nDrugs} of your medications`}. The plans below are ranked by yearly cost among those. A plan that skips one of your drugs would leave you paying full price for it, so it isn’t shown as a top plan even if it looks cheaper.`
    : `No plan in ${data.county.name} covers every medication on your list. The plans below cover the most, ranked by yearly cost; each plan flags what it misses.` }));
  p1.append(el('h2', { className: 'pp-h', textContent: complete.length
    ? `Top ${top.length} plans that cover all your medications, by yearly cost`
    : `Top ${top.length} plans by coverage, then yearly cost` }));
  for (const p of top) p1.append(buildPassportPlan(p));
  doc.append(p1);

  // --- Page 2: caveats + share link + QR ---
  const p2 = el('section', { className: 'pp-page pp-break' });
  p2.append(el('h2', { className: 'pp-h', textContent: 'Before you decide' }));
  const caveats = el('ul', { className: 'pp-caveats' });
  [
    `Costs are estimates from public CMS files (as of CMS ${meta.quarter || ''}, loaded ${asOf}). Your actual cost can differ with pharmacy, days-supply, deductible status, and coverage phase.`,
    'Educational tool — not advice, and not an enrollment. PlanRobin does not sell insurance or enroll you in coverage.',
    'A private website — not affiliated with the federal Medicare program or any insurance company.',
    'Confirm any plan on Medicare.gov, or by calling 1-800-MEDICARE (1-800-633-4227), before enrolling.',
    'Free, unbiased help: your State Health Insurance Assistance Program (SHIP) — find a counselor at shiphelp.org.',
  ].forEach((txt) => caveats.append(el('li', { textContent: txt })));
  p2.append(caveats);

  updateFragment();
  const url = location.href;
  const share = el('div', { className: 'pp-share' });
  share.append(el('h3', { className: 'pp-h3', textContent: 'Reopen this comparison' }));
  const cols = el('div', { className: 'pp-share-cols' });
  const left = el('div', {});
  left.append(el('p', { className: 'pp-note', textContent: 'Scan the code, or type the link below, to reopen this exact search — it reruns against the newest plan data.' }));
  left.append(el('p', { className: 'pp-url', textContent: url }));
  cols.append(left);
  const qr = buildQR(url);
  if (qr) cols.append(el('div', { className: 'pp-qr-wrap' }, [qr]));
  share.append(cols);
  p2.append(share);
  doc.append(p2);

  return doc;
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
    // Coinsurance: with a price + your quantity we show a dollar estimate; without a price we say so.
    if (res.estimated) {
      right.append(el('span', { className: 'annual-drug', textContent: ` · ≈ ${money(res.estimated.annual)}/yr est.` }));
    } else {
      const up = res.negotiatedPrice && res.negotiatedPrice.unitCostByDays && res.negotiatedPrice.unitCostByDays['30'];
      right.append(el('span', { className: 'annual-drug', textContent: up != null ? ` · of ~${money(up)}/unit` : ' · plan’s price not in data' }));
    }
  }
  // Trust feature: when federal law sets the price, say so plainly ("capped by federal law").
  const rule = (res.appliedOverrides || [])[0];
  if (rule && LAW_BADGE[rule.rule]) {
    const badge = el('span', { className: 'badge-law', title: rule.note || '' });
    badge.append(ic('law'), document.createTextNode(' ' + LAW_BADGE[rule.rule]));
    right.append(el('div', {}, [badge]));
  }

  const row = el('div', { className: 'drug-row' }, [left, right]);
  row.append(renderPhases(res));
  return row;
}

function renderPhases(res) {
  const phases = res.phases;
  const det = el('details', { className: 'phases' });
  det.append(el('summary', { textContent: 'Other phases & pharmacy channels' }));

  // Plain-English intro so the detail isn't a wall of Medicare jargon.
  det.append(el('p', { className: 'phase-intro', textContent:
    'Your cost for this drug changes during the year and by where you fill it. The number above is the everyday case — a 30-day fill at a standard pharmacy during initial coverage. Here’s the rest.' }));

  // The default: pattern-collapsed plain-English lines (a 6-column grid can't survive a phone). On
  // narrow screens THESE ARE the interface — the full grid below is hidden (see styles.css).
  const s = PRFormat.phaseSummary(phases, { deductibleExempt: res.deductibleApplies === false });
  const sum = el('ul', { className: 'phase-summary' });
  for (const line of s.lines) sum.append(el('li', {}, line));
  det.append(sum);
  if (s.footnote) det.append(el('p', { className: 'phase-foot', textContent: s.footnote }));

  // The full table stays available behind a toggle — on wide screens / print, where it fits.
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
  t.append(tb);
  const full = el('details', { className: 'full-table' });
  full.append(el('summary', { textContent: 'See the full table' }));
  full.append(el('div', { className: 'detail-scroll' }, [t]));
  det.append(full);

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
