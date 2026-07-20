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

// `road` is what the reader told us (or what their plan ID implies): 'ma' | 'original' | 'new' |
// 'unsure' | null. It only ever GROUPS results — it never filters them. Both roads always render.
const state = { county: '', countySource: null /* 'zip' | 'county' | 'link' */, drugs: new Map() /* rxcui -> {label, kind, qty} */, lastData: null, restoredFromLink: false, road: null,
  planId: null, planIdSource: null /* 'typed' (read off her card) | 'picked' (chosen from the list) */ };
const PHASES = [['0', 'Pre-deductible'], ['1', 'Initial coverage'], ['3', 'Catastrophic']];
const DAYS = [['1', '30-day'], ['2', '90-day']];

// Plain-English glossary for Medicare jargon. Project rule: if it's jargon, explain it
// in a sentence or two here, with a link to the fuller FAQ article (faq.html#slug).
const TERMS = {
  'pre-deductible': 'Early in the year, before you’ve met the plan’s deductible.',
  'initial-coverage': 'Your regular cost after meeting the deductible. This is the headline number above.',
  // The specific cap amount + year are filled in from /api/meta (the same statutory parameter the
  // engine computes with) once meta loads — never hardcoded here, so prose can't go stale.
  'catastrophic': 'After your yearly out-of-pocket spending reaches the cap, covered drugs are $0 for the rest of the year.',
  'standard-retail': 'Any in-network pharmacy.',
  'preferred-retail': 'Specific pharmacies the plan picks as lower-cost.',
  'preferred-mail': 'The plan’s mail-order pharmacy — often the cheapest, especially for 90-day fills.',
  'preferred-pharmacy': 'A pharmacy this plan has negotiated lower copays with. Most pharmacy chains are “preferred” on some plans and “standard” on others — it depends on the plan, not just the pharmacy.',
  'days-supply': 'How many days each fill covers. At a regular pharmacy a 90-day fill usually costs 3× the 30-day copay — the real 90-day savings come from mail order.',
  // Plan types
  // The two roads. Both entries name the switching consequence, because the plan-type label is what a
  // reader taps to find out what moving between them means. Mechanics verified against Medicare.gov
  // ("Switch, drop, or rejoin drug coverage") — see faq.html#two-roads.
  'ma-pd': 'An all-in-one Medicare Advantage plan — medical and drugs together from one private insurer, in place of Original Medicare. The premium shown is the drug-coverage portion; the plan may also have a separate medical premium. Joining a stand-alone drug plan (PDP) would end this plan and return you to Original Medicare.',
  'pdp': 'A stand-alone drug plan that sits on top of Original Medicare — drugs only; your medical coverage stays with Original Medicare. If you have a Medicare Advantage plan, joining one of these ends that plan and returns you to Original Medicare.',
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

// Which front door is this? 'compare' (index.html) or 'checkup' (checkup.html). The intake — ZIP,
// county fallback, medications, the road question, wallet check, plan-ID field — is IDENTICAL on both
// and is wired ONCE, here. Only what the button DOES differs, so the checkup binds its own runner
// (checkup.js) and this file leaves #go alone there. One intake, two doors — never a clone.
const PAGE = (document.body && document.body.dataset && document.body.dataset.page) || 'compare';

// ---------- init ----------
async function init() {
  try {
    const meta = await getJSON('/api/meta');
    renderProvenance(meta);
    // Fill the cap amount + year into the catastrophic glossary blurb from the engine's own parameter.
    const cap = PRFormat.capPhrase(meta);
    if (cap) TERMS['catastrophic'] = `After your yearly out-of-pocket spending reaches the cap (${cap}), covered drugs are $0 for the rest of the year.`;
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
  wireRoad();
  if (PAGE === 'compare') $('#go').addEventListener('click', runResults);   // checkup.js binds its own

  // Ctrl/⌘-P and the "Print this comparison" button both build the Plan Passport just before print.
  window.addEventListener('beforeprint', () => {
    if (!state.lastData) return;
    // null when the checkup doesn't know which plan is hers — print the page, not a sheet about nobody
    // (and never `append(null)`, which would quietly print the word "null").
    const doc = buildPassport(state.lastData); if (!doc) return;
    const host = ensurePassportHost();
    host.innerHTML = ''; host.append(doc);
    document.body.classList.add('printing-passport');
  });
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing-passport'); });

  // A share link in the fragment restores the search and reruns it against CURRENT data.
  await maybeRestoreFromHash();
  wireCodeRestore(); // the hand-typed paper restore code (both pages)
}

// The page-appropriate runner for a restored search: the checkup binds its own (PRRunSearch),
// the comparison uses runResults.
function runSearch() { if (typeof window.PRRunSearch === 'function') window.PRRunSearch(); else runResults(); }

// ---------- hand-typed restore code (the paper-only reopen path) ----------
// Forgiving, incremental, per-line: each line validates client-side (Damm check digit — instant, no
// server), then names are filled in best-effort from RxNorm. A mistake is isolated to its line and
// never costs a full retype. On restore we set the SAME state a link would, then run.
const CODE_ERR = {
  version: 'this code is from a newer version of PlanRobin — check you copied it correctly',
  length: 'doesn’t look quite right — check it digit by digit',
  check: 'doesn’t look quite right — check it digit by digit',
};
function wireCodeRestore() {
  const box = $('#code-restore'); if (!box || typeof PRRestoreCode === 'undefined') return;
  const ta = $('#code-input'), out = $('#code-lines'), go = $('#code-go'), hint = $('#code-hint');
  let seq = 0, timer = null;
  const debounced = (fn) => { clearTimeout(timer); timer = setTimeout(fn, 250); };

  async function validate() {
    const mine = ++seq;
    const dec = PRRestoreCode.decode(ta.value);
    out.innerHTML = '';
    if (dec.empty) { go.disabled = true; if (hint) hint.textContent = ''; return; }
    const rows = [];
    for (const ln of dec.lines) {
      const ok = ln.ok;
      const drugName = ln.kind === 'drug' ? ('medication code ' + ln.rxcui) : 'your area';
      const text = ok ? `Line ${ln.line} ✓ ${drugName}` : `Line ${ln.line} ${CODE_ERR[ln.reason] || CODE_ERR.check}`;
      const row = el('div', { className: 'code-line ' + (ok ? 'cl-ok' : 'cl-bad') }, [
        el('span', { className: 'cl-mark', 'aria-hidden': 'true', textContent: ok ? '✓' : '!' }),
        el('span', { className: 'cl-text', textContent: text }),
      ]);
      out.append(row); rows.push({ ln, row });
    }
    const drugsOk = dec.lines.filter((l, i) => i > 0 && l.ok);
    const countyOk = dec.lines[0] && dec.lines[0].ok && dec.lines[0].kind === 'county';
    const allOk = dec.lines.every((l) => l.ok);
    // Every line must check out before we restore — a bad line would silently drop that medication.
    go.disabled = !(countyOk && drugsOk.length && allOk);
    if (hint) hint.textContent = !allOk ? 'Check the highlighted line, then try again.'
      : go.disabled ? 'Enter the county line and at least one medication line.' : '';
    box._decoded = dec;
    // Names are best-effort: the checksum already proved each line; RxNorm just fills the label in.
    if (drugsOk.length) {
      try {
        const res = await getJSON('/api/rxnorm/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rxcuis: drugsOk.map((d) => d.rxcui) }) });
        if (mine !== seq) return;
        const byRx = Object.fromEntries((res.results || []).map((r) => [r.rxcui, r]));
        box._names = byRx;
        for (const { ln, row } of rows) if (ln.kind === 'drug' && ln.ok) {
          const r = byRx[ln.rxcui];
          if (r && r.name) row.querySelector('.cl-text').textContent = `Line ${ln.line} ✓ ${r.name}`;
        }
      } catch (_) { /* names best-effort — the code still restores, labelled by rxcui */ }
    }
  }
  ta.addEventListener('input', () => debounced(validate));

  go.addEventListener('click', () => {
    const dec = box._decoded || PRRestoreCode.decode(ta.value);
    if (!(dec.lines[0] && dec.lines[0].ok)) return;
    const byRx = box._names || {};
    const sel = $('#county'); const opt = sel && [...sel.options].find((o) => o.value === dec.county);
    if (opt) confirmCounty(dec.county, opt.textContent, 'link');
    state.drugs.clear();
    let anyUnresolved = false;
    for (const d of dec.drugs) {
      if (state.drugs.size >= 10) break;
      const r = byRx[d.rxcui];
      if (!(r && r.name)) anyUnresolved = true;
      state.drugs.set(d.rxcui, { label: (r && r.name) || ('Medication ' + d.rxcui), kind: (r && r.kind) || 'drug', qty: d.qty, offFormulary: r ? r.onFormulary === false : false });
    }
    if (dec.fill) state.fill = { where: dec.fill.where, days: dec.fill.days };
    state.restoredFromLink = true;
    renderChips(); refreshGo();
    // Honest note if RxNorm couldn't name a drug — the search still runs (never blocks).
    if (anyUnresolved) $('#go-hint').textContent = 'We couldn’t look up every medication name just now — your search still runs; names may show as codes.';
    if (state.county && state.drugs.size) runSearch();
    else $('#go-hint').textContent = 'Restored your medications from the code — enter your ZIP or pick your county to see plans.';
  });
}

function renderProvenance(meta) {
  if (!meta || !meta.quarter) { $('#provenance').textContent = 'Data: source unavailable'; return; }
  const d = meta.ingestedAt ? new Date(meta.ingestedAt) : null;
  const upd = d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown date';
  $('#provenance').textContent = `Data: CMS ${meta.quarter} Prescription Drug Plan files, loaded ${upd} (scope: ${meta.scope || 'MO'}).`;
}

// ---------- the reader's road (optional, never filters) ----------
// What each answer does to the results. Only 'ma'/'original' can group; "new" and "not sure" have no
// current road, so those results stay the mixed list with the both-kinds line above them.
const ROAD_STATUS = {
  original: 'Drug-only plans — the kind that work with Original Medicare — are listed first. Every other plan is still here, priced, below a divider.',
  ma: 'All-in-one Medicare Advantage plans are listed first. Every other plan is still here, priced, below a divider — with what switching would mean.',
  new: 'Both roads are open to you, so your results show both kinds. Tap any plan-type label to see how they differ.',
};

// The wallet check — for "Not sure". The red-white-and-blue card is NOT the tell; which card she
// hands over at the pharmacy is. Verified against Medicare.gov plan-type basics; ends at a human.
function renderWalletCheck() {
  const box = el('div', { className: 'wallet-check' });
  box.append(el('p', { textContent: 'Everyone on Medicare has the red, white and blue Medicare card — so having one doesn’t tell you which kind you have. The tell is which card you hand over at the pharmacy:' }));
  const ul = el('ul', { className: 'wallet-list' });
  for (const [strong, rest] of [
    ['An insurance company’s card you show at both the doctor and the pharmacy', ' — that’s likely a Medicare Advantage plan.'],
    ['An insurance card that’s only for prescriptions, or says PDP', ' — that’s a drug plan sitting on top of Original Medicare.'],
    ['The red, white and blue card at the doctor', ' — that’s Original Medicare.'],
  ]) ul.append(el('li', {}, [el('strong', { textContent: strong }), document.createTextNode(rest)]));
  box.append(ul);
  box.append(el('p', { className: 'fine' }, [
    document.createTextNode('Still unsure? The kind is usually printed on the card itself — HMO, PPO, or PDP. A SHIP counselor can confirm it in a minute: '),
    el('a', { href: 'https://www.shiphelp.org', rel: 'noopener', target: '_blank', textContent: 'find a counselor' }),
    document.createTextNode(' — or call 1-800-MEDICARE.'),
  ]));
  return box;
}

function setRoad(road, note) {
  state.road = road;
  // ONLY the road buttons — the checkup's fill-habit and perks buttons reuse the .road-choice class
  // for styling but must not answer the road question (their own pressGroup owns aria-pressed).
  for (const b of document.querySelectorAll('#road-choices .road-choice')) b.setAttribute('aria-pressed', String(b.dataset.road === road));
  const st = $('#road-status'); st.innerHTML = '';
  if (note) st.append(el('p', { className: 'road-status-line', textContent: note }));
  if (road === 'unsure') st.append(renderWalletCheck());
  // Grouping is a view of the same data — re-render in place if results are already on screen.
  if (state.lastData) renderResults(state.lastData);
}

function wireRoad() {
  // Scope to the ROAD question only. The checkup reuses .road-choice for its fill-habit / perks
  // buttons (styling); wiring them here would clobber state.road and fight their own aria-pressed
  // every time she answered Q4/Q5. (Bug found via the restore-code round-trip, 2026-07.)
  for (const btn of document.querySelectorAll('#road-choices .road-choice')) {
    btn.addEventListener('click', () => {
      const road = btn.dataset.road;
      if (state.road === road) { setRoad(null, null); return; } // tap again to un-answer
      setRoad(road, ROAD_STATUS[road] || null);
    });
  }

  // The plan ID ANCHORS the results: a complete, well-formed ID is matched against her results and,
  // if found, her plan renders first. We don't infer a road from an ID we couldn't match — if we
  // can't find the plan, we don't assume things about it; the not-found note asks her to pick a road.
  const idInput = $('#road-plan-id');
  const idNote = $('#road-planid-hint');
  idInput.addEventListener('input', () => {
    const raw = idInput.value;
    const v = PRFormat.normalizePlanId(raw);
    let hint = '';
    // Typed off the card: the strongest claim she can make about which plan is hers. Recorded so the
    // checkup's headline can mirror her confidence (see PRFormat.yoursLabel).
    if (!v) { state.planId = null; state.planIdSource = null; }
    else if (PRFormat.isPlanIdShape(v)) { state.planId = v; state.planIdSource = 'typed'; }
    else {
      state.planId = null;
      state.planIdSource = null;
      // Incremental + friendly: stay quiet while it could still become a valid ID; only speak up once
      // it can't. Spaces and case are already forgiven by normalizePlanId.
      if (!PRFormat.isPlanIdPrefix(v)) hint = 'Plan IDs look like H1234-001: a letter, four digits, a dash, three digits.';
    }
    idNote.textContent = hint;
    idNote.hidden = !hint;
    if (state.lastData) renderResults(state.lastData);
  });
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
  // ONE grouping definition drives the list AND the count, so the number can't contradict the layout.
  const group = PRFormat.groupPlans(data.plans, { road: state.road, planId: state.planId });
  box.append(el('h2', {}, `Plans in ${data.county.name}, ${data.county.state}`));
  const d = data.meta && data.meta.ingestedAt ? new Date(data.meta.ingestedAt) : null;
  box.append(el('div', { className: 'result-meta' }, [
    el('span', { className: 'muted small', textContent: `${PRFormat.resultsCountLine(group, data.county.name)} · sorted by estimated annual cost` }),
    el('span', { className: 'muted small', textContent: data.meta && data.meta.quarter ? `Data: CMS ${data.meta.quarter}${d ? ', loaded ' + d.toLocaleDateString() : ''}` : '' }),
  ]));
  if (state.restoredFromLink) {
    box.append(el('div', { className: 'restore-note', textContent: `Reopened from a saved link — rerun against today's data (CMS ${data.meta && data.meta.quarter || ''}).` }));
  }
  box.append(renderShareBar(data));
  box.append(renderCoverageSummary(data));
  box.append(el('div', { className: 'formula', textContent: data.formula }));
  box.append(renderKey());

  // The two roads framed BEFORE any plan is read (only when both kinds are actually here).
  const framing = renderRoadFraming(data);
  if (framing) box.append(framing);

  // A no-complete note is a fact about the WHOLE county, so it's computed once, above any grouping.
  if (data.plans.filter((p) => p.notCovered === 0).length === 0) {
    const n = state.drugs.size;
    const noteMsg = n === 1
      ? `No plan in ${data.county.name} covers your medication — every plan below is missing it.`
      : `No plan in ${data.county.name} covers all ${n} of these medications. Every plan below is missing at least one — each shows which.`;
    box.append(el('div', { className: 'no-complete-note' }, [ic('cross'), el('span', { textContent: noteMsg })]));
  }

  // Her plan, when she gave us an ID we could match: EXTRACTED and rendered first, unconditionally —
  // even if it's the worst plan in the county. Its treatment is never softened, though: a partial or
  // zero-coverage plan of hers shows exactly the badges any other card would. Her plan failing her,
  // shown first and plainly, is the most valuable render this page has.
  if (group.yourPlan) box.append(renderPlan(group.yourPlan, { yours: true }));
  // A real-looking ID we couldn't find is a designed state, never silence and never an error tone.
  if (group.planIdMissed) box.append(renderPlanIdMissed(data));

  // The rest: her road first, then the other road below a plain divider. Grouping NEVER filters —
  // every plan renders, fully priced, either way.
  if (group.grouped) {
    const note = renderRoadGroupNote(group.road);
    if (note && group.sameRoadOthers.length) box.append(note);
    if (group.yourPlan && group.sameRoadOthers.length) {
      box.append(el('h3', { className: 'group-head', textContent:
        `Other ${PRFormat.ROAD_NOUN[group.road]} plans in your county` }));
    }
    renderPlanPartition(box, group.sameRoadOthers);
    if (group.otherRoad.length) {
      box.append(renderRoadDivider(group.road));
      renderPlanPartition(box, group.otherRoad);
    }
  } else {
    renderPlanPartition(box, group.sameRoadOthers);
  }
}

// A well-formed ID that isn't in this county's results. Say what we looked for, why it might miss,
// and give her two ways forward — never a dead end, never an alarm.
function renderPlanIdMissed(data) {
  return el('div', { className: 'planid-missed', role: 'note' }, [
    el('span', { textContent: `We couldn’t find ${state.planId} among ${data.county.name}’s plans. Double-check the ID on the card — or it may be a plan offered in a different county or state. You can still choose your road above, or search without it.` }),
  ]);
}

// Plans covering ALL your drugs first, then a divider, then the rest. Unchanged logic — just
// parameterized so it can run once per road group without the two partitions interfering.
// data.plans arrives already sorted complete-first by the API (PRFormat.planRank).
function renderPlanPartition(box, plans) {
  const complete = plans.filter((p) => p.notCovered === 0);
  const partial = plans.filter((p) => p.notCovered > 0);
  for (const p of complete) box.append(renderPlan(p));
  if (partial.length) {
    // Divider only when there are complete plans above to divide from (else the note above says it).
    if (complete.length > 0) box.append(el('div', { className: 'partial-divider', textContent: 'These plans don’t cover all of your medications' }));
    for (const p of partial) box.append(renderPlan(p));
  }
}

// Free, unbiased human help — a feature, never fine print (00-PRINCIPLES: the SHIP handoff).
function shipLine() {
  return el('p', { className: 'road-ship fine' }, [
    document.createTextNode('Free, unbiased help deciding: your State Health Insurance Assistance Program (SHIP) — '),
    el('a', { href: 'https://www.shiphelp.org', rel: 'noopener', target: '_blank', textContent: 'find a counselor' }),
    document.createTextNode(' — or call 1-800-MEDICARE.'),
  ]);
}

// Shown only when BOTH roads appear in the results — otherwise there is nothing to mix up.
function renderRoadFraming(data) {
  if (!PRFormat.roadsMix(data.plans)) return null;
  const box = el('div', { className: 'road-framing', role: 'note' });
  if (!PRFormat.isKnownRoad(state.road)) {
    box.append(el('p', { className: 'road-mixed', textContent:
      'Your results include both kinds of plan — different roads, not interchangeable. Tap any plan-type label to see what switching between them means.' }));
  }
  // Premiums across the roads are different KINDS of number; say so where they sit side by side.
  box.append(el('p', { className: 'road-premium fine', textContent:
    'Premiums aren’t comparable across the two roads. A Medicare Advantage plan’s drug premium sits inside a plan that replaces your medical coverage; a drug-only plan’s premium sits on top of Original Medicare, which you may also carry a Medigap policy for. Compare drug costs within a road, not across it.' }));
  return box;
}

// The reader's own road, when it's Original Medicare: nothing here can cost them their medical
// coverage, so say the freeing thing plainly.
function renderRoadGroupNote(road) {
  if (road !== 'original') return null;
  return el('p', { className: 'road-note', textContent:
    'These drug-only plans work with Original Medicare — you’re free to choose by price alone.' });
}

// The divider between roads + the honest consequence of crossing it. Mechanics verified against
// Medicare.gov ("Switch, drop, or rejoin drug coverage") and the Medigap buying rules — see
// faq.html#two-roads. Rare exceptions are named as rare, and pointed at a human.
function renderRoadDivider(road) {
  const wrap = el('div', { className: 'road-divider', role: 'note' });
  if (road === 'ma') {
    wrap.append(el('div', { className: 'road-divider-head', textContent:
      'A different road: these plans work with Original Medicare, not with a Medicare Advantage plan.' }));
    wrap.append(el('p', { className: 'road-warn', textContent:
      'Enrolling in one of these drug-only plans would end your Medicare Advantage plan and return you to Original Medicare — your medical coverage would come from Original Medicare instead of your plan. Many people then add a Medigap policy; outside certain windows a Medigap insurer can consider your health history, and can turn you down or charge more. A few rare plan types work differently — a SHIP counselor can confirm yours.' }));
  } else {
    wrap.append(el('div', { className: 'road-divider-head', textContent:
      'A different road: these plans replace Original Medicare with an all-in-one Medicare Advantage plan.' }));
    wrap.append(el('p', { className: 'road-warn', textContent:
      'Joining one of these would move your medical coverage out of Original Medicare and into the plan — it isn’t a drug-only change. A few rare plan types work differently — a SHIP counselor can confirm yours.' }));
  }
  wrap.append(shipLine());
  return wrap;
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

// opts.yours — this is the plan whose ID she typed. It gets a badge and its placement is decided by
// the caller (first, always). Everything else about the card is IDENTICAL to any other plan's: the
// honesty treatment is never softened because the plan happens to be hers.
function renderPlan(p, opts) {
  opts = opts || {};
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
        // A real one-tap: a title tooltip never opens on a phone, so the plan-type label is a link to
        // its FAQ entry (new tab, so her results survive the tap). Links are exempt from the 44px
        // control floor; the tooltip still serves hover on desktop.
        el('a', { className: 'term plan-type-link', href: '/faq.html#' + planTypeSlug(p.planType),
          rel: 'noopener', target: '_blank', title: TERMS[planTypeSlug(p.planType)], textContent: p.planType }),
        document.createTextNode(' · '),
        el('span', { className: 'term plan-id', title: TERMS['plan-id'], textContent: displayPlanId(p) }),
        document.createTextNode(' · '),
        el('span', { className: 'term', title: TERMS.premium, textContent: `${PRFormat.premiumLabel(p.planType)} ${money(p.premium || 0)}/mo` }),
        document.createTextNode(' · '),
        el('span', { className: 'term', title: TERMS.deductible, textContent: `deductible ${money(p.deductible || 0)}` }),
      ]),
    ]),
    annual,
  ]);
  // `plan-nocover` is set from the ONE shared coverage definition (not a local re-derivation), and it
  // is what lets the stylesheet put the badge above the money in the visual hierarchy: on a plan that
  // covers nothing she takes, "$0.00/mo" must not out-shout "Doesn't cover any of your medications".
  const card = el('div', { className: 'plan' + (cov.complete ? '' : ' plan-partial') + (cov.covered === 0 ? ' plan-nocover' : '') + (opts.yours ? ' plan-yours' : '') }, [head]);
  // "Your plan" — semantic (icon + word + color), sentence case, never a shout. The word mirrors how
  // she told us it was hers (typed the ID vs picked it from a list); the treatment never changes.
  if (opts.yours) {
    const badge = el('div', { className: 'yours-badge' });
    badge.append(ic('save'), el('span', { textContent: opts.yoursLabel || PRFormat.yoursLabel() }));
    card.insertBefore(badge, head);
  }
  // The checkup gives the premium its own line: the first thing a real reader asked out loud was
  // "how much are these per month?" — it shouldn't be buried in a meta sub-line. Same label rule as
  // everywhere else (an MA-PD figure is the drug-coverage portion, not the whole premium).
  if (opts.premiumProminent) {
    card.append(el('div', { className: 'premium-prominent' }, [
      el('span', { className: 'pp-amt', textContent: `${money(p.premium || 0)}/mo` }),
      el('span', { className: 'pp-lbl term', title: TERMS.premium, textContent: PRFormat.premiumLabel(p.planType) }),
    ]));
  }
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
  card.append(renderBreakdown(p, opts));
  for (const [rxcui, meta] of state.drugs) card.append(renderDrugRow(rxcui, meta, p.drugs[rxcui]));
  return card;
}

