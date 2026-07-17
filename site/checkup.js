'use strict';
// The 5-Minute Medicare Checkup — the second front door. Deterministic, no LLM.
//
// The INTAKE is not reimplemented here: app.js wires ZIP, county fallback, medications, the road
// question, the wallet check and the plan-ID field for both doors (see PAGE in app.js). This file
// adds only what the checkup needs — the two habit questions, the plan picker, and the report — and
// binds the button to its own runner.
//
// Every figure comes from a shared PRFormat function that the comparison page and the passport also
// use: groupPlans (which plan is hers), actionPlan (what to change), fairPriceCheck (what's worth
// knowing), premiumLabel, planCoverage. Nothing is computed twice, so nothing can disagree.
//
// Every SENTENCE comes from PRPassport.checkupCopy — the same builders the printed sheet renders
// from. This file decides structure (headings, icons, links, tap targets); it does not author prose.
// That's why the PDF in her hand can't word the verdict differently from the page she read it on.

// Q4 baseline + Q5 perks awareness live on the shared state object app.js owns.
state.fill = { where: null, days: null };
state.perks = null;
state.checkupMeta = null;

// ---------- Q4 / Q5 (the only intake this door adds) ----------
function pressGroup(sel, attr, onPick) {
  for (const btn of document.querySelectorAll(sel + ' .road-choice')) {
    btn.addEventListener('click', () => {
      const v = btn.dataset[attr];
      const already = btn.getAttribute('aria-pressed') === 'true';
      for (const b of document.querySelectorAll(sel + ' .road-choice')) b.setAttribute('aria-pressed', 'false');
      if (!already) btn.setAttribute('aria-pressed', 'true');
      onPick(already ? null : v);            // tap again to un-answer — nothing here is compulsory
      if (state.lastData) renderCheckup(state.lastData);
    });
  }
}

function wireCheckupQuestions() {
  pressGroup('#fill-where', 'fillWhere', (v) => { state.fill.where = v; });
  pressGroup('#fill-days', 'fillDays', (v) => { state.fill.days = v; });
  pressGroup('#perks-known', 'perks', (v) => { state.perks = v; });
}

// ---------- the runner ----------
let checkupSeq = 0;
async function runCheckup() {
  const mine = ++checkupSeq;
  const box = $('#results'); box.hidden = false; box.innerHTML = '';
  renderSkeleton(box);
  try {
    const quantities = Object.fromEntries([...state.drugs].map(([rx, d]) => [rx, d.qty]));
    const data = await getJSON('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ county: state.county, rxcuis: [...state.drugs.keys()], quantities }),
    });
    if (mine !== checkupSeq) return;
    renderCheckup(data);
  } catch (e) {
    if (mine !== checkupSeq) return;
    box.innerHTML = '';
    const wrap = el('div', { className: 'state error' }, [
      el('p', { textContent: 'We couldn’t run your checkup just now.' }),
      el('p', { className: 'muted small', textContent: 'This is usually a brief connection hiccup — nothing is wrong with your list.' }),
    ]);
    const retry = el('button', { className: 'retry', type: 'button', textContent: 'Try again' });
    retry.addEventListener('click', runCheckup);
    wrap.append(retry);
    box.append(wrap);
  }
}

