// Tabitha palette — injected into the active page by the background on the
// keyboard shortcut. Re-injecting re-runs this file, so it toggles rather than
// stacking a second overlay.
//
// A shadow root, not an iframe. backdrop-filter cannot blur across an iframe
// boundary — the iframe is a separate document, so its backdrop is its own —
// and the frosted glass is the design. Shadow DOM gives the same style
// isolation while staying real page content.
//
// This file stays dumb, like popup.js: it renders and sends messages. Every
// decision lives in firefox/background.js. The one exception is which
// sections are expanded/collapsed: that's presentation state with nowhere
// else sensible to live (it's per palette-session, never persisted), so it's
// owned here as the `expanded` Set and handed to the pure buildPaletteRows
// for every actual open/collapsed/capped decision.
(() => {
  if (window.__tabithaPaletteToggle) {
    window.__tabithaPaletteToggle();
    return;
  }

  const api = globalThis.browser ?? globalThis.chrome;
  const {
    buildPaletteRows,
    nextSelectableIndex,
    normalizeIconNodes,
    PALETTE_FULL_SUFFIX,
    PALETTE_COLLAPSED_SUFFIX,
    paletteArrowTargetsTree,
  } = globalThis.TabithaCore;

  const SVG_NS = "http://www.w3.org/2000/svg";

  // Default leading glyph for a workspace with no chosen icon (or one whose
  // stored geometry doesn't survive normalizeIconNodes — see renderIcon).
  // Lucide "ellipsis", authored here as nodes rather than fetched from
  // icon-data.json so a row never needs the dataset just to render a
  // placeholder. Actually routed through normalizeIconNodes, once, right
  // here — not just described that way — so this literal gets the exact
  // same allowlist protection as every icon that comes from storage: a
  // future hand-edit to it (a stray `onload`, an unlisted tag) gets stripped
  // at load time instead of reaching the DOM, rather than relying on "it's a
  // hardcoded literal" as an unenforced promise.
  const DEFAULT_ICON_NODES = normalizeIconNodes([
    ["circle", { cx: "12", cy: "12", r: "1" }],
    ["circle", { cx: "19", cy: "12", r: "1" }],
    ["circle", { cx: "5", cy: "12", r: "1" }],
  ]);

  let host = null;
  let root = null;
  let items = [];
  let rows = [];
  let sel = -1;
  let workspaces = [];
  let activeWorkspaceId = null;
  // Workspace ids (plus `null` for the unfiled section) the user has opened
  // this palette session, in buildPaletteRows' two-state encoding: `id` means
  // "open, capped"; `id + PALETTE_FULL_SUFFIX` means "open, showing
  // everything". Fresh every open() — collapse state does not persist
  // between palette sessions.
  let expanded = new Set();
  // True while the footer shows a background error instead of the key hints.
  // Cleared the moment the user types again, so the hints come back rather
  // than leaving a stale error sitting there forever.
  let footShowingError = false;
  // open() awaits paletteState before it creates `host` (state-before-paint,
  // so the overlay never flashes the wrong theme for a frame). That leaves a
  // window where host is still null but an open is already underway — a
  // second palette shortcut in that window would see host === null and start a
  // second open(), stacking two overlays. This flag closes that window.
  let opening = false;

  const send = (msg) => api.runtime.sendMessage(msg);

  function close() {
    if (!host) return;
    host.remove();
    host = null;
    root = null;
    footShowingError = false;
  }

  // Rebuilds `rows` from the current query and `expanded` state, WITHOUT
  // touching `sel` — callers that need to reset selection (typing, opening)
  // do that themselves via recompute() below; callers that toggle a section
  // (expandRow/collapseRow) need the row list first so they can find where
  // the toggled section's header landed.
  function rebuildRows() {
    const q = root.querySelector(".query").value;
    const built = buildPaletteRows(items, workspaces, activeWorkspaceId, q, expanded);
    rows = built.rows;
    return built;
  }

  // Recomputes `rows` from the current query, resetting `sel` to the freshly
  // computed defaultSel. Called on open and on every keystroke — never from
  // render() itself, which repaints from whatever `rows`/`sel` already are.
  // Splitting these two apart is what lets ArrowUp/Down and mouse hover move
  // `sel` and repaint without silently reshuffling the grouping underneath
  // the user's finger.
  function recompute() {
    sel = rebuildRows().defaultSel;
  }

  // Expand/collapse state lives in one Set (see the `expanded` declaration
  // above for the key encoding) — these three helpers are the only place
  // that touches it, so the encoding never has to be re-derived elsewhere.
  function expandCapped(id) {
    expanded.delete(`${id}${PALETTE_COLLAPSED_SUFFIX}`); // undo a previous explicit collapse — see collapseSection
    expanded.add(id);
  }
  function expandFull(id) {
    expanded.delete(`${id}${PALETTE_COLLAPSED_SUFFIX}`);
    expanded.add(id);
    expanded.add(`${id}${PALETTE_FULL_SUFFIX}`);
  }
  function collapseSection(id) {
    expanded.delete(id);
    expanded.delete(`${id}${PALETTE_FULL_SUFFIX}`);
    // The active workspace defaults open with no entry in `expanded` at all
    // (see PALETTE_COLLAPSED_SUFFIX in core.js), so the two deletes above
    // aren't enough to close it — this marker is what actually overrides
    // that default. Setting it unconditionally, even for a non-active id
    // whose default is already collapsed, means this function never has to
    // check "is this the active workspace" itself.
    expanded.add(`${id}${PALETTE_COLLAPSED_SUFFIX}`);
  }

  // After toggling a section, `rows` is rebuilt and the row count can change
  // out from under `sel` (new tab rows inserted, a "more" row replaced by
  // real rows, ...). Rather than reason about index arithmetic, just find
  // that section's header again by workspaceId — headers are unique per
  // section — and land there; nextSelectableIndex is the documented fallback
  // for "nothing matched", same as everywhere else selection can go stale.
  function selectHeaderFor(workspaceId) {
    const idx = rows.findIndex((r) => r.kind === "header" && r.workspaceId === workspaceId);
    sel = idx !== -1 ? idx : nextSelectableIndex(rows, -1, 1);
  }

  // → on a header, or activating (click/Enter/Cmd+N) a "more" row.
  function expandRow(row) {
    if (row.kind === "header") expandCapped(row.workspaceId);
    else if (row.kind === "more") expandFull(row.workspaceId);
    else return;
    rebuildRows();
    selectHeaderFor(row.workspaceId);
    render();
  }

  // ← on a header or a tab row (a tab row collapses its parent and moves
  // selection to that header — there is nothing sensible to collapse from a
  // "more" row, so that kind is simply ignored here).
  function collapseRow(row) {
    if (row.kind !== "header" && row.kind !== "tab") return;
    collapseSection(row.workspaceId);
    rebuildRows();
    selectHeaderFor(row.workspaceId);
    render();
  }

  function buildIconSvg(nodes) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    // `nodes` is null when validation rejected everything. Render an empty SVG
    // rather than throwing: one bad icon must not take the whole palette down
    // with it, and this is also the guard if a future allowlist edit ever
    // invalidates DEFAULT_ICON_NODES itself.
    for (const [tag, attrs] of nodes || []) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const key of Object.keys(attrs)) el.setAttribute(key, attrs[key]);
      svg.appendChild(el);
    }
    return svg;
  }

  // Workspace icon geometry (`icon.nodes`) is adjacent to untrusted data: it
  // is validated on the way into storage (shared/core.js normalizeIcon), but
  // this is the last gate before it becomes real DOM nodes inside an
  // arbitrary web page, so it is re-validated here even though the
  // background already did it once — cheap, and the whole reason `nodes` is
  // structured data instead of markup. createElementNS + setAttribute only;
  // never innerHTML. A missing icon, or one whose nodes don't survive
  // normalizeIconNodes (e.g. a pre-`nodes` record that only ever stored
  // `paths`, which is markup and must never be rendered here), falls back to
  // the default glyph.
  function renderIcon(container, icon) {
    container.textContent = "";
    const clean = icon && normalizeIconNodes(icon.nodes);
    container.appendChild(buildIconSvg(clean || DEFAULT_ICON_NODES));
  }

  // favIconUrl is page-controlled: any site can serve any string as its own
  // favicon. Only a scheme this extension is willing to hand to <img src>
  // may reach the DOM; everything else (javascript:, an empty/missing value,
  // garbage) falls back to the glyph, same pattern as popup.js's move strip.
  function isSafeFaviconUrl(url) {
    return typeof url === "string" && /^(https?:|data:image\/)/i.test(url);
  }

  function renderFavicon(container, item) {
    container.textContent = "";
    const url = item.kind === "tab" ? item.favIconUrl : ""; // saved records carry none
    if (!isSafeFaviconUrl(url)) {
      container.textContent = "●";
      return;
    }
    const img = document.createElement("img");
    img.width = 16;
    img.height = 16;
    img.alt = "";
    // A broken/unreachable favicon URL fires error, not a rejected promise —
    // swap back to the glyph rather than leaving a broken-image icon.
    img.addEventListener("error", () => { container.textContent = "●"; }, { once: true });
    img.src = url;
    container.appendChild(img);
  }

  function countLabel(row) {
    const label = row.count === 1 ? "1 tab" : `${row.count} tabs`;
    // Only a REAL workspace can be "active" — guards the Default state
    // (activeWorkspaceId === null), where the unfiled section's own
    // workspaceId (also null) would otherwise false-match it.
    const isActive = row.workspaceId != null && row.workspaceId === activeWorkspaceId;
    return isActive ? `active · ${label}` : label;
  }

  function render() {
    const list = root.querySelector(".results");
    list.textContent = "";

    let selectedEl = null;

    rows.forEach((row, i) => {
      const el = document.createElement("div");
      // A row that can never be chosen must not offer assistive tech a
      // choice that doesn't exist — omit the listbox-option role and
      // selected state entirely rather than setting aria-selected="false" on
      // something unselectable. (Every row is selectable today, including
      // the unfiled header, but the guard costs nothing and keeps this
      // correct if that ever changes again.)
      if (row.selectable) {
        el.setAttribute("role", "option");
        el.setAttribute("aria-selected", String(i === sel));
      }
      el.dataset.depth = String(row.depth);

      const text = document.createElement("span");
      text.className = "text";
      const title = document.createElement("div");
      title.className = "title";
      // textContent throughout, never innerHTML: titles come from page
      // content and from imported backup files, neither of which is trusted
      // markup. row.item is null only for the synthetic "Unfiled" header,
      // which this file authors itself — "Not in a workspace" is the one
      // literal.
      text.appendChild(title);

      const right = document.createElement("span");
      right.className = "right";
      if (row.num) {
        const num = document.createElement("kbd");
        num.className = "num";
        num.textContent = "⌘" + row.num;
        right.appendChild(num);
      }
      if (row.selectable && i === sel) {
        const hint = document.createElement("span");
        hint.className = "hint";
        // A "more" row's Enter/click expands it rather than "opening"
        // anything (see the row.kind === "more" branches in onKeydown and
        // the click handler below) — → is the honest glyph for that action,
        // ↵ would promise the wrong thing.
        hint.textContent = row.kind === "more" ? "→" : "↵";
        right.appendChild(hint);
      }

      if (row.kind === "header") {
        el.className = "row group";

        const chev = document.createElement("span");
        chev.className = "chev";
        chev.textContent = row.expanded ? "▾" : "▸";
        chev.addEventListener("click", (e) => {
          e.stopPropagation(); // don't also fire the row's own activate()
          sel = i;
          if (row.expanded) collapseRow(row);
          else expandRow(row);
        });

        const ico = document.createElement("span");
        ico.className = "ico";
        renderIcon(ico, row.item && row.item.icon);
        title.textContent = row.item ? row.item.title : "Not in a workspace";

        const count = document.createElement("span");
        count.className = "count";
        count.textContent = countLabel(row);
        right.prepend(count);

        el.append(chev, ico, text, right);
      } else if (row.kind === "more") {
        el.className = "row more";
        title.textContent = `+ ${row.count} more`;
        // Empty icon slot, kept only so the 3-column grid (icon/text/right)
        // lines "+N more" up under the tab titles above it rather than
        // sliding left into the icon column.
        const spacer = document.createElement("span");
        spacer.className = "ico";
        el.append(spacer, text, right);
      } else {
        const item = row.item;
        el.className = "row";
        // Hidden tabs used to get a different dot glyph; now the favicon
        // occupies that slot, so "hidden" is conveyed by dimming the whole
        // row instead (see .row.dim in palette.css.js).
        if (item.hidden) el.classList.add("dim");

        const ico = document.createElement("span");
        ico.className = "ico";
        renderFavicon(ico, item);
        title.textContent = item.title;

        const sub = document.createElement("div");
        sub.className = "sub";
        // The header names the workspace now, so the subtitle is just the
        // URL.
        sub.textContent = item.url || "";
        text.appendChild(sub);

        el.append(ico, text, right);
      }

      if (row.selectable) {
        el.addEventListener("mousemove", () => { sel = i; render(); });
        el.addEventListener("click", () => {
          sel = i;
          if (row.kind === "more") expandRow(row);
          else activate();
        });
      }
      if (i === sel) selectedEl = el;
      list.appendChild(el);
    });

    // Keep the selection on screen as arrow keys move through a list that can
    // now be taller than the panel (header rows added length). "nearest" is
    // deliberate: it only scrolls when the row is actually out of view, so
    // this can run on every render — including hover and typing — without
    // jittering the list when the row is already visible.
    if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
  }

  // Send first, close only on success. Closing before the response landed
  // meant a stale tabId or a deleted workspace made the palette vanish and do
  // nothing — the background's error had nowhere left to be shown.
  async function activate() {
    const row = rows[sel];
    if (!row || !row.selectable || !row.item) return; // guards the non-selectable "Unfiled" header (item: null) and "more" rows
    const item = row.item;
    // Captured before the await: root can change underneath this request if
    // the user presses Escape (root -> null) or closes and reopens (root ->
    // a different shadow root) before the response lands. Either way, the
    // response belongs to a palette session that no longer exists, so it
    // must be dropped rather than acted on — a stale success must not close
    // a newly reopened palette, and a stale failure must not write into it
    // (or, if closed outright, throw on a null root).
    const session = root;
    let res;
    if (item.kind === "workspace") res = await send({ type: "openWorkspace", id: item.workspaceId });
    else if (item.tabId != null) res = await send({ type: "jumpToTab", tabId: item.tabId });
    else res = await send({ type: "openWorkspace", id: item.workspaceId });
    if (session !== root) return;
    if (res && res.ok) close();
    else showError(res && res.error);
  }

  async function search(where) {
    const q = root.querySelector(".query").value;
    // See the matching comment in activate(): this response can outlive the
    // palette session it was sent from.
    const session = root;
    const res = await send({ type: "paletteSearch", query: q, where });
    if (session !== root) return;
    if (res && res.ok) close();
    else showError(res && res.error);
  }

  // Background errors are plain strings (String(e) in the message router),
  // but this file treats every value it didn't author itself as untrusted —
  // textContent only, same rule as render()'s titles and subtitles.
  function showError(message) {
    const foot = root.querySelector(".foot");
    foot.textContent = "";
    const span = document.createElement("span");
    span.textContent = message || "Something went wrong.";
    foot.appendChild(span);
    footShowingError = true;
  }

  // Rebuilds the footer's normal key-hint row. Used to undo showError() once
  // the user starts typing again.
  function restoreHints() {
    const foot = root.querySelector(".foot");
    foot.textContent = "";
    const hints = [
      ["↵", "open"],
      ["⌘↵", "new tab"],
      ["⌘1–9", "jump"],
      ["→", "expand"],
      ["esc", "close"],
    ];
    hints.forEach(([key, label]) => {
      const span = document.createElement("span");
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      span.append(kbd, document.createTextNode(" " + label));
      foot.appendChild(span);
    });
    footShowingError = false;
  }

  function onKeydown(e) {
    if (!host) return;
    const q = root.querySelector(".query");

    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    // nextSelectableIndex skips non-selectable rows (none today, but the
    // contract holds regardless) and clamps at either end rather than
    // wrapping; if nothing is selectable it returns -1, left alone rather
    // than stomping `sel`.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = nextSelectableIndex(rows, sel, 1);
      if (n !== -1) sel = n;
      render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = nextSelectableIndex(rows, sel, -1);
      if (n !== -1) sel = n;
      render();
      return;
    }
    // Focus lives in the query input for the palette's entire lifetime, so
    // Left/Right can only safely drive the section tree while there is
    // nothing to type over: an empty query with no modifier held. Any text
    // already in the box, or any modifier (Shift-select, Option-word-jump,
    // Cmd-line-jump), means these are ordinary caret keys — don't
    // preventDefault, don't act, let the input handle them. See
    // paletteArrowTargetsTree's comment in core.js for why an empty query is
    // the one case with nothing meaningful to collapse anyway.
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const targetsTree = paletteArrowTargetsTree(q.value, {
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
      });
      if (!targetsTree) return;
      e.preventDefault();
      if (rows[sel]) {
        if (e.key === "ArrowRight") expandRow(rows[sel]);
        else collapseRow(rows[sel]);
      }
      return;
    }

    // Cmd+digit was measured cancellable inside page content: preventDefault
    // genuinely stops Firefox switching tabs. Without it, Cmd+2 jumps to tab 2.
    // preventDefault runs unconditionally, before anything else in this
    // branch, so the browser's own tab-switch binding never fires underneath
    // us even when the digit doesn't match a numbered row.
    //
    // This used to fire a "search into workspace N" message (paletteSearch
    // with where:{kind:"workspace", id}) — that binding is removed; the
    // message and its handler are untouched for a later command mode to
    // reuse. Cmd+N now activates whichever row currently carries that
    // number, same as pressing Enter on it after selecting it with the
    // arrow keys.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && e.metaKey) {
      e.preventDefault();
      const n = Number(digit[1]);
      const idx = rows.findIndex((r) => r.num === n);
      if (idx === -1) return;
      sel = idx;
      if (rows[idx].kind === "more") expandRow(rows[idx]);
      else activate();
      return;
    }
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      if (q.value.trim()) search({ kind: "newTab" }); // empty query: nothing to search for
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[sel];
      if (row && row.selectable) {
        // A selected row always wins, even on an empty query — that's the
        // whole point of the arrow keys. A "more" row isn't "opennable"; it
        // expands, same as → on it.
        if (row.kind === "more") expandRow(row);
        else activate();
      } else if (q.value.trim()) {
        // Nothing selected: fall through to a current-tab search only when
        // there's text to search for; with neither, do nothing rather than
        // closing on a search that would only fail.
        search({ kind: "currentTab" });
      }
    }
  }

  async function open() {
    // A second palette shortcut firing while the first open() is still awaiting
    // paletteState (host is still null) must be a no-op, not a second overlay.
    if (opening) return;
    opening = true;
    try {
      // State first, THEN paint. Fetching after mounting would show the overlay in
      // the system theme for one frame before a pinned override applied — a
      // visible flash on every open.
      const state = await send({ type: "paletteState" });
      if (!state || !state.ok) return;
      items = state.items;
      workspaces = state.workspaces;
      activeWorkspaceId = state.activeWorkspaceId;
      expanded = new Set(); // fresh collapse state every time the palette opens

      host = document.createElement("div");
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.inset = "0";
      host.style.zIndex = "2147483647";
      // documentElement, not body: fewer pages create a containing block there.
      // "system" means no attribute, so the stylesheet's media query decides.
      if (state.theme === "light" || state.theme === "dark") {
        host.setAttribute("data-theme", state.theme);
      }
      document.documentElement.appendChild(host);
      root = host.attachShadow({ mode: "closed" });

      const sheet = new CSSStyleSheet();
      sheet.replaceSync(globalThis.TABITHA_PALETTE_CSS);
      root.adoptedStyleSheets = [sheet];

      const scrim = document.createElement("div");
      scrim.className = "scrim";
      // Fixed literal, no interpolation — everything dynamic is rendered
      // later via textContent in render(), never here.
      scrim.innerHTML =
        '<div class="panel" role="dialog" aria-modal="true" aria-label="Tabitha palette">' +
        '<input class="query" type="text" placeholder="Search tabs, workspaces, or the web…" autocomplete="off" spellcheck="false" />' +
        '<div class="results" role="listbox"></div>' +
        '<div class="foot">' +
        "<span><kbd>↵</kbd> open</span>" +
        "<span><kbd>⌘↵</kbd> new tab</span>" +
        "<span><kbd>⌘1–9</kbd> jump</span>" +
        "<span><kbd>→</kbd> expand</span>" +
        "<span><kbd>esc</kbd> close</span>" +
        "</div></div>";
      root.appendChild(scrim);

      scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
      root.querySelector(".query").addEventListener("input", () => {
        if (footShowingError) restoreHints();
        recompute();
        render();
      });
      root.querySelector(".query").focus();
      recompute();
      render();
    } finally {
      opening = false;
    }
  }

  window.addEventListener("keydown", onKeydown, true);
  window.__tabithaPaletteToggle = () => (host || opening ? close() : open());
  window.__tabithaPaletteToggle();
})();
