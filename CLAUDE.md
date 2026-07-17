# PlanRobin — working instructions

PlanRobin is a free, non-commercial, **zero-LLM** Medicare Part D drug-cost checker (Missouri beta),
live at planrobin.com. Everything is deterministic: every figure traces to a public CMS PUF row (or
a documented statutory override); "NOT FOUND" is a valid, designed answer; nothing is invented.

**`docs/00-PRINCIPLES.md` is the constitution — it governs all.** Everything here is subordinate to it
and must read as an application of it (prime directive: the system never invents; it computes from
verifiable sources and narrates what it computed). It's deliberately hard to change — amendments need a
version bump, a written rationale, and a night's sleep. `CONTENT-RULES.md`, `UX-REVIEW.md`, and
`site/DESIGN.md` implement it in their domains.

Read `site/DESIGN.md` (design foundation), `UX-REVIEW.md` (UX judgment standard), and
`CONTENT-RULES.md` (editorial law for all user-facing prose) before touching anything user-facing.

## Standing hooks — REQUIRED

All three run *before* the "done" claim, with the findings listed in the session report. None is
optional. Hooks 1–2 read the session's own diff; hook 3 drives the actual product.

1. **UI / user-facing copy → `UX-REVIEW.md`.** Every session that touches UI or user-facing copy
   self-reviews its diff against `UX-REVIEW.md` (UX judgment) at 360px + large font, reporting either
   "UX review: pass" or an itemized list.
2. **Any session that produces prose → `CONTENT-RULES.md`.** Every session that writes prose (content,
   articles, FAQ entries, the booklet, email copy, and UI microcopy where it overlaps `UX-REVIEW.md`)
   self-reviews against `CONTENT-RULES.md` (editorial law), with **the PlanRobin Test — is it true?
   useful? understandable? calmer than the alternatives? — as the stated preflight** before that
   review; report the findings. A **NEVER** rule cannot ship; a **PREFER** rule flags for Evan
   (proceed if judged fine).
3. **Every new user-facing surface → one real-data browser pass, before preview is offered for hand
   test.** Drive the surface in a browser against the **live DB**, with **real drugs**, including **at
   least one mixed-coverage case** (a drug the plan covers *and* one it doesn't). Report what you
   drove and what it showed — green suites are not a substitute, and neither is a screenshot of the
   happy path.

   > **Hermetic fixtures encode our intent; real data has shapes we didn't intend.**

   Incident (Jul 2026, the checkup): the `h3` nesting bug and the lying "Good news" verdict — **both
   invisible to 132 green floors**, both caught in the first real-data pass. No fixture had a covered
   drug *and* a gap on the same report, because nobody thought to write one; live St. Louis County
   produces that shape constantly (all 82 plans cover duloxetine 60 MG, none cover brand Toprol).
   When real data exposes a shape the fixtures lack, **add the fixture** — the pass finds it once, the
   fixture keeps it found.

Two layers back these up:
1. **Mechanical floors — the UX floor suite** (`tests/ux/`, Playwright): no-overlap, no-horizontal-
   overflow, AA contrast, ≥44px touch targets, visible focus, and the type floor, across every page
   and major state × {360, 412}px × {default, 200% large-font}. It gates every deploy alongside
   `npm test`. Run it with `npm run test:ux`. If you add a page or a major UI state, add it to
   `tests/ux/ux-floor.spec.js`; if you change the API shape, rebuild fixtures with
   `node tests/ux/build-fixtures.js` (dev server running). **Hermetic by design** (canned APIs — that's
   what makes it fast, deterministic and deploy-gating), and therefore blind to any data shape the
   fixtures don't have. That blindness is hook 3's job, not a gap to fix here.
2. **Judgment — `UX-REVIEW.md` + `CONTENT-RULES.md`**: persona, brand (calm/sturdy/unhurried), copy
   rules, editorial law, and the known-failure-pattern list. The suite can't catch overpromising copy,
   mental-math number lines, or a `$0` shown for a meaningless case — the self-review must. **Both are
   living documents — append-only, dated, incident-linked. Evan edits them directly; treat his edits
   as canon; never silently rewrite them.**

## Deploy / gates
- `npm test` — deterministic node suite (format, share, overrides, channels, pricing, zip) + the
  **M0 acceptance** (DB path reproduces Milestone 0 exactly, $30.00 byte-for-byte). Never let M0 drift.
- `npm run test:ux` — the UX floor suite (above).
- Push to `main` → `.github/workflows/deploy.yml` gates on both of the above + a live-Supabase smoke
  before `wrangler pages deploy`. A DB schema/data change must be applied to Supabase first (via the
  `ingest` workflow, which runs `AUTO_MIGRATE=1`) before the code that needs it goes live.
- Bump the `?v=N` asset query on `index.html`/`faq.html`/`story.html`/`checkup.html` when shipping
  CSS/JS — every page that loads them, or one door serves stale code.
- **Preview aliases lag.** After `wrangler pages deploy --branch=X`, `X.planrobin.pages.dev` can serve
  the *previous* deployment for a minute or two while the unique `<hash>.planrobin.pages.dev` is
  already correct. It presents as a phantom bug (old `?v=N` script tags, "…is not a function"). During
  a real-data pass (hook 3), **assert the build before believing any finding**: confirm the page's
  `script[src]` tags carry the version you just shipped, or curl the unique URL.

## House rules that never bend
- No LLM anywhere in the product path. No invented numbers. Coinsurance without a published price
  stays *out* of a total, never faked to $0. Whole dollars in totals, cents in per-fill detail —
  `site/format.js` (`PRFormat`) is the single source and feeds screen + sort + Passport alike.
- Explain every Medicare term inline (one-tap) + in the FAQ; ~8th-grade reading level.
- Trust furniture at the point of use, not the footer. Semantic state = icon + word + color.
- Run prompts end-to-end autonomously; pause only for secrets, dashboard-only steps, or genuinely
  irreversible/outward-facing actions — and, per an explicit request, to report a user-visible fix
  before shipping it.