// Itemized, plain-English breakdown of exactly what's in (and out of) the headline number.
// Premium + flat copays + coinsurance-estimated make up the total (which stops at the annual OOP cap).
// Coinsurance is estimated from the quantity you picked; a coinsurance drug with no published
// price, and any not-covered drug, are shown by name and never folded in as a fake number.
// opts.yours → open by default. It's the one plan she came here to understand; making her tap for it
// would be decision friction on the single most valuable card. Every other card stays one tap away.
function renderBreakdown(p, opts) {
  const b = p.breakdown || {};
  // ONE coverage definition (shared with the card anchor, the sort and the passport) decides which
  // conditional notes have earned the right to speak here.
  const cov = PRFormat.planCoverage(p);
  const wrap = el('details', { className: 'breakdown', open: !!(opts && opts.yours) });
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

  // Not on the formulary — the SAME semantic badge the card and the drug rows use (icon + words +
  // the not-covered token), inline, not plain grey text. No dollar figure renders anywhere on this
  // line: there is no price to state, and a "$" here is the fake-$0 in breakdown clothing.
  for (const rxcui of (b.notCoveredRxcuis || [])) {
    const meta = state.drugs.get(rxcui) || { label: rxcui };
    const r = el('div', { className: 'bd-line bd-notcov' });
    r.append(el('span', { className: 'bd-label' }, [el('strong', { textContent: meta.label })]));
    const badge = el('span', { className: 'status notcov bd-notcov-badge' });
    badge.append(ic('cross'), document.createTextNode(' Not covered — you’d pay full price'));
    r.append(badge);
    r.append(el('span', { className: 'bd-note', textContent: 'Not on this plan’s formulary, so it isn’t included below.' }));
    rows.append(r);
  }

  // Deductible exemption — reassurance has to be EARNED (UX-REVIEW #13). The shared predicate
  // suppresses it when nothing she takes is covered, and scopes the sentence when only some is.
  const dedNote = PRFormat.deductibleExemptNote(p);
  if (dedNote) {
    rows.append(el('div', { className: 'bd-line bd-ded' }, [
      el('span', { className: 'bd-note', textContent: dedNote.text }),
    ]));
  }

  // Cap milestone, where it binds. Guarded on real coverage for the same reason: a cap you'd reach
  // in March is a statement about spending on drugs this plan actually pays for.
  if (cov.covered > 0 && b.capHit && b.capHit.reached && b.capHit.month) {
    rows.append(el('div', { className: 'bd-line bd-cap' }, [
      el('span', { className: 'bd-note', textContent: `You’d reach your ${PRFormat.dollars(b.oopCap)} yearly out-of-pocket cap around ${MONTHS[b.capHit.month]}; covered drugs are $0 after that${b.capBinds ? ', so the total below is less than the lines above add up to' : ''}.` }),
    ]));
  }

  // A yearly total for a plan that covers NOTHING she takes would be the premium alone — a real
  // number answering a question nobody asked, sitting where the answer goes. The card's anchor
  // already says the true thing ("Doesn't cover any of your medications"); the breakdown's last word
  // is the not-covered rows above. (Premium keeps its own true $0 line: that one is a fact about the
  // plan, not a verdict about her.)
  if (cov.covered > 0) {
    rows.append(line('Estimated total', PRFormat.dollars(PRFormat.planDisplayTotal(p)) + '/yr', 'bd-total'));
    if (b.hasUnpriceable) {
      rows.append(el('p', { className: 'bd-incomplete', textContent:
        'One or more of your drugs couldn’t be included (no published price) — your true yearly cost is higher.' }));
    }
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
  // Same guard as the deductible note (UX-REVIEW #13). The API suppresses savings on partial and
  // zero coverage today, so this is belt-and-braces — but "save $240 a year at preferred pharmacies"
  // on a plan that covers none of her drugs would be the loudest false all-clear on the page, and
  // that must not depend on the payload staying well-behaved.
  if (PRFormat.planCoverage(p).covered === 0) return null;
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

// Build the PDF and either download it or hand it to the native share sheet. The FILE is the
// artifact — it needs no configured printer (most of our audience's phones have none).
// pdf-lib is ~525KB — load it (self-hosted, no CDN) only when the user actually wants a file, so the
// results page stays fast.
let _pdfLibPromise = null;
function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve();
  if (!_pdfLibPromise) _pdfLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = '/vendor/pdf-lib.min.js';
    s.onload = () => resolve(); s.onerror = () => reject(new Error('pdf-lib load failed'));
    document.head.append(s);
  });
  return _pdfLibPromise;
}