// ---------- the no-ID plan picker ----------
// As light as we could make it: no extra question, no new endpoint, no second wait. We already priced
// every plan in her county to answer her question — so the picker IS that list, filtered to her road
// when she told us one. Picking sets the same state the typed ID would have.
function renderPlanPicker(data, group) {
  const wrap = el('section', { className: 'card picker' });
  wrap.append(el('h2', { textContent: 'Last thing — which one is your plan?' }));
  const pool = group.grouped ? group.sameRoadOthers : group.sameRoadOthers;
  wrap.append(el('p', { className: 'help-text', textContent: group.grouped
    ? `These are the ${PRFormat.ROAD_NOUN[group.road]} plans in ${data.county.name}. It’s printed on your membership card — the name usually matches.`
    : `These are the plans in ${data.county.name}. It’s printed on your membership card — the name usually matches.` }));
  const list = el('div', { className: 'county-choices' });
  for (const p of pool) {
    const b = el('button', { type: 'button', className: 'county-choice picker-choice' });
    b.append(el('span', { className: 'picker-name', textContent: p.planName }));
    b.append(el('span', { className: 'picker-sub muted small', textContent: `${p.planType} · ${displayPlanId(p)}` }));
    b.addEventListener('click', () => {
      state.planId = PRFormat.normalizePlanId(p.planId);
      // She picked a name off a list rather than reading an ID off her card — a softer claim, and the
      // report's headline says so ("The plan you selected"). Same card, same math, same honesty.
      state.planIdSource = 'picked';
      const input = $('#road-plan-id'); if (input) input.value = state.planId;   // keep the form honest
      renderCheckup(data);
      $('#results').scrollIntoView({ block: 'start' });
    });
    list.append(b);
  }
  wrap.append(list);
  wrap.append(el('p', { className: 'fine muted', textContent:
    'Don’t see it? It may be offered in a different county — or check the ID on your card above.' }));
  return wrap;
}

// ---------- the report ----------
function renderCheckup(data) {
  state.lastData = data;
  updateFragment();
  const box = $('#results'); box.innerHTML = '';
  const group = PRFormat.groupPlans(data.plans, { road: state.road, planId: state.planId });

  box.append(el('h2', {}, `Your checkup — ${data.county.name}, ${data.county.state}`));
  const d = data.meta && data.meta.ingestedAt ? new Date(data.meta.ingestedAt) : null;
  box.append(el('div', { className: 'result-meta' }, [
    el('span', { className: 'muted small', textContent: data.meta && data.meta.quarter
      ? `Data: CMS ${data.meta.quarter}${d ? ', loaded ' + d.toLocaleDateString() : ''}` : '' }),
  ]));

  // No plan yet → ask the one question we genuinely need, from the list we already priced.
  if (!group.yourPlan) {
    if (group.planIdMissed) box.append(renderPlanIdMissed(data));
    box.append(renderPlanPicker(data, group));
    return;
  }

  const you = group.yourPlan;
  // 1 — HEADLINE: her plan, her total, premium given the prominence she asked for out loud. The badge
  // mirrors how she told us: typed off the card = "Your plan"; picked from the list = "The plan you
  // selected". One conditional, one shared vocabulary (PRFormat.yoursLabel) — the sheet says it too.
  box.append(renderPlan(you, { yours: true, premiumProminent: true, yoursLabel: PRFormat.yoursLabel(state.planIdSource) }));
  // 2 — ACTION PLAN
  box.append(renderActionPlan(you));
  // 3 — FAIR-PRICE CHECK
  const fp = PRFormat.fairPriceCheck(group);
  const fpNode = renderFairPrice(fp, data);
  if (fpNode) box.append(fpNode);
  // 4 — PERKS (only when she said she doesn't know)
  if (state.perks === 'no' || state.perks === 'unsure') box.append(renderPerks());
  // 5 — CAPTURE BRIDGE
  box.append(renderBridge());
  // 6 — the passport (page 2 unchanged): the same share bar the comparison uses.
  box.append(renderShareBar(data));
}

// ---------- 2. the action plan ----------
const COPY = () => PRPassport.checkupCopy;   // the shared sentences (screen + printed sheet)

