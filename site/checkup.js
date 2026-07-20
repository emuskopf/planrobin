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
  // v2 — computed ONCE here, mirroring checkupModel exactly (screen and sheet read the same rules).
  const a = PRFormat.actionPlan(you, [...state.drugs], state.fill);
  const split = PRFormat.exceptionSplit(data.plans, you, [...state.drugs]);
  const fp = PRFormat.fairPriceCheck(group);
  const sc = PRFormat.checkupScorecard(a);
  const step = PRFormat.nextStep(a, split);
  const good = PRFormat.goodNewsBullets(you, a, fp, fp.floor);
  const ctx = { data, you, a, split, fp, sc, step, good, group };

  // 1 — SCORECARD (counted, never graded): the whole checkup at a glance, first.
  box.append(renderScorecard(sc));
  // 2 — NEXT STEP: one named action, before any detail.
  box.append(renderNextStep(step));
  // 3 — her plan (badge mirrors how she told us it was hers — typed vs picked).
  box.append(renderPlan(you, { yours: true, premiumProminent: true, yoursLabel: PRFormat.yoursLabel(state.planIdSource) }));
  // 4 — WHAT YOU CAN DO: the action detail (dollars); the "how" moves to Questions to ask.
  box.append(renderActionPlan(you, a));
  // 5 — WORTH KNOWING: would-switching-fix + the right remedy (exception path or compare).
  const wk = renderWorthKnowing(ctx);
  if (wk) box.append(wk);
  // 6 — QUESTIONS TO ASK, grouped by callee — the standard action format.
  const q = renderQuestions(ctx);
  if (q) box.append(q);
  // 7 — GOOD NEWS: computed-true bullets only; absent when there's nothing verifiable.
  if (good.length) box.append(renderGoodNews(good));
  // 8 — CAPTURE BRIDGE
  box.append(renderBridge());
  // 9 — the passport share bar (page 2 unchanged).
  box.append(renderShareBar(data));
}

// ---------- 1. scorecard (counted, never graded — UX-REVIEW #13) ----------
function renderScorecard(sc) {
  const C = COPY();
  const wrap = el('section', { className: 'card scorecard' });
  wrap.append(el('h2', { textContent: C.scorecardHeading }));
  // The header sentence carries the meaning (parity with the sheet); the stat chips are visual echo.
  wrap.append(el('p', { className: 'sc-line', textContent: C.scorecardHeader(sc) }));
  const stats = el('div', { className: 'sc-stats', 'aria-hidden': 'true' });
  const stat = (n, label, cls) => el('div', { className: 'sc-stat' + (cls ? ' ' + cls : '') }, [
    el('span', { className: 'sc-num', textContent: String(n) }), el('span', { className: 'sc-lbl', textContent: label })]);
  stats.append(stat(sc.reviewed, C.scorecardStat.reviewed));
  stats.append(stat(sc.best, C.scorecardStat.best, 'sc-good'));
  if (sc.attention) stats.append(stat(sc.attention, C.scorecardStat.attention, 'sc-attn'));
  wrap.append(stats);
  return wrap;
}

// ---------- 2. next step (one named action, first) ----------
function renderNextStep(step) {
  const C = COPY();
  const wrap = el('section', { className: 'card nextstep' + (step.kind === 'exception' ? ' nextstep-attn' : '') });
  wrap.append(el('h2', { className: 'ns-h', textContent: C.nextStepHeading }));
  const icon = step.kind === 'nothing' ? 'check' : 'arrow';
  wrap.append(el('p', { className: 'ns-body' }, [ic(icon === 'arrow' ? 'save' : 'check'), el('span', { textContent: C.nextStepText(step) })]));
  return wrap;
}

// ---------- 5. worth knowing (would-switching-fix + exception path or compare) ----------
function renderWorthKnowing(ctx) {
  const C = COPY();
  const { data, split, fp } = ctx;
  const hasGap = split.nowhere.length || split.elsewhere.length;
  if (!hasGap && fp.reason !== 'cheaper') return null;
  const wrap = el('section', { className: 'card worth-knowing', role: 'note' });
  wrap.append(el('h2', { textContent: C.fairHeading }));
  const would = C.wouldSwitchingFix(split, data.county.name);
  if (would) wrap.append(el('p', { className: 'wk-switch', textContent: would }));
  if (split.nowhere.length) {
    wrap.append(el('div', { className: 'wk-exception' }, [ic('cross'), el('span', { textContent: C.exceptionLead(split, data.county.name) })]));
  }
  if (fp.reason === 'cheaper') wrap.append(el('p', { className: 'wk-cheaper', textContent: C.fairCheaper(fp) }));
  const season = PRFormat.seasonLine(state.checkupMeta, new Date());
  if (fp.n > 0 && (split.elsewhere.length || fp.reason === 'cheaper')) {
    wrap.append(el('p', { textContent: C.fairStayPut }));
    const cta = el('p', {}, [
      document.createTextNode('If you’d like to compare, '),
      el('a', { href: '/', textContent: 'here’s the full list' }),
      document.createTextNode('.'),
    ]);
    if (season) cta.append(document.createTextNode(` (${season}.)`));
    wrap.append(cta);
  }
  return wrap;
}

