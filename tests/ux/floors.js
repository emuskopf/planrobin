'use strict';
// UX FLOOR CHECKERS — the mechanical, deterministic rules the whole site must pass at every
// viewport/font. Geometry + type + touch run IN THE PAGE (one evaluate call); contrast runs via
// axe-core; focus runs via keyboard traversal. Each returns plain violation objects the spec turns
// into a humane failure (page · state · rule · detail, with a screenshot attached).
//
// House rules encoded here trace to site/DESIGN.md and UX-REVIEW.md:
//   body prose >= 18px (DESIGN.md floor is 19); no text node < 14px; touch targets >= 44px;
//   AA contrast site-wide (body is AAA); visible focus on everything interactive.

// Selectors whose OWN overflow past the viewport is intentional — each must be a real scroll
// container with a visible affordance (documented in UX-REVIEW.md). Descendants are exempt too.
const OVERFLOW_EXEMPT = ['.detail-scroll'];

// TOUCH TARGETS: DESIGN.md's 44px rule is control-oriented ("buttons, select, chip remove,
// suggestion rows"). We enforce 44px on form CONTROLS + button-role elements; navigational text
// links (<a>) are exempt (keyboard-reachable, focus-ringed) per that list and WCAG's inline-link
// exception. Enforced selector below.
const TOUCH_SELECTOR = 'button, select, input:not([type=hidden]), textarea, [role=button]';

// Body/reading prose held to the 18px floor (the site uses 19px). Per DESIGN.md the type scale is
// body 19 / secondary-meta 16 / fine 14 — so SECONDARY text (.help-text, .hero-aside, privacy note,
// .small, plan-sub) is compliant at 16px and subject only to the 14px global floor. Primary reading
// prose is what must clear 18.
const BODY_COPY = ['.lede', '.sub', '.zip-ask', '.story-body p', '.faq-a p'];

// The single in-page audit (rules 1 NO-OVERLAP, 2 NO-H-OVERFLOW, 4 TOUCH, 6 TYPE). Self-contained
// (no outer references) so Playwright can serialize it into the page.
function inPageAudit(opts) {
  const { overflowExempt, bodyCopy } = opts;
  const V = { overlap: [], overflow: [], touch: [], type: [] };
  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const desc = (sel, el) => { try { return [...document.querySelectorAll(sel)].some((x) => x === el || x.contains(el)); } catch { return false; } };
  const label = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && el.className.baseVal !== undefined) ? '' : (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
  };

  // ---- Rule 2: no horizontal overflow ----
  const iw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > iw + 1) {
    V.overflow.push({ el: 'document', detail: `scrollWidth ${document.documentElement.scrollWidth} > clientWidth ${iw}` });
  }
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    if (overflowExempt.some((s) => desc(s, el))) continue;
    const r = el.getBoundingClientRect();
    if (r.right > iw + 1 && r.left >= 0 && r.width <= iw + 1) {
      // an element pushed partly off the right edge (not one that's just wider than the screen)
      V.overflow.push({ el: label(el), detail: `right edge ${Math.round(r.right)} > viewport ${iw}` });
    }
  }

  // ---- Rule 1: no two text-bearing boxes overlap ----
  // Text leaves = elements with a direct non-whitespace text node, visible, and NOT inside a
  // floating overlay (an autocomplete dropdown legitimately covers the content beneath it).
  // Compare PER-LINE client rects (not the bounding box) so an inline element wrapping across
  // lines doesn't phantom-overlap its neighbours — while real inline overprints are still caught.
  const floating = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'absolute' || pos === 'fixed') return true; } return false; };
  const leaves = [];
  for (const el of document.querySelectorAll('body *')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasText || !vis(el) || floating(el)) continue;
    const rects = [...el.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2);
    if (rects.length) leaves.push({ el, rects });
  }
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      let hit = null;
      for (const ra of a.rects) { for (const rb of b.rects) {
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox <= 2 || oy <= 2) continue;
        const frac = (ox * oy) / Math.min(ra.width * ra.height, rb.width * rb.height);
        if (frac > 0.25) { hit = { ox, oy, frac }; break; }
      } if (hit) break; }
      if (hit) V.overlap.push({ el: label(a.el), other: label(b.el), detail: `overlap ${Math.round(hit.ox)}x${Math.round(hit.oy)}px (${Math.round(100 * hit.frac)}% of smaller)` });
    }
  }

  // ---- Rule 4: touch targets >= 44px (form controls + button-role elements) ----
  for (const el of document.querySelectorAll('button, select, input:not([type=hidden]), textarea, [role=button]')) {
    if (!vis(el) || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) {
      V.touch.push({ el: label(el), detail: `${Math.round(r.width)}x${Math.round(r.height)}px (< 44)` });
    }
  }

  // ---- Rule 6: type floor (body prose >= 18px; no text node < 14px) ----
  const bodyEls = new Set();
  for (const sel of bodyCopy) { try { document.querySelectorAll(sel).forEach((e) => bodyEls.add(e)); } catch {} }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.textContent.trim().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const seen = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const p = node.parentElement;
    if (!p || !vis(p) || seen.has(p)) continue;
    seen.add(p);
    const fs = parseFloat(getComputedStyle(p).fontSize);
    if (fs < 13.5) V.type.push({ el: label(p), detail: `text ${fs}px (< 14 floor)` });
    else if (bodyEls.has(p) && fs < 17.5) V.type.push({ el: label(p), detail: `body prose ${fs}px (< 18 floor)` });
  }
  return V;
}

module.exports = { inPageAudit, OVERFLOW_EXEMPT, BODY_COPY, TOUCH_SELECTOR };