// Each door prints its own sheet — one noun, used for the bar's heading, the file, and the share sheet.
const SHEET = PAGE === 'checkup'
  ? { noun: 'checkup', shareTitle: 'PlanRobin Medicare checkup', shareText: 'My Medicare drug plan checkup from PlanRobin.' }
  : { noun: 'comparison', shareTitle: 'PlanRobin drug plan comparison', shareText: 'My Medicare drug plan comparison from PlanRobin.' };

async function runPdf(btn, mode) {
  const data = state.lastData; if (!data) return;
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    await loadPdfLib();
    const model = passportModelNow(data); if (!model) return;   // checkup with no plan → nothing to print
    const { blob, filename } = await renderPassportPdf(model);
    if (mode === 'share') {
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: SHEET.shareTitle, text: SHEET.shareText }); } catch (_) { /* user cancelled */ }
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (_) {
    alert('Sorry — couldn’t build the PDF just now. You can still copy the link or (on a computer) print.');
  } finally { btn.textContent = orig; btn.disabled = false; }
}

// Print: build the passport SYNCHRONOUSLY before printing so the preview is never blank (Android
// Chrome fires `beforeprint` unreliably — see the mobile-print fix). Desktop path.
function printPassport() {
  const data = state.lastData; if (!data) return;
  const doc = buildPassport(data); if (!doc) return;
  const host = ensurePassportHost(); host.innerHTML = ''; host.append(doc);
  document.body.classList.add('printing-passport');
  window.print();
  setTimeout(() => document.body.classList.remove('printing-passport'), 1000); // belt-and-suspenders vs missing afterprint
}

