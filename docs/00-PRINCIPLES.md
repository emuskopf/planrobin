# 00 — PRINCIPLES.md

*The constitution. Everything else in this repository — strategy,
product, prose, design, data, AI conduct — is subordinate to this page
and must be readable as an application of it. This document contains
only what survives every pivot.*

**Change friction, by design:** amendments require a version bump, a
written rationale in the change log below, and a night's sleep between
proposal and commit. If an amendment is urgent, that urgency is itself
a reason to wait. Every other document in /docs may be edited freely;
this one is supposed to be hard to change.

---

## The mission

PlanRobin exists because public Medicare data should be understandable
by the people it was created to serve. We build public infrastructure,
not marketing funnels.

It began at one kitchen table: a mother, a stack of plan papers, and a
question nobody would answer straight. Every principle below is that
table, generalized.

## Who we serve first

The existing enrollee — the 72-year-old on a fixed income with the
most medications, the highest stakes, and zero marketing attention —
and the caregiver helping her. She is neglected by the industry's
economic design, which makes serving her both the mission and the
moat. We cannot be everything to everyone, and we don't try.

## The prime directive

**The system never invents. It computes from verifiable sources and
narrates what it computed.** Every number traces to a row, a statute
(cited), or an official publication (edition and page). "The data
doesn't show this" is a valid, publishable, shippable answer. Where a
model is used, it narrates and explains; it never computes a figure,
never decides a route, and never answers from memory what should be
answered from a source.

## The Never List

These are not policies. They are identity. Violating one does not
change the company — it ends it and starts a different one.

1. **Never sell leads.** A lead sale is selling the user's information
   to people who will call them.
2. **Never sell, share, or monetize user data** — the email list,
   medication data, behavior — anonymized or otherwise.
3. **Never take carrier money** in any form that touches what the
   consumer product shows.
4. **Never sell placement.** Directory listings, rankings, and badges
   are merit-based, forever.
5. **Never charge consumers for understanding their own Medicare
   information.** The core help is always free — public data about a
   person's own coverage is never gated back to them for money.
6. **Never license access to consumers.** We may license software and
   data to people who serve consumers; the consumers themselves are
   not inventory.

## The Filter

Nothing ships without a filter. The current filter is strategy and
lives in 01-BLUEPRINT (today: makes strangers trust us, makes agents
pay us, or grows the list); it changes when the strategy changes. The
constitutional requirement is only this: **the filter must always be
concrete enough that good ideas can fail it.** A filter every clever
idea passes is a blessing, not a filter. Focus is a feature.

## Sustainable mission

Revenue exists to expand the mission, never to redirect it. When
evaluating any business model, we ask one question first: **would the
person at the kitchen table receive the same recommendation if this
revenue did not exist?** If the answer is no, the model fails. The
purpose of revenue is to help the next person, not to change how we
help this one.

## The trust mechanics

- **Trust is structural, not behavioral.** The moat is not that we
  don't exploit users — it's that we have arranged the business so we
  *can't benefit* from exploiting them. Protect the arrangement, not
  just the conduct.
- **Honesty is enforced by architecture.** Promises live in code:
  shared definitions, regression tests, floor suites, claims that
  re-verify themselves. A promise that exists only in prose is a
  promise waiting to drift.
- **We say what we don't answer.** Every tool names its blind spots
  and points each one at the resource that covers it. The handoff to
  free human help (SHIP first or equal, always, under every future
  variant of this company) is a feature, never fine print.
- **Calm beats urgency.** We never manufacture anxiety, deadline
  pressure, or engagement. The reader should leave less worried than
  she arrived. Anything rushing her is selling her.
- **Complexity belongs in our tools, not in the user's experience.**
  The engine holds the statutes, phases, crosswalks, and edge cases;
  she gets a sentence. If a screen is hard to understand, the
  complexity leaked — move it back inside.
- **Small, reversible, losing nothing.** Every change we recommend to
  a user is framed — and designed — to be exactly as small as
  promised. She has been burned by "small" changes before; we are the
  first one that isn't.

## The operating character

- **Prove it first.** Validate against reality before building on it —
  data before code, users before features, evidence before gates.
  Decisions are made on calendars and evidence, not morale.
- **Fix the mechanism, tighten the net.** Bugs are fixed at the class
  level; every escape upgrades the detection that missed it. This
  applies to code, copy, and process equally.
- **Decisions leave receipts.** Forks, rejections, and reversals are
  written down with their reasoning, so future judgment inherits past
  judgment instead of re-litigating it.
- **Lean survives.** Near-zero burn, self-refreshing systems, loud
  failures. The existential risk of a solo project is not money but
  momentum; build the thing that is still alive after a quiet month.
- **Build for acquirability, never for acquisition.** Revenue first;
  optionality as a byproduct of hygiene, not a strategy.

## The definition of success

A tool that lives forever on almost nothing, that people use to save
real money on the plan they already have, that tells them the truth
about the rest — and that a stranger would describe, unprompted, as
being on their side. Revenue, if and when it comes, is built adjacent
to that trust, never on top of it. If everything else fails and this
paragraph still holds, the project succeeded.

## The promise (public form)

We promise to explain before we persuade. We promise to admit what we
don't know. We promise to stay in our lane. We promise to protect your
privacy. We promise to show our work. We promise to value trust more
than growth. And if we ever fall short, we will fix it — and say so.

---

## Precedence

00 governs all. 01-BLUEPRINT (strategy) plans within it. 02-PRODUCT-LAW,
03-EDITORIAL-LAW, 04-DESIGN-SYSTEM, 05-DATA-STANDARDS, and
06-AI-STANDARDS implement it in their domains. Where documents
conflict, the lower number wins; where this document is silent, the
domain documents rule; where everything is silent, ask what the woman
at the kitchen table would need — and write down the answer.

## Change log

- v1.0 — Jul 2026. Extracted from the living roadmap (Sections 2, 3,
  9), the Never List, THE FILTER, and the governance documents, at the
  founding of the /docs hierarchy. Evan's edits are canon.
- v1.1 — Jul 2026. Pre-ratification amendments (Evan): mission restated
  as thesis + origin ("public data should be understandable by the
  people it was created to serve"); "public infrastructure, not
  marketing funnels" added; Never List rule 5 sharpened ("never charge
  consumers for understanding their own Medicare information"); Filter
  section reframed constitutionally (concrete filter lives in
  01-BLUEPRINT; constitutional floor: it must be concrete enough that
  good ideas can fail it); "complexity belongs in our tools" added to
  trust mechanics; definition-of-success section merged; Sustainable
  Mission section added (the kitchen-table revenue test — generalizes
  the roadmap Section 3 rule, which becomes a pointer here at
  restructuring). Rationale: founder's editorial pass at founding —
  softer-filter proposal declined to preserve teeth.
