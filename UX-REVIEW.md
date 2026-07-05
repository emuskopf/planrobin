# PlanRobin — UX Review Standard

This is the judgment layer. The mechanical floors (overlap, overflow, contrast, touch, focus,
type) are enforced automatically by the **UX floor suite** (`tests/ux/`, gates every deploy). This
document is the part a machine can't check: the persona, the brand, the copy rules, and the
specific failure patterns we've been personally burned by. **Every session that touches UI or
user-facing copy self-reviews its diff against this file at 360px + large font before declaring
done** (see the standing hook in `CLAUDE.md`).

Evan edits this file directly; his edits are canon. New rulings get appended with a date.

---

## 1. Persona — who we are actually building for

Review as **her**: a stressed **52-year-old at her mom's kitchen table, on her phone**, trying to
help an anxious parent before an enrollment deadline. She is not dumb; she is *tired, worried, and
short on time*, and she has been trained by a decade of predatory Medicare sites to read **jank as
danger**. A layout that stutters, a number that doesn't add up, a claim that oversells — each one
tells her "close this tab."

Secondary reader: the **70-year-old parent, reading glasses off**, looking over her shoulder. If he
can't read it at arm's length, it's too small.

The test for any change: *would this make her trust us more, or reach to close the tab?*

---

## 2. Brand — CALM · STURDY · UNHURRIED

"A credit union built by a public library — not an insurance startup." (see `site/DESIGN.md`)

**Never:**
- Countdown timers, "act now", deadline urgency, anything that nags or auto-moves.
- Alarm-red. Warnings are amber/clay (`--caution`) or clay (`--notcov`) — unmissable, not
  frightening.
- Exclamation points. ALL-CAPS for emphasis. Marketing cadence ("Now it is!", "Great news!").
- Editorial adjectives on results — **"substantial savings", "great plan", "huge difference"**.
  The numbers carry the weight; we state them and stop.
- Color as the only signal. Covered / not-covered / capped always pair **icon + word + color**.

**Always:** one accent (deep teal, actions only), calm neutrals, generous space, large type,
skeletons not spinners, motion ≤120ms on hover/focus only.

---

## 3. Copy rules (each with a real ruling from our history)

- **No overpromising — the first sentence never claims more than the tool does.**
  The tool shows *cost estimates from public CMS files*; it does not "audit," advise, or enroll.
  *Ruling:* "audit your parents' plan" was rewritten because we don't audit. Hero says "See what
  your medications really cost," not "Find the best plan."

- **Complete sentences for every number — never leave subtraction to the reader.**
  State what a figure *is*: *"Save about $120/year at this plan's mail-order pharmacy — bringing
  your total to about $180/yr."* The pair must visibly agree (anchor − savings = the "bringing to"
  total). Never show a bare delta and make her do the math.

- **No robot grammar, no bare `$0.00`.** Never "covers all 1 of these medications" — pluralize/branch.
  Whole dollars in totals, cents only in per-fill detail. **`site/format.js` (`PRFormat`) is the
  law** — the same rounding/wording feeds screen, sort, savings, and the printed Passport so they
  can't diverge.

- **Precise privacy claims only.** Say exactly what's true: the medication list *stays in the
  browser*; only anonymous drug codes are sent, and *"used only to run your search — never stored."*
  Don't round that up to a vaguer "nothing leaves your device" if a code does.

- **Plain-English pass (~8th-grade).** Every Medicare term gets a one-tap inline explainer + a
  fuller FAQ entry: prior authorization, step therapy, quantity limit, preferred pharmacy, tier,
  formulary, MA-PD/PDP, deductible, coinsurance, the coverage phases. Jargon with no explainer is a
  bug. (`[[planrobin-explain-jargon-principle]]`)

