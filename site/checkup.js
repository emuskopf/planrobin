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
  // 1 — HEADLINE: her plan, her total, premium given the prominence she asked for out loud.
  box.append(renderPlan(you, { yours: true, premiumProminent: true }));
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
const CHANNEL_WORD = { preferredMail: 'this plan’s mail-order pharmacy', standardMail: 'this plan’s mail-order pharmacy' };
const DAYS_WORD = { '1': '30-day', '2': '90-day' };

function renderActionPlan(plan) {
  const a = PRFormat.actionPlan(plan, [...state.drugs], state.fill);
  const wrap = el('section', { className: 'card action-plan' });
  wrap.append(el('h2', { textContent: 'What you can do about it' }));

  if (a.nothingToDo && !a.cant.length) {
    // The do-nothing verdict is a designed answer, not an empty section.
    wrap.append(el('div', { className: 'action-good' }, [ic('check'), el('span', { textContent:
      'Good news — the way you’re filling now is already the cheapest option on your plan. We checked.' })]));
    if (a.keep.length) {
      wrap.append(el('p', { className: 'muted small', textContent:
        `Keep filling ${a.keep.map((k) => k.label).join(', ')} where you do — already your best price.` }));
    }
    wrap.append(renderBaselineNote(a));
    return wrap;
  }

  // Grouped by ACTION: one instruction, the drugs it covers, the money, then how to actually do it.
  if (a.moves.length) {
    const names = a.moves.map((m) => m.label);
    const ds = a.moves[0].days;
    const verb = a.baseline.where === 'mail'
      ? `Switch ${names.length === 1 ? 'this one' : 'these ' + names.length} to ${DAYS_WORD[ds]} fills by mail`
      : `Send ${names.length === 1 ? 'this one' : 'these ' + names.length} to mail order`;
    const act = el('div', { className: 'action-item' });
    act.append(el('h3', { className: 'action-head', textContent: `${verb} — saving about ${PRFormat.dollars(a.saving)}/yr` }));
    const ul = el('ul', { className: 'action-drugs' });
    for (const m of a.moves) {
      ul.append(el('li', {}, [
        el('strong', { textContent: m.label }),
        document.createTextNode(` — ${PRFormat.dollars(m.current)}/yr now, about ${PRFormat.dollars(m.to)}/yr as a ${DAYS_WORD[m.days]} fill by mail. Saving about ${PRFormat.dollars(m.saving)}/yr.`),
      ]));
    }
    act.append(ul);
    // The how-to script — a recommendation without its action is incomplete (CONTENT-RULES 16).
    act.append(el('p', { className: 'action-how-head', textContent: 'How to do it, in one call:' }));
    act.append(el('blockquote', { className: 'action-script', textContent:
      'Call the number on the back of your insurance card and say: “I’d like to move my prescriptions to your mail-order pharmacy.” They’ll ask for your medication names and your doctor’s name, and they do the rest.' }));
    // Small, reversible, losing nothing (CONTENT-RULES 15).
    act.append(el('p', { className: 'action-reassure', textContent:
      'This is a split, not a switch: you keep the same plan and the same pharmacy for anything else — your pharmacist stays yours. You can change back at any time.' }));
    wrap.append(act);
  }

  if (a.keep.length) {
    wrap.append(el('div', { className: 'action-item' }, [
      el('h3', { className: 'action-head', textContent: 'Keep filling these where you do' }),
      el('p', { textContent: `${a.keep.map((k) => k.label).join(', ')} — already your best price on this plan.` }),
    ]));
  }
  // Never modelled: say plainly what we can't compare and why (rule 6 + trade-off honesty).
  if (a.cant.length) {
    wrap.append(el('p', { className: 'muted small', textContent:
      `We can’t compare pharmacies for ${a.cant.map((c) => c.label).join(', ')} — ${a.cant.length === 1 ? 'it’s' : 'they’re'} priced as coinsurance, which depends on the drug’s price and how much you take. Your plan’s member line can quote it.` }));
  }
  wrap.append(renderBaselineNote(a));
  return wrap;
}

