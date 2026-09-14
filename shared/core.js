// Tabitha — shared core
//
// Pure helpers used by both the Chrome and Firefox background scripts. Nothing
// in here may touch chrome.*/browser.* — that is the whole point. It keeps the
// logic that is genuinely identical across targets in one place, tested once.
//
// Loaded three ways:
//   - Firefox: listed first in manifest background.scripts.
//   - Chrome:  pulled in by importScripts("core.js") at the top of background.js.
//   - Node:    required by the tests.
//
// EVERYTHING IS WRAPPED IN AN IIFE, and must stay that way. In both browsers
// this file and background.js share ONE global scope. A bare `function foo(){}`
// here would create a var-like global binding, which cannot coexist with the
// `const { foo } = ...` that background.js declares — the engine throws
// "Identifier 'foo' has already been declared" and the extension never starts.
// The IIFE keeps these names local, so `globalThis.TabithaCore` below is the
// single, deliberate export. See tests/browser-load.test.js.

(function () {
  // Only http/https tabs are trackable. chrome://, about: and extension pages
  // cannot be reliably reopened, so they are never saved into a workspace.
  function isTrackableUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
  }

  // A hidden tab that belongs to no workspace of OURS, and whose URL we still
  // have saved, is garbage: see firefox/background.js collectOrphanTabs for
  // why they pile up (tabMap is session storage, so a restart forgets which
  // hidden tab belongs to which workspace, and nothing can ever re-adopt it
  // because the only ownership path only ever looks at VISIBLE tabs).
  //
  // `hidden` alone is NOT enough to call a tab ours: `tabs.hide` is a shared
  // permission — Sidebery, Simple Tab Groups and Panorama all use it too — so
  // a hidden tab found at startup could belong to a different extension
  // entirely, stashed there on purpose. (An earlier version of this predicate
  // assumed "only this extension hides tabs at all"; that was never actually
  // true and a reviewer caught it before it shipped.) What we actually know,
  // precisely, is what produces the leak: a superseded materialize() duplicate
  // is by definition a tab whose URL is still sitting in one of our own
  // workspaces' saved `tabs[]` records. So `savedUrls` (every URL in every
  // workspace's `tabs[]`, built by the caller) gates collection too, via exact
  // string equality on the same value already used everywhere else in this
  // codebase — no fragment or query stripping, no fuzzy matching. Two URLs
  // differing only by fragment are different tabs, not a match.
  //
  // This is deliberately conservative: a genuine orphan whose saved URL has
  // since changed (edited, or the tab navigated before hiding) will not match
  // and will survive uncollected. That is the correct trade for an automatic,
  // unconfirmed deletion — leaving some real garbage behind beats closing
  // something that was not ours.
  //
  // Be clear about what this does NOT establish: a URL match is not proof of
  // ownership. tabHide is a shared permission (Sidebery, Simple Tab Groups and
  // Panorama all use it), so another extension's stashed tab sitting on a URL
  // Tabitha also has saved WILL still be collected. The residual risk is
  // accepted rather than eliminated, because a tab id cannot be attributed to
  // an extension after a restart — the collision is narrow (a page the user
  // already keeps in a workspace) and the URL is recoverable, but it is real.
  //
  // `!tab.pinned` is kept explicit even though a pinned tab cannot currently
  // be hidden (Firefox refuses). Pinned tabs are deliberately owned by no
  // workspace and must never be closed by this — the exclusion has to survive
  // on its own, not depend on today's inability to hide one.
  function isCollectableOrphanTab(tab, ownedIds, savedUrls) {
    return (
      !!tab.hidden &&
      !tab.pinned &&
      isTrackableUrl(tab.url) &&
      !ownedIds.has(tab.id) &&
      savedUrls.has(tab.url)
    );
  }

  // Workspace names are mandatory. Returns a trimmed name, or null if blank.
  function cleanName(name) {
    const n = (name || "").trim();
    return n.length ? n : null;
  }

  // Cap on stored icon path markup — guards storage against absurd payloads.
  const MAX_ICON_PATHS = 4096;

  // The entire element/attribute surface used across all 1628 Lucide icons in
  // the committed dataset (measured directly from shared/icon-data.json's
  // `nodes`, freshly regenerated — NOT copied from an earlier estimate: an
  // initial pass over this task missed `<line>`'s x1/x2/y1/y2 endpoints, which
  // only showed up once the real dataset existed to check against). No
  // `href`, no `style`, no event handler ever appears, so an allowlist of
  // exactly this surface is sufficient by measurement, not by hope — and it
  // is what will let the palette render icon geometry with createElementNS +
  // setAttribute instead of innerHTML, which is the whole point: the palette
  // overlay lives inside arbitrary web pages, where markup injection would be
  // a real escalation. (The palette renderer itself is a later change — see
  // shared/palette.js, which still shows a fixed glyph.)
  const ICON_NODE_TAGS = ["circle", "ellipse", "line", "path", "polygon", "polyline", "rect"];
  const ICON_NODE_ATTRS = ["cx", "cy", "d", "fill", "height", "points", "r", "rx", "ry", "width", "x", "x1", "x2", "y", "y1", "y2"];

  // 32 is well above the largest real Lucide icon (15 elements, measured), so
  // this only ever bites a corrupted or hostile payload. Same reasoning for
  // the attribute-value cap: the longest real `d` value measured across the
  // dataset is 461 chars, so 1024 leaves headroom without letting a single
  // attribute balloon storage.
  const MAX_ICON_NODES = 32;
  const MAX_ICON_NODE_ATTR_LEN = 1024;

  // The per-node and per-attribute caps above bound a single node, but not
  // the array as a whole: 32 nodes x 16 attrs x 1024 chars is ~529KB of
  // otherwise-valid output, 130x MAX_ICON_PATHS (which guards this same
  // geometry in its markup form). This caps the serialised total instead.
  // 4096 mirrors MAX_ICON_PATHS's order of magnitude; the largest real icon
  // in the dataset serialises to 857 chars (measured), so there is ample
  // headroom for legitimate icons and none for an attack that relies on
  // stacking many large-but-individually-valid nodes/attributes.
  const MAX_ICON_NODES_TOTAL_LEN = 4096;

  // Clean a `nodes` array ([[tag, {attr: value}], ...]) down to exactly the
  // allowlisted shape, or null if the input isn't even an array (or nothing
  // survived cleaning — see below). Invalid individual nodes/attributes are
  // dropped rather than failing the whole icon — an icon that renders with
  // one stray element missing is a better failure mode than an icon that
  // silently reverts to no icon at all. Coerces nothing: a non-string
  // attribute value is dropped, never stringified, because coercion is how a
  // hostile object (e.g. one with a malicious toString) would sneak a string
  // out of this function.
  function normalizeIconNodes(nodes) {
    if (!Array.isArray(nodes)) return null;
    const out = [];
    for (const entry of nodes) {
      if (out.length >= MAX_ICON_NODES) break;
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [tag, attrs] = entry;
      if (typeof tag !== "string" || !ICON_NODE_TAGS.includes(tag)) continue;
      if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) continue;
      const cleanAttrs = {};
      for (const key of Object.keys(attrs)) {
        if (!ICON_NODE_ATTRS.includes(key)) continue;
        const value = attrs[key];
        if (typeof value !== "string" || value.length > MAX_ICON_NODE_ATTR_LEN) continue;
        cleanAttrs[key] = value;
      }
      out.push([tag, cleanAttrs]);
    }
    // Nothing survived cleaning (an empty input, or every entry was junk):
    // treat that the same as "not an array" and return null, not []. An
    // empty array is truthy and would otherwise look "already backfilled" to
    // firefox/background.js's needsBackfill check, permanently skipping a
    // record whose geometry never actually made it through.
    if (out.length === 0) return null;
    // All-or-nothing on total size, consistent with normalizeIcon's existing
    // all-or-nothing behaviour on `paths`: reject the whole value rather than
    // truncating it, which would silently produce a partial icon.
    if (JSON.stringify(out).length > MAX_ICON_NODES_TOTAL_LEN) return null;
    return out;
  }

  // TRUST BOUNDARY: `paths` is injected via innerHTML (ICON_SVG in popup.js) and is
  // trusted ONLY because it originates from the extension's own committed icon
  // dataset, never from web content. Do not wire an untrusted source into setIcon
  // or create.
  // Validate/normalize an icon picked in the popup before it is stored. Returns a
  // clean { name, paths } (plus `nodes` when present and valid) or null (null =>
  // the record gets no icon and renders the default sentinel).
  //
  // `paths`/`name` validation is unchanged from before `nodes` existed, so a
  // record saved before this change (name+paths, no nodes) keeps validating
  // exactly as it did. `nodes` is a pure addition: absent or invalid input
  // just means the field is left off, never a reason to reject the icon.
  function normalizeIcon(icon) {
    if (!icon || typeof icon !== "object") return null;
    const { name, paths, nodes } = icon;
    if (typeof name !== "string" || typeof paths !== "string") return null;
    if (!name.trim() || !paths.trim()) return null;
    if (paths.length > MAX_ICON_PATHS) return null;
    const out = { name, paths };
    const cleanNodes = normalizeIconNodes(nodes);
    if (cleanNodes !== null) out.nodes = cleanNodes;
    return out;
  }

  // Delete confirm wording (palette-round3 brief #1). `count` must be
  // row.count — the workspace's live AND saved-but-not-live tabs together —
  // never a live-only count. deleteWorkspace destroys the whole record, so
  // every saved tab is lost too, not just the ones currently open; a warning
  // that only counted live tabs was accurate about what Firefox closes and
  // wrong about what the user loses, which is the number that matters for a
  // destructive-action confirm. (An earlier version counted only
  // kind:"tab" items for exactly that reason — "closes" felt like the right
  // question — and got a workspace with 5 saved-but-unopened tabs down to
  // "close its 0 tabs?".) Factored out so the wording is unit-tested without
  // a DOM harness; palette.js's render() is the only caller.
  function deleteConfirmLabel(name, count) {
    return `Delete "${name}" and its ${count === 1 ? "1 tab" : count + " tabs"}?`;
  }

  // Append a tab to a target workspace, returning a new state. Never mutates the
  // input, never persists — callers do that. The source workspace is left alone;
  // re-saving it is the caller's job, because how a tab leaves its old workspace
  // differs per browser.
  function buildMovedState(state, targetId, tab) {
    if (!state.workspaces.some((w) => w.id === targetId)) {
      throw new Error("target not found");
    }
    return {
      ...state,
      workspaces: state.workspaces.map((w) =>
        w.id === targetId ? { ...w, tabs: [...(w.tabs || []), tab] } : w
      ),
    };
  }

  // Import caps. Rejection, not truncation: a file over these is a mistake or an
  // attack, and silently keeping part of it hides that.
  const MAX_IMPORT_WORKSPACES = 200;
  const MAX_IMPORT_TABS = 500;

  // Parse an exported backup. Returns { ok: true, workspaces } or
  // { ok: false, error }. Never throws — the caller shows `error` verbatim.
  //
  // TRUST BOUNDARY: this text comes from a user-chosen file and is untrusted,
  // unlike the committed icon dataset. `icon.paths` is dropped on purpose: it is
  // injected with innerHTML by ICON_SVG in popup.js. `icon.nodes` is dropped for
  // the identical reason, even though it is meant to be rendered with
  // createElementNS + setAttribute rather than innerHTML once the palette
  // renderer catches up: geometry from a user-supplied file is still untrusted,
  // and the palette's allowlist is a belt to core.js's normal suspenders, not a
  // replacement for re-resolving from the committed dataset.
  // The caller re-resolves both paths and nodes from icon-data.json by name, so
  // neither hostile markup nor hostile geometry can ever reach the DOM.
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: "That file is not valid JSON." };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "That file is not a Tabitha backup." };
    }
    if (data.format !== "tabitha-workspaces") {
      return { ok: false, error: "That file is not a Tabitha backup." };
    }
    if (data.version !== 1) {
      return { ok: false, error: `Unsupported backup version: ${data.version}.` };
    }
    if (!Array.isArray(data.workspaces)) {
      return { ok: false, error: "That backup has no workspaces list." };
    }
    if (data.workspaces.length > MAX_IMPORT_WORKSPACES) {
      return {
        ok: false,
        error: `Too many workspaces (${data.workspaces.length}, max ${MAX_IMPORT_WORKSPACES}).`,
      };
    }

    const seen = new Set();
    const workspaces = [];
    for (const raw of data.workspaces) {
      if (!raw || typeof raw !== "object") continue;
      const name = cleanName(raw.name);
      if (!name) continue;

      const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
      if (rawTabs.length > MAX_IMPORT_TABS) {
        return {
          ok: false,
          error: `"${name}" has too many tabs (${rawTabs.length}, max ${MAX_IMPORT_TABS}).`,
        };
      }
      // TRUST BOUNDARY: `title` comes from a user-chosen file. It is carried as
      // text only and MUST be rendered with textContent, never innerHTML — see
      // the palette row renderer. A non-string is dropped rather than coerced,
      // so an object or array can never reach the DOM.
      const tabs = rawTabs
        .filter((t) => t && isTrackableUrl(t.url))
        .map((t) => ({
          url: t.url,
          pinned: t.pinned === true,
          ...(typeof t.title === "string" && t.title.trim() ? { title: t.title } : {}),
        }));

      // A missing or duplicate id would collide in storage, so mint a fresh one.
      let id = typeof raw.id === "string" && raw.id ? raw.id : null;
      if (!id || seen.has(id)) id = crypto.randomUUID();
      seen.add(id);

      const ws = { id, name, tabs };
      // Only an http/s URL is a valid landing target, same rule as tabs.
      if (isTrackableUrl(raw.lastActiveUrl)) ws.lastActiveUrl = raw.lastActiveUrl;
      const iconName =
        raw.icon && typeof raw.icon === "object" && typeof raw.icon.name === "string"
          ? raw.icon.name.trim()
          : "";
      // Name only. Never carry `paths` or `nodes` across the trust boundary.
      if (iconName) ws.icon = { name: iconName };
      workspaces.push(ws);
    }
    return { ok: true, workspaces };
  }

  // Palette ranking. Substring scoring only — deliberately not fuzzy. A fuzzy
  // matcher surfaces confident nonsense for short queries, and the palette is
  // driven by muscle memory where a wrong first row is worse than no row.
  const MAX_PALETTE_RESULTS = 50;

  function scorePaletteItem(item, needle) {
    const title = ((item && item.title) || "").toLowerCase();
    const url = ((item && item.url) || "").toLowerCase();
    if (title.startsWith(needle)) return 100;
    if (title.includes(" " + needle)) return 80; // word boundary
    if (title.includes(needle)) return 60;
    if (url.includes(needle)) return 30;
    return 0;
  }

  // Returns the same item objects, filtered and sorted. Never mutates the input.
  function rankPaletteItems(items, query) {
    const list = Array.isArray(items) ? items : [];
    const needle = (query || "").trim().toLowerCase();
    if (!needle) return list.slice(0, MAX_PALETTE_RESULTS);
    return list
      .map((item, i) => ({ item, i, score: scorePaletteItem(item, needle) }))
      .filter((r) => r.score > 0)
      // Index breaks ties, so equal scores keep the caller's order. Array.sort
      // is stable in modern engines, but relying on that silently is how a
      // result order becomes accidentally load-bearing.
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, MAX_PALETTE_RESULTS)
      .map((r) => r.item);
  }

  // Default view (no query): how many of an expanded section's items show
  // before the rest fold behind a "+N more" row. The point of grouping is
  // "my workspaces, and what's in them" rather than a wall of tabs — see the
  // palette-ui brief's wireframe.
  const PALETTE_COLLAPSED_TABS = 5;

  // "Fully expanded" (every item, no cap — reached by activating a "more"
  // row) is tracked in the SAME `expanded` Set as "expanded at all", not a
  // second set: a workspace id present in the set means "open, capped at
  // PALETTE_COLLAPSED_TABS"; that id plus this suffix means "open, showing
  // everything". One Set is the single source of truth for a section's
  // closed/capped/full state, so a caller (palette.js owns and mutates the
  // Set across a palette session) can never get two collections out of sync
  // with each other. U+0000 can never appear in a real workspace id (a
  // crypto.randomUUID()) or be produced by String(null) (the unfiled
  // section's key), so the composed key is always unambiguous.
  const PALETTE_FULL_SUFFIX = "\u0000full";

  // The active workspace defaults to "capped" (open) purely from being
  // active — see visibilityFor's `isActive` check below — with no entry in
  // `expanded` needed to get there. That means deleting the id (what
  // collapsing every other section does) can't close the active one: "not in
  // the set" is exactly what already means "use the default". This marker is
  // the explicit override — "the user closed this even though it would
  // otherwise default open" — using the same key-composition trick as
  // PALETTE_FULL_SUFFIX. collapseSection sets it unconditionally on every
  // collapse (harmless for a non-active id, whose default is already
  // collapsed), so palette.js never has to ask "is this the active one?"
  // itself.
  const PALETTE_COLLAPSED_SUFFIX = "\u0000collapsed";

  // Inside the ACTIVE workspace's own section, the tab the user is actually
  // looking at right now sorts first — see the palette-actions brief: it's
  // what makes "move this tab" unambiguous, since the thing being moved is
  // visible while you choose a destination. Restricted to the active
  // workspace's own list: an `active` tab item appearing anywhere else would
  // be a browser inconsistency this function has no business papering over.
  // Default state (activeWorkspaceId === null) can never match a real
  // workspace id, so this naturally no-ops there, and the unfiled section
  // (workspaceId === null) is excluded the same way.
  function pinActiveTabFirst(list, workspaceId, activeWorkspaceId) {
    if (workspaceId == null || workspaceId !== activeWorkspaceId) return list;
    const idx = list.findIndex((it) => it.kind === "tab" && it.active === true);
    if (idx <= 0) return list; // already first, or no active tab in this list
    const copy = list.slice();
    const [pinned] = copy.splice(idx, 1);
    copy.unshift(pinned);
    return copy;
  }

  // Group the palette's flat `items` (tab/saved/workspace mix) into rows the
  // overlay can render as sections: a header row per workspace, followed by
  // that workspace's tabs (collapsed to a header-only summary unless it is
  // active or the caller has expanded it — see `expanded` below). Pure — see
  // buildPaletteRows below for the ordering rules, which mirror the
  // palette-grouping brief exactly.
  //
  // Header rows are synthesized from the `workspaces` records themselves,
  // not read off any kind:"workspace" entry in `items`. That is deliberate:
  // it is the only way a workspace with zero tabs (or a caller that omits
  // per-workspace kind:"workspace" entries) still gets a header under the
  // "every workspace" empty-query rule, and buildPaletteState's kind:"workspace"
  // items carry the exact same fields (title/url/icon/workspaceId) anyway, so
  // the renderer sees an identical shape either way. Any kind:"workspace"
  // entry present in `items` is otherwise ignored, so it never becomes a
  // second, duplicate header.
  //
  // `expanded` is a Set of workspace ids (plus `null` for the unfiled
  // section) the user has manually opened, in the two-state encoding
  // documented above PALETTE_FULL_SUFFIX. Ignored entirely while a query is
  // present: every matching section is shown fully expanded regardless of
  // it, per the brief ("the 5-tab cap does not apply while a query is
  // present").
  function buildPaletteRows(items, workspaces, activeWorkspaceId, query, expanded) {
    const wsList = Array.isArray(workspaces) ? workspaces : [];
    const itemList = Array.isArray(items) ? items : [];
    const needle = (query || "").trim();
    const expandedIds = expanded instanceof Set ? expanded : new Set();

    // Bucket the real (tab/saved) items by owning workspace. workspaceId ==
    // null (loose == so both null and undefined land here) means "unowned" —
    // the stale-tabMap case the brief calls out.
    const byWs = new Map();
    const unfiled = [];
    for (const it of itemList) {
      if (!it || it.kind === "workspace") continue;
      if (it.workspaceId == null) {
        unfiled.push(it);
        continue;
      }
      if (!byWs.has(it.workspaceId)) byWs.set(it.workspaceId, []);
      byWs.get(it.workspaceId).push(it);
    }

    const headerItemFor = (ws) => ({
      kind: "workspace",
      workspaceId: ws.id,
      title: ws.name,
      url: ws.lastActiveUrl || "",
      icon: ws.icon || null,
    });

    // "full" (query mode, or manually expanded to "show all"): every tab
    // shown, no cap, no more-row. "collapsed": header only. "capped":
    // PALETTE_COLLAPSED_TABS tabs, plus a more-row if any remain.
    function visibilityFor(id, isActive) {
      if (needle) return "full";
      if (expandedIds.has(`${id}${PALETTE_FULL_SUFFIX}`)) return "full";
      // The plain id (explicit "open") is checked before the collapsed
      // marker: an explicit expand always wins over an explicit collapse, so
      // a stale/overlapping marker (the two are never meant to coexist —
      // palette.js's expandCapped/expandFull delete one before adding the
      // other — but nothing here should silently depend on that ordering)
      // resolves the same way a human would read "open again after closing".
      if (expandedIds.has(id)) return "capped";
      // Checked before the isActive default below: an explicit collapse
      // must win over "active workspaces default open", or the active
      // section could never actually be closed — see PALETTE_COLLAPSED_SUFFIX.
      if (expandedIds.has(`${id}${PALETTE_COLLAPSED_SUFFIX}`)) return "collapsed";
      if (isActive) return "capped";
      return "collapsed";
    }

    // Sections, not a flat row list, so the final cap can protect headers —
    // see the budget pass below. Each section is { header, tabs }: the header
    // row plus that section's tab-and-more rows, already in their final
    // display order (pre budget-pass truncation).
    const sections = [];
    const tabRows = (workspaceId, list) =>
      list.map((it) => ({ kind: "tab", item: it, workspaceId, selectable: true, depth: 1 }));
    const moreRow = (workspaceId, count) => ({
      kind: "more", item: null, workspaceId, count, selectable: true, depth: 1,
    });
    // Applies the section's visibility state to its full candidate list —
    // `fullTabs` is already query-filtered where relevant (or unfiltered for
    // a name match), so "full" here just means "render it all, don't cap".
    const rowsFor = (workspaceId, fullTabs, vis) => {
      if (vis === "full") return tabRows(workspaceId, fullTabs);
      if (vis === "collapsed") return [];
      const shown = fullTabs.slice(0, PALETTE_COLLAPSED_TABS);
      const out = tabRows(workspaceId, shown);
      const hidden = fullTabs.length - shown.length;
      if (hidden > 0) out.push(moreRow(workspaceId, hidden));
      return out;
    };
    const headerRow = (ws, fullTabs, vis) => ({
      kind: "header",
      item: headerItemFor(ws),
      workspaceId: ws.id,
      selectable: true,
      depth: 0,
      // The DISPLAYED count for this section as currently shown — in query
      // mode where this workspace matched by its ITEMS (not its name),
      // `fullTabs` is only the matching subset, so this can be smaller than
      // the workspace's true size. That's fine for the "3 tabs" header text.
      // It is NOT fine for a destructive-action confirm — see `total` below.
      count: fullTabs.length,
      // The TRUE total this workspace owns, independent of query, collapse
      // state, the 5-item cap, and section budgeting — always read straight
      // off the unfiltered byWs grouping, never off whatever subset
      // `fullTabs` happens to be for this call. This is the number
      // deleteConfirmLabel must use (palette-round3 round-2 finding: `count`
      // reads as the match count when a workspace matched by its tabs rather
      // than its name, e.g. "Delete B and its 2 tabs?" for a 22-tab
      // workspace with only 2 tabs matching the query).
      //
      // Very close, not exact: buildPaletteState de-dupes a live tab against
      // any saved record sharing its URL, so (a) a live tab plus saved
      // duplicates of the same URL undercounts by the duplicate copies, and
      // (b) a live tab that navigated off its saved URL before the next
      // auto-save overcounts by one (both the live and the stale saved
      // record surface). Both are small, in both directions, and not worth
      // restructuring buildPaletteState to close.
      total: (byWs.get(ws.id) || []).length,
      expanded: vis !== "collapsed",
    });
    const unfiledHeaderRow = (fullTabs, vis) => ({
      kind: "header",
      item: null,
      workspaceId: null,
      // Selectable now, unlike the pre-collapse palette: the wireframe gives
      // "Not in a workspace" the same chevron/number/toggle affordance as a
      // real workspace, so it must be navigable and toggleable like one.
      // Activating it is still a no-op (item is null; see palette.js's
      // activate(), unchanged), only the toggle behaves.
      selectable: true,
      depth: 0,
      count: fullTabs.length,
      // No `total` here: palette.js only ever shows the delete trash/confirm
      // for a row with a real workspaceId (`isReal` in render()), and this
      // header's workspaceId is always null, so deleteConfirmLabel can never
      // see this row's count. Verified by reading that gate, not assumed.
      expanded: vis !== "collapsed",
    });
    const pushSection = (header, tabs) => sections.push({ header, tabs });

    let anyNameMatched = false;

    if (!needle) {
      // Every workspace, active one first, then stored order. Visibility
      // decides how much of each shows — see visibilityFor above.
      const ordered = [
        ...wsList.filter((w) => w.id === activeWorkspaceId),
        ...wsList.filter((w) => w.id !== activeWorkspaceId),
      ];
      for (const ws of ordered) {
        const fullTabs = pinActiveTabFirst(byWs.get(ws.id) || [], ws.id, activeWorkspaceId);
        const vis = visibilityFor(ws.id, ws.id === activeWorkspaceId);
        pushSection(headerRow(ws, fullTabs, vis), rowsFor(ws.id, fullTabs, vis));
      }
      if (unfiled.length) {
        const vis = visibilityFor(null, false);
        pushSection(unfiledHeaderRow(unfiled, vis), rowsFor(null, unfiled, vis));
      }
    } else {
      // 1. Workspaces whose NAME matches the query, best score first, each
      // followed by ALL of its items (unfiltered — see the header comment
      // above and the brief's "unfiltered" requirement). Scored via the same
      // rankPaletteItems ladder used everywhere else, over a synthetic
      // one-field-per-workspace list, rather than a second scorer.
      const nameCandidates = wsList.map((ws) => ({ title: ws.name, url: "", __ws: ws }));
      const nameMatches = rankPaletteItems(nameCandidates, needle);
      const matchedWs = nameMatches.map((m) => m.__ws);
      const matchedIds = new Set(matchedWs.map((w) => w.id));
      anyNameMatched = matchedWs.length > 0;

      for (const ws of matchedWs) {
        const fullTabs = pinActiveTabFirst(byWs.get(ws.id) || [], ws.id, activeWorkspaceId);
        pushSection(headerRow(ws, fullTabs, "full"), rowsFor(ws.id, fullTabs, "full"));
      }

      // 2. Remaining workspaces whose ITEMS match, best matching item first,
      // each followed by only its matching items. One rankPaletteItems call
      // over every remaining candidate (each tagged with its owning
      // workspace via a synthetic wrapper — the original item is carried
      // through untouched as __orig and is what ends up in the row, so
      // "item is the original object, unchanged" still holds) gives both
      // orderings for free: the sort is global by score with ties keeping
      // input order, so a workspace's best item is always the first time
      // that workspace appears in the sorted list, and filtering the sorted
      // list back down to one workspace preserves that workspace's own
      // relative (== per-workspace ranked) item order.
      const remaining = wsList.filter((w) => !matchedIds.has(w.id));
      const pool = [];
      for (const ws of remaining) {
        for (const it of byWs.get(ws.id) || []) {
          pool.push({ title: it.title, url: it.url, __ws: ws, __orig: it });
        }
      }
      const rankedPool = rankPaletteItems(pool, needle);
      const itemMatchedOrder = [];
      const seenWs = new Set();
      for (const r of rankedPool) {
        if (!seenWs.has(r.__ws.id)) {
          seenWs.add(r.__ws.id);
          itemMatchedOrder.push(r.__ws);
        }
      }
      for (const ws of itemMatchedOrder) {
        const matchedTabs = pinActiveTabFirst(
          rankedPool.filter((r) => r.__ws.id === ws.id).map((r) => r.__orig),
          ws.id,
          activeWorkspaceId
        );
        pushSection(headerRow(ws, matchedTabs, "full"), rowsFor(ws.id, matchedTabs, "full"));
      }

      // 3. Unfiled always goes last, regardless of how its own matches would
      // score against the workspaces above — it has no name to match by, so
      // it can only ever land in this "matching items" bucket, and the brief
      // is explicit that it goes last, not interleaved by score.
      const rankedUnfiled = rankPaletteItems(unfiled, needle);
      if (rankedUnfiled.length) {
        pushSection(unfiledHeaderRow(rankedUnfiled, "full"), rowsFor(null, rankedUnfiled, "full"));
      }
    }

    // Budget pass: a flat rows.slice(0, MAX_PALETTE_RESULTS) can truncate mid
    // section and drop a later section's header entirely — the palette exists
    // to show workspace structure, so losing a whole workspace this way is
    // worse than losing some of its tabs. Every section that made it this far
    // "qualifies" (it matched, or the query was empty) and always keeps its
    // header; only tab/more rows are ever trimmed to make room.
    //
    // This runs on the already visibility-truncated section.tabs above, so in
    // ordinary no-query use (most sections collapsed to zero rows, the rest
    // capped at PALETTE_COLLAPSED_TABS) it is a no-op — the scenario it still
    // protects is a query matching many large workspaces by name, or many
    // sections manually expanded to "full" at once, where visibility alone
    // no longer bounds the row count.
    //
    // If even one header per section can't fit under the cap, there is no
    // budget left for any tabs at all, and headerless tab rows (a tab with no
    // section title above it) would be more confusing than a workspace being
    // absent — so whole sections are dropped by rank instead, same as the old
    // flat cap did, just at section granularity rather than row granularity.
    let keptSections = sections;
    let tabBudget = MAX_PALETTE_RESULTS - sections.length;
    if (tabBudget < 0) {
      keptSections = sections.slice(0, MAX_PALETTE_RESULTS);
      tabBudget = 0;
    }

    // Round-robin the remaining budget across kept sections in their existing
    // rank order: each section's best (first) item, then each section's
    // second-best, and so on. One unit per section per pass keeps a
    // many-item section from starving a small one — the exact failure this
    // replaces (a 60-tab workspace silently deleting a 1-tab workspace's
    // entire row).
    const tabsKept = keptSections.map(() => 0);
    let remaining = tabBudget;
    while (remaining > 0) {
      let progressed = false;
      for (let i = 0; i < keptSections.length && remaining > 0; i++) {
        if (tabsKept[i] < keptSections[i].tabs.length) {
          tabsKept[i]++;
          remaining--;
          progressed = true;
        }
      }
      if (!progressed) break; // every kept section's tabs are fully included
    }

    const rows = [];
    keptSections.forEach((section, i) => {
      rows.push(section.header);
      // slice, not a filter — preserves each section's own existing order,
      // round-robin only ever decides how many of the leading items survive.
      rows.push(...section.tabs.slice(0, tabsKept[i]));
    });

    // defaultSel must always land on a selectable row, or -1. The empty-query
    // and "a workspace name matched" cases both want the leading header
    // (always row 0, always selectable, when rows exist); a tabs/items-only
    // match wants the first tab row instead. nextSelectableIndex is reused
    // for the fallback searches so this stays consistent with arrow-key
    // navigation rather than re-implementing "find a selectable row".
    //
    // Computed BEFORE the create/createEmpty/label/search rows below are
    // appended. Appending to the end of `rows` cannot change the index of
    // anything already in it, so a match found above stays correct — and it
    // means a create row can never accidentally become the default purely by
    // being the first selectable thing left when nothing else matched (see
    // the brief: Enter on an empty selection must still mean "search this",
    // not "silently create a workspace"). The one deliberate exception is
    // below, after the search rows exist to point at.
    let defaultSel;
    if (!needle || anyNameMatched) {
      defaultSel = rows.length && rows[0].selectable ? 0 : nextSelectableIndex(rows, -1, 1);
    } else {
      const firstTab = rows.findIndex((r) => r.kind === "tab" && r.selectable);
      defaultSel = firstTab >= 0 ? firstTab : nextSelectableIndex(rows, -1, 1);
    }

    // Tail grouping (palette-round3 brief #3): once the query is non-empty,
    // the remainder of the list is two labelled, non-selectable-header
    // sections.
    //
    // WORKSPACE — "New workspace ... from current tabs" / "New empty
    // workspace ...", unchanged in behaviour from before grouping existed,
    // preceded by its own label. Appears only when the query names something
    // no workspace already is (case-insensitive, trimmed — an exact match
    // means the query's own section is already showing above, so offering to
    // create it again would be redundant) — and when the create rows are
    // absent, the label is omitted too. A group label must never be emitted
    // with nothing under it.
    //
    // WEB — "Search ... in current tab" / "Search ... in new tab", always
    // present for a non-empty query regardless of whether anything else
    // matched (searching the web is always a sensible thing to do), also
    // preceded by its own label.
    //
    // Neither group is part of a `section` / the budget pass above: the
    // brief is explicit these always appear at the very bottom regardless of
    // how much else matched, same as the create rows always did before
    // grouping existed.
    let searchCurrentTabIdx = -1;
    if (needle) {
      const exists = wsList.some((w) => w.name.trim().toLowerCase() === needle.toLowerCase());
      if (!exists) {
        rows.push({ kind: "label", item: null, workspaceId: null, text: "WORKSPACE", selectable: false, depth: 0 });
        rows.push({ kind: "create", item: null, workspaceId: null, name: needle, selectable: true, depth: 0 });
        rows.push({ kind: "createEmpty", item: null, workspaceId: null, name: needle, selectable: true, depth: 0 });
      }
      rows.push({ kind: "label", item: null, workspaceId: null, text: "WEB", selectable: false, depth: 0 });
      searchCurrentTabIdx = rows.length;
      rows.push({ kind: "search", item: null, workspaceId: null, where: { kind: "currentTab" }, name: needle, hint: "⏎", selectable: true, depth: 0 });
      rows.push({ kind: "search", item: null, workspaceId: null, where: { kind: "newTab" }, name: needle, hint: "⌘⏎", selectable: true, depth: 0 });
    }

    // Deliberate default-selection change (palette-round3 brief #3): when
    // NOTHING else matched (defaultSel is still -1 from the pass above — no
    // workspace by name, no tab/saved item by content), land the selection
    // on "Search in current tab" instead of leaving nothing highlighted.
    // Behaviour is identical either way — a bare Enter already runs this
    // exact search when nothing is selected (see palette.js onKeydown's
    // plain-Enter branch) — this only makes the selection visible. Never
    // fires when something DID match (defaultSel is only -1 in the no-match
    // case), and never lands on a create row (those are appended above,
    // before this check, and untouched by it — a stray Enter must still
    // never silently create a workspace).
    if (needle && defaultSel === -1) defaultSel = searchCurrentTabIdx;

    // Numbering: 1-based position among selectable rows, in the order they
    // appear on screen, capped at 9 (Cmd+digit only reaches that far) —
    // headers, tabs, more-rows and the two create rows all take a number,
    // since Cmd+N in palette.js activates whichever row owns it. Search rows
    // are the deliberate exception: they show their own ⏎/⌘⏎ hint instead of
    // a ⌘N badge (their keys already work from anywhere in the list, so a
    // number would just be a second, competing way to describe the same
    // row), so they are skipped WITHOUT advancing `n` — every row's number is
    // exactly as if the search rows were not there at all. Runs after every
    // row (including label/search) has been appended, and after defaultSel
    // is already fixed, so numbering cannot influence which row that is.
    let n = 0;
    for (const row of rows) {
      if (row.selectable && row.kind !== "search") {
        n += 1;
        row.num = n <= 9 ? n : null;
      } else {
        row.num = null;
      }
    }

    return { rows, defaultSel };
  }

  // Arrow-key stepping for a row list where some rows (the synthetic
  // "Unfiled" header) are not selectable. Skips over them in the direction
  // of travel and clamps at either end rather than wrapping — matching the
  // Math.min/Math.max clamp the overlay used before grouping existed. Falls
  // back to a scan from the top when `from` is not itself a valid selectable
  // row (e.g. -1 on first render), so a stale or out-of-range index can never
  // leave the selection permanently stuck. Returns -1 only when nothing in
  // `rows` is selectable; every path below terminates in at most one O(n)
  // pass, so it cannot loop forever.
  function nextSelectableIndex(rows, from, direction) {
    const list = Array.isArray(rows) ? rows : [];
    const n = list.length;
    if (n === 0) return -1;
    const d = direction < 0 ? -1 : 1;

    for (let i = from + d; i >= 0 && i < n; i += d) {
      if (list[i] && list[i].selectable) return i;
    }
    if (list[from] && list[from].selectable) return from; // nothing further; clamp in place
    for (let i = 0; i < n; i++) {
      if (list[i] && list[i].selectable) return i;
    }
    return -1;
  }

  // Whether a bare ArrowLeft/ArrowRight in the palette's query input should
  // drive the section tree (collapse/expand) rather than act as an ordinary
  // text-caret key. Pure so palette.js's onKeydown (untestable — there is no
  // DOM harness for it) can stay a thin wrapper around a decision that is
  // actually covered by a test.
  //
  // Only when the query is empty AND no modifier is held: focus lives in the
  // query input the whole time the palette is open, so once there is any
  // text, Left/Right have to mean "move the caret" (or option-jump a word,
  // shift-select, ...) or the user can never fix a typo without hitting
  // Escape first. An empty query is the one case with nothing meaningful to
  // collapse mid-search anyway — buildPaletteRows shows the unfiltered tree
  // then, same as on open — so repurposing the bare arrow keys there doesn't
  // take anything away from typing.
  function paletteArrowTargetsTree(query, modifiers) {
    const m = modifiers || {};
    return !(query || "").trim() && !m.shiftKey && !m.altKey && !m.metaKey && !m.ctrlKey;
  }

  // Which verbs a given row supports — the single source of truth for both
  // the footer's per-row hints and onKeydown's routing (⌥⏎ move-here and
  // ⇧⏎ rename only ever fire where this says they can), so the two surfaces
  // can never drift out of sync with each other. There is no DOM harness for
  // either the renderer or onKeydown, so this is the one piece of "which
  // verbs apply to this row" logic that is actually unit-tested; both
  // untestable callers are meant to stay thin wrappers around it.
  //
  // Booleans only — callers decide labels, key glyphs and ordering, this only
  // decides applicability. A non-selectable row (none exist today, but the
  // contract holds regardless — see nextSelectableIndex's own comment)
  // supports nothing.
  //
  // - `activate`: what Enter does — jump a tab, open a real workspace,
  //   create one from a create/createEmpty row, or run a web search from a
  //   search row. (A "more" row's Enter also "does something" — expand — but
  //   that is routed directly off `row.kind === "more"` in palette.js today,
  //   same as it always was, so it is deliberately left out of this table
  //   rather than folded in and re-plumbed for no behavioural change. A
  //   "label" row supports nothing at all — it is never selectable, so it
  //   already falls into the `!row.selectable` early return below.)
  // - `moveHere` / `rename` / `delete`: only a REAL workspace header
  //   (workspaceId != null) — never a tab row, a "more" row, the synthetic
  //   Unfiled header, a create row, or a search row. Moving/renaming/
  //   deleting "Not in a workspace" or something that isn't a workspace at
  //   all makes no sense.
  // - `expand` / `collapse`: any header (real or Unfiled) can toggle; a tab
  //   row can only collapse (← folds its parent, same as before); a "more"
  //   row can only expand (that is its entire purpose). A search row can do
  //   neither — it has no children to fold or unfold.
  function paletteRowVerbs(row) {
    if (!row || !row.selectable) {
      return { activate: false, moveHere: false, rename: false, delete: false, expand: false, collapse: false };
    }
    const isHeader = row.kind === "header";
    const isRealHeader = isHeader && row.workspaceId != null;
    const isCreateRow = row.kind === "create" || row.kind === "createEmpty";
    return {
      activate: row.kind === "tab" || isRealHeader || isCreateRow || row.kind === "search",
      moveHere: isRealHeader,
      rename: isRealHeader,
      delete: isRealHeader,
      expand: isHeader || row.kind === "more",
      collapse: isHeader || row.kind === "tab",
    };
  }

  // ---------- Exports ----------
  // The one name this file is allowed to put on the global scope. background.js
  // destructures from it in the browser; the tests require() it.
  const TabithaCore = { isTrackableUrl, isCollectableOrphanTab, cleanName, MAX_ICON_PATHS, normalizeIcon, ICON_NODE_TAGS, ICON_NODE_ATTRS, normalizeIconNodes, buildMovedState, parseBackup, MAX_IMPORT_WORKSPACES, MAX_IMPORT_TABS, rankPaletteItems, MAX_PALETTE_RESULTS, buildPaletteRows, nextSelectableIndex, PALETTE_COLLAPSED_TABS, PALETTE_FULL_SUFFIX, PALETTE_COLLAPSED_SUFFIX, paletteArrowTargetsTree, paletteRowVerbs, deleteConfirmLabel };

  if (typeof globalThis !== "undefined") globalThis.TabithaCore = TabithaCore;
  if (typeof module !== "undefined" && module.exports) module.exports = TabithaCore;
})();