function renderShareBar(data) {
  const bar = el('div', { className: 'share-bar' });
  bar.append(el('h3', { className: 'share-h', textContent: `Save or share this ${SHEET.noun}` }));
  bar.append(el('p', { className: 'share-lead', textContent: 'Save it, print it anywhere, or send it to someone helping you.' }));
  const actions = el('div', { className: 'share-actions' });

  // Primary: the downloadable file (works with no printer configured).
  const dl = el('button', { type: 'button', className: 'share-btn share-primary', textContent: 'Download PDF' });
  dl.addEventListener('click', () => runPdf(dl, 'download'));
  actions.append(dl);

  // Share the FILE via the native sheet where supported (text it to your sister). Feature-detect
  // file sharing with a dummy PDF so it only appears where it actually works (most mobile).
  let canShareFiles = false;
  try { canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File(['%PDF-1.4'], 'x.pdf', { type: 'application/pdf' })] })); } catch (_) {}
  if (canShareFiles) {
    const sh = el('button', { type: 'button', className: 'share-btn share-primary', textContent: 'Share' });
    sh.addEventListener('click', () => runPdf(sh, 'share'));
    actions.append(sh);
  }

  // Print stays for wide viewports (it works well there); hidden on phones via CSS — the PDF prints
  // from anywhere later.
  const pr = el('button', { type: 'button', className: 'share-btn share-secondary pp-print-btn', textContent: 'Print' });
  pr.addEventListener('click', printPassport);
  actions.append(pr);

  const copyBtn = el('button', { type: 'button', className: 'share-btn share-secondary', textContent: 'Copy link' });
  copyBtn.addEventListener('click', async () => {
    updateFragment();
    try { await navigator.clipboard.writeText(location.href); copyBtn.textContent = 'Link copied ✓'; setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000); }
    catch (_) { window.prompt('Copy this link:', location.href); }
  });
  actions.append(copyBtn);
  bar.append(actions);

  bar.append(el('p', { className: 'share-warn', textContent: 'The link and the PDF contain your medication list — share only with people you trust.' }));
  bar.append(el('p', { className: 'share-super', textContent: 'Bookmark the link and reopen it this fall — it reruns against the newest plan data automatically.' }));
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

