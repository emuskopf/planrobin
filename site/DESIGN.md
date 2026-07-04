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

## Tokens (see `:root` in styles.css)

### Type scale
Body is large by default and everything is in `rem`, so it scales with the browser's font
setting and with zoom. System font stack — the OS's most-legible face — so **no third-party
font CDN** (privacy) and instant load. (A self-hosted *Atkinson Hyperlegible* is a documented
future option if we want a more distinctive, low-vision-first face; deferred to avoid a binary
dependency this session.)

| token | rem | px @16 | use |
|---|---|---|---|
| `--fs-fine` | 0.875 | 14 | fine print, sparingly (never body) |
| `--fs-sm` | 1.0 | 16 | secondary/meta |
| `--fs-base` | **1.1875** | **19** | body (floor is 19px) |
| `--fs-md` | 1.375 | 22 | lead paragraph, sub-headings |
| `--fs-lg` | 1.75 | 28 | section headings (h2) |
| `--fs-xl` | 2.25 | 36 | page/hero heading (h1) |
| `--fs-num` | 2.0 | 32 | the big annual-cost number |

Line height: `--lh` 1.6 (body), `--lh-tight` 1.25 (headings, numbers). Font stack:
`system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.

### Color — calm, high-contrast (WCAG-checked)
Contrast ratios computed against the surface each color is used on. **Body text meets AAA
(≥7:1); all text meets at least AA (≥4.5:1).**

| token | hex | on | ratio | grade |
|---|---|---|---|---|
| `--bg` (warm paper) | #f5f3ee | — | — | page background |
| `--surface` (card) | #ffffff | — | — | — |
| `--ink` (body text) | #1c2733 | #fff | **14.8:1** | AAA |
| `--ink` on paper | #1c2733 | #f5f3ee | **13.3:1** | AAA |
| `--ink-2` (secondary) | #495563 | #fff | **7.6:1** | AAA |
| `--ink-3` (muted, ≥16px only) | #5c6773 | #fff | **6.0:1** | AA |
| `--accent` (actions) | #0f5f76 | — | — | deep teal |
| white text on `--accent` | #ffffff | #0f5f76 | **7.2:1** | AAA |
| `--good` (covered) | #146c3a | #fff | **5.3:1** | AA |
| `--caution` (incomplete/deductible) | #8a5a00 | #fff | **5.2:1** | AA |
| `--notcov` (not covered) | #9a3b2f | #fff | **6.4:1** | AA |
| `--focus` (focus ring) | #1558d6 | — | — | high-contrast ring |

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
