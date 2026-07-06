# PlanRobin — Design Foundation

The design serves one person: **a stressed 52-year-old on her phone at her mom's kitchen
table**, helping an anxious parent, wary because most Medicare sites are predatory. Secondary
user: the **70-year-old parent**, reading glasses off.

## Brand adjectives — every choice serves these
**CALM · STURDY · UNHURRIED.** The deliberate opposite of Medicare marketing: no countdown
urgency, no red alarm badges, no exclamation points, no stock photos, nothing that flashes,
slides, or nags. *A credit union built by a public library — not an insurance startup.*

Practical rules that fall out of this:
- One accent color, used only for actions. Everything else is calm neutrals.
- Warnings are amber/clay, never alarm-red. "Not covered" is unmissable but not frightening.
- Motion is minimal and never auto-plays. No spinners that spin forever — use skeletons.
- Large type, generous space, high contrast. Assume glasses are off.

---

## The mark — logo law

**The robin.** A hand-painted robin, perched, facing left, warm orange breast. It stands for a
watchful helper that shows up, tells the truth, and asks nothing in return. Two forms ship:

- **Primary horizontal lockup** — robin + the wordmark **PlanRobin** to its right. Site header, PDF.
- **One-color mark** — a solid-ink robin silhouette (paper shows through the eye). For grayscale,
  print, photocopy, and fax: the passport page-1 header and anywhere a single ink is safest.
- **Favicon variant** — a *derived* flat two-tone robin (dark body + orange breast, no branch, no
  circle). The painterly illustration turns to mud below ~32px, so the favicon is intentionally a
  simplified silhouette, not a shrink of the photo. Renders legibly at 16px.

**The wordmark** is **live text**, never an image: Source Serif 4 Semibold, "**Plan**" in Navy and
"**Robin**" in Orange. Live text stays crisp at every size and zoom, is selectable, and re-colors
with the palette. Because "Robin" is Orange on Cream (3.86:1) it is only compliant as **large text**
(≥24px ⇒ 3:1) — so the wordmark is never rendered below 24px.