// ---------- 6. questions to ask, grouped by callee ----------
function renderQuestions(ctx) {
  const C = COPY();
  const { a, split } = ctx;
  const perksUnknown = state.perks === 'no' || state.perks === 'unsure';
  const qDoctor = [], qPlan = [];
  if (split.nowhere.length) { qDoctor.push(C.exceptionDoctorQ(split)); qPlan.push(C.exceptionPlanQ); }
  if (a.moves.length) qPlan.push(C.moveQuestion);
  if (perksUnknown) for (const q of C.perksQuestions) qPlan.push(q);
  if (!qDoctor.length && !qPlan.length) return null;
  const wrap = el('section', { className: 'card questions' });
  wrap.append(el('h2', { textContent: C.questionsHeading }));
  const group = (callee, label, qs) => {
    if (!qs.length) return;
    const g = el('div', { className: 'q-group q-' + callee });
    g.append(el('h3', { className: 'q-label', textContent: label }));
    const ol = el('ul', { className: 'q-list' });
    for (const q of qs) ol.append(el('li', { className: 'q-item' }, el('blockquote', { className: 'action-script', textContent: q })));
    g.append(ol); wrap.append(g);
  };
  group('doctor', C.calleeLabel.doctor, qDoctor);
  group('plan', C.calleeLabel.plan, qPlan);
  group('ship', C.calleeLabel.ship, [C.shipQuestion]);
  if (perksUnknown) {
    wrap.append(el('p', { className: 'fine muted' }, [
      document.createTextNode('Benefits are also in your plan’s Annual Notice of Change (ANOC) or Evidence of Coverage, and on your plan’s page at '),
      el('a', { href: 'https://www.medicare.gov/plan-compare', rel: 'noopener', target: '_blank', textContent: 'Medicare.gov' }),
      document.createTextNode('. A '),
      el('a', { href: 'https://www.shiphelp.org', rel: 'noopener', target: '_blank', textContent: 'SHIP counselor' }),
      document.createTextNode(' can read it with you, free.'),
    ]));
  }
  return wrap;
}

// ---------- 7. good news (computed-true bullets only) ----------
function renderGoodNews(good) {
  const C = COPY();
  const wrap = el('section', { className: 'card good-news' });
  wrap.append(el('h2', {}, [ic('check'), document.createTextNode(' ' + C.goodNewsHeading)]));
  const ul = el('ul', { className: 'gn-list' });
  for (const b of good) ul.append(el('li', { className: 'gn-item', textContent: C.goodNewsBullet(b) }));
  wrap.append(ul);
  return wrap;
}

// ---------- 2. the action plan ----------
const COPY = () => PRPassport.checkupCopy;   // the shared sentences (screen + printed sheet)

function renderActionPlan(plan, a) {
  const C = COPY();
  a = a || PRFormat.actionPlan(plan, [...state.drugs], state.fill);
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

  // One grouped action: the instruction head, the drugs it covers (drug name given weight; the rest
  // is the shared sentence verbatim, so the li's text still equals the printed line).
  const actionGroup = (head, list, lineFn, reassure, extraNote) => {
    const act = el('div', { className: 'action-item' });
    act.append(el('h3', { className: 'action-head', textContent: head }));
    const ul = el('ul', { className: 'action-drugs' });
    for (const m of list) {
      const line = lineFn(m), li = el('li', { className: 'action-drug' });
      if (line.indexOf(m.label) === 0) li.append(el('strong', { textContent: m.label }), document.createTextNode(line.slice(m.label.length)));
      else li.textContent = line;
      ul.append(li);
    }
    act.append(ul);
    // Order mirrors the sheet: bullets → PA clause (if any) → reassurance.
    if (extraNote) act.append(el('p', { className: 'fine muted', textContent: extraNote }));
    if (reassure) act.append(el('p', { className: 'action-reassure', textContent: C.reassure }));
    wrap.append(act);
  };

  // Grouped by ACTION — mail move and preferred-pharmacy switch each stand alone (never mixed).
  if (a.moves.length) actionGroup(C.moveHead(a), a.moves, C.moveLine, true, a.moves.some((m) => m.pa) ? C.paClause : null);
  if (a.switches.length) actionGroup(C.switchHead(a), a.switches, C.switchLine, false);

  if (a.keep.length) {
    wrap.append(el('div', { className: 'action-item' }, [
      el('h3', { className: 'action-head', textContent: C.keepHead }),
      el('p', { textContent: C.keepBody(a) }),
    ]));
  }
  if (a.cant.length) wrap.append(el('p', { className: 'muted small', textContent: C.cant(a) }));
  // The baseline note explains a measurement — so it only shows when something was measured.
  if (a.moves.length || a.switches.length || a.keep.length) wrap.append(renderBaselineNote(a));
  return wrap;
}

// The baseline we measured from — including the assumption that could make a saving too big.
function renderBaselineNote(a) {
  return el('p', { className: 'fine muted action-baseline', textContent: COPY().baseline(a) });
}

// ---------- the capture bridge ----------
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
// The restore-code path (app.js) runs the page's own runner after setting state.
window.PRRunSearch = runCheckup;
// The cap/season parameters ride on /api/meta — the same source the engine computes with.
getJSON('/api/meta').then((m) => { state.checkupMeta = m; }).catch(() => {});
