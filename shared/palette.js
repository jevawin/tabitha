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
// decision lives in firefox/background.js.
(() => {
  if (window.__tabithaPaletteToggle) {
    window.__tabithaPaletteToggle();
    return;
  }

  const api = globalThis.browser ?? globalThis.chrome;
  const { buildPaletteRows, nextSelectableIndex } = globalThis.TabithaCore;

  let host = null;
  let root = null;
  let items = [];
  let rows = [];
  let sel = -1;
  let workspaces = [];
  let activeWorkspaceId = null;
  // True while the footer shows a background error instead of the key hints.
  // Cleared the moment the user types again, so the hints come back rather
  // than leaving a stale error sitting there forever.
  let footShowingError = false;
  // open() awaits paletteState before it creates `host` (state-before-paint,
  // so the overlay never flashes the wrong theme for a frame). That leaves a
  // window where host is still null but an open is already underway — a
  // second Cmd+Shift+K in that window would see host === null and start a
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

  // Recomputes `rows` from the current query, resetting `sel` to the freshly
  // computed defaultSel. Called on open and on every keystroke — never from
  // render() itself, which repaints from whatever `rows`/`sel` already are.
  // Splitting these two apart is what lets ArrowUp/Down and mouse hover move
  // `sel` and repaint without silently reshuffling the grouping underneath
  // the user's finger.
  function recompute() {
    const q = root.querySelector(".query").value;
    const built = buildPaletteRows(items, workspaces, activeWorkspaceId, q);
    rows = built.rows;
    sel = built.defaultSel;
  }

  function render() {
    const list = root.querySelector(".results");
    list.textContent = "";

    // A header's count is every "tab" row that shares its workspaceId. Rows
    // for one workspace are always contiguous (buildPaletteRows emits a
    // header immediately followed by its own items, never interleaved), so
    // a straight filter-by-workspaceId is exactly the count for the section
    // that follows this header — no need to walk forward looking for the
    // next header.
    const counts = new Map();
    rows.forEach((r) => {
      if (r.kind === "tab") counts.set(r.workspaceId, (counts.get(r.workspaceId) || 0) + 1);
    });

    rows.forEach((row, i) => {
      const el = document.createElement("div");
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === sel));
      el.dataset.depth = String(row.depth);

      const ico = document.createElement("span");
      ico.className = "ico";

      const text = document.createElement("span");
      text.className = "text";
      const title = document.createElement("div");
      title.className = "title";
      // textContent throughout, never innerHTML: titles come from page
      // content and from imported backup files, neither of which is trusted
      // markup. row.item is null only for the synthetic "Unfiled" header,
      // which this file authors itself — "Unfiled" is the one literal.
      text.appendChild(title);

      if (row.kind === "header") {
        el.className = "row group";
        // Workspace icon.paths is untrusted markup carried from backups and
        // must never be rendered as markup — same rule as the popup's icon
        // picker. A fixed glyph stands in for every workspace here, same as
        // the old flat list did for a kind:"workspace" item.
        ico.textContent = "▦";
        title.textContent = row.item ? row.item.title : "Unfiled";

        const count = document.createElement("span");
        count.className = "count";
        count.textContent = String(counts.get(row.workspaceId) || 0);

        el.append(ico, text, count);
      } else {
        const item = row.item;
        el.className = "row";
        ico.textContent = item.hidden ? "○" : "●";
        title.textContent = item.title;

        const sub = document.createElement("div");
        sub.className = "sub";
        // The header names the workspace now, so the subtitle is just the
        // URL.
        sub.textContent = item.url || "";
        text.appendChild(sub);

        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = i === sel ? "↵" : "";

        el.append(ico, text, hint);
      }

      if (row.selectable) {
        el.addEventListener("mousemove", () => { sel = i; render(); });
        el.addEventListener("click", () => activate());
      }
      list.appendChild(el);
    });
  }

  // Send first, close only on success. Closing before the response landed
  // meant a stale tabId or a deleted workspace made the palette vanish and do
  // nothing — the background's error had nowhere left to be shown.
  async function activate() {
    const row = rows[sel];
    if (!row || !row.selectable || !row.item) return; // guards the non-selectable "Unfiled" header (item: null)
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
      ["↵", "this tab"],
      ["⌘↵", "new tab"],
      ["⌘1–9", "workspace"],
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
    // nextSelectableIndex skips the non-selectable "Unfiled" header and
    // clamps at either end rather than wrapping; if nothing is selectable it
    // returns -1, which is left alone rather than stomping `sel`.
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

    // Cmd+digit was measured cancellable inside page content: preventDefault
    // genuinely stops Firefox switching tabs. Without it, Cmd+2 jumps to tab 2.
    // preventDefault runs unconditionally, before the empty-query check below,
    // so the browser's own tab-switch binding never fires underneath us even
    // when there's nothing to search for.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && e.metaKey) {
      e.preventDefault();
      if (!q.value.trim()) return; // nothing to search for; leave the palette open
      const ws = workspaces[Number(digit[1]) - 1];
      if (ws) search({ kind: "workspace", id: ws.id });
      return;
    }
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      if (q.value.trim()) search({ kind: "newTab" }); // empty query: nothing to search for
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // A selected row always wins, even on an empty query — that's the whole
      // point of the arrow keys. Only fall through to a current-tab search
      // when nothing is selected and there's text to search for; with neither,
      // do nothing rather than closing on a search that would only fail.
      if (rows[sel] && rows[sel].selectable) activate();
      else if (q.value.trim()) search({ kind: "currentTab" });
    }
  }

  async function open() {
    // A second Cmd+Shift+K firing while the first open() is still awaiting
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
      scrim.innerHTML =
        '<div class="panel" role="dialog" aria-modal="true" aria-label="Tabitha palette">' +
        '<input class="query" type="text" placeholder="Search tabs, workspaces, or the web…" autocomplete="off" spellcheck="false" />' +
        '<div class="results" role="listbox"></div>' +
        '<div class="foot">' +
        "<span><kbd>↵</kbd> this tab</span>" +
        "<span><kbd>⌘↵</kbd> new tab</span>" +
        "<span><kbd>⌘1–9</kbd> workspace</span>" +
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