**Usage rules (do / don't):**
- **Minimum size** — horizontal lockup: robin ≥ 28px tall (wordmark ≥ 24px). One-color mark ≥ 20px.
  Favicon: use the dedicated 16/32 renders, never the illustration.
- **Clear space** — keep at least the robin's head-height of empty space around the whole lockup.
- **One-color / print** — use the solid-ink silhouette, not a grayscale of the color painting.
- **Never** stretch, squash, rotate, recolor the robin, add drop-shadows/gradients/glows/outlines,
  put the mark on a busy photo, or box it in. The wordmark is only ever Navy+Orange (or all-ink for
  one-color). Don't re-typeset the wordmark in another face.
- **Links home** — the header lockup is always a link to `/`, labelled "PlanRobin — home".

**Tagline** — "Clear answers. Nothing to sell." Shown in the header lockup only where it's legible
(desktop); dropped on narrow screens. *Provisionally final* — kept as its own text node so a swap is
a one-line change.

**File locations:**
- `site/img/robin.png` — the painterly header robin (transparent, ~229×234), from `brand/exports/`.
- `site/icons/` — `favicon.ico` (16+32), `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`
  (180), `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`; wired via `site.webmanifest`.
- `site/fonts/source-serif-4-latin.woff2` — the self-hosted serif.
- The one-color robin is inline SVG (`ROBIN_1C_SVG` in `app.js`) for the passport DOM and drawn as
  vector shapes in the PDF (`drawRobin`), so it needs no external asset and survives photocopying.
- `brand/` — the source brand board and exports (see the brand audit note below).

**Brand audit (rollout note).** The supplied brand ZIP was a set of *raster concept boards*, not a
buildable vector/font/favicon asset kit — the "files provided" list on the board (SVG/AI/PNG) was not
in the package. Per the rollout's stop-and-flag rule this was reported before any tracing. The chosen
path: use the real painted robin (cleanly extracted from the approved board) as a raster + a
**live-text** wordmark (so the name stays crisp and re-colorable), and *derive* the flat favicon
silhouette since the illustration is mud at 16px. No mark was invented from a mockup.

---

## Tokens (see `:root` in styles.css)

### Type scale
Body is large by default and everything is in `rem`, so it scales with the browser's font
setting and with zoom. Two families, **both never loaded from a CDN**:
- **Body & UI — system stack** (`--font`): the OS's most-legible face, zero-latency, private.
- **Headings & the wordmark — Source Serif 4** (`--font-serif`), SIL OFL, **self-hosted** as a
  latin-subset variable `woff2` (`site/fonts/source-serif-4-latin.woff2`, ~50 KB, one file covers
  the 400–700 weight axis). Serif is used *only* for `h1–h4` and the brand wordmark — a warm,
  library-ish voice on the loud parts — while body copy keeps the legible sans. `font-display: swap`
  + a `<link rel="preload">` so a slow font never blocks or reflows the reading experience.

| token | rem | px @16 | use |
|---|---|---|---|
| `--fs-fine` | 0.875 | 14 | fine print, sparingly (never body) |
| `--fs-sm` | 1.0 | 16 | secondary/meta |
| `--fs-base` | **1.1875** | **19** | body (floor is 19px) |
| `--fs-md` | 1.375 | 22 | lead paragraph, sub-headings |
| `--fs-lg` | 1.75 | 28 | section headings (h2) |
| `--fs-xl` | 2.25 | 36 | page/hero heading (h1) |
| `--fs-num` | 2.0 | 32 | the big annual-cost number |

Line height: `--lh` 1.6 (body), `--lh-tight` 1.25 (headings, numbers). Body stack:
`system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. Serif stack:
`"Source Serif 4", Georgia, "Times New Roman", serif`.

### Color — the brand palette (WCAG-checked)
The six-color brand palette is the law; UI chrome maps onto it and status colors are a functional
traffic-light layer nudged toward brand where it stays legible. Ratios computed against the surface
each color is used on. **Body text meets AAA (≥7:1); all text meets at least AA (≥4.5:1); Orange is
decorative / large-text only.**

| token | hex | on | ratio | grade / use |
|---|---|---|---|---|
| `--brand-navy` / `--accent` (actions, links, focus) | **#1F3A56** | #fff | **11.7:1** | AAA |
| white text on Navy (buttons, step) | #ffffff | #1F3A56 | **11.7:1** | AAA |
| `--brand-orange` (wordmark "Robin", decorative) | **#C85A2B** | #F7F4EC | **3.86:1** | **large/decorative only** (≥24px ⇒ 3:1) |
| `--brand-forest` / `--good` (covered) | **#39573A** | #fff | **8.1:1** | AAA |
| white text on Forest (covered badge) | #ffffff | #39573A | **8.1:1** | AAA |
| `--brand-sage` (soft fills, dividers) | **#A4B28C** | — | — | tint/decorative only |
| `--brand-warm-gray` | **#756C5C** | #fff | **5.2:1** | AA (text ok) |
| `--brand-cream` / `--bg` (page) | **#F7F4EC** | — | — | page background |
| `--surface` (card) | #ffffff | — | — | — |
| `--ink` (body text) | #1c2733 | #F7F4EC | **13.8:1** | AAA |
| `--ink-2` (secondary) | #495563 | #fff | **7.6:1** | AAA |
| `--ink-3` (muted, ≥16px only) | #5c6773 | #fff | **6.0:1** | AA |
| `--caution` (incomplete/deductible) | #8a5a00 | #fff | **5.9:1** | AA (functional amber — no brand equiv.) |
| `--notcov` (not covered) | #9a3b2f | #fff | **6.9:1** | AA (brand-orange family, darkened for small text) |

**Token reconciliation (this brand rollout).** Existing tokens were mapped to the nearest brand color:
- `--accent` deep **teal #0f5f76 → Navy #1F3A56** (also `--focus`, buttons, step badges) — contrast *rose* 7.2→11.7.
- `--bg` warm paper **#f5f3ee → Cream #F7F4EC**.
- `--good` green **#146c3a → Forest #39573A** — 5.3→8.1.
- Added `--brand-orange #C85A2B`, `--brand-sage #A4B28C`, `--brand-warm-gray #756C5C` tokens.
- **Kept** `--caution #8a5a00` (no brand equivalent for a warm warning; stays AA) and `--notcov #9a3b2f`
  (the brand-orange *family*, darkened so it's AA as small "Not covered" text — pure `#C85A2B` is only 3.86:1).

Semantic states **never rely on color alone** — covered/not-covered/capped always pair the
color with an icon (✓ / ✕ / ⚖) and a word.

### Spacing (4px base)
`--sp-1:4 · --sp-2:8 · --sp-3:12 · --sp-4:16 · --sp-5:24 · --sp-6:32 · --sp-7:48 · --sp-8:64` (px).
Layout leans on the larger steps — space is how "unhurried" is expressed.

### Radii & elevation
`--radius-sm:6 · --radius:10 · --radius-lg:14`. Elevation is restrained (sturdy, not floaty):
`--shadow` = a 1px hairline border plus a very soft shadow; cards do not lift or animate.

### Interaction
- **Touch targets ≥ 44px** (`--tap: 44px`) — buttons, select, chip remove, suggestion rows.
- **Visible focus on everything interactive**: `outline: 3px solid var(--focus); outline-offset: 2px`.
  Never removed.
- Transitions are ≤ 120ms and only on hover/focus color — nothing moves on load.

---

## Trust furniture = features, not footer fine print
Placed at the point of use, not buried:
- **Privacy sits AT the medication input**: "Your medication list never leaves this device."
- **Non-affiliation** ("a private website, not affiliated with the federal Medicare program")
  appears near the hero and in the footer.
- **"Free. No accounts. We don't sell anything — or anyone."** is a visible trust line, not a tagline.
- **Data provenance** ("Data: CMS [quarter], loaded [date]") sits with the results it describes.
- **SHIP counselor link** (free, unbiased Medicare help) offered near the results and help areas.

## Accessibility floors (tested each session)
200% browser zoom breaks nothing · fully keyboard-navigable incl. the autocomplete (arrows /
Enter / Esc) · works one-handed on a small phone · **prints sanely** — the results page is the
proto "Plan Passport," so `@media print` gives a clean, ink-frugal handout.
