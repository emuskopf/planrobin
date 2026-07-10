# CONTENT-RULES.md — PlanRobin Editorial Law (v2)

*Merged v2: Evan's revision (Jul 2026) reorganized into tiered rules with
incidents and rationale. Reader of this doc: whoever — human or Claude —
decides whether a draft passes. **NEVER** = cannot ship. **PREFER** = flag
for Evan, proceed if judged fine.*

*Living document — append-only, dated, incident-linked. Evan's edits are canon; never silently rewrite them.*

## Purpose

This document exists to protect the reader. Search rankings, CMS data,
and product features will change. The reader's need for clear, honest,
calm guidance does not.

## Philosophy & maintenance

Rules earn entry by incident, not hypothesis. Short enough to be feared:
past ~30 rules, consolidate. Append-only, dated, incident-linked; when a
rule fails in spirit but not letter, sharpen the rule — don't add a twin.
Scope questions ("should we build/write this at all?") go to the
roadmap's FILTER; this document governs how things read, not whether
they ship.

## Our lane

PlanRobin helps people make better Medicare **prescription cost**
decisions: drug costs, formularies, preferred pharmacies, mail order,
coverage phases, and the plan context needed to understand them — not
every Medicare topic. Focus is a feature. Content outside the lane
exists only to hand off honestly (the two-roads explainer ends at SHIP,
not at a Medigap comparison we don't do).

## Who we write for

A stressed 52-year-old on her phone at her mom's kitchen table — and the
70-year-old parent, reading glasses off, on a fixed income, trained by
twenty years of predatory marketing to treat hype and urgency as danger.
She visits because she's worried, not because she enjoys Medicare; every
piece's job is to leave her less uncertain than it found her. Tie-breaker
when rules are silent: *would this make her trust us more, or reach to
close the tab?*

## The PlanRobin Test (preflight — every piece, before review)

1. Is it true? (Every claim traceable.)
2. Is it useful? (Answers a real question; solves a problem even if the
   reader never uses PlanRobin.)
3. Is it understandable? (The persona, reading glasses off.)
4. Is it calmer than the alternatives? (If our page raises the reader's
   pulse relative to Medicare.gov's, rewrite.)

---

## The rules

### Honesty of claims

1. **NEVER overpromise.** The first sentence never claims more than the
   thing delivers. *(Incident: "audit your parents' plan" hero,
   retired.)* Why: the audience's trust breaks on the first gap between
   promise and product, and it doesn't reset.
2. **NEVER use insurance-marketing language or manufactured urgency.**
   No "coverage," "act now," countdown pressure, "licensed agents
   standing by." *(Incident: "Low Cost Medicare Coverage" placeholder,
   killed on sight.)* Why: it's the dialect of the mailers in her trash;
   speaking it files us with them instantly.
3. **NEVER manufacture anxiety. Calm beats urgency.** The October
   plans-change fact is legitimate and load-bearing; the register is
   calendar, not alarm. *(Incident: "(sometimes drastically)" edited out
   of the capture bridge.)* Why: fear-based conversion is the business
   model we exist to invert.
4. **NEVER make privacy claims that cannot be technically defended.**
   "Used only to run your search — never stored, never shared, never
   sold" survives a network tab; "stays on your device" did not.
   *(Incidents: About rewrite; the mockup regression caught pre-build.)*
   Why: precision-of-privacy is the single claim a journalist will test.
5. **NEVER publish a data claim without scope AND a reproducible
   source.** State + plan year/quarter, query stored with the prose,
   re-run each ingest, failures flag for human review — never auto-edit.
   Decay tiers: evergreen (law) / annual (plan-year figures, handbook
   citations) / quarterly (premiums, savings stats). Every article
   carries "Verified against CMS [quarter] data." *(From the 90-day
   forensics discipline.)* Why: stale Medicare content is the industry
   norm; provably-current is a differentiator no mill can copy.
6. **NEVER invent, estimate, or round a number into being.** Figures
   trace to a row, a statute (cited), or an official publication
   (edition + page). "The data doesn't show this" is publishable.
7. **PREFER stating what we don't answer.** Price is our lane and we say
   so — doctors/networks, medical-side costs, MOOP named as unanswered,
   each pointing at its resource. **Admit the limits of our expertise**
   the same way: we do math; we are not counselors, lawyers, or doctors.
   *(Incident: the pre-switch checklist; the MA-PD premium qualifier.)*

### Numbers in prose

8. **NEVER leave arithmetic to the reader.** State the end result:
   "— bringing your total to about $155/yr." *(Incident: the savings
   line Evan himself had to subtract.)*
9. **NEVER use editorial adjectives on numbers.** $200 says substantial
   better than "substantial" does.
10. **Whole dollars in totals and summary lines; cents only where exact
    (per-fill detail).** $0 gets plain speech — no "about," no ".00."
11. **PREFER numbers with their context attached** — what the total
    can't see ("its deductible is $500 higher, which matters if you're
    prescribed something new"). Anchor always-true prices in time
    ("$0 all year"). *(Incidents: trade-off framing; the ambiguous
    mail-order $0 sentence, Jul 2026.)*

### Plain English

12. **Use the official term, then teach it.** Where accuracy requires
    CMS terminology (prior authorization, formulary, ANOC), use the real
    word — she'll meet it on her plan's paperwork — and explain it on
    contact (one-tap or one-line). Never jargon unexplained; never
    dumbed-down synonyms that leave her unable to recognize the term in
    the wild. Target ~8th-grade reading level around the terms.
    *(Reconciles the plain-English and CMS-accuracy rules; incident: the
    glossary + explainer pattern.)*
13. **NEVER robot grammar.** "Covers all 1 of these" ships nowhere;
    write count-aware variants. *(Incident: no-complete-plans note.)*
14. **PREFER teaching by pointing, not assuming.** Describe the physical
    action and what the person will see happen; state "no special app
    needed" when the audience remembers needing one. *(Incident: the QR
    instruction rewrite.)*