- **Honest states are designed, never silent.** NOT FOUND, not-on-formulary, no-plan-covers-all,
  zero-coverage — each has real words and a real layout. A plan that covers none of her drugs shows
  a **"Doesn't cover your medication" badge, not a `$0`**. A partial plan reads "$X · covers N of
  your M meds" and names the missing drug; it can never rank or advertise as comparable to a
  complete plan. (`[[project-planrobin-cost-breakdown]]`)

- **Trade-off honesty — numbers that need context get it.** Coinsurance is estimated from her
  quantity and labelled as such; a coinsurance drug with no published price stays *out* of the total
  rather than being faked to $0. We say which questions the tool **isn't** answering (it doesn't
  pick a plan, doesn't know her exact dose, doesn't include her pharmacy's own discounts).

- **Trust furniture at the point of use, never footer-only.** Privacy line *at* the medication
  input; non-affiliation near the hero; data-as-of provenance *with* the results it describes; the
  SHIP counselor link near results/help. (`site/DESIGN.md` §Trust furniture)

---

## 4. Known failure patterns (the personally-caught list — hunt for these)

These are real bugs we shipped and fixed; the floor suite now guards most, but review for them by
hand too because a mechanism can reappear in a new component:

1. **min-width content crush → one-word-per-line wrapping.** A flex/grid text child without
   `min-width: 0` gets crushed by fixed-width siblings (badge, select, button). Fix at the
   mechanism: `min-width: 0` + `overflow-wrap: anywhere` on the text; `minmax(0, …)` tracks.
   *(v=16 results rows; v=18 medication chip — the sibling audit had missed entry components.)*
2. **Pill radius ballooning on a wrapped chip.** `border-radius: 999px` turns a tall wrapped chip
   into a giant oval that overflows its card. Use a modest fixed radius (`--radius`) once content
   can wrap. *(v=18)*
3. **Right-aligned overflow overprinting left.** `grid-template-columns: 1fr auto` + `text-align:
   right` + a flex child lacking `min-width: 0` spills the right column *left*, over its neighbour.
   *(v=16)*
4. **Savings/number lines that require mental math.** A delta with no "bringing your total to …"
   sentence. *(results copy rider)*
5. **A dollar figure rendered for a meaningless case.** `$0` / a total shown for a plan that covers
   *none* of her drugs — must be the not-covered badge instead. *(zero-coverage rider)*
6. **A sibling audit that stops at the component you touched.** When you fix a wrapping/overlap
   mechanism, extend it to *every* component on the same pattern (rows, chips, suggestions,
   confirmation lines, table headers) — not just the one in the screenshot.

---

## 5. How the mechanical floors are calibrated (so review and suite agree)

The suite (`tests/ux/floors.js`) encodes these, matching `site/DESIGN.md`:
- **No overlap:** no two text boxes intersect (per-line rects; floating overlays like the
  autocomplete dropdown are exempt).
- **No horizontal overflow:** `scrollWidth == clientWidth` on every page; only deliberate scroll
  containers (`.detail-scroll`, with a visible affordance) are allow-listed.
- **Contrast:** axe-core `color-contrast` (WCAG AA) site-wide; body/reading text is AAA (≥7:1) by
  token choice.
- **Touch targets ≥44px:** enforced on **controls** (button, select, input, `[role=button]`).
  Navigational text links are exempt (keyboard-reachable, focus-ringed) — DESIGN.md's target list
  is control-oriented and WCAG exempts inline links.
- **Focus:** every rendered, enabled interactive element is keyboard-reachable and shows the 3px
  ring; the ring is never removed.
- **Type floor:** primary **reading prose ≥18px** (site floor is 19); **no text node below 14px**,
  legal lines included. Secondary/meta text may sit at 16px per the DESIGN.md type scale.

Matrix: every page + major state × {360px, 412px} × {default, 200% large-font}.

---

## Ruling log
- *2026-07-05* — Standard created from accumulated project rulings (memory + git history) alongside
  the automated UX floor suite. Touch-target rule scoped to controls (links exempt); body-floor
  scoped to primary reading prose (secondary text may be 16px) — both to match `site/DESIGN.md`.
