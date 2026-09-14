// Palette styles, as a string so they can be adopted into a closed shadow root
// via CSSStyleSheet — which a strict page CSP cannot block, unlike a <style>.
//
// Tokens mirror popup.css so the palette and the popup are visibly one product.
// Unlike popup.css (dark only), the palette follows prefers-color-scheme: it
// overlays page content in daylight too, so it needs a real light theme.
globalThis.TABITHA_PALETTE_CSS = `
/* Light is the base: the COMPLETE palette lives on bare :host, so no colour has
   its only definition inside a media query. Dark redefines the same tokens
   twice — once for the system preference (unless the user pinned light), once
   for an explicit dark override — so a pinned choice wins in both directions.
   prefers-color-scheme here reflects the browser setting, not the host page's. */
:host {
  --scrim: rgba(20, 20, 24, .18);
  --panel: rgba(250, 250, 252, .72);
  --border: rgba(0, 0, 0, .10);
  --line: rgba(0, 0, 0, .08);
  --fg: #1c1c1f;
  --muted: #6b6b73;
  --sel: rgba(0, 0, 0, .06);
  --kbd: rgba(0, 0, 0, .07);
  --shadow: 0 24px 64px rgba(0, 0, 0, .22), 0 2px 8px rgba(0, 0, 0, .12);
  /* Current-tab status dot. NOT popup.css's --green (#5fd39a) here — that's
     tuned for popup.css's permanently-dark panel and fails contrast against
     this theme's light --panel. #16a34a (Tailwind's green-600) is a
     saturated green that reads clearly on a near-white panel while staying
     unmistakably "green"; --current-glow is its own translucent rgba rather
     than color-mix() so the glow has no browser-support floor. (Round 3:
     lightened one shade from green-700 #15803d — the user's manual pass
     found the original too dark in light mode.) */
  --current: #16a34a;
  --current-glow: rgba(22, 163, 74, .35);
}

@media (prefers-color-scheme: dark) {
  :host(:not([data-theme="light"])) {
    --scrim: rgba(10, 10, 12, .42);
    --panel: rgba(31, 31, 34, .72);
    --border: rgba(255, 255, 255, .10);
    --line: rgba(255, 255, 255, .08);
    --fg: #e8e8ea;
    --muted: #9a9aa2;
    --sel: rgba(255, 255, 255, .08);
    --kbd: rgba(255, 255, 255, .08);
    --shadow: 0 24px 64px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .35);
    /* Dark can afford the actual project green (popup.css's --green) since
       it's sitting on a dark panel, same as everywhere else in the product. */
    --current: #5fd39a;
    --current-glow: rgba(95, 211, 154, .45);
  }
}

:host([data-theme="dark"]) {
  --scrim: rgba(10, 10, 12, .42);
  --panel: rgba(31, 31, 34, .72);
  --border: rgba(255, 255, 255, .10);
  --line: rgba(255, 255, 255, .08);
  --fg: #e8e8ea;
  --muted: #9a9aa2;
  --sel: rgba(255, 255, 255, .08);
  --kbd: rgba(255, 255, 255, .08);
  --shadow: 0 24px 64px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .35);
  --current: #5fd39a;
  --current-glow: rgba(95, 211, 154, .45);
}

* { box-sizing: border-box; }

.scrim {
  position: fixed;
  inset: 0;
  display: grid;
  justify-items: center;
  align-items: start;
  padding-top: 14vh;
  background: var(--scrim);
  backdrop-filter: blur(3px);
  font: 14px/1.4 -apple-system, system-ui, sans-serif;
  color: var(--fg);
}

.panel {
  width: min(640px, calc(100vw - 48px));
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  backdrop-filter: blur(24px) saturate(180%);
  box-shadow: var(--shadow);
  animation: rise 120ms ease-out;
}
@keyframes rise {
  from { opacity: 0; transform: scale(.98); }
  to   { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .panel { animation: none; }
}

.query {
  width: 100%;
  padding: 16px 18px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: inherit;
  font: 20px/1.3 -apple-system, system-ui, sans-serif;
  outline: none;
}
.query::placeholder { color: var(--muted); }

.results { overflow-y: auto; padding: 6px 0; }
.results:empty { display: none; }

.row {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 18px;
  cursor: default;
}
.row[aria-selected="true"] { background: var(--sel); }
.row .ico { display: flex; color: var(--muted); }
.row .ico img,
.row .ico svg { width: 16px; height: 16px; }
.row .ico img { border-radius: 3px; }
.row .text { min-width: 0; }
.row .title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* A tab row's title swaps in a leading status dot (see palette.js render()) —
   flex so the dot and the text sit side by side, with the text itself, not
   this container, carrying the ellipsis truncation. Only tab rows get this
   modifier; header/more/create titles stay the plain block above.
   overflow: visible (round 3) undoes the `.row .title` rule above, which
   this selector's higher specificity would otherwise still inherit even
   though this block never repeats it: the current-tab glow (box-shadow,
   0 0 6px 1px) extends ~7px past the 8px dot and was getting clipped at
   .title's tight line box. Safe to relax here specifically because
   .title-text below carries its OWN overflow:hidden + ellipsis — the thing
   that must keep truncating a long tab title is that inner span, not this
   flex container, and it does not depend on the container's own overflow.
   Walked every ancestor between the dot and .scrim for another clip before
   making this change: .text (span, min-width:0 only, no overflow rule),
   .row (grid container, no overflow rule), .results (overflow-y:auto — a
   scroll boundary, and the row's own horizontal padding plus its 34px
   depth-1 indent keep the ~7px glow well clear of it), .panel (overflow:
   hidden, but the same indent keeps a tab row's dot far from its edge —
   this is what actually clips the query input and results list into the
   panel's rounded corners, not this glow), .scrim (no overflow rule). None
   of them but `.row .title` itself were clipping the glow, so this was the
   one and only place that needed to change. */
/* The dot's size and gap are tokens rather than literals because two rules
   depend on them: the title's flex gap, and the URL's indent below it. If
   they were separate numbers they could drift and the URL would stop lining
   up under the title text. */
.row {
  --marker-size: 8px;
  --marker-gap: 6px;
}
.row .title.with-marker {
  display: flex;
  align-items: center;
  gap: var(--marker-gap);
  overflow: visible;
}
/* Always in the DOM on a tab row, painted only when .is-current — that's
   what reserves the same 8px + gap on every row, current or not, so titles
   line up whether or not a row is the current tab. Static: no transition,
   no animation — see palette.js's comment on why a pulse would be wrong here. */
.current-dot {
  flex: none;
  width: var(--marker-size);
  height: var(--marker-size);
  border-radius: 50%;
  background: transparent;
}
.current-dot.is-current {
  background: var(--current);
  box-shadow: 0 0 6px 1px var(--current-glow);
}
.title.with-marker .title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row .sub {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Tab and saved rows reserve the dot's slot on every row, so the title text
   starts after it. Indent the URL by the same slot so it sits directly under
   the title text rather than out to the left of it. */
.row .sub.with-marker {
  padding-left: calc(var(--marker-size) + var(--marker-gap));
}
/* Right-hand column: an optional Cmd+N badge plus an optional action hint,
   side by side — a header also prepends its tab count here (see .count). */
.row .right {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-self: end;
}
.row .hint {
  font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--muted);
}
/* The Cmd+N badge reuses the footer's kbd chip look (background pill) so a
   row's number reads as "a key you can press", same as the footer legend. */
kbd.num { color: var(--muted); }

/* A tab row (depth 1) indents under its workspace header (depth 0), so the
   grouping reads without needing a border around every section. */
.row[data-depth="1"] { padding-left: 34px; }

/* A hidden (backgrounded) tab used to get a different dot glyph; now that
   slot shows its favicon instead, so "hidden" is conveyed by dimming the
   whole row — still legible, clearly secondary. */
.row.dim { opacity: .55; }

/* The "+N more" row: same indent as the tabs it summarizes, muted like a
   hint rather than a title, since it's an action, not a document. */
.row.more .title { color: var(--muted); }

/* The workspace header row: taller and heavier than a tab row so a section
   break is obvious while scanning, with a top rule between one workspace's
   group and the next (not before the very first one). The chevron adds a
   fourth grid column ahead of the icon; tab/more rows keep the base 3-column
   template above and indent via padding instead (see [data-depth="1"]). */
.row.group {
  grid-template-columns: 16px 20px 1fr auto;
  height: 50px;
  border-top: 1px solid var(--line);
}
.row.group:first-child { border-top: 0; }
.row.group .chev {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  cursor: pointer;
}
.row.group .title { font-size: 15px; font-weight: 600; }
.row.group .count {
  font-size: 12px;
  color: var(--muted);
}

/* Delete affordance (palette-actions brief #4): a plain icon button, only
   ever in the DOM for the selected row (see palette.js render()) so no hover-
   only CSS state is needed here — its mere presence already means "this row
   is selected or was just hovered". */
.trash {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.trash:hover { background: var(--sel); color: var(--fg); }

/* The armed "Delete <name> and its N tabs?" text replaces the count in
   the same slot — same size/colour as .count so the row's height and rhythm
   don't shift when the confirm appears. */
.confirm-text {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Inline rename (brief #3): sized to replace the title in place, same grid
   cell, so the row's height and the icon's position don't shift when it
   swaps in. */
.row.renaming { grid-template-columns: 16px 20px 1fr; }
.rename-input {
  width: 100%;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--sel);
  color: inherit;
  font: inherit;
  font-weight: 600;
  outline: none;
}

/* The two "create a workspace from what I typed" rows (brief #5): same muted
   treatment as the "+N more" row above — an action, not a document, and
   never the default selection (see buildPaletteRows), so it should not read
   as more prominent than the results it sits below. */
.row.create .title { color: var(--muted); }

/* Tail grouping (palette-round3 brief #3): a small, uppercase, muted,
   letter-spaced section label — WORKSPACE / WEB — never a selectable row
   (buildPaletteRows sets selectable: false), so it needs none of .row's
   grid/hover/selection machinery, just its own block. The top rule and
   extra top padding read as "new section starting", echoing .row.group's
   own border-top immediately above a workspace header. */
.section-label {
  padding: 10px 18px 6px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--muted);
}

.foot {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 8px 18px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
}
kbd {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--kbd);
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--fg);
}
`;