// Build the shared model from current state (URL fragment kept fresh for the share link). THE seam
// between the two doors: each page prints its own sheet, and everything downstream — Download PDF,
// Print, the parity test — goes through here, so neither can drift onto the other's model.
// Returns null when the checkup doesn't know which plan is hers (the screen shows the picker instead).
function passportModelNow(data) {
  updateFragment();
  const shareUrl = location.href;
  if (PAGE === 'checkup') {
    return PRPassport.checkupModel(data, [...state.drugs], {
      shareUrl, county: state.county,
      road: state.road, planId: state.planId, planIdSource: state.planIdSource,
      fill: state.fill, perks: state.perks,
      // The season verdict is computed on HER clock, from the window the engine carries on /api/meta.
      meta: state.checkupMeta, now: new Date(),
    });
  }
  return PRPassport.passportModel(data, [...state.drugs], { shareUrl, county: state.county });
}

// ---- DOM renderer: walks the shared model into the 2-page print passport (.pp-* classes) ----
function planCardDom(it) {
  const card = el('div', { className: 'pp-plan' + (it.partialFlag ? ' pp-plan-partial' : '') });
  card.append(el('div', { className: 'pp-plan-head' }, [
    el('div', { className: 'pp-plan-name', textContent: it.name }),
    el('div', { className: 'pp-plan-total' + (it.noCover ? ' pp-no-cover' : ''), textContent: it.total }),
  ]));
  // Order is the parity contract: name, total, [premium], sub — matches passportStrings + the PDF.
  if (it.premium) card.append(el('div', { className: 'pp-plan-premium', textContent: it.premium }));
  card.append(el('div', { className: 'pp-plan-sub', textContent: it.sub }));
  if (it.partial) card.append(el('div', { className: 'pp-partial', textContent: it.partial }));
  if (it.savings) card.append(el('div', { className: 'pp-savings', textContent: it.savings }));
  const tbl = el('table', { className: 'pp-drugs' });
  for (const [label, tier, cost] of it.drugs) tbl.append(el('tr', {}, [el('td', { textContent: label }), el('td', { textContent: tier }), el('td', { textContent: cost })]));
  card.append(tbl);
  return card;
}

