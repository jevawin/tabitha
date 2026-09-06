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
  const { rankPaletteItems } = globalThis.TabithaCore;

  let host = null;
  let root = null;
  let items = [];
  let shown = [];
  let sel = 0;
  let workspaces = [];
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

  function labelFor(item) {
    if (item.kind === "workspace") return "Workspace";
    const ws = workspaces.find((w) => w.id === item.workspaceId);
    return ws ? ws.name : "Unfiled";
  }

  function render() {
    const q = root.querySelector(".query").value;
    shown = rankPaletteItems(items, q);
    sel = Math.min(sel, Math.max(0, shown.length - 1));

    const list = root.querySelector(".results");
    list.textContent = "";
    shown.forEach((item, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === sel));

      const ico = document.createElement("span");
      ico.className = "ico";
      ico.textContent = item.kind === "workspace" ? "▦" : item.hidden ? "○" : "●";

      const text = document.createElement("span");
      text.className = "text";
      const title = document.createElement("div");
      title.className = "title";
      // textContent, never innerHTML: titles come from page content and from
      // imported backup files, neither of which is trusted markup.
      title.textContent = item.title;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = labelFor(item) + (item.url ? " · " + item.url : "");
      text.append(title, sub);

      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = i === sel ? "↵" : "";

      row.append(ico, text, hint);
      row.addEventListener("mousemove", () => { sel = i; render(); });
      row.addEventListener("click", () => activate());
      list.appendChild(row);
    });
  }

  // Send first, close only on success. Closing before the response landed
  // meant a stale tabId or a deleted workspace made the palette vanish and do
  // nothing — the background's error had nowhere left to be shown.
  async function activate() {
    const item = shown[sel];
    if (!item) return;
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
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); return; }

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
      if (shown[sel]) activate();
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
        sel = 0;
        if (footShowingError) restoreHints();
        render();
      });
      root.querySelector(".query").focus();
      render();
    } finally {
      opening = false;
    }
  }

  window.addEventListener("keydown", onKeydown, true);
  window.__tabithaPaletteToggle = () => (host || opening ? close() : open());
  window.__tabithaPaletteToggle();
})();
