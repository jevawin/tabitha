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
    paletteRowVerbs,
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
  // Workspace id of the header row currently mid-rename (its title swapped
  // for an <input>), or null. While set, onKeydown returns immediately for
  // every key except a Cmd+digit guard (see its own comment) — the rename
  // input's own keydown listener owns Enter/Escape instead. Restored to null
  // on commit or cancel, which is what un-suspends normal key routing.
  let renamingId = null;
  // Workspace id of the header row currently armed for delete confirmation
  // (trash icon showing a tick, asking "Delete <name> and close its N tabs?"),
  // or null. Cleared by any keydown, by clicking anywhere that isn't that
  // row's trash icon, or by selection moving to a different row (see
  // render()'s own check) — never survives past the row it was armed on.
  let deletingId = null;
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
    renamingId = null;
    deletingId = null;
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

  // Builds a header row's leading chevron, shared by the ordinary render
  // path and renderRenamingRow (a rename still shows the chevron so the row
  // doesn't jump horizontally when it flips back to display mode).
  function buildChevron(row, i) {
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = row.expanded ? "▾" : "▸";
    chev.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also fire the row's own activate()
      sel = i;
      if (row.expanded) collapseRow(row);
      else expandRow(row);
    });
    return chev;
  }

  // The inline rename UI for a workspace header row (⇧⏎ — see onKeydown).
  // Built as its own row rather than threaded through the generic branch
  // below: a renaming row has none of the usual right-side furniture (count,
  // num badge, hint, trash), so keeping it separate is simpler than adding
  // conditionals to every piece of that furniture.
  //
  // Key routing: onKeydown returns immediately while renamingId is set (see
  // its own comment), so this input's own keydown listener is the only thing
  // that ever sees Enter/Escape while renaming — that IS the suspension the
  // brief asks for, not a separate flag this function has to check.
  function renderRenamingRow(el, row, i) {
    el.className = "row group renaming";
    if (row.selectable) {
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === sel));
    }
    el.dataset.depth = String(row.depth);

    const ico = document.createElement("span");
    ico.className = "ico";
    renderIcon(ico, row.item && row.item.icon);

    const input = document.createElement("input");
    input.className = "rename-input";
    input.maxLength = 40;
    // Seeded with the current name via .value — never markup, per the
    // security boundary that applies to every dynamic value in this file.
    input.value = row.item.title;

    let done = false;
    // Shared by cancel and a post-commit repaint: drop back to display mode
    // and let the ordinary render() path draw this row again.
    const finish = () => {
      if (done) return;
      done = true;
      renamingId = null;
      rebuildRows();
      render();
    };
    const commit = async () => {
      if (done) return;
      const name = input.value.trim();
      // A blank/whitespace-only name cancels rather than committing — the
      // background's renameWorkspace ignores an empty name anyway (keeps the
      // old one), so sending it would be a silent no-op dressed up as success.
      if (!name) { finish(); return; }
      done = true;
      const id = row.workspaceId;
      // Same staleness guard as activate()/search(): the palette can close or
      // reopen while this await is in flight.
      const session = root;
      const res = await send({ type: "rename", id, name });
      if (session !== root) return;
      renamingId = null;
      if (res && res.ok) {
        // Reflect the new name immediately rather than waiting for the next
        // full paletteState fetch — there isn't one until the palette is
        // reopened.
        const ws = workspaces.find((w) => w.id === id);
        if (ws) ws.name = name;
        rebuildRows();
        render();
      } else {
        // renamingId is already null above, but without a render() here the
        // <input> from renderRenamingRow stays on screen as a leftover DOM
        // node: render() only redraws rows it iterates over, and nothing
        // re-triggers that iteration on its own after this await resolves.
        // Key routing has already resumed (onKeydown's renamingId check now
        // sees null), so the visible input would take no keys at all —
        // rebuild+render to drop it back to the ordinary display row before
        // showing the error.
        rebuildRows();
        render();
        showError(res && res.error);
      }
    };
    input.addEventListener("keydown", (e) => {
      // Enter/Escape are exactly what onKeydown left for this input to
      // handle by returning early while renamingId is set — see its comment.
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); finish(); }
    });
    // Blur commits rather than cancels — same convention as the popup's own
    // inline rename (shared/popup.js), which this mirrors. Losing focus for
    // any reason other than Escape (clicking another row, clicking the query
    // input, ...) is "I'm done editing", not "throw away what I typed".
    input.addEventListener("blur", commit);
    input.addEventListener("click", (e) => e.stopPropagation());

    el.append(buildChevron(row, i), ico, input);
    return input;
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
    // An armed delete confirm survives only on the row it was armed on. If
    // selection has moved elsewhere since (arrow keys, hover, a fresh
    // recompute from typing, ...) it is stale — drop it here, once, rather
    // than threading a "did selection change" check through every caller
    // that can move `sel`.
    if (deletingId != null) {
      const selRow = rows[sel];
      if (!selRow || selRow.kind !== "header" || selRow.workspaceId !== deletingId) deletingId = null;
    }

    const list = root.querySelector(".results");
    list.textContent = "";

    let selectedEl = null;

    rows.forEach((row, i) => {
      const el = document.createElement("div");

      // A workspace mid-rename gets an entirely different row shape (an
      // <input>, no right-side furniture) — build and mount it, then move on
      // to the next row without touching any of the generic building below.
      if (row.kind === "header" && row.workspaceId != null && row.workspaceId === renamingId) {
        const input = renderRenamingRow(el, row, i);
        list.appendChild(el);
        input.focus();
        input.select();
        if (i === sel) selectedEl = el;
        return;
      }

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
      // markup. row.item is null for the synthetic "Unfiled" header and for
      // the two create rows, all of which this file authors the label for
      // itself.
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
        const isReal = row.workspaceId != null; // false only for the synthetic "Unfiled" header
        const isDeleting = isReal && row.workspaceId === deletingId;

        const ico = document.createElement("span");
        ico.className = "ico";
        renderIcon(ico, row.item && row.item.icon);
        title.textContent = row.item ? row.item.title : "Not in a workspace";

        if (isDeleting) {
          // Count only the LIVE tabs this workspace owns — that is exactly
          // what deleteWorkspace actually closes (see firefox/background.js:
          // it calls tabs.remove on liveIds(id), never on the saved-record
          // count). row.count mixes live + saved-but-not-live records, which
          // would overstate what is about to close.
          const liveCount = items.filter((it) => it.kind === "tab" && it.workspaceId === row.workspaceId).length;
          const ask = document.createElement("span");
          ask.className = "confirm-text";
          ask.textContent = `Delete "${row.item.title}" and close its ${liveCount === 1 ? "1 tab" : liveCount + " tabs"}?`;
          right.append(ask);
        } else {
          const count = document.createElement("span");
          count.className = "count";
          count.textContent = countLabel(row);
          right.prepend(count);
        }

        if (isReal) {
          // Only ever in the DOM for the selected row — same pattern as the
          // ↵ hint above, and it is enough: mousemove already promotes hover
          // to selection (see the listener below), so "selected or hovered"
          // from the brief falls out of the existing sel-follows-hover
          // behaviour for free, no separate CSS hover state needed. Stays
          // mounted through an armed confirm even if focus moves (isDeleting
          // check above already pins deletingId to this row via render()'s
          // staleness check), so the tick doesn't vanish mid-confirm.
          if (i === sel || isDeleting) {
            const trash = document.createElement("button");
            trash.type = "button";
            trash.className = "trash";
            trash.title = isDeleting ? "Confirm delete" : "Delete workspace";
            trash.textContent = isDeleting ? "✓" : "🗑";
            trash.addEventListener("click", async (e) => {
              e.stopPropagation(); // never let this bubble into the row's own click (which would activate/navigate)
              if (!isDeleting) {
                deletingId = row.workspaceId;
                render();
                return;
              }
              const id = row.workspaceId;
              const session = root; // see activate()'s comment: the palette can close/reopen mid-await
              const res = await send({ type: "delete", id });
              if (session !== root) return;
              deletingId = null;
              // Deleting closes real tabs and can change activeWorkspaceId —
              // close on success, same convention as every other action that
              // changes where you are.
              if (res && res.ok) close();
              else showError(res && res.error);
            });
            right.appendChild(trash);
          }
        }

        el.append(buildChevron(row, i), ico, text, right);
      } else if (row.kind === "more") {
        el.className = "row more";
        title.textContent = `+ ${row.count} more`;
        // Empty icon slot, kept only so the 3-column grid (icon/text/right)
        // lines "+N more" up under the tab titles above it rather than
        // sliding left into the icon column.
        const spacer = document.createElement("span");
        spacer.className = "ico";
        el.append(spacer, text, right);
      } else if (row.kind === "create" || row.kind === "createEmpty") {
        el.className = "row create";
        // row.name is the trimmed query, typed by the user themselves — not
        // page content or an imported file, but still rendered via
        // textContent like everything else here, never string-built markup.
        title.textContent = row.kind === "create"
          ? `New workspace "${row.name}" from current tabs`
          : `New empty workspace "${row.name}"`;
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
        // The tab the user is actually on right now (pinned first within the
        // active workspace's own section by buildPaletteRows — see
        // shared/core.js pinActiveTabFirst) gets a leading marker so "move
        // THIS tab" (⌥⏎ on a header) is unambiguous about what is being
        // moved. Still an ordinary row otherwise: Enter jumps to it, which
        // is a no-op since it is already frontmost — that's fine.
        const isCurrent = item.kind === "tab" && item.active === true;
        title.textContent = (isCurrent ? "➤ " : "") + item.title;

        const sub = document.createElement("div");
        sub.className = "sub";
        // The header names the workspace now, so the subtitle is just the
        // URL — except the current tab, where the word "current" leads and
        // the URL still follows, same "label · detail" shape countLabel uses
        // for the active workspace's header.
        sub.textContent = isCurrent ? `current · ${item.url || ""}` : (item.url || "");
        text.appendChild(sub);

        el.append(ico, text, right);
      }

      if (row.selectable) {
        el.addEventListener("mousemove", () => {
          // A render() while a rename is open tears down and rebuilds the
          // <input> (renderRenamingRow reseeds it from the STORED name), so a
          // mouse nudge over any other row would silently discard whatever
          // the user has typed so far — this listener is attached to every
          // selectable row, so it is trivially reachable. Bailing here, once,
          // for every row is safer than trying to make render() itself
          // rename-safe: a repaint that never happens can't reintroduce this,
          // whereas "restore state correctly" has to be gotten right at every
          // call site that can trigger it. onKeydown already suspends key
          // routing the same way while renamingId is set (see its comment) —
          // this is that same suspension for the mouse path.
          if (renamingId != null) return;
          // "Selecting another row" cancels an armed delete confirm (brief,
          // #4) — hover already promotes to selection below, so this is the
          // one place that needs to know about it for the mouse path; the
          // keyboard path is handled at the top of onKeydown.
          if (deletingId != null && !(row.kind === "header" && row.workspaceId === deletingId)) {
            deletingId = null;
          }
          sel = i;
          render();
        });
        el.addEventListener("click", () => {
          // A click anywhere that isn't that row's own trash icon (which
          // stopPropagation()s before this ever fires) cancels an armed
          // confirm instead of performing the row's normal action — "click
          // elsewhere cancels" from the brief, and clicking the confirming
          // row's own body (not its trash) counts as "elsewhere" too.
          if (deletingId != null) { deletingId = null; sel = i; render(); return; }
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

    // The footer tracks the selected row (brief: "show what applies to the
    // selected row"). Skipped while a background error is showing there —
    // the query input's own "input" listener is what clears footShowingError,
    // same trigger point as before this change (it used to call restoreHints
    // directly; now it just flips the flag and lets this render() reach here).
    if (!footShowingError) renderFootHints();
  }

  // Send first, close only on success. Closing before the response landed
  // meant a stale tabId or a deleted workspace made the palette vanish and do
  // nothing — the background's error had nowhere left to be shown.
  async function activate() {
    const row = rows[sel];
    if (!row || !row.selectable) return;
    // The two create rows carry no `item` (there is no workspace yet) — they
    // are the one selectable, activate()-able kind that isn't "act on an
    // existing item", so they get their own branch rather than trying to
    // squeeze a fake item shape through the logic below.
    if (row.kind === "create" || row.kind === "createEmpty") {
      const session = root;
      const type = row.kind === "create" ? "create" : "createEmpty";
      const res = await send({ type, name: row.name });
      if (session !== root) return;
      if (res && res.ok) close();
      else showError(res && res.error);
      return;
    }
    if (!row.item) return; // guards the non-selectable "Unfiled" header (item: null) and "more" rows
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

  // ⌥⏎ on a workspace header: move the active tab there and follow it (brief
  // #2). moveTab's source is always "the active tab" — the target is the
  // only choice the header itself supplies.
  async function moveActiveTabHere(targetId) {
    const session = root;
    const res = await send({ type: "moveTab", targetId });
    if (session !== root) return;
    if (res && res.ok) close();
    else showError(res && res.error);
  }

  // ⇧⏎ on a workspace header: swap it into rename mode. The actual commit/
  // cancel logic lives in renderRenamingRow, invoked by render() the moment
  // renamingId names this row.
  function startRename(row) {
    renamingId = row.workspaceId;
    deletingId = null; // renaming and an armed delete confirm should never coexist on screen
    render();
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

  // Which key hints to show for the currently selected row — "show what
  // applies to the selected row rather than everything at once" (brief,
  // footer section). Built from paletteRowVerbs (shared/core.js), the same
  // table onKeydown consults before firing ⌥⏎/⇧⏎, so the footer can never
  // promise a verb the key routing wouldn't actually honour.
  function footHintsFor(row, hasQuery) {
    const verbs = paletteRowVerbs(row);
    const hints = [];
    if (row && row.kind === "tab") {
      hints.push(["↵", "jump"]);
      // ⌘↵ (search { kind: "newTab" } in onKeydown) fires off the query text,
      // not off the selected row — it's live whenever there's something to
      // search for, regardless of which row happens to be selected. Gated on
      // hasQuery for the same reason the "search" hint below is: with an
      // empty query onKeydown's own `if (q.value.trim())` guard makes it a
      // no-op, and a hint for a key that currently does nothing is worse than
      // no hint.
      if (hasQuery) hints.push(["⌘↵", "new tab"]);
      if (verbs.collapse) hints.push(["←", "collapse"]);
    } else if (row && row.kind === "more") {
      hints.push(["→", "show all"]);
    } else if (row && row.kind === "create") {
      hints.push(["↵", "create from tabs"]);
    } else if (row && row.kind === "createEmpty") {
      hints.push(["↵", "create empty"]);
    } else if (row && row.kind === "header") {
      hints.push(["↵", row.workspaceId == null ? "toggle" : "open"]);
      if (verbs.moveHere) hints.push(["⌥↵", "move tab here"]);
      if (verbs.rename) hints.push(["⇧↵", "rename"]);
      // No ⌘↵/delete hint added here even though a header row already
      // supports both: the header line already carries up to five pairs
      // (open, move tab here, rename, expand/collapse, esc), which is at the
      // edge of the one-line footer the brief asks for. Delete in particular
      // has no key of its own to show (brief #4: it's button-only, "a
      // destructive action is acceptable being slightly harder to reach"),
      // so it would need an unfamiliar non-kbd hint shape just to fit the
      // pattern — cramming it in reads worse than leaving it undiscoverable
      // via the footer (the trash icon itself is the affordance). See the
      // F3 fix report for the reasoning; revisit if the footer ever gets a
      // second line or a narrower row of glyphs.
      hints.push([row.expanded ? "←" : "→", row.expanded ? "collapse" : "expand"]);
    } else if (hasQuery) {
      // Nothing selected (defaultSel was -1, or the list is empty) but there
      // is text to search for — the plain-Enter fallback in onKeydown.
      hints.push(["↵", "search"]);
      hints.push(["⌘↵", "new tab"]);
    }
    hints.push(["esc", "close"]);
    return hints;
  }

  // Rebuilds the footer's key-hint row from the current selection. Also used
  // to undo showError() once the user starts typing again (footShowingError
  // is reset to false first — see the query input's "input" listener below —
  // so the very next render() call reaches this instead of leaving the error
  // in place).
  function renderFootHints() {
    const foot = root.querySelector(".foot");
    foot.textContent = "";
    const hasQuery = !!root.querySelector(".query").value.trim();
    footHintsFor(rows[sel], hasQuery).forEach(([key, label]) => {
      const span = document.createElement("span");
      const kbd = document.createElement("kbd");
      kbd.textContent = key;
      span.append(kbd, document.createTextNode(" " + label));
      foot.appendChild(span);
    });
  }

  function onKeydown(e) {
    if (!host) return;

    // Renaming suspends the palette's own key routing entirely: arrows,
    // digits and Enter belong to the edit, not the list (brief, #3). This
    // listener runs on window in the CAPTURE phase (see the addEventListener
    // call at the bottom of this file), so it sees every keystroke typed
    // into the rename <input> BEFORE that input's own listener does —
    // returning here, doing nothing, is what lets the event continue down to
    // the input so its own keydown handler (in renderRenamingRow) can act on
    // Enter/Escape instead.
    if (renamingId != null) {
      // The one exception: Cmd+digit is a real Firefox tab-switch shortcut
      // that fires regardless of focus unless prevented (see the guard
      // below, measured the same way). Typing a workspace name is exactly
      // the moment a stray real tab-switch would be most disruptive, so this
      // still blocks it — it does not turn into a jump-to-row-N the way it
      // would outside a rename, since the routing that would do that never
      // runs below.
      if (/^Digit[1-9]$/.test(e.code) && e.metaKey) e.preventDefault();
      return;
    }

    // Any key other than the second trash click cancels an armed delete
    // confirm (brief, #4: "any other key ... cancels"). The trash click
    // itself is a mouse event with its own handler, never seen here, so this
    // is unconditional — render() repaints immediately so a stale "Delete?"
    // never lingers even for a key with no other branch below (e.g. a bare
    // modifier).
    if (deletingId != null) { deletingId = null; render(); }

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
    // MEASURED (brief, #2): ⌥⏎ already reaches page content, but without
    // this branch checked FIRST it can never fire — e.key is "Enter" with
    // altKey set, so the plain-Enter branch below catches it and closes the
    // palette instead. Same shape as the Cmd+digit guard above: check the
    // more specific combo before the more general one.
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      const row = rows[sel];
      // Do nothing on a tab row, a "more" row, the unfiled header, or when
      // nothing is selected — paletteRowVerbs is the single source of truth
      // for which rows this applies to (also what the footer hint reflects).
      // A genuinely untrackable active tab is rejected by the background
      // (moveActiveTab -> resolveActiveSaveableTab) and surfaces there as an
      // ordinary showError, same as any other failed action.
      if (paletteRowVerbs(row).moveHere) moveActiveTabHere(row.workspaceId);
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      const row = rows[sel];
      if (paletteRowVerbs(row).rename) startRename(row);
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
      // .foot starts empty — render() fills it from the selected row on the
      // first recompute()+render() call below, rather than duplicating a
      // static hint list here that render() would immediately overwrite
      // anyway (see renderFootHints).
      scrim.innerHTML =
        '<div class="panel" role="dialog" aria-modal="true" aria-label="Tabitha palette">' +
        '<input class="query" type="text" placeholder="Search tabs, workspaces, or the web…" autocomplete="off" spellcheck="false" />' +
        '<div class="results" role="listbox"></div>' +
        '<div class="foot"></div></div>';
      root.appendChild(scrim);

      scrim.addEventListener("click", (e) => {
        if (e.target === scrim) { close(); return; }
        // A click anywhere in the panel that isn't a row (the query input,
        // empty results space, ...) cancels an armed delete confirm too —
        // the row-level click handler in render() covers clicks ON a row;
        // this covers everywhere else inside the panel ("click elsewhere",
        // brief #4). The trash icon's own handler stopPropagation()s, so a
        // confirming click never reaches this listener.
        if (deletingId != null) { deletingId = null; render(); }
      });
      root.querySelector(".query").addEventListener("input", () => {
        footShowingError = false; // typing always exits the stale-error footer state; render() below rebuilds it
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