// One-color robin mark — a solid black silhouette (paper shows through the eye). Deliberately NOT the
// painterly color illustration: a single ink holds up when the passport is photocopied or faxed. It's
// decorative (aria-hidden) so it never enters the DOM↔PDF parity strings — the wordmark text does that.
const ROBIN_1C_SVG = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true" focusable="false">'
  + '<ellipse cx="37" cy="37" rx="21" ry="16"/>'
  + '<path d="M53 32 L63 44 L50 48 Z"/>'
  + '<ellipse cx="25" cy="40" rx="13" ry="14"/>'
  + '<circle cx="23" cy="25" r="12.5"/>'
  + '<path d="M12 25 L2 27.5 L12 30 Z"/>'
  + '<path d="M30 51 v9 M39 51 v9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/>'
  + '<circle cx="26" cy="23" r="2.4" fill="#fff"/></svg>';
function oneColorRobin() { const s = el('span', { className: 'pp-robin', 'aria-hidden': 'true' }); s.innerHTML = ROBIN_1C_SVG; return s; }

function renderPassportDom(model) {
  const doc = el('div', { className: 'passport-doc' });
  let page = el('section', { className: 'pp-page' }); doc.append(page);
  let brand = '', asof = '';
  const flushHead = () => { if (brand || asof) { const left = el('div', { className: 'pp-brandmark' }, [oneColorRobin(), el('div', { className: 'pp-brand', textContent: brand })]); page.insertBefore(el('div', { className: 'pp-head' }, [left, el('div', { className: 'pp-asof', textContent: asof })]), page.firstChild); brand = asof = ''; } };
  const inputs = () => { let d = page.querySelector('.pp-inputs'); if (!d) { d = el('div', { className: 'pp-inputs' }); page.append(d); } return d; };
  const listIn = (host, cls) => { let ul = host.querySelector('.' + cls); if (!ul) { ul = el('ul', { className: cls }); host.append(ul); } return ul; };
  // Bullets can appear in more than one place on a sheet, so they attach to the list at the TAIL and
  // start a fresh one otherwise — never reaching back into an earlier list and scrambling model order.
  const listTail = (host, cls) => { const last = host.lastElementChild; if (last && last.classList.contains(cls)) return last; const ul = el('ul', { className: cls }); host.append(ul); return ul; };

  for (const it of model.items) {
    if (it.pageBreak) { flushHead(); page = el('section', { className: 'pp-page pp-break' }); doc.append(page); }
    if (it.type === 'brand') brand = it.text;
    else if (it.type === 'asof') asof = it.text;
    else if (it.type === 'kv') { const idx = it.text.indexOf(': '); inputs().append(el('div', {}, [el('strong', { textContent: it.text.slice(0, idx + 2) }), document.createTextNode(it.text.slice(idx + 2))])); }
    else if (it.type === 'label') inputs().append(el('div', {}, el('strong', { textContent: it.text })));
    else if (it.type === 'med') listIn(inputs(), 'pp-meds').append(el('li', { textContent: it.text }));
    else if (it.type === 'coverage') page.append(el('div', { className: 'pp-coverage', textContent: it.text }));
    else if (it.type === 'h') page.append(el('h2', { className: 'pp-h', textContent: it.text }));
    else if (it.type === 'plan') page.append(planCardDom(it));
    // ---- the checkup's page 1: a verdict, an instruction, the words to say, the small print ----
    // Semantic state on paper is word + weight + color: the sentence itself carries the word, so a
    // black-and-white photocopy of this sheet still says the same thing.
    else if (it.type === 'verdict') page.append(el('div', { className: 'pp-verdict pp-verdict-' + (it.kind || 'good'), textContent: it.text }));
    else if (it.type === 'bullet') listTail(page, 'pp-bullets').append(el('li', { className: 'pp-bullet', textContent: it.text }));
    else if (it.type === 'strong') page.append(el('p', { className: 'pp-strong', textContent: it.text }));
    else if (it.type === 'script') page.append(el('blockquote', { className: 'pp-script', textContent: it.text }));
    else if (it.type === 'fine') page.append(el('p', { className: 'pp-fine', textContent: it.text }));
    // ---- v2 ---- Scorecard: the header sentence (parity), plus a decorative stat row (aria-hidden,
    // NOT in the parity strings — same treatment as icons/QR). Counts, never a graded word.
    else if (it.type === 'scorecard') {
      page.append(el('div', { className: 'pp-scorecard', textContent: it.text }));
      const s = it.stats, chips = el('div', { className: 'pp-scorestats', 'aria-hidden': 'true' });
      chips.append(el('span', {}, [el('b', { textContent: String(s.reviewed) }), document.createTextNode(' reviewed')]));
      chips.append(el('span', {}, [el('b', { textContent: String(s.best) }), document.createTextNode(' at best price')]));
      if (s.attention) chips.append(el('span', { className: 'pp-attn' }, [el('b', { textContent: String(s.attention) }), document.createTextNode(' need attention')]));
      page.append(chips);
    }
    // The single named next step, as a callout above the detail.
    else if (it.type === 'nextstep') page.append(el('div', { className: 'pp-nextstep', textContent: it.text }));
    // The hand-typed restore code: a monospace block, one line per row (digits easy to read aloud).
    else if (it.type === 'codelines') { const blk = el('div', { className: 'pp-codelines' }); for (const ln of it.lines) blk.append(el('div', { className: 'pp-codeline', textContent: ln })); (page._share ? page._share.left : page).append(blk); }
    // A callee group: the "Ask your doctor/plan/SHIP" label + the sentences to say (parity order).
    else if (it.type === 'qgroup') {
      const g = el('div', { className: 'pp-qgroup pp-qgroup-' + it.callee });
      g.append(el('div', { className: 'pp-qlabel', textContent: it.label }));
      const ul = el('ul', { className: 'pp-qs' });
      for (const q of it.questions) ul.append(el('li', { className: 'pp-q', textContent: q }));
      g.append(ul); page.append(g);
    }
    else if (it.type === 'caveat') listIn(page, 'pp-caveats').append(el('li', { textContent: it.text }));
    // A plain sub-heading (the action plan's "Keep filling these…", "Send these 2 to mail order…").
    else if (it.type === 'h3') page.append(el('h3', { className: 'pp-h3', textContent: it.text }));
    // The reopen block: a heading that OPENS the two-column layout the QR sits in.
    else if (it.type === 'reopen-h') { const sh = el('div', { className: 'pp-share' }); sh.append(el('h3', { className: 'pp-h3', textContent: it.text })); const cols = el('div', { className: 'pp-share-cols' }); const left = el('div', {}); cols.append(left); sh.append(cols); page.append(sh); page._share = { cols, left }; }
    // Notes are the checkup's workhorse paragraph and appear on BOTH pages: inside the reopen block
    // (the comparison's only use) and in the report body above it. So they land in the share column
    // when one is open, and in the page otherwise — never assuming an h3 came first.
    else if (it.type === 'note') (page._share ? page._share.left : page).append(el('p', { className: 'pp-note', textContent: it.text }));
    // path/url/qr belong to the reopen block by construction; guarded so a model change can't crash print.
    else if (it.type === 'path' && page._share) page._share.left.append(el('div', { className: 'pp-path' }, [el('span', { className: 'pp-path-icon', 'aria-hidden': 'true', textContent: it.icon }), el('span', { className: 'pp-path-text', textContent: it.text })]));
    else if (it.type === 'url' && page._share) page._share.left.append(el('a', { className: 'pp-url', href: it.link || it.text, textContent: it.text }));
    else if (it.type === 'qr' && page._share) { const q = buildQR(it.url); if (q) page._share.cols.append(el('div', { className: 'pp-qr-wrap' }, [q])); }
  }
  flushHead();
  return doc;
}