function renderActionPlan(plan) {
  const C = COPY();
  const a = PRFormat.actionPlan(plan, [...state.drugs], state.fill);
  const wrap = el('section', { className: 'card action-plan' });
  wrap.append(el('h2', { textContent: C.actionHeading }));

  // A gap outranks a verdict about pharmacies: she hears about the drug her plan won't pay for BEFORE
  // she hears that her pharmacy choice is fine. (Same order as the printed sheet.)
  if (a.notCovered.length) {
    wrap.append(el('div', { className: 'action-warn' }, [ic('cross'), el('span', { textContent: C.actionNotCovered(a) })]));
  }
  if (a.allClear) {
    // The do-nothing verdict is a designed answer, not an empty section — and it's only honest when
    // every drug she takes was actually checkable (see PRFormat.actionPlan's allClear).
    wrap.append(el('div', { className: 'action-good' }, [ic('check'), el('span', { textContent: C.doNothing })]));
    const keep = C.doNothingKeep(a);
    if (keep) wrap.append(el('p', { className: 'muted small', textContent: keep }));
    wrap.append(renderBaselineNote(a));
    return wrap;
  }

  // Grouped by ACTION: one instruction, the drugs it covers, the money, then how to actually do it.
  if (a.moves.length) {
    const act = el('div', { className: 'action-item' });
    act.append(el('h3', { className: 'action-head', textContent: C.moveHead(a) }));
    const ul = el('ul', { className: 'action-drugs' });
    for (const m of a.moves) {
      // The shared sentence, with only its leading drug name given weight. Emphasis is presentation;
      // the characters are identical either way, so the li's text still equals the printed line.
      const line = C.moveLine(m), li = el('li', { className: 'action-drug' });
      if (line.indexOf(m.label) === 0) li.append(el('strong', { textContent: m.label }), document.createTextNode(line.slice(m.label.length)));
      else li.textContent = line;
      ul.append(li);
    }
    act.append(ul);
    act.append(el('p', { className: 'action-how-head', textContent: C.howHead }));
    act.append(el('blockquote', { className: 'action-script', textContent: C.script }));
    act.append(el('p', { className: 'action-reassure', textContent: C.reassure }));
    wrap.append(act);
  }

  if (a.keep.length) {
    wrap.append(el('div', { className: 'action-item' }, [
      el('h3', { className: 'action-head', textContent: C.keepHead }),
      el('p', { textContent: C.keepBody(a) }),
    ]));
  }
  if (a.cant.length) wrap.append(el('p', { className: 'muted small', textContent: C.cant(a) }));
  // The baseline note explains a measurement — so it only shows when something was measured.
  if (a.moves.length || a.keep.length) wrap.append(renderBaselineNote(a));
  return wrap;
}

// The baseline we measured from — including the assumption that could make a saving too big.
function renderBaselineNote(a) {
  return el('p', { className: 'fine muted action-baseline', textContent: COPY().baseline(a) });
}

// ---------- 3. the fair-price check ----------
function renderFairPrice(fp, data) {
  if (!fp.fires) return null;                       // silence is a designed outcome, not an omission
  const C = COPY();
  const wrap = el('section', { className: 'card fair-price', role: 'note' });
  // Computed on HER clock: a precomputed boolean would go stale in the edge cache across October 15.
  const season = PRFormat.seasonLine(state.checkupMeta, new Date());
  wrap.append(el('h2', { textContent: C.fairHeading }));

  if (fp.reason === 'not-covered') {
    const missing = fp.yourCoverage.missing.map((rx) => (state.drugs.get(rx) || {}).label || rx).join(', ');
    wrap.append(el('div', { className: 'fp-lead' }, [ic('cross'), el('span', { textContent: C.fairNotCoveredLead(fp, missing) })]));
    wrap.append(el('p', { textContent: C.fairNotCoveredOthers(fp) }));
  } else {
    wrap.append(el('p', { className: 'fp-lead-text', textContent: C.fairCheaper(fp) }));
  }

  // "Staying put is a perfectly good choice" only makes sense when there's somewhere to go. With no
  // alternative that covers everything, the honest next step is a person, not a plan switch.
  if (fp.n > 0) {
    wrap.append(el('p', { textContent: C.fairStayPut }));
    // Screen-only shape: the sheet can't be tapped, so the model prints the address (fairComparePaper).
    const cta = el('p', {}, [
      document.createTextNode('If you’d like to compare, '),
      el('a', { href: '/', textContent: 'here’s the full list' }),
      document.createTextNode('.'),
    ]);
    if (season) cta.append(document.createTextNode(` (${season}.)`));
    wrap.append(cta);
  } else {
    wrap.append(el('p', { textContent: C.fairNoWhereToSwitch }));
  }
  wrap.append(el('p', { className: 'fine muted' }, [
    document.createTextNode('Free, unbiased help deciding: your State Health Insurance Assistance Program (SHIP) — '),
    el('a', { href: 'https://www.shiphelp.org', rel: 'noopener', target: '_blank', textContent: 'find a counselor' }),
    document.createTextNode(' — or call 1-800-MEDICARE.'),
  ]));
  return wrap;
}

