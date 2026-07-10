# PlanRobin — working instructions

PlanRobin is a free, non-commercial, **zero-LLM** Medicare Part D drug-cost checker (Missouri beta),
live at planrobin.com. Everything is deterministic: every figure traces to a public CMS PUF row (or
a documented statutory override); "NOT FOUND" is a valid, designed answer; nothing is invented.

Read `site/DESIGN.md` (design foundation), `UX-REVIEW.md` (UX judgment standard), and
`CONTENT-RULES.md` (editorial law for all user-facing prose) before touching anything user-facing.

## Standing self-review hooks — REQUIRED

Both hooks run a self-review of the session's own diff *before* the "done" claim, with the findings
listed in the session report. Neither is optional.

1. **UI / user-facing copy → `UX-REVIEW.md`.** Every session that touches UI or user-facing copy
   self-reviews its diff against `UX-REVIEW.md` (UX judgment) at 360px + large font, reporting either
   "UX review: pass" or an itemized list.
2. **Any session that produces prose → `CONTENT-RULES.md`.** Every session that writes prose (content,
   articles, FAQ entries, the booklet, email copy, and UI microcopy where it overlaps `UX-REVIEW.md`)
   self-reviews against `CONTENT-RULES.md` (editorial law), with **the PlanRobin Test — is it true?
   useful? understandable? calmer than the alternatives? — as the stated preflight** before that
   review; report the findings. A **NEVER** rule cannot ship; a **PREFER** rule flags for Evan
   (proceed if judged fine).

Two layers back these up:
1. **Mechanical floors — the UX floor suite** (`tests/ux/`, Playwright): no-overlap, no-horizontal-
   overflow, AA contrast, ≥44px touch targets, visible focus, and the type floor, across every page
   and major state × {360, 412}px × {default, 200% large-font}. It gates every deploy alongside
   `npm test`. Run it with `npm run test:ux`. If you add a page or a major UI state, add it to
   `tests/ux/ux-floor.spec.js`; if you change the API shape, rebuild fixtures with
   `node tests/ux/build-fixtures.js` (dev server running).
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
- Bump the `?v=N` asset query on `index.html`/`faq.html`/`story.html` when shipping CSS/JS.

## House rules that never bend
- No LLM anywhere in the product path. No invented numbers. Coinsurance without a published price
  stays *out* of a total, never faked to $0. Whole dollars in totals, cents in per-fill detail —
  `site/format.js` (`PRFormat`) is the single source and feeds screen + sort + Passport alike.
- Explain every Medicare term inline (one-tap) + in the FAQ; ~8th-grade reading level.
- Trust furniture at the point of use, not the footer. Semantic state = icon + word + color.
- Run prompts end-to-end autonomously; pause only for secrets, dashboard-only steps, or genuinely
  irreversible/outward-facing actions — and, per an explicit request, to report a user-visible fix
  before shipping it.
