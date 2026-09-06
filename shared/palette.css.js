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

.group {
  padding: 8px 18px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--muted);
}

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
.row .ico img { width: 16px; height: 16px; border-radius: 3px; }
.row .text { min-width: 0; }
.row .title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row .sub {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row .hint {
  font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
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