// ---------- 4. perks ----------
// We have NO benefits data — the PUF is formulary, pricing and pharmacy network. So this section
// never enumerates or prices a perk; it points at where the real answer lives (00-PRINCIPLES: the
// system never invents).
function renderPerks() {
  const C = COPY();
  const wrap = el('section', { className: 'card perks' });
  wrap.append(el('h2', { textContent: C.perksHeading }));
  wrap.append(el('p', { textContent: C.perksLead }));
  wrap.append(el('p', { className: 'action-how-head', textContent: C.perksAsk }));
  const ol = el('ol', { className: 'perks-script' });
  for (const q of C.perksQuestions) ol.append(el('li', {}, el('blockquote', { className: 'action-script', textContent: q })));
  wrap.append(ol);
  wrap.append(el('p', { className: 'fine muted' }, [
    document.createTextNode('It’s also in your plan’s Annual Notice of Change (ANOC) or Evidence of Coverage (EOC) — the booklet it mails you — and on your plan’s page at '),
    el('a', { href: 'https://www.medicare.gov/plan-compare', rel: 'noopener', target: '_blank', textContent: 'Medicare.gov' }),
    document.createTextNode('. A '),
    el('a', { href: 'https://www.shiphelp.org', rel: 'noopener', target: '_blank', textContent: 'SHIP counselor' }),
    document.createTextNode(' can read it with you, free.'),
  ]));
  return wrap;
}

// ---------- 5. the capture bridge ----------
// The email capture backend doesn't exist yet, so this renders as copy only — no button, no disabled
// control, nothing that looks tappable and isn't. The "Want a reminder?" paragraph stays as plain
// text: it's true, it sets the expectation, and cutting it leaves the section trailing off.
//
// TODO(capture-session): THIS is where the reminder form lands. That session — the only one that
// knowingly runs against production — owns, as one deliberate bundle (see README § Roadmap):
//   1. the capture backend + POST /api/subscribe (double opt-in, unsubscribe token, no list rental)
//   2. migration 0005 — the counters (aggregate only; never a medication list, never an identifier)
//   3. the privacy page, authored properly: YMYL, human-reviewed, linked from the form BEFORE it
//      takes a single address. No form ships before that page does.
//   4. tuning FAIR_PRICE_FLOOR_UNTUNED against the live DB (format.js) — needs real MO distributions
// Until then this stays copy. A form with nothing behind it would be the first promise we've broken.
function renderBridge() {
  const wrap = el('section', { className: 'card bridge' });
  wrap.append(el('h2', { textContent: 'One more thing worth knowing: plans change every October.' }));
  wrap.append(el('p', { textContent:
    'Each fall, every Medicare drug plan resets for the new year — prices move, and some drugs get dropped from coverage entirely. Your plan will mail you a letter about it in September (most people never open it).' }));
  wrap.append(el('p', { textContent:
    'When the new plan data is published, this same free check takes about five minutes and shows you exactly what’s changing for your medications — so staying or switching is an informed decision, not a guess.' }));
  wrap.append(el('p', { className: 'bridge-ask' }, [
    el('strong', { textContent: 'Want a reminder?' }),
    document.createTextNode(' Leave your email and we’ll send one note in September when the new data loads. That’s the whole deal: one reminder a year, no newsletters, unsubscribe anytime.'),
  ]));
  return wrap;
}

// ---------- boot ----------
// app.js's init() has already wired the shared intake by the time this runs.
wireCheckupQuestions();
$('#go').addEventListener('click', runCheckup);
// The cap/season parameters ride on /api/meta — the same source the engine computes with.
getJSON('/api/meta').then((m) => { state.checkupMeta = m; }).catch(() => {});