15. **PREFER framing change as small, reversible, and losing nothing.**
    "Split, not switch"; "your pharmacist stays yours"; "change back
    anytime." Older readers have been burned by changes sold as small;
    be the first change that's exactly as small as promised.
    *(Incident: the mail-order passage, Jul 2026.)*

### Structure & recommendations

16. **Every recommendation explains itself: why this, and what to do
    next.** A recommendation without its reason and its action is
    incomplete. *(Incident: the wedge action plan — each action carries
    its dollars and its script.)*
17. **NEVER leave a dead end.** Every error, empty, warning, or
    unsupported state answers "what should I do next" with a concrete
    action. *(Incidents: NOT FOUND states; the rural pharmacy
    fallback.)*
18. **NEVER ask for input that doesn't change the answer.** Decision
    friction is a bug. *(Incidents: no name field on capture; the
    skippable router.)*
19. **Emphasis is a budget** — one emphasized word/phrase per screen or
    section, italic preferred, differentiating facts only; never
    ALL-CAPS, highlight, or color-alone. Fix visibility with position,
    not decoration.
20. **PREFER the finding as the story** (syndication/press): PlanRobin
    is the cited source, never the advertorial CTA. Constructed examples
    labeled honestly ("a typical medication list on a real local plan"),
    never implying a real patient.
21. **Build habits, not engagement.** Content optimizes for the reader
    finishing informed and leaving — the September return, the printed
    page, the bookmark — never for time-on-site, streaks, or
    click-bait structures. Mission metrics outrank vanity metrics.

### Safety-adjacent content

22. **NEVER soften the two-roads facts.** Auto-disenrollment stated
    plainly, rare exceptions honestly, Medigap underwriting mentioned on
    the road back; mechanics verified against current CMS pubs at
    writing time.
23. **NEVER give deadline or enrollment-window advice from memory.**
    Verified against the current edition of official pubs, edition
    cited. Stale deadline advice does real harm.
24. **Decision-oriented content ends with the human handoff.** SHIP
    (free, unbiased, named), 1-800-MEDICARE, Medicare.gov — framed as a
    feature. Decisions belong to people.
25. **NEVER imply government affiliation**; our lines are "educational,
    not advice" and "a private website not affiliated with the federal
    Medicare program." Don't borrow TPMO disclaimer language describing
    what we deliberately aren't. (And: the official site ends in .gov,
    not .com — worth teaching, given medicare.com is a lead-gen site.)

### Sourcing & accountability

26. **Official sources linked, not self-hosted.** Handbook citations by
    edition + page. Brief quotes at most from non-government sources;
    prefer paraphrase with attribution.
27. **Every substantial piece has a clearly accountable human editor**,
    and data-derived articles publish under the founder's byline once
    the founder story ships. Nothing publishes anonymously into YMYL
    space — and nothing auto-publishes, ever.

---

## Appendix — The Promise (public copy; destination: the About page)

*Reader-facing covenant, not an internal rule. Ship it where readers
are:*

> We promise to explain before we persuade. We promise to admit what we
> don't know. We promise to stay in our lane. We promise to protect your
> privacy. We promise to show our work. We promise to value trust more
> than growth. And if we ever fall short, we will fix it — and say so.

*Drafted Jul 2026, merged from Evan's v1.0 revision. Evan's edits are
canon.*