// The baseline we measured from — including the assumption that could make a saving too big.
function renderBaselineNote(a) {
  const where = a.baseline.where === 'mail' ? 'by mail' : 'at a local pharmacy';
  const days = DAYS_WORD[a.baseline.days];
  const txt = `Measured against ${days} fills ${where}` + (a.baselineAssumed
    ? ' at a standard (non-preferred) pharmacy. If yours is one of your plan’s preferred pharmacies you may already pay less than we’ve shown, which would make the saving smaller.'
    : '.');
  return el('p', { className: 'fine muted action-baseline', textContent: txt });
}

// ---------- 3. the fair-price check ----------
function renderFairPrice(fp, data) {
  if (!fp.fires) return null;                       // silence is a designed outcome, not an omission
  const wrap = el('section', { className: 'card fair-price', role: 'note' });
  const noun = PRFormat.ROAD_NOUN[fp.road] || '';
  const season = PRFormat.seasonLine(state.checkupMeta, new Date());

  if (fp.reason === 'not-covered') {
    const missing = fp.yourCoverage.missing.map((rx) => (state.drugs.get(rx) || {}).label || rx).join(', ');
    wrap.append(el('h2', { textContent: 'Worth knowing' }));
    wrap.append(el('div', { className: 'fp-lead' }, [ic('cross'), el('span', { textContent:
      `Your plan doesn’t cover ${missing} — you’d pay full price for ${fp.yourCoverage.missing.length === 1 ? 'it' : 'them'}, and it wouldn’t count toward your yearly out-of-pocket cap.` })]));
    wrap.append(el('p', { textContent:
      `${fp.n} other ${noun} ${fp.n === 1 ? 'plan' : 'plans'} in your county ${fp.n === 1 ? 'covers' : 'cover'} everything on your list${fp.atLeast ? `, and at least one for about ${PRFormat.dollars(fp.atLeast)} less per year` : ''}.` }));
  } else {
    wrap.append(el('h2', { textContent: 'Worth knowing' }));
    wrap.append(el('p', { className: 'fp-lead-text', textContent:
      `${fp.n} other ${noun} ${fp.n === 1 ? 'plan' : 'plans'} in your county would cover these same medications for at least ${PRFormat.dollars(fp.atLeast)} less per year.` }));
  }

  // Disclosure, not alarm: staying put is explicitly a good choice, and we name what we don't check.
  wrap.append(el('p', { textContent:
    'If you’re happy with your plan’s doctors, staying put and using the steps above is a perfectly good choice — cheaper plans may not include your doctors, and this checkup doesn’t check networks.' }));
  const cta = el('p', {}, [
    document.createTextNode('If you’d like to compare, '),
    el('a', { href: '/', textContent: 'here’s the full list' }),
    document.createTextNode('.'),
  ]);
  if (season) cta.append(document.createTextNode(` (${season}.)`));
  wrap.append(cta);
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
  const wrap = el('section', { className: 'card perks' });
  wrap.append(el('h2', { textContent: 'Your plan may include benefits nobody reminded you about' }));
  wrap.append(el('p', { textContent:
    'Dental, vision, over-the-counter allowances, gym memberships — many plans include them, and they’re real money. We don’t have benefits data, so we won’t guess at yours. Here’s how to find out in one call:' }));
  wrap.append(el('p', { className: 'action-how-head', textContent: 'Call the number on the back of your card and ask:' }));
  const ol = el('ol', { className: 'perks-script' });
  for (const q of [
    '“What extra benefits does my plan include this year?”',
    '“Do I have an over-the-counter allowance — and how do I use it?”',
    '“Is there anything in my plan I haven’t used this year?”',
  ]) ol.append(el('li', {}, el('blockquote', { className: 'action-script', textContent: q })));
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