function buildPassport(data) { const m = passportModelNow(data); return m ? renderPassportDom(m) : null; }

// ---- PDF renderer: same model → a text-based (selectable), self-hosted PDF. Records every string it
// draws so a test can prove PDF text == print-DOM text == the model. ----
async function renderPassportPdf(model) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Serif (Times, a standard PDF font → no embedding, no size cost) for the wordmark + headings, so the
  // PDF echoes the site's Source Serif look without shipping a font. Body stays Helvetica (crisp small).
  const serif = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const mono = await pdf.embedFont(StandardFonts.Courier); // the restore code — monospace, easy to read digit-by-digit
  const W = 612, H = 792, M = 54, maxW = W - 2 * M;
  // PALETTE (DESIGN.md): warnings are amber/clay, NEVER alarm-red. `warn` is the --notcov brand-orange
  // family (#9a3b2f, 6.9:1 AA at any size) — the same token the screen uses — so needs-attention reads
  // the same on paper as on screen, and no true red appears anywhere. `orange` is Robin Orange
  // (#C85A2B, large/decorative only) for the scorecard accent. `warmgray` (#756C5C) for muted labels.
  const c = { ink: rgb(0.11, 0.15, 0.2), gray: rgb(0.3, 0.3, 0.32), green: rgb(0.08, 0.42, 0.23),
    warn: rgb(0.604, 0.231, 0.184), orange: rgb(0.784, 0.353, 0.169), warmgray: rgb(0.459, 0.424, 0.361),
    line: rgb(0.8, 0.79, 0.75), link: rgb(0.05, 0.35, 0.72), mark: rgb(0.12, 0.16, 0.21) };
  let page = pdf.addPage([W, H]); let y = H - M;
  const drawn = [];

  const wrap = (str, f, size, width) => { const words = String(str).split(/\s+/); const out = []; let cur = ''; for (const w of words) { const t = cur ? cur + ' ' + w : w; if (f.widthOfTextAtSize(t, size) <= width || !cur) cur = t; else { out.push(cur); cur = w; } } if (cur) out.push(cur); return out; };
  const need = (h) => { if (y - h < M) { page = pdf.addPage([W, H]); y = H - M; } };
  const rule = () => { need(8); y -= 6; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.75, color: c.line }); y -= 4; };
  // draw one text block (wrapped), recording the LOGICAL string; `record:false` to skip parity list.
  const text = (str, o = {}) => {
    if (str == null || str === '') return;
    if (o.record !== false) drawn.push(String(str));
    const f = o.mono ? mono : (o.serif ? serif : (o.bold ? bold : font)), size = o.size || 10.5, x = M + (o.indent || 0), width = maxW - (o.indent || 0);
    const lh = size * 1.32;
    for (const ln of wrap((o.prefix || '') + str, f, size, width)) { need(lh); y -= lh; page.drawText(ln, { x, y: y + lh * 0.24, size, font: f, color: o.color || c.ink }); }
    y -= (o.gap != null ? o.gap : 3);
  };
  const drugRow = (cells) => {
    const size = 9.5, lh = size * 1.28;
    const cols = [{ x: M, w: maxW * 0.44 }, { x: M + maxW * 0.45, w: maxW * 0.2 }, { x: M + maxW * 0.66, w: maxW * 0.34 }];
    const wc = cells.map((cell, i) => wrap(String(cell || ''), font, size, cols[i].w));
    const rows = Math.max(1, ...wc.map((w) => w.length));
    need(rows * lh + 2);
    for (let i = 0; i < 3; i++) if (cells[i]) drawn.push(String(cells[i]));
    const top = y;
    for (let i = 0; i < 3; i++) { let yy = top; for (const ln of wc[i]) { yy -= lh; page.drawText(ln, { x: cols[i].x, y: yy + lh * 0.24, size, font: i === 0 ? bold : font, color: c.ink }); } }
    y = top - rows * lh - 2;
  };
  // One-color robin glyph (decorative — NOT recorded to `drawn`, so it never touches parity). Solid
  // ink shapes = photocopy-resilient. Coordinates are the 64×64 mark mapped into PDF space (y flipped:
  // sy grows downward from yTop, matching pdf-lib's drawSvgPath anchor). Guarded so it can never break
  // PDF generation. Returns the glyph width so the wordmark can sit beside it.
  const drawRobin = (xLeft, yTop, s) => {
    try {
      const px = (sx) => xLeft + sx * s, py = (sy) => yTop - sy * s, col = c.mark;
      page.drawEllipse({ x: px(37), y: py(37), xScale: 21 * s, yScale: 16 * s, color: col });          // body
      page.drawSvgPath('M53 32 L63 44 L50 48 Z', { x: xLeft, y: yTop, scale: s, color: col });         // tail
      page.drawCircle({ x: px(23), y: py(25), size: 12.5 * s, color: col });                            // head
      page.drawEllipse({ x: px(25), y: py(40), xScale: 13 * s, yScale: 14 * s, color: col });           // breast
      page.drawSvgPath('M12 25 L2 27.5 L12 30 Z', { x: xLeft, y: yTop, scale: s, color: col });         // beak
      page.drawCircle({ x: px(26), y: py(23), size: 2.4 * s, color: rgb(1, 1, 1) });                    // eye knockout
    } catch (e) { /* decorative — a drawing hiccup must never fail the PDF */ }
    return 64 * s;
  };
  const drawQR = (url) => {
    let qr; try { qr = (typeof qrcode !== 'undefined') && qrcode(0, 'L'); if (!qr) return; qr.addData(url); qr.make(); } catch { return; }
    const n = qr.getModuleCount(), box = 120, cell = box / n; need(box + 8); y -= box;
    page.drawRectangle({ x: M, y, width: box, height: box, color: rgb(1, 1, 1) });
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) page.drawRectangle({ x: M + col * cell, y: y + box - (r + 1) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
    y -= 8;
  };
  // A real clickable URI link annotation over the drawn text rect (selectable + tappable in viewers).
  const addLink = (rect, uri) => {
    const { PDFName, PDFString } = window.PDFLib;
    const annot = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) } });
    const ref = pdf.context.register(annot);
    const annots = page.node.Annots() || pdf.context.obj([]);
    annots.push(ref); page.node.set(PDFName.of('Annots'), annots);
  };
  const linkText = (url, uri) => {
    drawn.push(String(url));
    const size = 9, lh = size * 1.4;
    for (const ln of wrap(url, font, size, maxW)) {
      need(lh); y -= lh;
      const baseline = y + lh * 0.28, w = font.widthOfTextAtSize(ln, size);
      page.drawText(ln, { x: M, y: baseline, size, font, color: c.link });
      page.drawLine({ start: { x: M, y: baseline - 1.5 }, end: { x: M + w, y: baseline - 1.5 }, thickness: 0.5, color: c.link });
      addLink([M, baseline - 3, M + w, baseline + size], uri || url);
    }
    y -= 4;
  };

  for (const it of model.items) {
    if (it.pageBreak) { page = pdf.addPage([W, H]); y = H - M; }
    if (it.type === 'brand') {
      // one-color mark: robin glyph + serif wordmark on the same band, then the text (parity-recorded).
      const gs = 22 / 64;                       // ~22pt-tall glyph
      need(26); const glyphTop = y - 2;
      const gw = drawRobin(M, glyphTop, gs);
      text(it.text, { serif: true, size: 15, indent: gw + 8, gap: 2, color: c.mark });
    }
    else if (it.type === 'asof') { text(it.text, { size: 9, color: c.gray, gap: 2 }); rule(); }
    else if (it.type === 'kv') text(it.text, { size: 10.5 });
    else if (it.type === 'label') text(it.text, { bold: true, size: 10.5, gap: 1 });
    else if (it.type === 'med') text(it.text, { size: 10.5, indent: 12, prefix: '•  ', gap: 1 });
    else if (it.type === 'coverage') { y -= 3; text(it.text, { size: 9.5, color: c.gray }); }
    else if (it.type === 'h') { y -= 4; text(it.text, { serif: true, size: 14 }); rule(); }
    else if (it.type === 'plan') {
      text(it.name, { bold: true, size: 12, gap: 1 });
      text(it.total, { bold: true, size: 12, color: it.noCover ? c.warn : c.ink, gap: 1 });
      // Same order as the model + the print DOM: name, total, [premium], sub.
      if (it.premium) text(it.premium, { bold: true, size: 11, gap: 1 });
      text(it.sub, { size: 9, color: c.gray });
      if (it.partial) text(it.partial, { size: 9, color: c.warn });
      if (it.savings) text(it.savings, { size: 9.5, color: c.green });
      for (const row of it.drugs) drugRow(row);
      rule();
    }
    // ---- v2 ---- Scorecard: the header sentence in Robin-Orange-accented ink, then a decorative
    // stat line (NOT recorded to the parity `drawn` list — matches the aria-hidden DOM chips).
    else if (it.type === 'scorecard') {
      text(it.text, { bold: true, size: 11 });
      const s = it.stats;
      const chips = `${s.reviewed} reviewed   ·   ${s.best} at best price` + (s.attention ? `   ·   ${s.attention} need attention` : '');
      text(chips, { size: 9, color: c.warmgray, record: false, gap: 4 });
    }
    else if (it.type === 'nextstep') { y -= 2; text(it.text, { bold: true, size: 11, color: c.ink }); y -= 2; }
    // The restore code — each line in monospace so the digits line up and read aloud cleanly.
    else if (it.type === 'codelines') { y -= 2; for (const ln of it.lines) text(ln, { mono: true, size: 11, indent: 8, gap: 2 }); y -= 2; }
    else if (it.type === 'qgroup') {
      text(it.label, { bold: true, size: 10, color: c.warmgray, gap: 1 });
      // Render each question VERBATIM (no added quotes) — the parity string is the raw sentence.
      for (const q of it.questions) text(q, { size: 10, indent: 16, prefix: '•  ', color: c.gray });
    }
    // ---- the checkup's page 1 (see the DOM renderer for the pairing) ----
    // warn = brand-orange-family clay (never alarm-red), matching the screen's --notcov and DESIGN.md.
    else if (it.type === 'verdict') { y -= 2; text(it.text, { bold: true, size: 11, color: it.kind === 'warn' ? c.warn : c.green }); }
    else if (it.type === 'bullet') text(it.text, { size: 10, indent: 12, prefix: '•  ' });
    else if (it.type === 'strong') text(it.text, { bold: true, size: 10.5, gap: 1 });
    else if (it.type === 'script') text(it.text, { size: 10, indent: 16, color: c.gray });
    else if (it.type === 'fine') text(it.text, { size: 9, color: c.gray });
    else if (it.type === 'caveat') text(it.text, { size: 10, indent: 12, prefix: '•  ' });
    else if (it.type === 'h3' || it.type === 'reopen-h') { y -= 4; text(it.text, { serif: true, size: 12 }); }
    else if (it.type === 'note') text(it.text, { size: 9.5 });
    else if (it.type === 'path') { y -= 1; text(it.text, { size: 10, indent: 16, prefix: '•  ' }); } // icon is decorative → a plain marker in the PDF
    else if (it.type === 'url') linkText(it.text, it.link || it.text);
    else if (it.type === 'qr') drawQR(it.url);
  }
  // useObjectStreams:false keeps the font dict + text operators in plain bytes — selectable text,
  // broad viewer compatibility, and still only a few KB.
  const bytes = await pdf.save({ useObjectStreams: false });
  return { blob: new Blob([bytes], { type: 'application/pdf' }), bytes, drawn, filename: model.filename };
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
  // A price never ships without its basis: per WHAT supply. The label and the ×fills-per-year come
  // from the one constant the engine's projection basis is mirrored in (PRFormat.HEADLINE_BASIS), so
  // the words and the arithmetic can't drift apart. (Kitchen-table test: "is that 30 or 90 days?")
  const B = PRFormat.HEADLINE_BASIS;
  if (res.headline.kind === 'copay') {
    right.append(el('span', { className: 'amt', textContent: `${money(res.headline.dollars)} ${B.perLabel}` }));
    right.append(el('span', { className: 'annual-drug', textContent: ` · ${money(PRFormat.headlineAnnual(res.headline.dollars))}/yr` }));
  } else {
    right.append(el('span', { className: 'amt', textContent: `${res.headline.display} ${B.ofEachLabel}` }));
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
  // The label earns the tap by naming her question, not our data model. "Phases" is taught INSIDE,
  // where the glossary can explain it. (Founder review, Jul 2026.)
  det.append(el('summary', { textContent: 'How this price changes — during the year and by pharmacy' }));

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
